/* Review report runtime. Inlined into the generated HTML by `hunk-plan render`.
 *
 * Reads window.__REPORT__ (written by the renderer) and does five things, in
 * this order, because each depends on the one before it:
 *
 *   1. decode the base64 payloads and convert them per data-format
 *   2. rewrite links in the resulting DOM (external -> new tab, #123 -> GitHub)
 *   3. give doc headings ids, so a citation can land on a section
 *   4. remember where each pane was scrolled to, as an anchor rather than a pixel
 *   5. wire hash routing between the review pane and the doc panes
 *   6. render mermaid, per pane, only once that pane is actually visible
 *
 * Step 6 is last and per-pane on purpose: mermaid measures its container, and a
 * diagram laid out inside a `hidden` pane comes back zero-width with no error.
 * It also changes the page height after the fact, which is why step 4 restores
 * again once its promise settles.
 */
(function () {
  'use strict';

  var CFG = window.__REPORT__ || {};
  var REPO = CFG.repo || null; // "owner/repo", or null when origin isn't github.com

  /* ── 1. markdown ──────────────────────────────────────────────────────── */

  // Payloads are base64 so that nothing in an ADR -- backticks, `<`, `&`, or a
  // literal `</script` -- can terminate the carrying element or be silently
  // entity-mangled. Script content is not entity-decoded, so escaping would be
  // wrong here, not merely ugly.
  function decodeB64(text) {
    var bin = atob(text.replace(/\s+/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }

  // A ```mermaid fence in a repo doc parses to <pre><code class="language-mermaid">.
  // Promote it to the <pre class="mermaid"> shape mermaid.run() looks for, so a
  // diagram an ADR author wrote renders as a diagram rather than as source.
  function promoteMermaidFences(root) {
    var codes = root.querySelectorAll('pre > code.language-mermaid');
    for (var i = 0; i < codes.length; i++) {
      var pre = codes[i].parentNode;
      var out = document.createElement('pre');
      out.className = 'mermaid';
      out.textContent = codes[i].textContent;
      pre.parentNode.replaceChild(out, pre);
    }
  }

  /* ── frontmatter ──────────────────────────────────────────────────────── */

  // ADRs and RFCs routinely open with a YAML block, and markdown has no idea
  // what it is. `---\nstatus: accepted\ndate: ...\n---` parses as a thematic
  // break followed by a *setext heading*, so the metadata renders larger than
  // the document's own title. Split it off before parsing and present it as
  // what it is: a small table of fields.
  var FM_MAX_LINES = 80; // a `---` this far down is a real horizontal rule

  function splitFrontmatter(src) {
    if (!/^---[ \t]*\r?\n/.test(src)) return null;
    var lines = src.split(/\r?\n/);
    for (var i = 1; i < lines.length && i <= FM_MAX_LINES; i++) {
      if (/^(---|\.\.\.)[ \t]*$/.test(lines[i])) {
        return { meta: lines.slice(1, i), body: lines.slice(i + 1).join('\n') };
      }
    }
    return null; // unterminated: it was an ordinary rule after all
  }

  function unquote(v) {
    var t = v.trim();
    if (t.length > 1 && ((t[0] === '"' && t.slice(-1) === '"') || (t[0] === "'" && t.slice(-1) === "'"))) {
      return t.slice(1, -1);
    }
    return t;
  }

  // A deliberate YAML subset: `key: scalar`, `key: [a, b]`, and a key followed
  // by an indented `- item` block. Anything else is kept as its raw text rather
  // than guessed at -- this is a display aid, not a YAML implementation.
  function parseFrontmatter(lines) {
    var pairs = [];
    var current = null;
    var inBlock = false; // `key: |` / `key: >` -- the indented lines are literal
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line.trim()) continue;
      if (!inBlock && /^\s*#/.test(line)) continue;

      var indented = /^\s+\S/.test(line);
      if (indented && current) {
        var item = line.trim();
        // A `- ` in a block scalar is literal text, not a list bullet.
        current.push(!inBlock && item.indexOf('- ') === 0 ? item.slice(2).trim() : item);
        continue;
      }

      var m = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
      if (!m) continue;
      var key = m[1];
      var raw = m[2].trim();

      if (raw === '' || /^[|>][-+]?$/.test(raw)) {
        // Block scalar or a nested/list key: the value is the indented block
        // underneath. Taking `|` as the value is how these rendered as a stray
        // pipe character.
        current = [];
        inBlock = raw !== '';
        pairs.push([key, current]);
      } else if (raw[0] === '[' && raw.slice(-1) === ']') {
        current = null;
        inBlock = false;
        pairs.push([key, raw.slice(1, -1).split(',').map(unquote).filter(Boolean)]);
      } else {
        current = null;
        inBlock = false;
        pairs.push([key, [unquote(raw)]]);
      }
    }
    return pairs.filter(function (p) { return p[1].length > 0; });
  }

  // The collapsed peek is one line of plain text. Truncating markdown would
  // leave unmatched `**`, so strip the markers rather than parse them.
  function plainPeek(text) {
    return text
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\*\*([^*]*)\*\*/g, '$1')
      .replace(/__([^_]*)__/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Real ADR frontmatter is not all short scalars. A `decision_summary` can run
  // to several thousand characters on one line, which would bury the document
  // it describes -- so anything past this collapses behind its own opening.
  var FM_INLINE_MAX = 220;
  var FM_PEEK = 110;

  // Values carry markdown (`code`, **bold**) often enough that literal
  // backticks read badly, so they go through the inline parser -- and then
  // through the same scrub as everything else, because this text comes from a
  // file in the diff under review.
  function fmValueInto(el, text) {
    if (typeof marked === 'undefined' || !marked.parseInline) {
      el.textContent = text;
      return;
    }
    var staging = document.createElement('div');
    try {
      staging.innerHTML = marked.parseInline(text);
    } catch (e) {
      el.textContent = text;
      return;
    }
    scrub(staging);
    el.replaceChildren.apply(el, Array.prototype.slice.call(staging.childNodes));
  }

  function frontmatterNode(pairs) {
    var dl = document.createElement('dl');
    dl.className = 'fm';
    for (var i = 0; i < pairs.length; i++) {
      var key = pairs[i][0];
      var value = pairs[i][1].join(', ');

      var dt = document.createElement('dt');
      dt.textContent = key;
      var dd = document.createElement('dd');

      if (value.length > FM_INLINE_MAX) {
        var details = document.createElement('details');
        details.className = 'fm-long';
        var summary = document.createElement('summary');
        summary.textContent = plainPeek(value).slice(0, FM_PEEK).replace(/\s+\S*$/, '') + '…';
        var full = document.createElement('div');
        fmValueInto(full, value);
        details.appendChild(summary);
        details.appendChild(full);
        dd.appendChild(details);
      } else {
        fmValueInto(dd, value);
        dd.className = 'fm-short';
      }
      if (key.toLowerCase() === 'status') dd.className = 'fm-status';

      dl.appendChild(dt);
      dl.appendChild(dd);
    }
    return dl;
  }

  // Inline HTML has to survive -- <pre class="mermaid"> and <details> are the
  // whole reason bodies are markdown-with-passthrough rather than plain
  // markdown. So strip the executable subset instead of escaping everything.
  // The case that matters: reviewing someone else's PR whose ADR carries a
  // <script>. This page runs from file:// with nothing worth stealing, but it
  // can still reach the network, and executing a contributor's markdown is not
  // a property a review tool should have.
  // `style` is in here for a reason that only shows up once a doc is HTML: a
  // <style> block is not scoped to the element it sits in, so a stylesheet
  // carried by a converted document restyles the whole report, nav and all.
  var DROP_TAGS = 'script,style,iframe,object,embed,link,meta,form,base';

  function scrub(root) {
    var bad = root.querySelectorAll(DROP_TAGS);
    for (var i = 0; i < bad.length; i++) bad[i].parentNode.removeChild(bad[i]);

    var all = root.querySelectorAll('*');
    for (var j = 0; j < all.length; j++) {
      var attrs = all[j].attributes;
      for (var k = attrs.length - 1; k >= 0; k--) {
        var name = attrs[k].name.toLowerCase();
        var value = attrs[k].value;
        if (name.indexOf('on') === 0) {
          all[j].removeAttribute(attrs[k].name);
        } else if (
          (name === 'href' || name === 'src' || name === 'xlink:href') &&
          /^\s*(javascript|data|vbscript):/i.test(value)
        ) {
          all[j].removeAttribute(attrs[k].name);
        }
      }
    }
    return root;
  }

  // Markdown into a detached div: parse, scrub, promote fences. Returns the
  // staging node, or null when marked is missing.
  function stageMarkdown(src) {
    if (typeof marked === 'undefined') return null;
    var staging = document.createElement('div');
    staging.innerHTML = marked.parse(src);
    scrub(staging);
    promoteMermaidFences(staging);
    return staging;
  }

  // A whole HTML document, not a fragment: DOMParser is inert (nothing it
  // builds ever runs) and hands back a real <body>, which is the only reliable
  // way to drop the <!doctype>/<head> wrapper instead of rendering it as text.
  function stageHtml(src) {
    var parsed = new DOMParser().parseFromString(src, 'text/html');
    var staging = document.createElement('div');
    scrub(parsed);
    promoteMermaidFences(parsed);
    staging.replaceChildren.apply(staging, Array.prototype.slice.call(parsed.body.childNodes));
    return staging;
  }

  // Anything else. Guessing a converter for .rst or .adoc would render their
  // markup as noise and claim it was a document; a <pre> is honest.
  function stagePlain(src) {
    var staging = document.createElement('div');
    var pre = document.createElement('pre');
    pre.className = 'plain';
    pre.textContent = src;
    staging.appendChild(pre);
    return staging;
  }

  function renderBodies() {
    if (typeof marked !== 'undefined') marked.setOptions({ gfm: true, breaks: false });
    var holders = document.querySelectorAll('.md');
    for (var i = 0; i < holders.length; i++) {
      var script = holders[i].querySelector('script[type="text/markdown"]');
      if (!script) continue;
      var src = '';
      try {
        src = decodeB64(script.textContent);
      } catch (e) {
        holders[i].textContent = 'Could not decode this section.';
        holders[i].className += ' missing';
        continue;
      }

      // The renderer decided the format from the file's extension; agent prose
      // has no attribute and is always markdown.
      var format = holders[i].getAttribute('data-format') || 'md';

      // Frontmatter is a doc-file convention, not something a group body ever
      // carries -- so a leading `---` in agent prose stays an honest rule.
      var fmNode = null;
      if (format === 'md' && holders[i].closest && holders[i].closest('article.doc')) {
        var split = splitFrontmatter(src);
        if (split) {
          var pairs = parseFrontmatter(split.meta);
          if (pairs.length) fmNode = frontmatterNode(pairs);
          src = split.body;
        }
      }

      // Staged detached, scrubbed, then adopted -- so nothing removable is ever
      // live in the document, however briefly.
      var staging =
        format === 'html' ? stageHtml(src) :
        format === 'text' ? stagePlain(src) :
        stageMarkdown(src);
      if (!staging) continue; // markdown with no marked: leave the payload alone

      var adopted = Array.prototype.slice.call(staging.childNodes);
      if (fmNode) adopted.unshift(fmNode);
      holders[i].replaceChildren.apply(holders[i], adopted);
    }
  }

  /* ── 2. links ─────────────────────────────────────────────────────────── */

  // Every off-machine link opens in a new tab. Rule is mechanical rather than
  // authored, so it cannot be forgotten in a hand-written bullet.
  function externalLinksToNewTab() {
    var links = document.querySelectorAll('a[href^="http://"], a[href^="https://"]');
    for (var i = 0; i < links.length; i++) {
      links[i].target = '_blank';
      links[i].rel = 'noopener noreferrer';
    }
  }

  // Bare `#123` and `other/repo#123` become GitHub links. Done over text nodes
  // rather than over the markdown source so a `#123` inside a fenced code block
  // or an existing link is left alone -- a regex on the source cannot tell.
  var ISSUE_RE = /(^|[^\w\/#])(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#(\d+)\b/g;
  var SKIP_TAGS = { A: 1, CODE: 1, PRE: 1, SCRIPT: 1, STYLE: 1 };

  function linkifyIssues(root) {
    if (!REPO) return; // no github.com origin: leave #123 as plain text
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        for (var p = node.parentNode; p && p !== root; p = p.parentNode) {
          if (SKIP_TAGS[p.nodeName]) return NodeFilter.FILTER_REJECT;
        }
        return ISSUE_RE.test(node.nodeValue)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      }
    });

    var targets = [];
    while (walker.nextNode()) targets.push(walker.currentNode);

    for (var i = 0; i < targets.length; i++) {
      var node = targets[i];
      var html = node.nodeValue.replace(/[&<>]/g, function (c) {
        return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;';
      });
      html = html.replace(ISSUE_RE, function (_m, lead, repo, num) {
        var slug = repo || REPO;
        return lead + '<a href="https://github.com/' + slug + '/issues/' + num +
          '" target="_blank" rel="noopener noreferrer">' +
          (repo ? repo : '') + '#' + num + '</a>';
      });
      var frag = document.createElement('span');
      frag.innerHTML = html;
      node.parentNode.replaceChild(frag, node);
    }
  }

  /* ── 3. heading anchors ───────────────────────────────────────────────── */

  // Byte-identical to slugify() in bin/hunk-plan. The agent authoring
  // `[ADR](#doc-adr-0001/consistency-model)` predicts this slug from the
  // heading text it read out of the file, and the pane half of that same hash
  // is slugged in bash -- two slug rules in one URL is how a deep link silently
  // stops resolving. (This is also why marked-gfm-heading-id is not used: it
  // slugs with github-slugger, whose rules differ.)
  function slugify(text) {
    return String(text).toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/, '')
      .replace(/-+$/, '');
  }

  // Only doc panes. Group bodies live in the review pane alongside the
  // renderer's own `group-<slug>` ids, and a heading in agent prose could
  // collide with one.
  function anchorHeadings(pane) {
    var heads = pane.querySelectorAll('article.doc .md h1, article.doc .md h2, article.doc .md h3, article.doc .md h4, article.doc .md h5, article.doc .md h6');
    var seen = {};
    for (var i = 0; i < heads.length; i++) {
      var base = slugify(heads[i].textContent);
      if (!base) continue;
      var slug = base;
      var n = 2;
      while (Object.prototype.hasOwnProperty.call(seen, slug)) slug = base + '-' + n++;
      seen[slug] = 1;
      if (!heads[i].id) heads[i].id = slug;
    }
  }

  var TOC_MIN = 3; // a contents list for two headings is furniture, not navigation

  function buildDocToc(pane) {
    var article = pane.querySelector('article.doc');
    if (!article || article.querySelector('nav.doc-toc')) return;
    var heads = article.querySelectorAll('.md h2, .md h3');
    if (heads.length < TOC_MIN) return;

    var nav = document.createElement('nav');
    nav.className = 'doc-toc';
    // Unordered on purpose. An <ol> keeps counting items it does not mark, so
    // indented h3 entries silently shift every number after them -- a doc whose
    // own headings are numbered then disagrees with its own contents list.
    var list = document.createElement('ul');
    for (var i = 0; i < heads.length; i++) {
      if (!heads[i].id) continue;
      var li = document.createElement('li');
      li.className = heads[i].nodeName === 'H3' ? 'sub' : '';
      var a = document.createElement('a');
      a.href = '#' + pane.getAttribute('data-doc') + '/' + heads[i].id;
      a.textContent = heads[i].textContent;
      li.appendChild(a);
      list.appendChild(li);
    }
    if (!list.childNodes.length) return;
    nav.appendChild(list);
    var after = article.querySelector('.doc-src');
    article.insertBefore(nav, after ? after.nextSibling : article.firstChild);
  }

  function flash(el) {
    if (!el) return;
    el.classList.remove('anchor-flash');
    void el.offsetWidth; // restart the animation rather than skip it on a repeat
    el.classList.add('anchor-flash');
  }

  /* ── 4. scroll memory ─────────────────────────────────────────────────── */

  // Remembering an absolute scrollY is wrong the moment the viewport reflows --
  // a resized window, a zoom step, a rotated phone. So remember *what* was at
  // the top of the viewport and how far above it sat, then recompute the offset
  // against the live layout on the way back. Absolute y survives only as a
  // fallback for a pane with no addressable block.
  var ANCHOR_SEL = 'section.group, .tldr, nav.toc, .md > *, article.doc > *';
  var scrollMemory = {};
  var currentKey = 'review';
  var expectedY = null;

  function paneFor(key) {
    return key === 'review' ? reviewPane : docPanes[key];
  }

  function scrollY() {
    return window.pageYOffset || document.documentElement.scrollTop || 0;
  }

  function navHeight() {
    var nav = document.querySelector('nav.top');
    return nav ? nav.offsetHeight : 0;
  }

  function applyScroll(y) {
    expectedY = Math.max(0, Math.round(y));
    window.scrollTo(0, expectedY);
  }

  // A late restore (mermaid finished, layout settled) must not yank the page
  // out from under someone who has already started scrolling.
  function userMoved() {
    return expectedY !== null && Math.abs(Math.round(scrollY()) - expectedY) > 2;
  }

  function rememberScroll(key) {
    var pane = paneFor(key);
    if (!pane) return;
    var list = pane.querySelectorAll(ANCHOR_SEL);
    var limit = navHeight() + 1;
    var best = -1;
    var delta = 0;
    // Last in document order that still starts at or above the viewport top:
    // with nesting that is the innermost block the reader is looking at.
    for (var i = 0; i < list.length; i++) {
      var top = list[i].getBoundingClientRect().top;
      if (top <= limit) {
        best = i;
        delta = top;
      }
    }
    scrollMemory[key] = { y: scrollY(), i: best, delta: delta };
  }

  function restoreScroll(key) {
    var m = scrollMemory[key];
    if (!m) {
      applyScroll(0);
      return;
    }
    var pane = paneFor(key);
    var list = pane ? pane.querySelectorAll(ANCHOR_SEL) : [];
    if (m.i >= 0 && list[m.i]) {
      // Put the remembered block back where it was relative to the viewport.
      applyScroll(scrollY() + list[m.i].getBoundingClientRect().top - m.delta);
      return;
    }
    applyScroll(m.y);
  }

  // Mermaid lays out after its pane becomes visible and changes the page
  // height, so a single restore lands short. rAF covers plain layout; the
  // promise covers the diagrams.
  function restoreScrollSettled(key, pending) {
    restoreScroll(key);
    var again = function () {
      if (!userMoved()) restoreScroll(key);
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(again);
    if (pending && typeof pending.then === 'function') pending.then(again, function () {});
  }

  /* ── 5. routing ───────────────────────────────────────────────────────── */

  var reviewPane = null;
  var docPanes = {};
  var navLinks = [];

  function showPane(slug) {
    var isDoc = slug && docPanes[slug];
    if (reviewPane) reviewPane.hidden = !!isDoc;
    for (var key in docPanes) {
      if (Object.prototype.hasOwnProperty.call(docPanes, key)) {
        docPanes[key].hidden = key !== slug;
      }
    }
    for (var i = 0; i < navLinks.length; i++) {
      var want = navLinks[i].getAttribute('data-nav');
      navLinks[i].classList.toggle('active', want === (isDoc ? slug : 'review'));
    }
    return renderMermaidIn(isDoc ? docPanes[slug] : reviewPane);
  }

  // `#doc-adr-0001/consistency-model` -> pane `doc-adr-0001`, anchor
  // `consistency-model`. A slug can never contain "/", so the split is
  // unambiguous and needs no escaping.
  function parseHash() {
    var raw = location.hash.replace(/^#/, '');
    var cut = raw.indexOf('/');
    return cut === -1
      ? { pane: raw, anchor: '' }
      : { pane: raw.slice(0, cut), anchor: raw.slice(cut + 1) };
  }

  function scrollToId(root, id) {
    var el = root.querySelector('[id="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
    if (!el) return false;
    applyScroll(scrollY() + el.getBoundingClientRect().top - navHeight());
    flash(el);
    return true;
  }

  function route() {
    var h = parseHash();
    var toDoc = h.pane.indexOf('doc-') === 0 && !!docPanes[h.pane];
    var key = toDoc ? h.pane : 'review';

    if (key !== currentKey) rememberScroll(currentKey);
    var pending = showPane(toDoc ? h.pane : null);
    currentKey = key;

    if (toDoc) {
      // An explicit anchor wins over memory: the reader followed a citation to
      // a place, not back to where they last were. A heading that no longer
      // exists degrades to the top of the doc rather than to nothing.
      if (h.anchor) {
        if (!scrollToId(docPanes[h.pane], h.anchor)) applyScroll(0);
        return;
      }
      restoreScrollSettled(key, pending);
      return;
    }

    if (h.pane) {
      var target = document.getElementById(h.pane);
      if (target) {
        applyScroll(scrollY() + target.getBoundingClientRect().top - navHeight());
        flash(target);
        return;
      }
    }
    restoreScrollSettled('review', pending);
  }

  /* ── 6. mermaid ───────────────────────────────────────────────────────── */

  var mermaidReady = false;

  function initMermaid() {
    if (typeof mermaid === 'undefined' || mermaidReady) return;
    // Theme and canvas move together. A diagram themed for the wrong canvas
    // still "renders" with no console error and is simply unreadable, so this
    // is easy to ship broken and never notice.
    var dark = window.matchMedia('(prefers-color-scheme: dark)').matches &&
      document.documentElement.getAttribute('data-theme') !== 'light';
    if (document.documentElement.getAttribute('data-theme') === 'dark') dark = true;
    mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'neutral' });
    mermaidReady = true;
  }

  // Returns mermaid's promise when there is work to do, so scroll restore can
  // wait for the height these diagrams add. Null when there is nothing pending.
  function renderMermaidIn(pane) {
    if (!pane || typeof mermaid === 'undefined') return null;
    initMermaid();
    var pending = pane.querySelectorAll('pre.mermaid:not([data-processed])');
    if (!pending.length) return null;
    try {
      var run = mermaid.run({ nodes: pending });
      return run && typeof run.then === 'function' ? run : null;
    } catch (e) {
      return null; /* a malformed diagram must not take the rest of the page down */
    }
  }

  /* ── boot ─────────────────────────────────────────────────────────────── */

  function boot() {
    renderBodies();
    externalLinksToNewTab();
    linkifyIssues(document.body);
    externalLinksToNewTab(); // links minted by linkifyIssues carry their own target

    reviewPane = document.getElementById('pane-review');
    var docs = document.querySelectorAll('.pane[data-doc]');
    for (var i = 0; i < docs.length; i++) {
      docPanes[docs[i].getAttribute('data-doc')] = docs[i];
      anchorHeadings(docs[i]);
      buildDocToc(docs[i]);
    }
    navLinks = Array.prototype.slice.call(document.querySelectorAll('nav.top a[data-nav]'));

    // The browser's own restore fights ours on Back and wins intermittently,
    // which reads as a jitter rather than as a bug.
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

    window.addEventListener('hashchange', route);
    route();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
