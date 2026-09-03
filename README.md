# hunk-review-skill

Turn a large diff or PR into a **grouped, prioritised review plan** you open before reading any
code — plus a skimmable HTML writeup of what the branch actually does.

Two agent skills, a CLI, and a [Hunk](https://github.com/modem-dev/hunk) extension. An agent reads
the changeset, decides what matters, and writes a plan; Hunk then presents the diff in that order,
grouped by topic, with a handful of annotations on the hunks that carry a real decision.

The point is what it *doesn't* show you. A branch with a genuine auth fix buried inside a
2,000-file rename reads as 2,000 files. With a plan it reads as "security boundary, 4 files" —
and everything else sinks.

## What's in here

| Path | What it is |
|---|---|
| `skills/hunk-review/` | Builds the plan and the HTML writeup. The main event. |
| `skills/hunk-handle-notes/` | Reads and acts on review notes you left in a live Hunk session. |
| `bin/hunk-plan` | CLI to write, read, convert, and clear the plan file. |
| `extension/review-plan/` | The Hunk extension that renders the plan as grouped, ordered review. |

## Requirements

- [Hunk](https://github.com/modem-dev/hunk) — `mise use -g aqua:modem-dev/hunk`
- An agent that reads `~/.agents/skills/` or `~/.claude/skills/` (Claude Code, Codex, OpenCode,
  Cursor, and most others)
- `~/.local/bin` on your `PATH`

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
| `review-plan` | *nowhere* — see below | Hunk is pointed at the checkout by absolute path. |

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

Re-run `install.sh` as well whenever a release **adds a skill**. Nothing links a new one on its
own, and the failure is silent: it just never shows up. The installer is idempotent and prints
`(already linked)` for everything unchanged, so running both every time is the safe habit.

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

Then open Hunk on the same range the plan was built from. On a feature branch that's the base
branch, three dots, `HEAD`:

```sh
hunk diff origin/dev...HEAD      # or origin/main — whatever you forked from
```

Three dots, not two. `..` also drags in everything that landed on the base branch since you forked,
which can multiply the diff several times over and fills the pane with files the plan says nothing
about.

`}` and `{` jump between annotated hunks; `v` marks a file reviewed.

Left notes in Hunk and want them acted on?

> work through my hunk notes

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

The extension's dev dependencies are not installed by `install.sh` — Hunk injects its own React and
OpenTUI at load time, so the runtime doesn't need them, and they're ~450 MB.

```sh
cd extension/review-plan
bun install
bun test
bun run typecheck
```

`extension/review-plan/README.md` documents the plan JSON schema, the annotation model, key
bindings, and where plan and viewed state live on disk.

## License

MIT
