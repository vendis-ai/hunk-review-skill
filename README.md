# hunk-review-skill

Turn a large diff or PR into a **grouped, prioritised review plan** you open before reading any
code — plus a skimmable HTML writeup of what the branch actually does.

Two agent skills, a CLI, and two [Hunk](https://github.com/modem-dev/hunk) extensions. An agent
reads the changeset, decides what matters, and writes a plan; Hunk then presents the diff in that
order, grouped by topic, with a handful of annotations on the hunks that carry a real decision.

The point is what it *doesn't* show you. A branch with a genuine auth fix buried inside a
2,000-file rename reads as 2,000 files. With a plan it reads as "security boundary, 4 files" —
and everything else sinks.

## What's in here

| Path | What it is |
|---|---|
| `skills/hunk-review/` | Builds the plan and the HTML writeup. The main event. |
| `skills/hunk-handle-notes/` | Reads and acts on review notes you left in a live Hunk session. |
| `bin/hunk-plan` | CLI to write, read, convert, render, and clean up the plan file. |
| `assets/` | The writeup's frame — CSS, runtime JS, and vendored `marked` and `mermaid`. |
| `extension/review-plan/` | The Hunk extension that renders the plan as grouped, ordered review. |
| `extension/copy-path/` | A Hunk extension that copies the selected file's path, or an `@path#Lx` reference. |
| `test/render_test.sh` | Smoke test for the renderer and the state-directory cleanup. |

## Requirements

- [Hunk](https://github.com/modem-dev/hunk) — `mise use -g aqua:modem-dev/hunk`
- `git`, `bash` and `jq` — `hunk-plan` validates, converts and renders with them
- An agent that reads `~/.agents/skills/` or `~/.claude/skills/` (Claude Code, Codex, OpenCode,
  Cursor, and most others)
- `~/.local/bin` on your `PATH`

Nothing else. The writeup is built by the same `bash`/`jq` the plan already needs, and its
Markdown and diagram rendering come from the two libraries vendored in `assets/` — so the page
opens over `file://` and never makes a network call.

## Install

```sh
git clone https://github.com/vendis-ai/hunk-review-skill.git
cd hunk-review-skill
./install.sh          # --dry-run to see what it would do first
```

Everything is symlinked back into the checkout, so updating is mostly just `git pull` — see
[Updating](#updating).

The installer never clobbers a real file, and it refuses to run if a destination directory is
itself a symlink back into this repo. Re-running it is safe.

### What it installs, and where

| What | Where | Why there |
|---|---|---|
| Both skills | `~/.agents/skills/<name>` | The cross-agent location. Codex, OpenCode, Cursor, Cline, Warp, Zed, Gemini CLI and Copilot read it directly — no per-agent setup. |
| Both skills | `~/.claude/skills/<name>` | Claude Code is the one common harness that reads only its own directory. |
| `hunk-plan` | `~/.local/bin/hunk-plan` | The skill invokes it as a bare command, so it has to be on your real PATH. |
| Both extensions | *nowhere* — see below | Hunk is pointed at the checkout by absolute path. |

If you already have an `[extensions]` section in `~/.config/hunk/config.toml`, the installer
**will not edit it**. It prints the exact line to add instead. TOML forbids a second `[extensions]`
table, and a shell script rewriting an existing `paths` array is precisely how the silent failure
below gets introduced.

## Updating

```sh
cd hunk-review-skill && git pull && ./install.sh
```

`git pull` on its own covers the common case. The skills, `hunk-plan` and the extension are all
read straight out of this checkout, so changed content is live the next time you start an agent or
launch Hunk — nothing to reinstall.

Re-run `install.sh` as well whenever a release **adds a skill or an extension**. Nothing links a
new skill on its own, and nothing adds a new extension to Hunk's `paths`; both failures are silent,
the thing just never shows up. The installer is idempotent and prints `(already linked)` for
everything unchanged, so running both every time is the safe habit.

⚠ **Don't move or rename the checkout.** The installed symlinks and the absolute path in
`~/.config/hunk/config.toml` both point here. If you do move it, re-run `install.sh` from the new
location *and* fix that `paths` entry by hand, since the installer won't touch an existing
`[extensions]` section. Hunk says nothing when that path is wrong; you just get a flat file list,
the failure described in [the one thing to know](#the-one-thing-to-know-if-it-looks-broken).

## Usage

Ask your agent for a review plan on the current branch:

> build me a hunk review plan for this branch

It reports the changeset size, groups the files by topic, orders the groups by what you're most
likely to get wrong, annotates only the hunks that carry a decision, and hands you back two things:
a command to open the plan in Hunk, and a path to the HTML writeup.

The writeup is a self-contained local file: a verdict badge per group, a few bullets each, a
collapsed `why` for the reasoning, a Mermaid diagram where the substance is a sequence or a race,
and a table of contents. `Skim`-tier groups start collapsed, so the page opens showing only what
needs a decision.

Any ADR, RFC or runbook the branch leans on becomes **its own page inside that same file**,
converted from the working-tree copy and reachable from a nav bar across the top. Follow a
citation to read the decision it rests on, hit Back, and you're at the group you left. GitHub
`#123` references become links on their own, and every off-machine link opens in a new tab.

The agent writes only prose. The frame, nav, table of contents, section ids, badges and link
rules are all produced by `hunk-plan render` from the plan itself, so the page can't disagree with
what Hunk shows you — and the agent can't quietly reinvent the layout on its next run.

Then open Hunk on the same range the plan was built from. On a feature branch that's the base
branch, three dots, `HEAD`:

```sh
hunk diff origin/dev...HEAD      # or origin/main — whatever you forked from
```

Three dots, not two. `..` also drags in everything that landed on the base branch since you forked,
which can multiply the diff several times over and fills the pane with files the plan says nothing
about.

`}` and `{` jump between annotated hunks; `v` marks a file reviewed. `y` copies the selected file's
path, `Y` picks between the other spellings of it, and `ctrl+y` copies an `@path#L42` reference to
paste back into an agent — see [`extension/copy-path/`](extension/copy-path/README.md).

Left notes in Hunk and want them acted on?

> work through my hunk notes

## Where the files go, and how they leave

Plans live outside your repos, in `${XDG_STATE_HOME:-~/.local/state}/hunk/review-plan/`, keyed by
a hash of the repo path. Each review leaves a `<digest>.json` plan, a `<digest>.report/` directory
of the agent's prose, and the rendered `<digest>.html`, plus a shared copy of the two vendored
libraries.

```sh
hunk-plan clear              # this repo's plan, report and rendered page
hunk-plan gc --dry-run       # everything collectable, machine-wide
hunk-plan gc                 # ...and remove it
```

`gc` collects three things: artifacts whose plan file is gone, plans whose **repo** is gone, and
plans older than 30 days (`--older-than <days>`). That second one needs a name, not a hash — so
`write` keeps a `repos.json` mapping each digest back to its repo root. Without it nothing could
ever tell whether `0e8a342967784894.viewed.json` still belonged to anything, which is exactly how
these directories used to silently accumulate. Neither command ever deletes as a side effect of a
write; a crowded directory only earns a one-line hint.

## The one thing to know if it looks broken

**A flat, ungrouped file list means the extension didn't load.** Hunk does not tell you this. It
quarantines a failed pane and silently restores the built-in files pane, while the extension's
non-React half keeps working — so the plan file is written, the notes are injected, `v` still
marks files viewed, and it all looks healthy.

The cause is almost always the extension being reached **through a symlink**. Hunk serves `react`,
`@opentui/*` and `hunkdiff/extension` to an extension via a Bun `onLoad` plugin whose filter is
anchored at `dirname(entryPath)` — but Bun matches it against the file's **realpath**. Through a
symlink the two differ, the hook never fires, and the imports resolve as ordinary npm ones.

So: `[extensions] paths` must be an absolute path to the real checkout, with no symlinked
component. That is why `install.sh` points Hunk here instead of copying or linking the extension
anywhere.

Hunk 0.21.0 fixes this upstream (it registers both the literal directory and its canonical path).
Pointing at the real path works on every version, so the installer does that unconditionally.

## Contributing

Neither extension's dev dependencies are installed by `install.sh`. Hunk injects its own React and
OpenTUI at load time, so the runtime never needs them — and for `review-plan` they're ~450 MB.

```sh
cd extension/review-plan   # or extension/copy-path
bun install
bun test
bun run typecheck
```

The CLI and the renderer have no such dependency — their tests are plain bash against a throwaway
repo and a throwaway `XDG_STATE_HOME`, so they never touch your real plan directory:

```sh
test/render_test.sh                          # frame, ordering, slugs, gc, clear
CHROME=google-chrome-stable test/render_test.sh   # ...plus the DOM behaviour
```

The `CHROME` pass is the one that matters when touching `assets/report.js`: it asserts that
Markdown converts, that a `#123` inside a code fence is *not* linkified, that external links get
`target="_blank"`, that a `<script>` in a converted doc is stripped, and that hash routing swaps
panes.

`extension/review-plan/README.md` documents the plan JSON schema, the annotation model, key
bindings, and where plan and viewed state live on disk.
`extension/copy-path/README.md` documents its three commands, the path forms it offers, and how it
reaches the clipboard over SSH.

## License

MIT
