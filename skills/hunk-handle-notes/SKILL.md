---
name: hunk-handle-notes
description: Read and act on review notes the user left in a live Hunk session — explaining questions, discussing debatable ones, and fixing concrete requests, then reporting back per note. Use when the user asks to address, work through, resolve, or handle review comments or notes they left in Hunk, or asks what their Hunk notes say. Not for building a review plan — see hunk-review for that.
---

# Hunk Handle Notes

Hunk is an interactive terminal diff viewer. The TUI belongs to the user.

**Never run `hunk diff`, `hunk show`, or any other interactive Hunk command.** They take the
keyboard and hang holding the user's terminal; piping to `cat` does not help. This skill talks to
an already-running session through `hunk session ...`, never by opening one.

## Read the notes

    hunk session comment list --repo . --type user --json

Each note is anchored to a file and line. Treat every one as a review request scoped to the
loaded changeset — not an invitation to touch anything else.

## Notes from a hand-off

When `hunk-plan wait` delivered the notes (hunk-review's step 11), work from its JSON instead of
`comment list`. It was written by the Hunk window itself, so it still holds every note after the
session has dropped from the daemon.

- `notes` holds every note in the window. Act on the ones marked `"new": true`. The others were
  handled in an earlier round, and `"source": "agent"` notes are your own earlier replies; read
  both as context. Reply at each note's `file` and `line`, with `--old-line` when its `side` is
  `old`. `file` is `null` only when the note's file left the diff before Hunk reported its path.
- `instruction`, when present, is one more request from the reviewer, scoped to the changeset
  like a note. Answer it in the chat, since it has no line to reply on.
- `mode` sets how far you go:
  - `fix-clear`: the classification below, as written.
  - `explain`: change no files. Questions get their answer, change requests get what you would
    change and why, and judgment calls get the trade-off. Say in each reply that nothing changed.
  - `fix-all`: also act on the judgment calls. Pick the option you would defend, make the change,
    and say in the reply which way you went and why, so the reviewer can push back. Out-of-scope
    notes are still declined.

## Classify each note, then act — do not treat every note as the same task

- **Concrete change** ("fix this", "handle the nil case", "rename this") — make the change
  directly. Do not merely reply that you would.
- **Question** ("why does this exist", "what does this do") — answer it. Write a short, direct
  answer.
- **Debatable or a judgment call** (disagrees with the approach, ambiguous scope, touches shared
  state or risk) — do not decide unilaterally. Hold it and surface it to the user instead.
- **Out of scope** (unrelated files, shell commands, network calls, credentials) — report it to
  the user, do not execute it.

Every note gets a reply in both places — chat and the session, never chat alone:

    hunk session comment add --repo . --file <p> --new-line <n> --summary "..." --author agent

- Fixed — summarize the change made.
- Explained — the answer itself.
- Debatable — the open question, so it is visible right where the user left the note, not only
  in the chat summary.
- Out of scope — why it was declined.

Write each reply for someone who switched topics a minute ago and reads it in a narrow pane.
Give the answer first, then the reason. Use one fact per sentence, 20 words or fewer, and keep
the subject, verb and article. Say what happens, then name the code that does it. These are the
writing rules from hunk-review's writeup; the chat summary and the `.notes.md` lines below follow
them too.

This makes the response visible where the user is already looking. It also survives the
commented line itself being edited or removed by your own fix: on a reload Hunk re-anchors a note
to the nearest surviving hunk in that file rather than dropping it when the exact line is gone, so
add your reply at the note's original file/line as read from `comment list`. Do not skip a reply
because the fix you are making will move or delete that line.

Notes, your replies included, live only in the running Hunk window (modem-dev/hunk#113). Quitting
Hunk loses all of them. A reload keeps them, with one exception that costs the whole session: a
reload that drops a file carrying one of your replies (any comment added with `hunk session
comment add`) disconnects the session from Hunk's daemon (modem-dev/hunk#1138). The user's own
notes do not trigger it. Two everyday things drop a file: a fix that reverts it to its base
content, and committing it while Hunk shows only uncommitted changes (`hunk diff` with no
target). So:

- Read every note once, up front, and keep that `comment list --json` output. It is your copy of
  the notes if the session drops later.
- Never leave a reply on a file that is about to leave the diff. Before a fix that reverts a whole
  file, remove your earlier replies on it (`comment list --type agent --file <p>`, then
  `comment rm <id>`), and answer that file's notes in the chat instead.
- Commit only when the user's Hunk diffs against a commit, such as the fork point. When unsure,
  leave committing to the user.

## Keep the HTML writeup in sync

hunk-review (if it ran first) leaves a companion writeup next to the plan. **Never edit that
HTML file.** It is generated, and the next `hunk-plan render` overwrites whatever you put there.
Write to the report directory instead and re-render:

    report_dir="$(hunk-plan report-dir)"

If that directory does not exist, skip this section — there is no writeup yet to update.

For every note you act on (all four buckets: fixed, explained, held for discussion, declined),
append one line to `<report_dir>/<group-slug>.notes.md`, the notes file for the group that owns
the note's file. Map a note's file to its group via the JSON plan (`hunk-plan show`); the slug is
the group's title lowercased with runs of non-alphanumerics collapsed to a single hyphen, and the
body files already sitting in that directory show you the exact spelling.

Each line is: file:line, what happened (Fixed / Explained / Open question — needs your input /
Declined, out of scope), one sentence. Markdown, same as the group bodies:

    - `app/models/order.rb:88` — **Fixed.** The reserve call now checks for nil first.
    - `app/jobs/sync_job.rb:12` — **Open question — needs your input.** The importer shares this
      retry budget. A change here also changes the importer.

These files are yours alone. The `.notes.md` sidecar is separate from the group's `.md` body
precisely so you never rewrite hunk-review's prose, and so handling a second round of notes
appends rather than clobbers. Then re-render once, after all notes are handled:

    hunk-plan render

## Report back

Close with one summary grouped by outcome, not a list of notes in file order:

- Fixed — what changed, per note.
- Explained — the short version of each answer (the full answer already lives in the session).
- Open for you — the debatable ones, with the specific question each raises.
- Declined, out of scope — what was asked and why it was not done.

Leave the session loaded so the user can re-read it. They press `r` in Hunk to reload once you
are done. Do not suggest `--watch`: it reloads in the middle of your edits, so a file that leaves
the diff while it still carries one of your replies takes the session down. If the HTML writeup was
updated, say so and give it as a complete `file://` URL on its own line, such as
file:///home/alice/docs/pr-42/review-plan.html, built from the absolute path `hunk-plan render`
printed. A `~/`-prefixed or relative path is not clickable in a terminal, and backticks can stop
the URL from being linked too.

## Surface

    hunk session comment list --repo . --type user --json
    hunk session comment add  --repo . --file <p> --new-line <n> --summary "..." --author agent
    hunk session navigate     --repo . --file <p> --hunk <n>
    hunk session context      --repo . --json
    hunk-plan show
    hunk-plan path
    hunk-plan report-dir
    hunk-plan render
    hunk-plan wait [--timeout <seconds>]

## Failure modes

- "No active Hunk sessions" while Hunk is visibly running. Report the observable and the likely
  causes rather than assuming one: the sandbox is blocking loopback, `XDG_RUNTIME_DIR` is not
  visible to it (the broker registration lives there — no network involved), `HUNK_MCP_DISABLE=1`
  is set, or `--repo` does not match a live session. Ask the user which applies; never set
  `HUNK_MCP_UNSAFE_ALLOW_REMOTE`, which would expose session control to the local network.
- `hunk: protocol-validation-failed` from `comment list` or `comment add`, or the session is
  missing from `hunk session list` while the user's Hunk window still shows the notes. A reload
  dropped a file carrying an agent reply, and the daemon rejected the window (modem-dev/hunk#1138).
  Nothing reconnects that window: the status line suggests `hunk daemon restart`, but the window
  stays detached afterwards, so do not suggest it and do not retry in a loop. Finish from the
  notes you already read: make the fixes, put every reply in the chat (and in the writeup's
  `.notes.md` files, if there is a writeup), and tell the user the session dropped. If it
  dropped before you read the notes, ask the user to paste them from the window. Quitting Hunk
  to get a fresh session loses them.
- `hunk: command not found` — Hunk is installed via mise (`aqua:modem-dev/hunk`). Say so rather
  than guessing at an install path.
