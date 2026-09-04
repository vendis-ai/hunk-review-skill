/* Review report runtime. Inlined into the generated HTML by `hunk-plan render`.
 *
 * Reads window.__REPORT__ (written by the renderer) and does four things, in
 * this order, because each depends on the one before it:
 *
 *   1. decode the base64 markdown payloads and convert them with marked
 *   2. rewrite links in the resulting DOM (external -> new tab, #123 -> GitHub)
 *   3. wire hash routing between the review pane and the doc panes
 *   4. render mermaid, per pane, only once that pane is actually visible
 *
 * Step 4 is last and per-pane on purpose: mermaid measures its container, and a
 * diagram laid out inside a `hidden` pane comes back zero-width with no error.
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

  // Inline HTML has to survive -- <pre class="mermaid"> and <details> are the
  // whole reason bodies are markdown-with-passthrough rather than plain
  // markdown. So strip the executable subset instead of escaping everything.
  // The case that matters: reviewing someone else's PR whose ADR carries a
  // <script>. This page runs from file:// with nothing worth stealing, but it
  // can still reach the network, and executing a contributor's markdown is not
  // a property a review tool should have.
  var DROP_TAGS = 'script,iframe,object,embed,link,meta,form,base';

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

  function renderMarkdown() {
    if (typeof marked === 'undefined') return;
    marked.setOptions({ gfm: true, breaks: false });
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
      // Parse detached, scrub, then adopt -- so nothing removable is ever live
      // in the document, however briefly.
      var staging = document.createElement('div');
      staging.innerHTML = marked.parse(src);
      scrub(staging);
      promoteMermaidFences(staging);
      var adopted = Array.prototype.slice.call(staging.childNodes);
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

  /* ── 3. routing ───────────────────────────────────────────────────────── */

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
    renderMermaidIn(isDoc ? docPanes[slug] : reviewPane);
    return !!isDoc;
  }

  function route() {
    var hash = location.hash.replace(/^#/, '');
    if (hash.indexOf('doc-') === 0 && docPanes[hash]) {
      showPane(hash);
      window.scrollTo(0, 0);
      return;
    }
    showPane(null);
    if (hash) {
      var target = document.getElementById(hash);
      if (target) target.scrollIntoView();
    }
  }

  /* ── 4. mermaid ───────────────────────────────────────────────────────── */

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

  function renderMermaidIn(pane) {
    if (!pane || typeof mermaid === 'undefined') return;
    initMermaid();
    var pending = pane.querySelectorAll('pre.mermaid:not([data-processed])');
    if (!pending.length) return;
    try {
      mermaid.run({ nodes: pending });
    } catch (e) {
      /* a malformed diagram must not take the rest of the page down */
    }
  }

  /* ── boot ─────────────────────────────────────────────────────────────── */

  function boot() {
    renderMarkdown();
    externalLinksToNewTab();
    linkifyIssues(document.body);
    externalLinksToNewTab(); // links minted by linkifyIssues carry their own target

    reviewPane = document.getElementById('pane-review');
    var docs = document.querySelectorAll('.pane[data-doc]');
    for (var i = 0; i < docs.length; i++) {
      docPanes[docs[i].getAttribute('data-doc')] = docs[i];
    }
    navLinks = Array.prototype.slice.call(document.querySelectorAll('nav.top a[data-nav]'));

    window.addEventListener('hashchange', route);
    route();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
