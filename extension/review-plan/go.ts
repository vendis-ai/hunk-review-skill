/**
 * The review loop's hand-off: what "Send review to agent" and "Approve" leave
 * behind for `hunk-plan wait` to pick up.
 *
 * Everything goes through files, never through the session daemon. These
 * commands run inside the Hunk process, which still holds every note after a
 * reload has taken the session off the daemon (modem-dev/hunk#1138). So the
 * marker carries the notes themselves rather than ids an agent would have to
 * look up through a session that may be gone.
 *
 * Layout, next to the plan and its viewed state:
 *
 *   <stateDir>/hunk/review-plan/<repoDigest>.loop/go.json      the pending marker
 *   <stateDir>/hunk/review-plan/<repoDigest>.loop/window.json  the Hunk process that has the repo open
 *
 * `hunk-plan wait` consumes go.json (renaming it to last.json) and reads
 * window.json to tell "Hunk is not open yet" from "Hunk was closed".
 *
 * No hunk imports here, so this module is testable under plain `bun test`.
 * The snapshot types below are structural subsets of hunk's own
 * `ExtensionReviewSnapshot`, so the host's object passes straight in.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { repoDigest, stateDir } from "./plan";

export type GoMode = "explain" | "fix-clear" | "fix-all";
export type MarkerKind = "go" | "approve";

/** The choices "Send review to agent" offers, default first. */
export const MODE_CHOICES: readonly { mode: GoMode; label: string }[] = [
  { mode: "fix-clear", label: "Fix what's clear, ask about the rest" },
  { mode: "explain", label: "Explain only, change nothing" },
  { mode: "fix-all", label: "Fix everything" },
];

/** The mode a dialog answer stands for, or `null` for a cancelled dialog. */
export function modeFromLabel(label: string | null): GoMode | null {
  if (label === null) return null;
  return MODE_CHOICES.find((choice) => choice.label === label)?.mode ?? null;
}

export function loopDir(repoRoot: string, env: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), "hunk", "review-plan", `${repoDigest(repoRoot)}.loop`);
}

export function markerPath(repoRoot: string, env: NodeJS.ProcessEnv): string {
  return path.join(loopDir(repoRoot, env), "go.json");
}

export function windowPath(repoRoot: string, env: NodeJS.ProcessEnv): string {
  return path.join(loopDir(repoRoot, env), "window.json");
}

// ---------------------------------------------------------------------------
// Snapshot -> marker
// ---------------------------------------------------------------------------

type Range = readonly [number, number];

export interface SnapshotNoteLike {
  id: string;
  /** Hunk 0.23+ only: the note this one replies to. */
  parentId?: string;
  source: string;
  fileKey: string;
  anchor: {
    oldRange?: Range;
    newRange?: Range;
    preferred?: { side: "old" | "new"; line: number };
  };
  summary: string;
  rationale?: string;
  author?: string;
  createdAt?: string;
  resolution: string;
}

export interface SnapshotLike {
  files: readonly { fileKey: string; path: string }[];
  notes: readonly SnapshotNoteLike[];
}

export interface MarkerNote {
  id: string;
  parentId?: string;
  /** "user" for the reviewer's own notes; "agent" or "ai" for replies and annotations. */
  source: string;
  /** `null` when the note's file left the diff before its path was ever seen. */
  file: string | null;
  side: "old" | "new" | null;
  line: number | null;
  oldRange?: [number, number];
  newRange?: [number, number];
  summary: string;
  rationale?: string;
  author?: string;
  createdAt?: string;
  /** Hunk's verdict on the anchor: "active", "stale" (moved) or "orphaned". */
  resolution: string;
  /** A user note no earlier send from this window has delivered. */
  new: boolean;
}

export interface GoMarker {
  version: 1;
  kind: MarkerKind;
  mode: GoMode | null;
  instruction: string | null;
  repoRoot: string;
  head: string | null;
  createdAt: string;
  notes: MarkerNote[];
}

export interface BuildMarkerInput {
  kind: MarkerKind;
  mode: GoMode | null;
  instruction: string | null;
  repoRoot: string;
  head: string | null;
  now: Date;
  snapshot: SnapshotLike | null;
  /** fileKey -> path learned from earlier snapshots, for files that have since left the diff. */
  fileKeyPaths: ReadonlyMap<string, string>;
  /** note id -> path, from hunk's `note_created` events. */
  notePaths: ReadonlyMap<string, string>;
  /** User notes an earlier, already consumed send delivered. */
  sentIds: ReadonlySet<string>;
}

function copyRange(range: Range | undefined): [number, number] | undefined {
  return range ? [range[0], range[1]] : undefined;
}

/**
 * Where a note points, for an agent that will open the file: the anchor's own
 * preferred line, else the start of its new-side range, else its old side.
 */
function lineOf(anchor: SnapshotNoteLike["anchor"]): { side: "old" | "new" | null; line: number | null } {
  if (anchor.preferred) return { side: anchor.preferred.side, line: anchor.preferred.line };
  if (anchor.newRange) return { side: "new", line: anchor.newRange[0] };
  if (anchor.oldRange) return { side: "old", line: anchor.oldRange[0] };
  return { side: null, line: null };
}

export function buildMarker(input: BuildMarkerInput): GoMarker {
  const pathByKey = new Map(input.fileKeyPaths);
  for (const file of input.snapshot?.files ?? []) pathByKey.set(file.fileKey, file.path);

  const notes: MarkerNote[] = (input.snapshot?.notes ?? []).map((note) => {
    const out: MarkerNote = {
      id: note.id,
      source: note.source,
      file: pathByKey.get(note.fileKey) ?? input.notePaths.get(note.id) ?? null,
      ...lineOf(note.anchor),
      summary: note.summary,
      resolution: note.resolution,
      new: note.source === "user" && !input.sentIds.has(note.id),
    };
    if (note.parentId !== undefined) out.parentId = note.parentId;
    const oldRange = copyRange(note.anchor.oldRange);
    const newRange = copyRange(note.anchor.newRange);
    if (oldRange) out.oldRange = oldRange;
    if (newRange) out.newRange = newRange;
    if (note.rationale !== undefined) out.rationale = note.rationale;
    if (note.author !== undefined) out.author = note.author;
    if (note.createdAt !== undefined) out.createdAt = note.createdAt;
    return out;
  });

  const instruction = input.instruction?.trim() ?? "";
  return {
    version: 1,
    kind: input.kind,
    mode: input.kind === "go" ? input.mode : null,
    instruction: instruction === "" ? null : instruction,
    repoRoot: input.repoRoot,
    head: input.head,
    createdAt: input.now.toISOString(),
    notes,
  };
}

/** Merge a snapshot's fileKey -> path pairs into what is already known. Pure. */
export function rememberFileKeys(known: ReadonlyMap<string, string>, snapshot: SnapshotLike | null): Map<string, string> {
  const next = new Map(known);
  for (const file of snapshot?.files ?? []) next.set(file.fileKey, file.path);
  return next;
}

/** The new user notes a marker delivers. */
export function deliveredIds(marker: GoMarker): Set<string> {
  return new Set(marker.notes.filter((note) => note.new).map((note) => note.id));
}

/**
 * Settle which user notes count as already sent, just before a new send.
 *
 * A send is only delivered once `hunk-plan wait` has consumed its marker. If
 * the previous marker is still pending, the new one replaces it, so its notes
 * must stay "new" -- otherwise pressing Send twice before the agent looks would
 * hide the first batch from it. Pure; returns a new set.
 */
export function settleSent(
  sentIds: ReadonlySet<string>,
  pendingIds: ReadonlySet<string>,
  previousStillPending: boolean
): Set<string> {
  const next = new Set(sentIds);
  if (!previousStillPending) for (const id of pendingIds) next.add(id);
  return next;
}

// ---------------------------------------------------------------------------
// Window presence
// ---------------------------------------------------------------------------

export interface WindowPresence {
  version: 1;
  pid: number;
  startedAt: string;
  closedAt?: string;
}

export function windowOpened(pid: number, now: Date): WindowPresence {
  return { version: 1, pid, startedAt: now.toISOString() };
}

/**
 * Mark the window closed, but only if it is still ours: with two Hunk windows
 * on one repo, the first to quit must not report the other as closed.
 */
export function windowClosed(current: WindowPresence | null, pid: number, now: Date): WindowPresence | null {
  if (!current || current.pid !== pid) return null;
  return { ...current, closedAt: now.toISOString() };
}

/** Missing or corrupt file -> `null`. Never throws. */
export function readWindow(filePath: string): WindowPresence | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const raw = parsed as Record<string, unknown>;
    if (raw.version !== 1 || typeof raw.pid !== "number" || typeof raw.startedAt !== "string") return null;
    const out: WindowPresence = { version: 1, pid: raw.pid, startedAt: raw.startedAt };
    if (typeof raw.closedAt === "string") out.closedAt = raw.closedAt;
    return out;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

/** mkdir -p the parent, write atomically (tmp file + rename). Never throws; reports success via the return value. */
export function writeJsonAtomic(filePath: string, value: unknown): boolean {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch {
    return false;
  }
}

/** The commit HEAD points at, or `null` outside git or on any failure. */
export function readHead(repoRoot: string): string | null {
  try {
    const out = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
    return /^[0-9a-f]{40,64}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}
