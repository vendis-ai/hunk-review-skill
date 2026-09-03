# review-plan

Groups a hunk changeset by topic from an agent-written review plan, orders it
by importance, and tracks what you have reviewed -- with automatic
invalidation when a file changes after you marked it done.

> **Installing this?** Run `./install.sh` at the root of this repository; it
> points hunk at this directory by absolute path. Do not copy or symlink this
> extension somewhere else -- hunk's module rewriting matches on realpath, and
> through a symlink it fails silently rather than erroring. The root
> [`README.md`](../../README.md) explains why and what the failure looks like.

## What it does

An agent (or you) drops a small JSON file describing how the changeset should
be triaged: which files belong together, in what order, and why. This
extension reads that plan, reorders and groups the files pane accordingly,
optionally injects each file's plan note and hunk-level annotations as its
agent context, and remembers which files you have already reviewed --
against the exact patch content, so a file that changes after you reviewed
it automatically reverts to unseen instead of staying falsely checked off.

The same plan JSON is also the single source for hunk's own native
`--agent-context` sidecar format -- see [`hunk-plan sidecar`](#hunk-plan-sidecar)
below. One authored artifact drives both the extension's groups/order/notes
and hunk's inline hunk-level annotation UI, instead of hand-authoring the
sidecar separately and keeping the two in sync by hand.

This is aimed at the mixed-diff case: a real behavioral change (say, an auth
fix) buried inside a big mechanical rename. Without a plan, the rename's
sheer file count buries the change that actually needs scrutiny. With a
plan, the auth change is its own small, high-priority group at the top, and
the rename is a large, collapsed, low-priority group underneath it.

## Plan JSON schema

```ts
interface ReviewPlan {
  version: 1;
  generatedAt?: string; // ISO timestamp, informational only
  label?: string; // informational only
  summary?: string; // one-line thesis for the whole changeset
  groups: PlanGroup[];
}

interface PlanGroup {
  title: string; // required, non-empty
  summary?: string;
  importance?: number; // 0-100, default 50 -- LOWER IS MORE IMPORTANT
  collapsed?: boolean; // start this group collapsed in the pane
  hidden?: boolean; // see "hidden groups" below
  files: PlanFileEntry[];
}

interface PlanFileEntry {
  path: string; // required, non-empty, repo-root-relative
  importance?: number; // 0-100, default 50 -- LOWER IS MORE IMPORTANT
  note?: string; // shown as the file's agent summary, if inject_notes is on
  annotations?: PlanAnnotation[]; // hunk-level notes -- see "Annotations" below
}

interface PlanAnnotation {
  summary: string; // required, non-empty
  rationale?: string;
  oldRange?: [number, number]; // 1-based, inclusive, [start, end], start <= end
  newRange?: [number, number]; // 1-based, inclusive, [start, end], start <= end
  tags?: string[];
  confidence?: "low" | "medium" | "high";
}
```

**Importance is LOWER = MORE IMPORTANT** (think P0/P1/P2 triage, not a
percentage). A group or file at importance 0 sorts first; a file the plan
never mentions is dropped into a synthesized trailing "Unplanned" group at
importance 100.

## Annotations

**Annotations are for hunks that carry a decision, not for narrating every
hunk.** `{` and `}` navigate between annotated hunks -- that is the whole
point of the feature: it lets a reviewer skip straight to the lines an agent
actually made a call about. Annotate every hunk and there is nothing left to
jump between; you have turned a triage tool into wallpaper. A large
mechanical group (a rename, a lockfile bump, a generated-file regen) should
usually carry a `note` on its files, at most, and zero `annotations`.

A `PlanAnnotation` on a file entry is a hunk-level note, not a file-level
one -- give it `oldRange` and/or `newRange` (1-based, inclusive line spans on
the diff's old/new side) to anchor it to the hunk it is actually about. An
annotation with neither range is treated as file-scoped and always kept; an
annotation with a range that does not land inside any hunk of that file's
current patch is dropped rather than injected pointing at nothing --
`inject_notes` reports how many were dropped this way via a notification.
`rationale`, `tags`, and `confidence` are optional context alongside the
required `summary`; an invalid `confidence` (outside `low`/`medium`/`high`)
or a non-array `tags` is silently dropped rather than failing plan
validation, since both are cosmetic.

Every plan annotation that survives is injected with `"source":
"review-plan"` set, so it is visible in the UI as plan-authored rather than
sidecar-authored. If a file already carries real `--agent-context`
annotations, the plan's are appended after them -- never dropped, never
reordered ahead of the real ones.

### `hunk-plan sidecar`

The same annotations, plus file order, are also what drives hunk's own
native `--agent-context` sidecar format -- one plan, two consumers, instead
of hand-authoring the sidecar separately and keeping it in sync by hand.

```bash
hunk-plan sidecar              # resolved plan -> hunk's sidecar JSON, on stdout
hunk-plan sidecar --in-repo    # read <repoRoot>/.hunk/review-plan.json directly
hunk-plan sidecar -o sidecar.json
hunk sidecar.json --agent-context sidecar.json   # example: feed it back to hunk
```

File order in the sidecar follows the plan's own group/file order exactly
(the extension's importance-based sort is not re-applied by this command --
the plan file is already stored in the order the extension will apply). A
group marked `hidden: true` has no equivalent in hunk's sidecar format, so
its files are sunk to the very end of the file order instead of being
dropped; `hunk-plan sidecar` prints how many files were sunk that way to
stderr.

### Worked example

An auth fix landed alongside a mechanical rename of a large module. The plan
puts the real change first, small, expanded, and annotated; the rename last,
huge, collapsed, and carrying zero annotations -- there is nothing in a pure
rename worth interrupting `{`/`}` navigation for:

```json
{
  "version": 1,
  "label": "Session token rotation + billing/ -> payments/ rename",
  "summary": "Auth fix behind a large mechanical rename; only session.ts has a real behavior change.",
  "groups": [
    {
      "title": "Session token rotation fix",
      "summary": "Closes the race where a refreshed token could be used before the old one was revoked.",
      "importance": 0,
      "files": [
        {
          "path": "src/auth/session.ts",
          "importance": 0,
          "note": "The actual fix: revoke-then-issue instead of issue-then-revoke.",
          "annotations": [
            {
              "summary": "Revoke before issue, not after",
              "rationale": "Closes the window where a refreshed token and the old one were both valid.",
              "newRange": [40, 52],
              "confidence": "high",
              "tags": ["security"]
            }
          ]
        },
        {
          "path": "src/auth/session.test.ts",
          "importance": 5,
          "note": "New regression test for the race."
        }
      ]
    },
    {
      "title": "billing/ -> payments/ rename",
      "summary": "Pure rename, no behavior change. Skim for accidental edits.",
      "importance": 90,
      "collapsed": true,
      "files": [
        { "path": "src/payments/invoice.ts", "importance": 90 },
        { "path": "src/payments/invoice.test.ts", "importance": 90 },
        { "path": "src/payments/webhook.ts", "importance": 91 }
      ]
    }
  ]
}
```

A file present in the changeset but not mentioned in the plan still shows up
-- in a trailing "Unplanned" group -- rather than silently disappearing.

## Key bindings

| Key | Command | Effect |
| --- | --- | --- |
| `v` | Toggle file reviewed | Marks/unmarks the selected file as viewed, against its current patch content |
| `V` | Collapse/expand group | Toggles the collapse state of the group containing the selected file |
| `n` | Next group | Jumps to the first file of the next group |
| `p` | Previous group | Jumps to the first file of the previous group |
| *(unbound)* | Collapse fully reviewed groups | Reachable from the Extensions menu; collapses every group whose files are all marked viewed |

## Config (`[extension.review-plan]`)

```toml
[extension.review-plan]
hide_groups = false   # apply a plan group's `hidden: true` as real removal from the pane
inject_notes = true   # write each file's plan `note` into its agent summary
width = 38             # pane width in columns, clamped 22-80
placement = "left"     # "left" | "right"
```

`hidden` groups are always ordered like any other group; `hide_groups` (off
by default) is what actually removes their files from the pane and rolls
them into the hidden-file count shown in the header. A plan can mark, say, a
vendored or generated group `hidden: true` and leave `hide_groups` off by
default so a reviewer can still opt in with a config flip, rather than the
plan author unilaterally hiding files from every reviewer.

## Where the plan and viewed state live

The plan file is resolved in priority order, and **the first candidate that
exists wins outright** -- even if it fails to parse, so a typo'd plan is
reported rather than silently falling back to a stale one:

1. `$HUNK_REVIEW_PLAN`, if set (used verbatim, no path joining)
2. `<repo root>/.hunk/review-plan.json`
3. `${XDG_STATE_HOME:-~/.local/state}/hunk/review-plan/<repo-digest>.json`

where `<repo-digest>` is the first 16 hex characters of the sha256 of the
repo root's absolute path -- stable per-repo without leaking the path itself
into a filename.

Viewed-file state (which files you have marked reviewed, and against which
patch digest) lives alongside it, at
`${XDG_STATE_HOME:-~/.local/state}/hunk/review-plan/<repo-digest>.viewed.json`,
and is pruned automatically as files drop out of the changeset.
