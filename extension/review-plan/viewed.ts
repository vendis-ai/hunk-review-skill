/**
 * Persistent mark-as-viewed tracking with automatic invalidation on change.
 *
 * A file is remembered as "viewed" against the sha256 digest of its patch
 * text at the moment it was marked. If the patch changes afterwards (new
 * commits, a rebase, `--watch` picking up an edit), the stored digest no
 * longer matches and the file reports "changed" instead of "viewed" --
 * that self-invalidation is the whole point: nothing here ever second-guesses
 * whether a file has really been reviewed again.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { repoDigest } from "./plan";

export function patchDigest(patch: string): string {
  return createHash("sha256").update(patch).digest("hex").slice(0, 16);
}

export interface ViewedState {
  version: 1;
  entries: Record<string, string>;
}

/**
 * What the window last showed, written next to the marks for a reader that
 * cannot recompute a patch digest (`hunk-plan list`). `files` are the files
 * the plan asks the reviewer to look at; `viewed` are those whose mark
 * matches their current patch, `changed` those whose patch moved on since.
 * Only the marks are read back: this is recomputed on every write.
 */
export interface ViewedShown {
  /** The plan the window showed; `null` for a plan written before plan ids, or none. */
  planId: string | null;
  at: string;
  files: string[];
  viewed: string[];
  changed: string[];
}

function emptyState(): ViewedState {
  return { version: 1, entries: {} };
}

/** `<stateDir>/hunk/review-plan/<repoDigest>.viewed.json`. */
export function viewedStatePath(repoRoot: string, env: NodeJS.ProcessEnv): string {
  const override = env.XDG_STATE_HOME;
  const stateDir = override && override.trim() !== "" ? override : path.join(homedir(), ".local", "state");
  return path.join(stateDir, "hunk", "review-plan", `${repoDigest(repoRoot)}.viewed.json`);
}

/** Missing or corrupt file -> empty state. Never throws. */
export function readViewed(filePath: string): ViewedState {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as Record<string, unknown>).version !== 1 ||
      typeof (parsed as Record<string, unknown>).entries !== "object" ||
      (parsed as Record<string, unknown>).entries === null ||
      Array.isArray((parsed as Record<string, unknown>).entries)
    ) {
      return emptyState();
    }
    const rawEntries = (parsed as { entries: Record<string, unknown> }).entries;
    const entries: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawEntries)) {
      if (typeof value === "string") entries[key] = value;
    }
    return { version: 1, entries };
  } catch {
    return emptyState();
  }
}

/**
 * mkdir -p the parent, write atomically (tmp file + rename), with what the
 * window showed when it is given. Never throws; reports success via the
 * return value.
 */
export function writeViewed(filePath: string, state: ViewedState, shown?: ViewedShown): boolean {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(shown ? { ...state, shown } : state), "utf8");
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch {
    return false;
  }
}

export type ViewedStatus = "unseen" | "viewed" | "changed";

/** Pure classification against the currently stored digests. */
export function classify(
  state: ViewedState,
  files: readonly { path: string; patch: string }[]
): Map<string, ViewedStatus> {
  const result = new Map<string, ViewedStatus>();
  for (const file of files) {
    const stored = state.entries[file.path];
    if (stored === undefined) {
      result.set(file.path, "unseen");
    } else if (stored === patchDigest(file.patch)) {
      result.set(file.path, "viewed");
    } else {
      result.set(file.path, "changed");
    }
  }
  return result;
}

/** What a window showing these files records next to the marks. Pure. */
export function shownOf(
  state: ViewedState,
  files: readonly { path: string; patch: string }[],
  planId: string | null,
  now: Date
): ViewedShown {
  const status = classify(state, files);
  const paths = [...new Set(files.map((file) => file.path))];
  return {
    planId,
    at: now.toISOString(),
    files: paths,
    viewed: paths.filter((p) => status.get(p) === "viewed"),
    changed: paths.filter((p) => status.get(p) === "changed"),
  };
}

/** Drop entries for paths no longer present. Pure -- returns a new object. */
export function prune(state: ViewedState, presentPaths: readonly string[]): ViewedState {
  const present = new Set(presentPaths);
  const entries: Record<string, string> = {};
  for (const [filePath, digest] of Object.entries(state.entries)) {
    if (present.has(filePath)) entries[filePath] = digest;
  }
  return { version: 1, entries };
}

/**
 * Pure toggle. Currently "viewed" -> remove the entry (back to unseen).
 * Otherwise (unseen or changed) -> mark viewed against the CURRENT digest,
 * so toggling a "changed" file re-marks it rather than clearing it.
 */
export function toggle(state: ViewedState, path: string, patch: string): ViewedState {
  const currentDigest = patchDigest(patch);
  const entries = { ...state.entries };
  if (entries[path] === currentDigest) {
    delete entries[path];
  } else {
    entries[path] = currentDigest;
  }
  return { version: 1, entries };
}
