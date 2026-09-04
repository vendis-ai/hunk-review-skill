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

3. Look for design-doc references worth cross-linking — ADRs, RFCs, PRDs. Grep the commit
   messages already in scope and the diff text itself for identifiers:

       git -c color.ui=false log origin/main...HEAD --format=%B | grep -inE 'ADR[- ]?[0-9]{4}(-[0-9]{2}){0,2}|RFC[- ]?[0-9]+|PRD'
       git -c color.ui=false diff origin/main...HEAD | grep -inE 'ADR[- ]?[0-9]{4}(-[0-9]{2}){0,2}|RFC[- ]?[0-9]+|PRD'

   Also treat anything the reviewer config's `knowledge_base` (step 2) already named as a
   candidate. For each identifier found, search the repo for a matching file or heading —
   `rg -il` the identifier itself, then the conventional locations (`docs/adr/`, `docs/decisions/`,
   `docs/rfcs/`, `docs/prd/`) if the direct grep misses. A match earns an entry in the report's
   `meta.json` `docs` array (step 9) — `{ "id": "ADR 2026-07-01", "path": "docs/adr/…md",
   "citedBy": "<group-slug>" }` — and the renderer turns each one into its own page inside the
   writeup, converted from the working-tree copy, reachable from the nav and linking back to the
   group that cited it. Record the path; never paste the file's contents into a group body.
   No match is not an error: most identifiers cited in a commit message are
   shorthand for a doc that lives outside the repo (Notion, Confluence, an internal wiki), and get
   an ordinary external link there instead if a URL is already present in the text — never a
   fabricated one. This step is in-repo only and reads no network; do not fetch external URLs to
   go looking for a doc that isn't already linked, and never invent a link the source text doesn't
   contain.

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
   badge covers that) and not the whole branch (the TL;DR covers that). "Attachment ids move from
   a loose draft list to a reserved sibling list across the async transcription boundary" is a
   summary; "risky ordering change" is not — that's a verdict wearing a summary's clothes. The
   HTML table of contents (step 9) renders it under the group title, so it is often the only thing
   a reviewer reads before deciding whether to open the section at all.

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
   method."

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

   Scaffold the report directory first. It creates one Markdown file per group, named with the
   exact slug the renderer will use, so you never compute a slug yourself:

       hunk-plan report-dir --init

   Then fill in the files it created. Optimise for skimming, not reading: the reader is
   switching between this and other work all day. Paragraphs of narrative are the failure mode
   this step used to produce — don't.

   - `_tldr.md` — exactly 3 bullets: what the branch does, the single biggest risk, the one
     thing to check first. The only prose-adjacent text above the fold.
   - `<group-slug>.md` — one file per group, **3-6 short bullets**, not sentences. The fact, the
     risk, or the check, nothing narrating around it. Caveman register is fine: "Claim before
     read = retry eats valid data" beats "The reordering here matters because it changes what
     happens on retry." Do not repeat the group's title or summary at the top — the renderer
     already emits both.
   - `meta.json` — `title`, `subtitle` (the branch/base and the counts), and `docs` (step 3).

   Inside a group file, Markdown with inline HTML passthrough:

   - **Ref tags** on any bullet a `[A]`/`[B]`/`[C]` annotation (step 7) backs:
     `` `delivery.rb` <span class="ref">ref A</span> ``.
   - **Design-doc citations** are ordinary Markdown links to the doc's own page:
     `[ADR 2026-07-01](#doc-adr-2026-07-01)`, where the slug is `doc-` plus the `id` you gave it
     in `meta.json`, lowercased with runs of non-alphanumerics collapsed to a single hyphen.
   - **GitHub references need no markup at all.** Write `#123` as plain text and the renderer
     links it, deriving `owner/repo` from `git remote get-url origin` itself. `other/repo#123`
     works too, and a `#123` inside a code fence is deliberately left alone. Do not hand-write a
     GitHub URL; a wrong guess is worse than no link.
   - **External links** need no `target` — every `http(s)` link opens in a new tab by rule.
   - **One `<details><summary>why</summary>…</details>`** per group for reasoning that doesn't
     fit a bullet — trade-offs, the history behind a fix. Closed by default; there on demand,
     not blocking the skim.
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

   A group whose file you leave empty renders with a visible "no writeup" marker and a warning
   on stderr. That is a bug, not a way to skip a group: use `importance` to sink it instead.

   Then render:

       hunk-plan render

   It writes the HTML next to the plan, copies its own Mermaid and Markdown assets alongside,
   and prints the path. Keep it a local file: it is a review of unmerged code, and it loads
   those assets by relative path, so publishing it anywhere would both leak the diff and break
   every diagram on the page.

10. Hand it back. Tell the user the counts — total files, files listed, annotations — and the
    single command to open the plan, plus the HTML path from step 9. If the `review-plan`
    extension is active, the plan alone is enough to open in Hunk. If not, pass the derived
    sidecar with `--agent-context`.

    Fall back gracefully: if `hunk-plan` is not on PATH, write the sidecar JSON directly and hand
    the user a `--agent-context` command instead. Say that is what you did. There is no fallback
    for the writeup — without `hunk-plan render` there is no frame to put prose in, so say the
    writeup was skipped rather than hand-rolling an HTML document.

## Surface

    hunk-plan path       [--in-repo]
    hunk-plan write      [--in-repo]   < plan.json
    hunk-plan show
    hunk-plan sidecar    [--in-repo] [-o <path>]
    hunk-plan report-dir [--in-repo] [--init]
    hunk-plan render     [--in-repo] [-o <path>]
    hunk-plan clear      [--yes]
    hunk-plan gc         [--dry-run] [--yes] [--older-than <days>]

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
