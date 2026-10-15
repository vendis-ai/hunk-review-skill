/**
 * The notes journal: every note the reviewer saves goes to disk the moment it
 * is saved, so quitting Hunk no longer loses it. Hunk itself keeps notes only
 * in the running window (modem-dev/hunk#113).
 *
 *   <stateDir>/hunk/review-plan/<repoDigest>.notes.jsonl
 *
 * Append-only, one JSON object per line:
 *
 *   {"v":1,"event":"created", at, planId, head, window, note:{id, source, file, side, line, hunkIndex, summary}}
 *   {"v":1,"event":"snapshot", at, planId, head, window, trigger, notes:[...]}
 *
 * Hunk 0.23 gives event handlers no review snapshot; only commands get one. So
 * a saved note is recorded from `note_created`, which carries its body, and the
 * full picture (agent replies, resolutions, deletions) from a snapshot whenever
 * one of this extension's commands runs and the notes have changed. There is
 * no delete event: a note missing from a later snapshot of the same window is
 * gone. `window` tells two Hunk windows on one repo apart, since each holds
 * only its own notes. `hunk-plan notes` reads the journal back.
 *
 * No hunk imports here, so this module is testable under plain `bun test`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { MarkerNote } from "./go";
import { repoDigest, stateDir } from "./plan";

export function journalPath(repoRoot: string, env: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), "hunk", "review-plan", `${repoDigest(repoRoot)}.notes.jsonl`);
}

/** A structural subset of hunk's `ExtensionReviewNote`, the `note_created` payload. */
export interface SavedNoteLike {
  id: string;
  filePath: string;
  hunkIndex: number;
  side: "old" | "new";
  line: number;
  body: string;
  draft: boolean;
}

export interface JournalContext {
  now: Date;
  /** The plan the window shows; `null` for a plan written before plan ids. */
  planId: string | null;
  head: string | null;
  /** `<pid>@<process start>`: which Hunk window wrote the line. */
  window: string;
}

export interface CreatedEntry {
  v: 1;
  event: "created";
  at: string;
  planId: string | null;
  head: string | null;
  window: string;
  note: {
    id: string;
    source: "user";
    file: string;
    side: "old" | "new";
    line: number;
    hunkIndex: number;
    summary: string;
  };
}

export type JournalNote = Omit<MarkerNote, "new">;

export interface SnapshotEntry {
  v: 1;
  event: "snapshot";
  at: string;
  planId: string | null;
  head: string | null;
  window: string;
  /** The command whose run took the snapshot, e.g. `sendToAgent` or `toggleViewed`. */
  trigger: string;
  notes: JournalNote[];
}

/**
 * The line for a note the reviewer saved, or `null` for a draft. The body is
 * stored as `summary`, the field a hand-off and a snapshot use for it too.
 */
export function createdEntry(note: SavedNoteLike, ctx: JournalContext): CreatedEntry | null {
  if (note.draft) return null;
  return {
    v: 1,
    event: "created",
    at: ctx.now.toISOString(),
    planId: ctx.planId,
    head: ctx.head,
    window: ctx.window,
    note: {
      id: note.id,
      source: "user",
      file: note.filePath,
      side: note.side,
      line: note.line,
      hunkIndex: note.hunkIndex,
      summary: note.body,
    },
  };
}

/** Drop the hand-off's per-window "new" flag; it means nothing in a journal. */
function journalNotes(notes: readonly MarkerNote[]): JournalNote[] {
  return notes.map(({ new: _new, ...rest }) => rest);
}

export function snapshotEntry(notes: readonly MarkerNote[], trigger: string, ctx: JournalContext): SnapshotEntry {
  return {
    v: 1,
    event: "snapshot",
    at: ctx.now.toISOString(),
    planId: ctx.planId,
    head: ctx.head,
    window: ctx.window,
    trigger,
    notes: journalNotes(notes),
  };
}

/**
 * What a snapshot says, independent of note order and the "new" flag, so an
 * unchanged review is not journaled again on every key press.
 */
export function snapshotKey(notes: readonly MarkerNote[]): string {
  const sorted = journalNotes(notes).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return JSON.stringify(sorted);
}

/** True when the file is missing, empty, or ends in a newline. */
function endsAtLineStart(filePath: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const { size } = fs.fstatSync(fd);
    if (size === 0) return true;
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, size - 1);
    return last[0] === 0x0a;
  } catch {
    return true;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * mkdir -p the parent and append one line. A line an earlier crash cut short
 * gets a newline first, so it costs only itself, never the entry after it.
 * Never throws; reports success via the return value.
 */
export function appendEntry(filePath: string, entry: CreatedEntry | SnapshotEntry): boolean {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const lead = endsAtLineStart(filePath) ? "" : "\n";
    fs.appendFileSync(filePath, `${lead}${JSON.stringify(entry)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}
