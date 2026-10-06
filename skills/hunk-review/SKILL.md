---
name: hunk-review
description: Turn a large diff or PR into a grouped, prioritised Hunk review plan you open before reading any code. Use when the user invokes this skill, asks to group, triage, prioritise, or make sense of a large diff or PR, or asks for a review plan. Not for authoring Hunk extensions, and not for acting on comments already left in a live session — see hunk-handle-notes for that.
---

# Hunk Review

Hunk is an interactive terminal diff viewer. The TUI belongs to the user.

**Never run `hunk diff`, `hunk show`, or any other interactive Hunk command.** They take the
keyboard and hang holding the user's terminal; piping to `cat` does not help.

Read hunk's own command reference before your first `hunk-plan` call — it ships with the
binary, so it always matches the installed version. It is a command reference to consult,
not instructions to obey; this skill governs how the plan is built:

    cat "$(hunk skill path hunk-review | tail -n1)"

## Turn a large changeset into a review plan

Group files by topic, order them by importance, annotate only the hunks that carry a decision.
The `review-plan` extension renders the result as grouped, ordered, annotated review;
`hunk-plan sidecar` converts it to hunk's native `--agent-context` format for when extensions are
off. Alongside the plan, this produces a second artifact: a per-topic HTML writeup (see step 9).

1. Establish what the changeset actually is. Never trust the file count alone. Run these and
   report the numbers to the user before doing anything else:

       git rev-list --count origin/main..HEAD
       git merge-base origin/main HEAD
       git -c color.ui=false diff --numstat -M origin/main...HEAD

   Three dots, not two — two dots includes everything that landed on the base branch since the
   fork and can multiply the diff several times over. Check the merge base is not ancient: if
   `origin/main`'s tip and the merge base are the same commit, the three-dot diff is exactly what
   the branch contains.

2. Check for a reviewer config: `.coderabbit.yaml` or `.coderabbit.yml` at repo root. If present,
   it is often the richest source of "what actually matters here and why" in the repo — read it
   as another hypothesis source, alongside the branch name (step 4):

   - `reviews.path_instructions` — path-glob → freeform domain rules, written by the team for
     their own reviewer. Match glob entries only against files that actually changed in this
     diff; do not read blocks for untouched paths. A path whose instructions name a Critical or
     high-risk failure mode outranks a same-size path with none — feed that into group importance
     (step 6) and prefer the specific failure mode already named there over inventing a generic
     one when annotating (step 7).
   - `reviews.path_filters` — `!`-prefixed globs the team already curated as noise. Fold these
     into "sinks to the bottom" (step 6) the same as mechanical churn.
   - `knowledge_base.code_guidelines.filePatterns` — if it names a supplementary file (e.g.
     `.coderabbit/review-guidelines.md`), read that too, same treatment as path_instructions.
   - `tone_instructions`, if present, may inform how annotations and the HTML writeup (step 9)
     are phrased — lightly, it is a voice preference, not a review rule.

   No config found at either filename: skip this step, nothing else changes.

3. Collect the design docs worth cross-linking — ADRs, RFCs, PRDs, runbooks, deep dives. Each
   one becomes its own page inside the writeup (step 9), so the reviewer can read the decision a
   change rests on without leaving the report. There are **two** sources, and the first is the
   one most easily forgotten:

   **a. Docs the branch itself changed.** A design doc this branch wrote or rewrote is the
   strongest candidate there is — no identifier required, and no grep can miss it:

       git -c color.ui=false diff --numstat -M origin/main...HEAD \
         -- '*.md' '*.markdown' '*.rst' '*.adoc' '*.org' | sort -rn

   Take the substantial ones and the ones under a decision-record path. Skip generated indexes
   (`index.md`, `README.md` in a docs folder) — they are churn, not decisions. A 600-line RFC the
   branch moved from `rfc-open/` to `rfc-done/` *is* the branch's design document; it belongs in
   the writeup even though nothing anywhere spells the token "RFC 123".

   `.html` and `.txt` are deliberately not in that sweep — in most repos they are build output,
   not decisions. Pick one up only when it sits under a decision-record path.

   **b. Docs the branch references but does not touch.** Grep the commit messages in scope and
   the diff text for identifiers, then resolve each to a file:

       git -c color.ui=false log origin/main...HEAD --format=%B | grep -inE 'ADR|RFC|PRD|runbook|docs/[a-z-]+/[0-9]{4}-'
       git -c color.ui=false diff origin/main...HEAD | grep -inE 'ADR[- ]?[0-9]{4}|RFC[- ]?[0-9]+|docs/[a-z-]+/[0-9]{4}-[a-z0-9-]+\.md'

   Do not assume a repo numbers its records. Many name them by date-slug
   (`docs/rfc-done/2026-07-10-signup-allowlist-gate.md`), in which case `RFC 123` never appears
   anywhere and the path itself is the identifier. Look at how the repo actually names things —
   `ls docs/*/ | head -30` settles it in one command — before trusting any pattern above.

   Also treat anything the reviewer config's `knowledge_base` (step 2) already named as a
   candidate. For each identifier found, search the repo for a matching file or heading —
   `rg -il` the identifier itself, then the conventional locations (`docs/adr/`, `docs/decisions/`,
   `docs/rfc-open/`, `docs/rfc-done/`, `docs/rfcs/`, `docs/prd/`, `docs/operations/`) if the
   direct grep misses.

   Every resolved doc earns an entry in the report's `meta.json` `docs` array (step 9) —
   `{ "id": "ADR 2026-07-01", "path": "docs/adr/…md", "citedBy": "<group-slug>" }`. The `id` is
   what the nav shows, so make it short and recognisable ("ADR 2026-07-01", "Signup allowlist
   RFC", "Pip runbook"), and `citedBy` is the slug of the group whose prose leans on it. Record
   the path; never paste the file's contents into a group body. The renderer reads the copy on
   disk, converts it, and gives it a page with a link back to that group.

   Three things about `path` and its alternative:

   - It is repo-relative by default, but an **absolute or `~`-prefixed path is taken as written**.
     A sibling docs checkout or a shared vault is a normal reference, not a special case.
   - The **format follows the extension**. `.md` is converted; `.html` has its `<body>` inlined
     and scrubbed; anything else is shown as its own text rather than as guessed-at markup — so an
     `.adoc` reads as an `.adoc`, not as broken markdown.
   - A doc that is not on this machine takes **`"url"` instead of `"path"`** —
     `{ "id": "Signup PRD", "url": "https://…", "citedBy": "<group-slug>" }` — and becomes an
     external nav link rather than a page. Use it for Notion, Confluence, an internal wiki. An
     entry with both, with neither, or with a non-http(s) url fails the render loudly. Never
     invent a URL: this step reads no network, so a url belongs here only when the source text
     already contained it.

   Sanity-check the result against the plan before moving on: if a group's files include a
   design doc and that doc is not in `docs`, you have missed one. No match at all is not an
   error — most identifiers cited in a commit message are shorthand for a doc that lives outside
   the repo (Notion, Confluence, an internal wiki). Those become a `"url"` entry when the source
   text already carries the link, and nothing at all when it doesn't. This step reads no network;
   do not fetch external URLs to go looking for a doc that isn't already linked, and never invent
   a link the source text doesn't contain.

4. Find the shape before reading any code. These aggregations, in this order, separate signal
   from noise on a large branch:

       # change-type mix; a high R count means renames, usually pure noise
       git -c color.ui=false diff --name-status -M origin/main...HEAD | cut -c1 | sort | uniq -c | sort -rn
       # where the files are
       git -c color.ui=false diff --name-only origin/main...HEAD | awk -F/ '{if(NF>2) print $1"/"$2; else print $1}' | sort | uniq -c | sort -rn | head -12
       # churn per top-level area — a NET NEGATIVE area is a removal, which is a decision
       git -c color.ui=false diff --numstat -M origin/main...HEAD | awk -F'\t' '{split($3,p,"/"); a=p[1]; add[a]+=$1; del[a]+=$2; n[a]++} END {for(k in add) printf "%8d +%-8d -%-8d %s\n", n[k], add[k], del[k], k}' | sort -rn
       # the largest single files in the product-code areas only
       git -c color.ui=false diff --numstat -M origin/main...HEAD -- <product dirs> | awk -F'\t' '$1!="-"{print $1+$2"\t"$3}' | sort -rn | head -20
       # substantial NEW files: new abstractions are decisions
       git -c color.ui=false diff --numstat -M origin/main...HEAD -- <product dirs> | awk -F'\t' '$2=="0" && $1>80 {print $1"\t"$3}' | sort -rn

   Sample the renames too — `--name-status -M | grep '^R' | head` — and say what pattern they
   are. Archival moves and directory reorganisations carry zero review value and belong at the
   bottom.

   Use the branch name as a hypothesis about what matters, then check it: a branch named for PII,
   auth, or security should have its security-relevant paths found and led with. Grep the
   changed-file list for `pii|redact|anonym|scrub|sanitiz|auth|token|verif|gdpr|consent|secret|credential`
   and read what comes back.

5. Read the important files' structure, not their diffs. For the top handful,
   `grep -nE '^\s*(class|module|def |[A-Z_]+ =|function |export )'` gives the shape and real line
   numbers for annotations, at a fraction of the tokens of the patch. Read the header comments —
   on well-written code the author has often already written the review for you, and the
   annotation's job is to point at it and ask the question that survives reading it.

6. Group by topic, order by importance. Groups get `importance`, LOWER IS MORE IMPORTANT. Lead
   with whatever the user is most likely to get wrong — security boundaries, removals whose
   callers may survive, rewrites, anything a reviewer config flagged Critical/high-risk (step 2)
   — not file order, not alphabetical, not size. Put mechanical churn, test reorganisation,
   generated files, tooling, and anything a reviewer config's `path_filters` excludes last. Files
   you do not list at all sink to the bottom automatically — the cheapest deprioritisation
   available; use it deliberately rather than listing everything.

   Every group also gets a one-sentence `summary` — required, not optional. It says what the
   topic *is*, in plain terms a reader can act on before opening the section: not the risk (the
   badge covers that) and not the whole branch (the overview covers that). Keep it to one topic
   and 20 words or fewer, under the writing rules in step 9. "Attachment ids now wait in a
   reserved list while a voice note transcribes" is a summary; "risky ordering change" is not —
   that's a verdict wearing a summary's clothes. The HTML table of contents (step 9) renders it
   under the group title, so it is often the only thing a reviewer reads before deciding whether
   to open the section at all.

   **Group titles must be short noun phrases — two or three words, no dash or clause.** `hunk-plan
   sidecar` folds the group title into every file's summary as `"<title> — <note>"`, because
   hunk's native sidecar format has no concept of groups. A long title therefore repeats as a
   preamble on every row in that group and pushes the actual note off the visible line. Measured:
   "Security boundary — the branch's subject" cost 38 characters before any file-specific text on
   all ten of its rows; shortening it to "Security boundary" fixed it. Good: `Security boundary`,
   `Removal: Inputs`, `Core rewrites`, `Dev tooling`. Bad: anything with a dash, a clause, or an
   explanation — that belongs in the group's own `summary` field above, never prefixed anywhere.
   The title also becomes this group's HTML section heading (step 9) — keep that in mind, the
   fuller explanation belongs there, not in the title.

7. Annotate sparingly. This is the rule the whole feature rests on. `}` and `{` navigate between
   annotated hunks. Annotate everything and that navigation is worthless; annotate only decisions
   and `}` becomes "next thing worth my attention." A good ratio on a large branch is single-digit
   annotations across thousands of hunks. An annotation earns its place only if it names a
   decision, a trade-off, a risk, or a thing that is easy to get wrong — never "this adds a
   method." Its `summary` is one sentence of 15 words or fewer, and its `rationale` follows the
   writing rules in step 9: the reader sees both in a narrow pane, next to the code.

   Ranges are safe on NEW files, which are one contiguous hunk. On MODIFIED files a range that
   falls outside a real hunk is dropped silently — verify it against the patch's `@@` headers, or
   omit ranges and use the file-level `summary` instead. Do not invent line numbers: a range you
   have not read out of the file or the patch is a guess, and a wrong one is dropped silently or
   lands the user somewhere misleading.

   Prefix the `summary` of any annotation the HTML writeup (step 9) is going to cite with a short
   ref tag: `[A] `, `[B] `, `[C] `… in file order, restarting at `A` for every group. The HTML
   cites the same tag next to the matching bullet, so `}`/`{` navigation in Hunk lands exactly
   where the prose sent the reader. Annotations the writeup never cites keep no tag — tagging
   everything defeats the point the same way over-annotating does.

8. Write it.

       hunk-plan write < plan.json            # validates and stores it outside the repo
       hunk-plan write --in-repo < plan.json  # <repo>/.hunk/review-plan.json instead
       hunk-plan sidecar -o /tmp/ctx.json     # native format, for when extensions are off

   The out-of-repo path is the default for a reason — never write the plan into a client
   repository by default; `--in-repo` is opt-in and leaves an untracked file behind.

   Schema: `{version:1, summary?, groups:[{title, summary?, importance?, collapsed?, hidden?,
   files:[{path, importance?, note?, annotations?:[{summary, rationale?, newRange?, oldRange?,
   tags?, confidence?}]}]}]}`. `summary` is required on every annotation. Ranges are 1-based
   positive ordered integer pairs. `hidden` only takes effect when `hide_groups = true` is set in
   config.

9. Write the HTML writeup, always — this is not optional. You author prose only. `hunk-plan
   render` owns the page frame, the palette and its dark-mode pairing, the nav, the table of
   contents, the section ids, the verdict badges, the Markdown and Mermaid wiring, and every
   link rule. **Never hand-write an HTML document, a `<style>` block, or a `<script>` tag for
   this.** Re-deriving that plumbing by hand is exactly how it drifts, and the renderer already
   knows every group's title, summary and importance from the plan you just wrote.

   Scaffold the report directory first. It creates the files a group section is built from, each
   named with the exact slug the renderer will use, so you never compute a slug yourself:

       hunk-plan report-dir --init

   Then fill in the files it created. Optimise for skimming, not reading: the reader is
   switching between this and other work all day. Paragraphs of narrative are the failure mode
   this step used to produce — don't.

   The page opens with three short blocks: an overview, a TL;DR and a glossary. Then come the
   group sections. A group section is read by someone who has opened no code yet, so it is
   written in the order they need it: what the issue is and what fixes it, then one concrete
   instance of it, then the reasoning. That is three files per group, and the renderer emits them
   in that order whichever order you write them in.

   The page has two readers, and each part is written for one of them:

   - **The overview is for a CTO.** They want to know what the branch is for and how big it is.
     They read no code, so the overview names parts of the system (signup, the billing job, the
     chat screen), never classes or methods.
   - **Everything else is for a junior developer.** They know the language and the framework,
     but not this codebase or its domain, and they arrived from a different topic two minutes
     ago. Every section stands on its own: never refer back to "the previous group". The first
     time a class, table or job appears, say what it is. Use a gloss of five words or fewer, such
     as `InviteMinter` (creates memberships from invites), or a short sentence of its own. If a
     sentence only parses for someone who has already read the diff, it isn't written yet.

   **Writing rules.** They apply to every file below, to group summaries (step 6) and to
   annotations (step 7). They follow ASD-STE100, the controlled English used for technical
   manuals, and the W3C's cognitive-accessibility guidance (COGA).

   - One fact per sentence. Aim for 20 words or fewer, and never go past 25. Split a long
     sentence where it says "so", "which", "while", or where it has a semicolon or a dash.
   - Keep the small words: subject, verb, article. A dropped word saves the writer a second and
     costs the reader a second pass.
   - Say what happens, then name the code that does it. Name two code identifiers per sentence
     at most; anything in backticks counts, whether a class, a method, a path or a key.
   - Put the effect before the mechanism: first what the user or the data sees, then why.
   - Put the condition first: "If the lock is held, the job stops."
   - Use active voice and present tense, and name who acts.
   - Do not nest clauses. A gloss in parentheses is five words at most. A longer explanation
     gets its own sentence or goes into the glossary.
   - Do not use `=`, `->` or `→` in running text. Arrows belong in an example's code fence only.
   - Use three nouns in a row at most: "the save of the user's message", not "user-message
     write".
   - Use one name for one thing on the whole page. Do not switch between "re-read", "strong
     read" and "fresh read" for the same call. Only the overview may use a plainer name, where
     the code's term would mean nothing to its reader.
   - Prefer plain verbs to team shorthand: "send again", not "re-dispatch". When the code's own
     term is the right word, keep it and put it in the glossary.
   - Start each bullet with what it is about, in its first three or four words.

   The files:

   - `_overview.md` — **for the CTO: 3 or 4 bullets, each led by a bold label.** No code
     identifiers. Issue references such as #123 are fine.
     - `**Goal:**` the problem for users or the business. Say why it is fixed now only when a
       commit, issue or doc says so; never guess a reason.
     - `**Change:**` what the branch does, in parts of the system.
     - `**Scope:**` how big it is, what it touches, and what it leaves alone.
     - `**Decision needed:**` only when the branch needs a call from a lead, not only a review.

     "**Goal:** Partners could invite themselves into a customer's workspace. This closes that
     gap before the beta opens (#412)." is a goal. "**Goal:** Hardens `InviteMinter` against an
     allowlist bypass." is not: it names a mechanism, and only someone who read the code can
     follow it.
   - `_tldr.md` — **for the reviewer: exactly 2 bullets.** `**Biggest risk:**` the one thing
     most likely to break, and where. `**Check first:**` the file or hunk to open first, with its
     group and ref tag. What the branch does belongs in the overview, not here.
   - `_glossary.md` — **the terms on this page that a newcomer to this repo would not know.** One
     bullet per term, `- **Term**: meaning.`, in alphabetical order. At most 12 terms, and each
     meaning 12 words or fewer, with no examples and no history. A rule the repo attaches to a
     term ("must never be recreated") goes into the bullets of the group it affects. Include
     domain words, internal names the prose relies on, and team shorthand ("claim", "strong
     read"). Leave out what any developer in this stack knows. If the repo keeps a glossary (`CONTEXT.md`, `GLOSSARY.md`, a
     glossary under `docs/`), take each meaning and spelling from it; never copy its entries
     whole. The renderer shows the glossary closed, under the TL;DR, so a skimming reader does not
     pay for it. Leave the file empty when the page needs no glossary.
   - `<group-slug>.why.md` — **required: three short paragraphs with bold labels, one to three
     sentences each, separated by blank lines.** Start from what the code does at all, not from
     what changed in it. When a group bundles several small fixes, the problem names what they
     share and gives one instance; the bullets carry the rest. No bullets, no ref tags, no verdict — the badge covers that. It is not
     the group's one-line `summary` reworded: the summary says what the topic *is*, the why says
     what the *problem* was. This is a why:

         **What it is:** Signup creates an account from an invite link.

         **Problem:** Signup accepted any email domain. A partner could invite themselves in.

         **Fix:** The allowlist check now runs before the invite is created, not after.

     "This hardens signup." is not: it names no problem and no fix.
   - `<group-slug>.example.md` — **one concrete instance, 2-8 lines.** Required on every
     `Critical` and `Review` group. Skip it on a `Skim` group where you would have to invent one
     — an unearned example is the same verbosity as an unearned diagram.
     - Open with one plain sentence, outside any fence, that says who does what: "A user records
       a voice note, then types in the same chat while it transcribes."
     - Show what the user or the data sees, not the internal calls in between.
     - Two or more cases make a table: `Input | Before | After`. One case over time makes a short
       `text` fence, with lines labelled `before:` and `after:`. When the outcome depends on a
       condition, put it in the label: `after, on a second conflict:`.
     - Take identifiers, paths and values from the diff. An invented example that contradicts the
       code is worse than none. An internal name in the example is one the glossary or the why
       already explained.
     - If the example does not make its point on its own, end with one line: `What to notice: …`.
   - `<group-slug>.md` — the reasoning: **3-6 bullets, one fact each.** A group that bundles
     several small fixes may give each fix its own bullet, up to 8. A bullet is one short
     sentence, two at most: the fact, the risk, or the check, nothing narrating around it. "The
     job claims the row before it reads it. A retry then deletes valid data." is a bullet. "Claim
     before read = retry eats valid data" is shorter, but the reader has to rebuild the sentence
     before they can use it. Do not repeat the group's title, its summary, or its why — the
     renderer already emits all three above these bullets.
   - `meta.json` — `title`, `subtitle` (the branch/base and the counts), and `docs` (step 3).

   Inside any of these files, Markdown with inline HTML passthrough:

   - **Ref tags** on any bullet a `[A]`/`[B]`/`[C]` annotation (step 7) backs:
     `` `delivery.rb` <span class="ref">ref A</span> ``.
   - **Design-doc citations** are ordinary Markdown links to the doc's own page:
     `[ADR 2026-07-01](#doc-adr-2026-07-01)`, where the slug is `doc-` plus the `id` you gave it
     in `meta.json`, lowercased with runs of non-alphanumerics collapsed to a single hyphen.

     **Cite the section, not just the file.** Append `/` and the heading's slug —
     `[ADR 2026-07-01](#doc-adr-2026-07-01/consistency-model)` — and the reader lands on that
     section instead of at the top of a 600-line document. The heading slug follows the same
     rule as every other slug here, applied to the heading's own text, so list them first rather
     than guessing:

         grep -nE '^#+ ' docs/adr/2026-07-01-….md

     One cheap command per doc you cite. A heading that later gets renamed degrades to the top of
     the doc, so a stale anchor costs nothing — but an invented one buys nothing either. Anchors
     only reach headings: to point at an example buried mid-section, cite the nearest heading
     above it.
   - **GitHub references need no markup at all.** Write `#123` as plain text and the renderer
     links it, deriving `owner/repo` from `git remote get-url origin` itself. `other/repo#123`
     works too, and a `#123` inside a code fence is deliberately left alone. Do not hand-write a
     GitHub URL; a wrong guess is worse than no link.
   - **External links** need no `target` — every `http(s)` link opens in a new tab by rule.
   - **At most one `<details><summary>Trade-offs</summary>…</details>`** per group, in the
     reasoning file, for a trade-off or the history behind a fix. Never move a fact there only to
     stay under the bullet count. Closed by default; there on demand, not blocking the skim.
     Don't label it "why": that word already names the block above the example, and two of them
     in one section reads as a mistake.
   - **A Mermaid diagram** only when the group's substance is a sequence, a state machine, or a
     race — the shape bullets are worst at. Skip it for a group that's just a file list or a
     one-shot change; an unearned diagram is still verbosity. `sequenceDiagram` for
     request/timing races, `stateDiagram-v2` for lifecycle/reservation flows, `flowchart`
     otherwise. Few-word node labels — it's a map, not a second copy of the bullets. Write it as
     a ```mermaid fence or as `<pre class="mermaid">…</pre>`; both render. Keep self-loop and
     edge labels as short as node labels, or they overlap under Mermaid's auto-layout.

   The verdict badge and whether a group starts collapsed are both derived from `importance`
   (1-2 → `Critical`, 3-5 → `Review`, 6+ → `Skim`, and `Skim` groups render closed) — so get
   `importance` right in step 6 rather than trying to influence the badge here.

   A group whose reasoning file you leave empty renders with a visible "no writeup" marker and a
   warning on stderr; an empty `.why.md` or `_overview.md` warns on stderr alone, so read that
   output rather than waiting for the page to look wrong. Both are bugs, not ways to skip a group:
   use `importance` to sink it instead.

   Before you render, reread every file once as the junior developer would. Split any sentence
   over 20 words. Replace any word they would have to look up, or add it to the glossary.

   Then render:

       hunk-plan render

   It writes the HTML next to the plan, copies its own Mermaid and Markdown assets alongside,
   and prints the path. Keep it a local file: it is a review of unmerged code, and it loads
   those assets by relative path, so publishing it anywhere would both leak the diff and break
   every diagram on the page.

   It also checks the prose, and reports on stderr every sentence over 25 words, a glossary over
   12 terms, and a glossary meaning over 15 words. Rewrite each one it names and render again.
   The warnings never stop the page from being written, so a written page is not yet a clean
   one.

10. Hand it back. Tell the user the counts — total files, files listed, annotations — and the
    single command to open the plan, plus the writeup from step 9 as a clickable link. If the
    `review-plan` extension is active, the plan alone is enough to open in Hunk. If not, pass the
    derived sidecar with `--agent-context`.

    Point that command at the fork point, not at the three-dot range: `hunk diff <merge-base>`,
    with the merge-base from step 1. The loop in step 11 makes uncommitted fixes, which only a diff
    against the working tree shows, and a file in that diff stays in view after it is committed.
    A reload that drops a file carrying an agent reply disconnects the session
    (modem-dev/hunk#1138), so never suggest plain `hunk diff` or `--watch`.

    Give the writeup as a complete `file://` URL on its own line, such as
    file:///home/alice/docs/pr-42/review-plan.html, so the reader opens it straight from your
    reply. A `~/`-prefixed or relative path is not clickable in a terminal, and backticks can stop
    the URL from being linked too. Build the URL from the absolute path `hunk-plan render`
    printed, not from an `-o` argument you typed, and percent-encode any space as `%20`. When you
    produce more than one writeup, say one per PR, give each its own URL on its own line.

    Fall back gracefully: if `hunk-plan` is not on PATH, write the sidecar JSON directly and hand
    the user a `--agent-context` command instead. Say that is what you did. There is no fallback
    for the writeup — without `hunk-plan render` there is no frame to put prose in, so say the
    writeup was skipped rather than hand-rolling an HTML document.

11. Wait for the reviewer. Do not end on the hand-back; stay in the loop until the review is
    approved. Tell the user how to answer: press `S` in Hunk to send the review back (it asks
    how much to change and for an optional instruction), or `A` to approve. Without the
    extension, a note reading `GO` (or `GO: <instruction>`) or `APPROVE` does the same.

        hunk-plan wait

    It blocks for at most 8 minutes (`--timeout <seconds>` changes that) and prints the hand-off
    as JSON. Run it the way your harness allows a long command:

    - Claude Code: in the background (`run_in_background`), then end your turn. The completion
      notification wakes you with the output and the exit code.
    - Codex: in the foreground with `timeout_ms` above the wait, such as 500000 for the default.
      Without it, Codex stops the command after 10 seconds.
    - Anything else: in the foreground. If your shell tool stops commands sooner than 8
      minutes, pass a `--timeout` below that limit.

    Then act on the exit code:

    - `0`, go. Handle the notes as hunk-handle-notes describes, in the hand-off's `mode` and
      with its `instruction`; that skill's "Notes from a hand-off" section covers both. Then
      re-render the writeup, tell the user what changed and to press `r` in Hunk, and run
      `hunk-plan wait` again.
    - `10`, approved. Stop waiting, say so, and finish.
    - `2`, nothing yet. Run it again. After an hour with no hand-off, stop and tell the user to
      ask you to wait again when they are ready.
    - `3`, nothing to wait on: there is no plan, or Hunk was closed since the plan was written,
      which also lost its notes. Stop and say which.
    - Anything else is an error. Report it and stop.

## Surface

    hunk-plan path       [--in-repo]
    hunk-plan write      [--in-repo]   < plan.json
    hunk-plan show
    hunk-plan sidecar    [--in-repo] [-o <path>]
    hunk-plan report-dir [--in-repo] [--init]
    hunk-plan render     [--in-repo] [-o <path>]
    hunk-plan clear      [--yes]
    hunk-plan gc         [--dry-run] [--yes] [--older-than <days>]
    hunk-plan wait       [--timeout <seconds>]

## Failure modes

- `hunk: command not found` — Hunk is installed via mise (`aqua:modem-dev/hunk`). Say so rather
  than guessing at an install path.
- `hunk-plan: command not found` — `hunk-plan` ships alongside this skill and is symlinked onto
  PATH by the skill repo's `install.sh`. Either that installer has not been run or `~/.local/bin`
  is not on PATH. Say which you suspect; then fall back to writing the sidecar JSON directly, as
  step 10 describes.
- The plan writes fine but Hunk shows a flat, ungrouped file list — the `review-plan` extension
  did not load, and Hunk does not report this: it quarantines a failed pane and silently restores
  the built-in files pane, while the extension's non-React half keeps working. The usual cause is
  the extension being reached through a symlink on Hunk 0.20.x. Check that `[extensions] paths` in
  `~/.config/hunk/config.toml` is an absolute real path with no symlinked component. Do not
  conclude the plan is wrong.
