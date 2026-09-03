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

This makes the response visible where the user is already looking, and it survives a reload. It
also survives the commented line itself being edited or removed by your own fix: Hunk re-anchors
a note to the nearest surviving hunk in that file rather than dropping it when the exact line is
gone, so add your reply at the note's original file/line as read from `comment list` — do not
skip a reply because the fix you are making will move or delete that line.

## Keep the HTML writeup in sync

hunk-review (if it ran first) leaves a companion HTML doc at the JSON plan's path with `.json`
swapped for `.html`:

    plan_path="$(hunk-plan path)"
    html_path="${plan_path%.json}.html"

If that file exists, update it as you handle notes — do not leave it stale. For every note you
act on (all four buckets: fixed, explained, held for discussion, declined), find its group's
section by id — `group-<slug>`, the group's title lowercased with spaces turned to hyphens, same
scheme hunk-review used to write it — and add one short entry there: file:line, what happened
(Fixed / Explained / Open question — needs your input / Declined, out of scope), one line. Map a
note's file to its group via the JSON plan (`hunk-plan show`).

If `html_path` does not exist, skip this — there is no writeup yet to update.

## Report back

Close with one summary grouped by outcome, not a list of notes in file order:

- Fixed — what changed, per note.
- Explained — the short version of each answer (the full answer already lives in the session).
- Open for you — the debatable ones, with the specific question each raises.
- Declined, out of scope — what was asked and why it was not done.

Leave the session loaded so the user can re-read it. They reload, or run with `--watch`. If the
HTML writeup was updated, say so and give its path.

## Surface

    hunk session comment list --repo . --type user --json
    hunk session comment add  --repo . --file <p> --new-line <n> --summary "..." --author agent
    hunk session navigate     --repo . --file <p> --hunk <n>
    hunk session context      --repo . --json
    hunk-plan show
    hunk-plan path

## Failure modes

- "No active Hunk sessions" while Hunk is visibly running. Report the observable and the likely
  causes rather than assuming one: the sandbox is blocking loopback, `XDG_RUNTIME_DIR` is not
  visible to it (the broker registration lives there — no network involved), `HUNK_MCP_DISABLE=1`
  is set, or `--repo` does not match a live session. Ask the user which applies; never set
  `HUNK_MCP_UNSAFE_ALLOW_REMOTE`, which would expose session control to the local network.
- `hunk: command not found` — Hunk is installed via mise (`aqua:modem-dev/hunk`). Say so rather
  than guessing at an install path.
