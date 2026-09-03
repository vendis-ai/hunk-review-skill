/**
 * Pure plan-loading and ordering logic for the review-plan extension.
 *
 * No hunk imports here (only type-only ones would be safe anyway) so this
 * module is testable under plain `bun test` with nothing beyond node
 * builtins.
 *
 * Importance convention: LOWER importance number = MORE important. A group
 * or file with importance 0 sorts first; importance 100 sorts last. This
 * matches "P0/P1/P2" style triage numbering, which is why the synthesized
 * "Unplanned" group and the no-plan fallback both use 100 (default/last)
 * rather than 0.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * One agent-authored note anchored to a file, optionally scoped to a line
 * range. Deliberately a near-mirror of hunk's own `AgentAnnotation` sidecar
 * shape (see `index.tsx`'s mapping to `AgentFileContext`) so a plan
 * annotation survives the round trip into hunk's native `--agent-context`
 * format without lossy translation. `id`/`author`/`createdAt`/`source` are
 * left out of the plan-authored shape on purpose -- those are provenance
 * hunk's sidecar format tracks, not something a review plan should author;
 * `source: "review-plan"` is stamped on at the point of injection instead.
 */
export interface PlanAnnotation {
  summary: string; // required, non-empty
  rationale?: string;
  oldRange?: [number, number]; // 1-based, inclusive, [start, end], start <= end
  newRange?: [number, number]; // 1-based, inclusive, [start, end], start <= end
  tags?: string[];
  confidence?: "low" | "medium" | "high";
}

export interface PlanFileEntry {
  path: string;
  importance?: number;
  note?: string;
  annotations?: PlanAnnotation[];
}

export interface PlanGroup {
  title: string;
  summary?: string;
  importance?: number;
  collapsed?: boolean;
  hidden?: boolean;
  files: PlanFileEntry[];
}

export interface ReviewPlan {
  version: 1;
  generatedAt?: string;
  label?: string;
  summary?: string; // one-line thesis for the whole changeset
  groups: PlanGroup[];
}

const DEFAULT_IMPORTANCE = 50;
const UNPLANNED_IMPORTANCE = 100;

function clampImportance(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_IMPORTANCE;
  return Math.min(100, Math.max(0, value));
}

const CONFIDENCE_VALUES = new Set(["low", "medium", "high"]);

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/** A valid `[start, end]` pair: 1-based, inclusive, positive integers, start <= end. */
function isValidRange(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    isPositiveInteger(value[0]) &&
    isPositiveInteger(value[1]) &&
    value[0] <= value[1]
  );
}

/**
 * Validate one raw annotation. Strict on structure (returns an error string
 * naming the file path and annotation index), forgiving on `confidence` and
 * `tags` -- both are cosmetic, so an invalid value is dropped rather than
 * failing the whole plan.
 */
function validateAnnotation(
  rawAnn: unknown,
  annIndex: number,
  filePath: string,
  groupTitle: string
): { ok: true; annotation: PlanAnnotation } | { ok: false; error: string } {
  const where = `annotation ${annIndex} on file "${filePath}" in group "${groupTitle}"`;
  if (typeof rawAnn !== "object" || rawAnn === null || Array.isArray(rawAnn)) {
    return { ok: false, error: `${where} must be an object` };
  }
  const a = rawAnn as Record<string, unknown>;
  if (typeof a.summary !== "string" || a.summary.trim() === "") {
    return { ok: false, error: `${where} is missing a non-empty "summary"` };
  }

  const annotation: PlanAnnotation = { summary: a.summary };
  if (typeof a.rationale === "string") annotation.rationale = a.rationale;

  if (a.oldRange !== undefined) {
    if (!isValidRange(a.oldRange)) {
      return {
        ok: false,
        error: `${where} has an invalid "oldRange" (must be [start, end], 1-based positive integers, start <= end)`,
      };
    }
    annotation.oldRange = a.oldRange;
  }
  if (a.newRange !== undefined) {
    if (!isValidRange(a.newRange)) {
      return {
        ok: false,
        error: `${where} has an invalid "newRange" (must be [start, end], 1-based positive integers, start <= end)`,
      };
    }
    annotation.newRange = a.newRange;
  }

  if (Array.isArray(a.tags)) {
    const tags = a.tags.filter((t): t is string => typeof t === "string");
    if (tags.length > 0) annotation.tags = tags;
  }
  if (typeof a.confidence === "string" && CONFIDENCE_VALUES.has(a.confidence)) {
    annotation.confidence = a.confidence as "low" | "medium" | "high";
  }

  return { ok: true, annotation };
}

/**
 * Result of `validatePlan`. Extended beyond the minimal ok/error shape with
 * `droppedDuplicates` on the success branch: the spec requires the
 * deduplication count to reach `loadPlan`'s result rather than being
 * silently discarded, and validation is where dedup happens.
 */
export type ValidatePlanResult =
  | { ok: true; plan: ReviewPlan; droppedDuplicates: number }
  | { ok: false; error: string };

/**
 * Validate and normalize a parsed-JSON value into a `ReviewPlan`.
 *
 * Strict about structure (rejects with a descriptive error), forgiving about
 * extra keys and about importance values (coerced/clamped rather than
 * rejected). A path appearing more than once across the whole plan (within
 * or across groups) keeps its first occurrence and drops the rest.
 */
export function validatePlan(input: unknown): ValidatePlanResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "plan must be a JSON object" };
  }
  const raw = input as Record<string, unknown>;

  if (raw.version !== 1) {
    return { ok: false, error: `plan "version" must be 1, got ${JSON.stringify(raw.version)}` };
  }
  if (!Array.isArray(raw.groups)) {
    return { ok: false, error: '"groups" must be an array' };
  }

  const seenPaths = new Set<string>();
  let droppedDuplicates = 0;
  const groups: PlanGroup[] = [];

  for (let groupIndex = 0; groupIndex < raw.groups.length; groupIndex++) {
    const rawGroup = raw.groups[groupIndex];
    if (typeof rawGroup !== "object" || rawGroup === null || Array.isArray(rawGroup)) {
      return { ok: false, error: `group ${groupIndex} must be an object` };
    }
    const g = rawGroup as Record<string, unknown>;
    if (typeof g.title !== "string" || g.title.trim() === "") {
      return { ok: false, error: `group ${groupIndex} is missing a non-empty "title"` };
    }
    if (!Array.isArray(g.files)) {
      return { ok: false, error: `group "${g.title}" is missing a "files" array` };
    }

    const files: PlanFileEntry[] = [];
    for (let fileIndex = 0; fileIndex < g.files.length; fileIndex++) {
      const rawFile = g.files[fileIndex];
      if (typeof rawFile !== "object" || rawFile === null || Array.isArray(rawFile)) {
        return { ok: false, error: `file ${fileIndex} in group "${g.title}" must be an object` };
      }
      const f = rawFile as Record<string, unknown>;
      if (typeof f.path !== "string" || f.path.trim() === "") {
        return {
          ok: false,
          error: `file ${fileIndex} in group "${g.title}" is missing a non-empty "path"`,
        };
      }
      if (seenPaths.has(f.path)) {
        droppedDuplicates += 1;
        continue;
      }
      seenPaths.add(f.path);

      const entry: PlanFileEntry = { path: f.path, importance: clampImportance(f.importance) };
      if (typeof f.note === "string") entry.note = f.note;

      if (Array.isArray(f.annotations)) {
        const annotations: PlanAnnotation[] = [];
        for (let annIndex = 0; annIndex < f.annotations.length; annIndex++) {
          const result = validateAnnotation(f.annotations[annIndex], annIndex, f.path, g.title);
          if (!result.ok) return { ok: false, error: result.error };
          annotations.push(result.annotation);
        }
        if (annotations.length > 0) entry.annotations = annotations;
      }
      // f.annotations present but not an array: forgiven like `tags` on an
      // individual annotation -- dropped silently rather than failing the file.

      files.push(entry);
    }

    const group: PlanGroup = {
      title: g.title,
      importance: clampImportance(g.importance),
      files,
    };
    if (typeof g.summary === "string") group.summary = g.summary;
    if (typeof g.collapsed === "boolean") group.collapsed = g.collapsed;
    if (typeof g.hidden === "boolean") group.hidden = g.hidden;
    groups.push(group);
  }

  const plan: ReviewPlan = { version: 1, groups };
  if (typeof raw.generatedAt === "string") plan.generatedAt = raw.generatedAt;
  if (typeof raw.label === "string") plan.label = raw.label;
  if (typeof raw.summary === "string") plan.summary = raw.summary;

  return { ok: true, plan, droppedDuplicates };
}

/** Walk up from `startDir` looking for a `.git` entry (file or directory, so worktrees work). */
export function findRepoRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** First 16 hex characters of the sha256 of the absolute repo root path. */
export function repoDigest(repoRoot: string): string {
  return createHash("sha256").update(path.resolve(repoRoot)).digest("hex").slice(0, 16);
}

function stateDir(env: NodeJS.ProcessEnv): string {
  const override = env.XDG_STATE_HOME;
  if (override && override.trim() !== "") return override;
  return path.join(os.homedir(), ".local", "state");
}

/** Candidate plan file paths, in priority order. */
export function planCandidatePaths(repoRoot: string, env: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = [];
  const override = env.HUNK_REVIEW_PLAN;
  if (override && override.trim() !== "") {
    candidates.push(override);
  }
  candidates.push(path.join(repoRoot, ".hunk", "review-plan.json"));
  candidates.push(path.join(stateDir(env), "hunk", "review-plan", `${repoDigest(repoRoot)}.json`));
  return candidates;
}

export interface LoadPlanResult {
  plan: ReviewPlan | null;
  source: string | null;
  error: string | null;
  droppedDuplicates: number;
}

/**
 * Try each candidate path in priority order. The first one that *exists*
 * wins outright, even if it fails to parse or validate -- we never silently
 * fall through to a lower-priority candidate after finding one, so a typo'd
 * plan is reported rather than quietly ignored in favor of a stale fallback.
 */
export function loadPlan(repoRoot: string, env: NodeJS.ProcessEnv): LoadPlanResult {
  const candidates = planCandidatePaths(repoRoot, env);

  for (const candidate of candidates) {
    let raw: string;
    try {
      raw = fs.readFileSync(candidate, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      return {
        plan: null,
        source: candidate,
        error: `${candidate}: could not read file (${err instanceof Error ? err.message : String(err)})`,
        droppedDuplicates: 0,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return {
        plan: null,
        source: candidate,
        error: `${candidate}: invalid JSON (${err instanceof Error ? err.message : String(err)})`,
        droppedDuplicates: 0,
      };
    }

    const result = validatePlan(parsed);
    if (!result.ok) {
      return { plan: null, source: candidate, error: `${candidate}: ${result.error}`, droppedDuplicates: 0 };
    }
    return { plan: result.plan, source: candidate, error: null, droppedDuplicates: result.droppedDuplicates };
  }

  return { plan: null, source: null, error: null, droppedDuplicates: 0 };
}

export interface OrderedGroup<T> {
  title: string;
  summary?: string;
  importance: number;
  collapsed: boolean;
  hidden: boolean;
  files: Array<{ file: T; note?: string; annotations?: PlanAnnotation[]; importance: number }>;
}

export interface OrderedResult<T> {
  groups: OrderedGroup<T>[];
  visibleFiles: T[];
  hiddenCount: number;
  unplannedCount: number;
}

/**
 * Order a changeset's files by plan group/file importance (lower = more
 * important, ties broken by plan order). Files present in the changeset but
 * absent from the plan land in a trailing synthesized "Unplanned" group in
 * their original changeset order. Plan entries whose path is not in the
 * changeset are dropped as stale, and a group that ends up with zero files
 * as a result is dropped entirely rather than emitted empty.
 */
export function orderChangeset<T extends { path: string }>(
  files: readonly T[],
  plan: ReviewPlan | null,
  opts: { hideGroups: boolean }
): OrderedResult<T> {
  if (plan === null) {
    const allFiles = files.map((file) => ({ file, importance: DEFAULT_IMPORTANCE }));
    return {
      groups:
        allFiles.length > 0
          ? [{ title: "All files", importance: 0, collapsed: false, hidden: false, files: allFiles }]
          : [],
      visibleFiles: [...files],
      hiddenCount: 0,
      unplannedCount: 0,
    };
  }

  const byPath = new Map<string, T>();
  for (const file of files) byPath.set(file.path, file);

  const planned = new Set<string>();
  const candidateGroups: OrderedGroup<T>[] = [];

  for (const group of plan.groups) {
    const matched: Array<{
      file: T;
      note?: string;
      annotations?: PlanAnnotation[];
      importance: number;
      order: number;
    }> = [];
    group.files.forEach((entry, order) => {
      const file = byPath.get(entry.path);
      if (!file) return; // stale plan entry: not in this changeset
      planned.add(entry.path);
      matched.push({
        file,
        note: entry.note,
        annotations: entry.annotations,
        importance: entry.importance ?? DEFAULT_IMPORTANCE,
        order,
      });
    });
    if (matched.length === 0) continue; // never emit an empty group

    matched.sort((a, b) => a.importance - b.importance || a.order - b.order);

    candidateGroups.push({
      title: group.title,
      summary: group.summary,
      importance: group.importance ?? DEFAULT_IMPORTANCE,
      collapsed: group.collapsed ?? false,
      hidden: group.hidden ?? false,
      files: matched.map(({ file, note, annotations, importance }) => ({ file, note, annotations, importance })),
    });
  }

  // Stable sort by importance; ties keep plan order (relative order of
  // survivors already matches plan order since we only ever filtered, never
  // reordered, candidateGroups above).
  const sortedGroups = candidateGroups
    .map((group, order) => ({ group, order }))
    .sort((a, b) => a.group.importance - b.group.importance || a.order - b.order)
    .map(({ group }) => group);

  const unplanned = files.filter((file) => !planned.has(file.path));
  if (unplanned.length > 0) {
    sortedGroups.push({
      title: "Unplanned",
      importance: UNPLANNED_IMPORTANCE,
      collapsed: false,
      hidden: false,
      files: unplanned.map((file) => ({ file, importance: UNPLANNED_IMPORTANCE })),
    });
  }

  let hiddenCount = 0;
  const visibleFiles: T[] = [];
  for (const group of sortedGroups) {
    const excludeGroup = group.hidden && opts.hideGroups;
    for (const entry of group.files) {
      if (excludeGroup) {
        hiddenCount += 1;
      } else {
        visibleFiles.push(entry.file);
      }
    }
  }

  return { groups: sortedGroups, visibleFiles, hiddenCount, unplannedCount: unplanned.length };
}

// ---------------------------------------------------------------------------
// Annotation <-> hunk range matching
//
// A plan annotation with a range is meant to point at a specific hunk; if
// the changeset moved on (rebase, `--watch` picking up an edit) that range
// can end up pointing at nothing. `index.tsx` uses these to drop such
// orphans rather than injecting a note that highlights the wrong lines --
// or no lines at all.
// ---------------------------------------------------------------------------

export interface PatchHunkRanges {
  old: Array<[number, number]>;
  new: Array<[number, number]>;
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse the `@@ -a,b +c,d @@` headers out of a unified-diff patch into the
 * 1-based inclusive line ranges each hunk covers on the old and new side.
 *
 * A hunk whose count is omitted (`@@ -5 +5 @@`) means a single line, per the
 * unified-diff spec -- the naive `,` split misses this and is the case this
 * function exists to get right. A zero count (`@@ -0,0 +1,20 @@`, a pure
 * addition) means that side contributes no range at all, so nothing is
 * pushed for it. A line that doesn't match the header shape is skipped
 * rather than throwing -- this parses whatever `@@` lines are recognizable
 * and ignores the rest of the patch text around them.
 */
export function patchHunkRanges(patch: string): PatchHunkRanges {
  const old: Array<[number, number]> = [];
  const newRanges: Array<[number, number]> = [];
  for (const line of patch.split("\n")) {
    const m = HUNK_HEADER_RE.exec(line);
    if (!m) continue;
    const oldStart = Number(m[1]);
    const oldCount = m[2] !== undefined ? Number(m[2]) : 1;
    const newStart = Number(m[3]);
    const newCount = m[4] !== undefined ? Number(m[4]) : 1;
    if (oldCount > 0) old.push([oldStart, oldStart + oldCount - 1]);
    if (newCount > 0) newRanges.push([newStart, newStart + newCount - 1]);
  }
  return { old, new: newRanges };
}

function rangesOverlap(a: [number, number], b: [number, number]): boolean {
  return a[0] <= b[1] && b[0] <= a[1];
}

export interface AnnotationFilterResult {
  kept: PlanAnnotation[];
  droppedCount: number;
}

/**
 * Drop annotations whose range falls outside every hunk `ranges` describes.
 * An annotation with neither `oldRange` nor `newRange` is file-scoped, not
 * hunk-scoped -- there is nothing for it to be "outside", so it always
 * survives. An annotation with a range survives if that range overlaps at
 * least one hunk's range on the side it names (old ranges checked against
 * `ranges.old`, new against `ranges.new` -- independently, so an annotation
 * naming only one side only needs to clear that side).
 */
export function filterAnnotationsInHunks(
  annotations: readonly PlanAnnotation[],
  ranges: PatchHunkRanges
): AnnotationFilterResult {
  const kept: PlanAnnotation[] = [];
  let droppedCount = 0;
  for (const annotation of annotations) {
    if (!annotation.oldRange && !annotation.newRange) {
      kept.push(annotation);
      continue;
    }
    const oldOk = annotation.oldRange ? ranges.old.some((r) => rangesOverlap(annotation.oldRange!, r)) : false;
    const newOk = annotation.newRange ? ranges.new.some((r) => rangesOverlap(annotation.newRange!, r)) : false;
    if (oldOk || newOk) {
      kept.push(annotation);
    } else {
      droppedCount += 1;
    }
  }
  return { kept, droppedCount };
}

export interface WindowResult<R> {
  rows: R[];
  offset: number;
}

const SCROLLOFF = 2;

/**
 * Pure viewport windowing: which slice of `rows` to show so that
 * `selectedIndex` stays visible, keeping (where possible) `SCROLLOFF` rows
 * of context above it. `selectedIndex < 0` means "no selection" and windows
 * from the top.
 */
export function windowRows<R>(rows: readonly R[], selectedIndex: number, height: number): WindowResult<R> {
  const total = rows.length;
  if (height <= 0 || total === 0) {
    return { rows: [], offset: 0 };
  }
  if (height >= total) {
    return { rows: [...rows], offset: 0 };
  }
  if (selectedIndex < 0) {
    return { rows: rows.slice(0, height), offset: 0 };
  }

  const maxOffset = total - height;
  const offset = Math.max(0, Math.min(selectedIndex - SCROLLOFF, maxOffset));

  return { rows: rows.slice(offset, offset + height), offset };
}
