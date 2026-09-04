/**
 * review-plan: groups a hunk changeset by topic from an agent-written review
 * plan, orders it by importance, and tracks what has been reviewed.
 *
 * All the pure logic (plan parsing/ordering, viewport windowing, viewed-state
 * persistence) lives in ./plan.ts and ./viewed.ts, which are plain modules
 * unit-tested under `bun test`. This file is the thin host-facing layer: the
 * factory that registers the transform, pane, commands, and lifecycle hooks.
 *
 * `react` and `@opentui/*` are imported normally at runtime -- Hunk injects
 * its own copies for extensions, so these must never appear under this
 * package's `dependencies`, only `devDependencies` (for typechecking).
 */
import type {
  AgentAnnotation,
  AgentFileContext,
  ExtensionChangeset,
  ExtensionCommandContext,
  ExtensionDiffFile,
  ExtensionPaneProps,
  ExtensionPaneTheme,
  HunkExtensionAPI,
} from "hunkdiff/extension";
import { useSyncExternalStore } from "react";
import { blendHex } from "./color";
import { buildCollapsedLayout, rawFallbackReason, type CollapsedFile } from "./collapsed";
import {
  anchorFileScopedAnnotations,
  filterAnnotationsInHunks,
  findRepoRoot,
  loadPlan,
  orderChangeset,
  patchHunkRanges,
  windowRows,
  type OrderedGroup,
  type OrderedResult,
  type PatchHunkRanges,
  type PlanAnnotation,
  type ReviewPlan,
} from "./plan";
import {
  classify,
  prune,
  readViewed,
  toggle,
  viewedStatePath,
  writeViewed,
  type ViewedState,
  type ViewedStatus,
} from "./viewed";

const PLAN_FILE_PATH = ".hunk/review-plan.json";
const MIN_API_VERSION = 8;

/**
 * How far a reviewed file's row is mixed toward the background behind it.
 * High enough to sink the row out of the reading path, low enough that the
 * filename stays legible when you go looking for it.
 */
const VIEWED_FADE = 0.55;

/** Id of the file view that stands in for a whole diff with one row. */
const COLLAPSED_VIEW_ID = "collapsed";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface ExtensionConfig {
  hideGroups: boolean;
  injectNotes: boolean;
  width: number;
  placement: "left" | "right";
}

const DEFAULT_CONFIG: ExtensionConfig = {
  hideGroups: false,
  injectNotes: true,
  width: 38,
  placement: "left",
};

function readConfig(raw: Record<string, unknown>): ExtensionConfig {
  const hideGroups = typeof raw.hide_groups === "boolean" ? raw.hide_groups : DEFAULT_CONFIG.hideGroups;
  const injectNotes = typeof raw.inject_notes === "boolean" ? raw.inject_notes : DEFAULT_CONFIG.injectNotes;
  const rawWidth = raw.width;
  const width =
    typeof rawWidth === "number" && Number.isFinite(rawWidth)
      ? Math.min(80, Math.max(22, rawWidth))
      : DEFAULT_CONFIG.width;
  const placement = raw.placement === "left" || raw.placement === "right" ? raw.placement : DEFAULT_CONFIG.placement;
  return { hideGroups, injectNotes, width, placement };
}

// ---------------------------------------------------------------------------
// Module-level store
//
// Survives factory re-runs (Hunk only re-runs a factory after a trust grant
// or a cwd change), so it is the right home for durable per-file state --
// which is why everything here is keyed by path, never by the renumbering
// `file.id`. Snapshots are only ever replaced wholesale (new object, new
// Set), never mutated in place, so useSyncExternalStore's reference-equality
// check works without extra bookkeeping.
// ---------------------------------------------------------------------------

interface StoreState {
  plan: ReviewPlan | null;
  source: string | null;
  error: string | null;
  ordered: OrderedResult<ExtensionDiffFile> | null;
  /** Group titles collapsed in the pane. */
  collapsed: Set<string>;
  /**
   * Paths whose diff is collapsed in the review stream.
   *
   * Ours rather than read back from `fileViews.isActive`: the host answer is
   * not reliable immediately after a `select`, and a toggle that mis-reads
   * the current state collapses when it meant to expand.
   */
  collapsedFiles: Set<string>;
  viewed: ViewedState;
  repoRoot: string | null;
}

const EMPTY_VIEWED: ViewedState = { version: 1, entries: {} };

function initialState(): StoreState {
  return {
    plan: null,
    source: null,
    error: null,
    ordered: null,
    collapsed: new Set(),
    collapsedFiles: new Set(),
    viewed: EMPTY_VIEWED,
    repoRoot: null,
  };
}

type Listener = () => void;

class Store {
  private state: StoreState = initialState();
  private listeners = new Set<Listener>();

  getSnapshot = (): StoreState => this.state;

  setState(next: StoreState): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}

const store = new Store();

/**
 * Carry session-adjusted collapse state across a reload: a group the user
 * touched keeps its current state as long as the group (by title) still
 * exists; a group appearing for the first time seeds from the plan's own
 * `collapsed` default; a group that disappeared is dropped.
 */
function reconcileCollapsed(previous: StoreState, ordered: OrderedResult<ExtensionDiffFile>): Set<string> {
  const previousTitles = new Set((previous.ordered?.groups ?? []).map((group) => group.title));
  const next = new Set<string>();
  for (const title of previous.collapsed) {
    if (ordered.groups.some((group) => group.title === title)) next.add(title);
  }
  for (const group of ordered.groups) {
    if (!previousTitles.has(group.title) && group.collapsed) next.add(group.title);
  }
  return next;
}

/**
 * Re-read viewed state, and forget which files were collapsed.
 *
 * A reload puts every file back on raw diff host-side, and presentation is
 * only settable for the file under the cursor -- so there is no way to put a
 * set of collapsed files back. Remembering them would only let our state
 * drift from what is on screen.
 */
function resyncAfterChangeset(): void {
  const state = store.getSnapshot();
  const viewed = state.repoRoot ? readViewed(viewedStatePath(state.repoRoot, process.env)) : state.viewed;
  store.setState({ ...state, viewed, collapsedFiles: new Set() });
}

function moveToAdjacentGroup(ctx: ExtensionCommandContext, direction: 1 | -1): void {
  const state = store.getSnapshot();
  if (!state.ordered || state.ordered.groups.length === 0) return;
  const groups = state.ordered.groups;
  const file = ctx.selection.file;
  const currentIndex = file ? groups.findIndex((group) => group.files.some((f) => f.file.path === file.path)) : -1;

  const targetIndex =
    currentIndex === -1
      ? direction === 1
        ? 0
        : groups.length - 1
      : Math.min(Math.max(currentIndex + direction, 0), groups.length - 1);

  const firstFile = groups[targetIndex]?.files[0]?.file;
  if (firstFile) ctx.navigation.selectFile(firstFile.id);
}

// ---------------------------------------------------------------------------
// Collapsed file view
//
// Presentation is host state, per file, and only ever set for the file under
// the cursor -- there is no API to collapse a set of files at once, and a
// reload drops the presentation entirely. So nothing here is persisted: the
// collapse follows `v` and the manual toggle, and comes back expanded after
// a reload.
// ---------------------------------------------------------------------------

function viewedStatusOf(file: ExtensionDiffFile): ViewedStatus {
  const state = store.getSnapshot();
  return classify(state.viewed, [{ path: file.path, patch: file.patch }]).get(file.path) ?? "unseen";
}

/**
 * The file's hunk spans as hunk itself parsed them, or `null` when it did not.
 *
 * Anchoring has to agree with the source ranges the collapsed row declares, and
 * the row's come from `file.hunks`. Anchoring off a separately parsed patch
 * risks placing a note a line outside every declared range -- which reads as
 * an unplaceable note and puts the file back on raw diff.
 */
function hostHunkRanges(file: ExtensionDiffFile): PatchHunkRanges | null {
  if (!file.hunks || file.hunks.length === 0) return null;
  const old: [number, number][] = [];
  const updated: [number, number][] = [];
  for (const hunk of file.hunks) {
    if (hunk.oldRange) old.push(hunk.oldRange);
    if (hunk.newRange) updated.push(hunk.newRange);
  }
  return { old, new: updated };
}

function collapsedFileOf(file: ExtensionDiffFile): CollapsedFile {
  return {
    path: file.path,
    hunks: (file.hunks ?? []).map((hunk) => ({
      header: hunk.header,
      oldRange: hunk.oldRange,
      newRange: hunk.newRange,
    })),
    additions: file.stats.additions,
    deletions: file.stats.deletions,
    noteCount: file.agent?.annotations.length ?? 0,
    viewed: viewedStatusOf(file) === "viewed",
  };
}

/**
 * Collapse or expand the selected file's diff.
 *
 * Hunk keeps a file with an unanchorable note on raw diff and never consults
 * a view for it, so a refusal is reported rather than left looking like a
 * dead key.
 */
function setSelectedFileCollapsed(ctx: ExtensionCommandContext, collapse: boolean): void {
  const file = ctx.selection.file;
  if (!file) return;
  const state = store.getSnapshot();

  if (collapse) {
    const reason = rawFallbackReason(file.agent?.annotations);
    if (reason) {
      ctx.notify(`${basename(file.path)} stays expanded: ${reason}`, "warning");
      return;
    }
    ctx.fileViews.select(COLLAPSED_VIEW_ID);
  } else if (!state.collapsedFiles.has(file.path)) {
    return;
  } else {
    ctx.fileViews.select(null);
  }

  const collapsedFiles = new Set(state.collapsedFiles);
  if (collapse) collapsedFiles.add(file.path);
  else collapsedFiles.delete(file.path);
  store.setState({ ...state, collapsedFiles });

  // Collapsing a file changes its height, and the review stream re-anchors on
  // whatever row survives -- which is above the file the user just acted on,
  // so the cursor appears to jump away from it. Reselecting puts it back on
  // the row that replaced the diff.
  ctx.navigation.selectFile(file.id);
}

// ---------------------------------------------------------------------------
// Small string helpers for fixed-width terminal rows
// ---------------------------------------------------------------------------

function basename(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx === -1 ? filePath : filePath.slice(idx + 1);
}

function clipRight(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width === 1) return "…";
  return `${text.slice(0, width - 1)}…`;
}

/** Truncate from the left so the tail of a path -- the readable part -- survives. */
function clipLeft(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width === 1) return "…";
  return `…${text.slice(text.length - (width - 1))}`;
}

function fileColor(file: ExtensionDiffFile, theme: ExtensionPaneTheme): string {
  if (file.isUntracked) return theme.fileUntracked;
  switch (file.changeType) {
    case "new":
      return theme.fileNew;
    case "deleted":
      return theme.fileDeleted;
    case "rename-pure":
    case "rename-changed":
      return theme.fileRenamed;
    case "change":
      return theme.fileModified;
    default:
      return theme.text;
  }
}

// ---------------------------------------------------------------------------
// Row model + pane component
// ---------------------------------------------------------------------------

interface GroupRow {
  kind: "group";
  group: OrderedGroup<ExtensionDiffFile>;
  collapsed: boolean;
  allViewed: boolean;
}

interface FileRow {
  kind: "file";
  file: ExtensionDiffFile;
  note?: string;
  status: ViewedStatus;
}

interface RowsResult {
  header: { hiddenCount: number; source: string | null };
  body: Array<GroupRow | FileRow>;
}

function buildRows(state: StoreState): RowsResult {
  const body: Array<GroupRow | FileRow> = [];

  if (state.ordered) {
    const allFiles = state.ordered.groups.flatMap((group) =>
      group.files.map((entry) => ({ path: entry.file.path, patch: entry.file.patch }))
    );
    const statusMap = classify(state.viewed, allFiles);

    for (const group of state.ordered.groups) {
      const collapsed = state.collapsed.has(group.title);
      const allViewed = group.files.length > 0 && group.files.every((f) => statusMap.get(f.file.path) === "viewed");
      body.push({ kind: "group", group, collapsed, allViewed });
      if (collapsed) continue;
      for (const entry of group.files) {
        body.push({
          kind: "file",
          file: entry.file,
          note: entry.note,
          status: statusMap.get(entry.file.path) ?? "unseen",
        });
      }
    }
  }

  return { header: { hiddenCount: state.ordered?.hiddenCount ?? 0, source: state.source }, body };
}

function GroupRowView({
  row,
  width,
  theme,
}: {
  row: GroupRow;
  width: number;
  theme: ExtensionPaneTheme;
}) {
  const marker = row.collapsed ? "▸" : "▾";
  const check = row.allViewed ? " ✓" : "";
  const left = `${marker} ${row.group.title}${check}`;
  const count = `${row.group.files.length} file${row.group.files.length === 1 ? "" : "s"}`;
  const leftWidth = Math.max(0, width - count.length - 1);
  const clippedLeft = clipRight(left, leftWidth);
  const gapWidth = Math.max(1, width - clippedLeft.length - count.length);

  return (
    <box width={width} flexDirection="row">
      <text fg={theme.accent}>{clippedLeft}</text>
      <text fg={theme.muted}>{" ".repeat(gapWidth) + count}</text>
    </box>
  );
}

function FileRowView({
  row,
  width,
  theme,
  selected,
}: {
  row: FileRow;
  width: number;
  theme: ExtensionPaneTheme;
  selected: boolean;
}) {
  const glyph = row.status === "viewed" ? "✓" : row.status === "changed" ? "●" : " ";
  const prefix = `  ${glyph} `;
  const added = `+${row.file.stats.additions}`;
  const removed = `−${row.file.stats.deletions}`;
  const suffixWidth = 1 + added.length + 1 + removed.length; // " " + added + " " + removed
  const nameWidth = Math.max(0, width - prefix.length - suffixWidth);
  const name = clipLeft(basename(row.file.path), nameWidth);
  const gapWidth = Math.max(0, width - prefix.length - name.length - suffixWidth);

  // A reviewed file is faded rather than recolored, so it still reads as its
  // own change type -- just quieter. The fade has to target the background
  // this particular row sits on, or a selected row fades toward the wrong
  // color and stops being legible exactly when it is under the cursor. The
  // ✓ itself is never faded: it is the reason the row is quiet.
  const backdrop = selected ? theme.selectedHunk : theme.panel;
  const fade = (color: string): string =>
    row.status === "viewed" ? blendHex(color, backdrop, VIEWED_FADE) : color;

  return (
    <box width={width} backgroundColor={selected ? theme.selectedHunk : undefined} flexDirection="row">
      <text fg={theme.muted}>{prefix}</text>
      <text fg={fade(fileColor(row.file, theme))}>{name}</text>
      <text>{" ".repeat(gapWidth + 1)}</text>
      <text fg={fade(theme.badgeAdded)}>{added}</text>
      <text fg={theme.muted}>{" "}</text>
      <text fg={fade(theme.badgeRemoved)}>{removed}</text>
    </box>
  );
}

function FilesPaneComponent(props: ExtensionPaneProps) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const { header, body } = buildRows(state);

  const selectedBodyIndex = props.selectedFileId
    ? body.findIndex((row) => row.kind === "file" && row.file.id === props.selectedFileId)
    : -1;

  const bodyHeight = Math.max(0, props.height - 1); // reserve 1 row for the header line
  const { rows: windowed } = windowRows(body, selectedBodyIndex, bodyHeight);

  const headerLabel = header.source
    ? header.hiddenCount > 0
      ? `${header.hiddenCount} hidden · ${basename(header.source)}`
      : basename(header.source)
    : "no review plan";

  return (
    <box width={props.width} height={props.height} flexDirection="column">
      <text fg={props.theme.muted}>{clipRight(headerLabel, props.width)}</text>
      {windowed.map((row) =>
        row.kind === "group" ? (
          <GroupRowView key={`g:${row.group.title}`} row={row} width={props.width} theme={props.theme} />
        ) : (
          <FileRowView
            key={`f:${row.file.path}`}
            row={row}
            width={props.width}
            theme={props.theme}
            selected={row.file.id === props.selectedFileId}
          />
        )
      )}
    </box>
  );
}

// ---------------------------------------------------------------------------
// Plan annotation -> hunk sidecar annotation
// ---------------------------------------------------------------------------

/**
 * One-to-one mapping onto hunk's `AgentAnnotation`. `source` is stamped
 * `"review-plan"` so the pane and any downstream tooling can tell a
 * plan-authored note from one that arrived in a real `--agent-context`
 * sidecar; `id`/`author`/`createdAt` are provenance hunk's sidecar format
 * tracks and are deliberately left unset here.
 */
function toAgentAnnotation(annotation: PlanAnnotation): AgentAnnotation {
  const out: AgentAnnotation = { summary: annotation.summary, source: "review-plan" };
  if (annotation.rationale !== undefined) out.rationale = annotation.rationale;
  if (annotation.oldRange !== undefined) out.oldRange = annotation.oldRange;
  if (annotation.newRange !== undefined) out.newRange = annotation.newRange;
  if (annotation.tags !== undefined) out.tags = annotation.tags;
  if (annotation.confidence !== undefined) out.confidence = annotation.confidence;
  return out;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export default function reviewPlan(hunk: HunkExtensionAPI): void {
  if (hunk.apiVersion < MIN_API_VERSION) return;

  const config = readConfig(hunk.config);

  hunk.transformChangeset(async (changeset: ExtensionChangeset, ctx) => {
    const repoRoot = findRepoRoot(ctx.cwd) ?? ctx.cwd;
    const loaded = loadPlan(repoRoot, process.env);

    if (loaded.error) {
      ctx.notify(`review-plan: ${loaded.error}`, "warning");
    } else if (loaded.droppedDuplicates > 0) {
      ctx.notify(
        `review-plan: dropped ${loaded.droppedDuplicates} duplicate plan path${
          loaded.droppedDuplicates === 1 ? "" : "s"
        }`,
        "warning"
      );
    }

    const files = changeset.files.filter((file) => file.path !== PLAN_FILE_PATH);
    const ordered = orderChangeset(files, loaded.plan, { hideGroups: config.hideGroups });

    const notesByPath = new Map<string, string>();
    const annotationsByPath = new Map<string, PlanAnnotation[]>();
    if (loaded.plan) {
      for (const group of loaded.plan.groups) {
        for (const entry of group.files) {
          if (entry.note) notesByPath.set(entry.path, entry.note);
          if (entry.annotations && entry.annotations.length > 0) {
            annotationsByPath.set(entry.path, entry.annotations);
          }
        }
      }
    }

    let orphanedAnnotations = 0;
    const outFiles: ExtensionDiffFile[] = ordered.visibleFiles.map((file) => {
      if (!config.injectNotes) return { ...file };

      const note = notesByPath.get(file.path);
      const planAnnotations = annotationsByPath.get(file.path);

      let mappedAnnotations: AgentAnnotation[] = [];
      if (planAnnotations && planAnnotations.length > 0) {
        const ranges = patchHunkRanges(file.patch);
        const { kept, droppedCount } = filterAnnotationsInHunks(planAnnotations, ranges);
        orphanedAnnotations += droppedCount;
        // Anchor before mapping: a note with no range cannot be placed on a
        // file view's row, and one unplaceable note keeps the whole file on
        // raw diff -- which would make any file carrying a file-scoped note
        // permanently uncollapsible.
        mappedAnnotations = anchorFileScopedAnnotations(kept, hostHunkRanges(file) ?? ranges).map(toAgentAnnotation);
      }

      if (!note && mappedAnnotations.length === 0) return { ...file };

      // Existing annotations came from a real `--agent-context` sidecar the
      // user passed in -- never drop them, only append the plan's on top.
      // Likewise, only overwrite `summary` when the plan actually has a note
      // for this file, so an annotation-only match doesn't blank out a real
      // sidecar summary.
      const existingAnnotations = file.agent?.annotations ?? [];
      const mergedAgent: AgentFileContext = file.agent
        ? {
            ...file.agent,
            ...(note ? { summary: note } : {}),
            annotations: [...existingAnnotations, ...mappedAnnotations],
          }
        : {
            path: file.path,
            ...(note ? { summary: note } : {}),
            annotations: mappedAnnotations,
          };
      return { ...file, agent: mergedAgent };
    });

    if (orphanedAnnotations > 0) {
      ctx.notify(
        `review-plan: ${orphanedAnnotations} annotation${
          orphanedAnnotations === 1 ? "" : "s"
        } skipped, outside any hunk`,
        "warning"
      );
    }

    const viewedPath = viewedStatePath(repoRoot, process.env);
    const prunedViewed = prune(
      readViewed(viewedPath),
      files.map((file) => file.path)
    );
    writeViewed(viewedPath, prunedViewed);

    const previous = store.getSnapshot();
    store.setState({
      plan: loaded.plan,
      source: loaded.source,
      error: loaded.error,
      ordered,
      collapsed: reconcileCollapsed(previous, ordered),
      // Not carried over: a freshly transformed changeset is on raw diff
      // throughout, whatever was collapsed before.
      collapsedFiles: new Set(),
      viewed: prunedViewed,
      repoRoot,
    });

    const summary = `${ordered.groups.length} group${ordered.groups.length === 1 ? "" : "s"} · ${
      ordered.visibleFiles.length
    } file${ordered.visibleFiles.length === 1 ? "" : "s"}${
      ordered.hiddenCount > 0 ? ` · ${ordered.hiddenCount} hidden` : ""
    }`;

    return {
      ...changeset,
      files: outFiles,
      agentSummary: changeset.agentSummary ?? summary,
    };
  });

  hunk.registerPane({
    id: "files",
    replaces: "hunk:files",
    placement: config.placement,
    width: { preferred: config.width, min: 22 },
    title: "Review plan",
    component: FilesPaneComponent,
  });

  hunk.registerFileView({
    id: COLLAPSED_VIEW_ID,
    title: "Collapsed",
    // Unconditional on purpose. `hunks` is optional in the contract, and
    // gating availability on it makes the view unavailable for any file whose
    // hunks are not populated at the moment Hunk asks -- `select` then refuses
    // and the key does nothing. `layout` declines instead, which is the
    // contract's own answer for a file a view cannot present.
    matches: () => true,
    layout: (input) => buildCollapsedLayout(collapsedFileOf(input.file)),
  });

  hunk.registerCommand({ id: "toggleViewed", title: "Toggle file reviewed", key: "v" }, (ctx) => {
    const file = ctx.selection.file;
    const state = store.getSnapshot();
    if (!file || !state.repoRoot) return;
    const nextViewed = toggle(state.viewed, file.path, file.patch);
    writeViewed(viewedStatePath(state.repoRoot, process.env), nextViewed);
    store.setState({ ...state, viewed: nextViewed });
    const status = classify(nextViewed, [{ path: file.path, patch: file.patch }]).get(file.path);
    ctx.notify(status === "viewed" ? `Marked ${basename(file.path)} reviewed` : `Marked ${basename(file.path)} unreviewed`);
    // Reviewing a file is the moment its diff stops being worth the space,
    // so marking it collapses it and unmarking it brings the diff back.
    setSelectedFileCollapsed(ctx, status === "viewed");
  });

  hunk.registerCommand({ id: "toggleCollapsed", title: "Collapse/expand file diff", key: "x" }, (ctx) => {
    const file = ctx.selection.file;
    if (!file) return;
    setSelectedFileCollapsed(ctx, !store.getSnapshot().collapsedFiles.has(file.path));
  });

  hunk.registerCommand({ id: "toggleGroup", title: "Collapse/expand group", key: "V" }, (ctx) => {
    const file = ctx.selection.file;
    const state = store.getSnapshot();
    if (!file || !state.ordered) return;
    const group = state.ordered.groups.find((g) => g.files.some((f) => f.file.path === file.path));
    if (!group) return;
    const nextCollapsed = new Set(state.collapsed);
    if (nextCollapsed.has(group.title)) nextCollapsed.delete(group.title);
    else nextCollapsed.add(group.title);
    store.setState({ ...state, collapsed: nextCollapsed });
  });

  hunk.registerCommand({ id: "nextGroup", title: "Next group", key: "n" }, (ctx) => {
    moveToAdjacentGroup(ctx, 1);
  });

  hunk.registerCommand({ id: "previousGroup", title: "Previous group", key: "p" }, (ctx) => {
    moveToAdjacentGroup(ctx, -1);
  });

  hunk.registerCommand({ id: "collapseViewedGroups", title: "Collapse fully reviewed groups" }, (ctx) => {
    const state = store.getSnapshot();
    if (!state.ordered) return;
    const allFiles = state.ordered.groups.flatMap((group) =>
      group.files.map((entry) => ({ path: entry.file.path, patch: entry.file.patch }))
    );
    const statusMap = classify(state.viewed, allFiles);
    const nextCollapsed = new Set(state.collapsed);
    let changed = 0;
    for (const group of state.ordered.groups) {
      if (group.files.length === 0 || nextCollapsed.has(group.title)) continue;
      const allViewed = group.files.every((f) => statusMap.get(f.file.path) === "viewed");
      if (allViewed) {
        nextCollapsed.add(group.title);
        changed += 1;
      }
    }
    if (changed > 0) {
      store.setState({ ...state, collapsed: nextCollapsed });
      ctx.notify(`Collapsed ${changed} fully reviewed group${changed === 1 ? "" : "s"}`);
    }
  });

  hunk.on("changeset_loaded", () => resyncAfterChangeset());
  hunk.on("session_reload", () => resyncAfterChangeset());
  hunk.on("shutdown", () => {
    const state = store.getSnapshot();
    if (!state.repoRoot) return;
    writeViewed(viewedStatePath(state.repoRoot, process.env), state.viewed);
  });
}
