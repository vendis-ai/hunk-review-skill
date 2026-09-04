/**
 * The collapsed presentation of one file: a single row standing in for the
 * whole diff, the way a reviewed file collapses on a pull request.
 *
 * Kept free of host types, like plan.ts and viewed.ts, so it unit-tests as a
 * plain module. The shapes here are structurally what `hunkdiff/extension`
 * expects back from a file view's `layout`.
 *
 * Two rules of the file-view contract drive the whole design:
 *
 *   - `hunkRows` must carry one inclusive, in-bounds entry per parsed hunk,
 *     at the same index. Nothing requires them to be distinct, so collapsing
 *     is every hunk pointing at row 0.
 *   - A visible note Hunk cannot anchor to a row keeps the entire file on raw
 *     diff. A plan annotation with neither `oldRange` nor `newRange` is
 *     exactly that, and Hunk decides it before a view is ever consulted --
 *     `layout` is not called at all. `rawFallbackReason` predicts that refusal
 *     so a command can say why a file refused to collapse instead of looking
 *     broken.
 */

export type CollapsedSpanTone = "muted" | "accent" | "accent-muted" | "syntax" | "added" | "removed";

export interface CollapsedSpan {
  text: string;
  tone?: CollapsedSpanTone;
  attributes?: ("bold" | "italic" | "underline" | "strikethrough")[];
}

export interface CollapsedSourceRange {
  side: "old" | "new";
  range: [number, number];
}

export interface CollapsedRow {
  id: string;
  spans: CollapsedSpan[];
  sourceRanges?: CollapsedSourceRange[];
}

/** The old/new line span of one hunk, as the host reports it. */
export interface CollapsedHunk {
  header?: string;
  oldRange?: [number, number];
  newRange?: [number, number];
}

function usable(range: [number, number] | undefined): range is [number, number] {
  return range !== undefined && range[0] >= 1 && range[1] >= range[0];
}

/**
 * Every hunk's line span, as source ranges for the one collapsed row.
 *
 * This is what lets a file that carries notes collapse at all: Hunk places an
 * inline note by finding the row whose source ranges contain it, and a note it
 * cannot place keeps the entire file on raw diff. Covering every hunk on both
 * sides means every anchorable note in the file resolves to the collapsed row.
 *
 * Hunks do not overlap, so the ranges are disjoint per side by construction --
 * but an overlapping pair would make the whole layout invalid, and Hunk
 * rejects an invalid layout back to raw diff without saying so. Cheap to be
 * defensive about.
 */
export function collapsedSourceRanges(hunks: readonly CollapsedHunk[]): CollapsedSourceRange[] {
  const out: CollapsedSourceRange[] = [];
  const lastEnd: Record<"old" | "new", number> = { old: 0, new: 0 };
  for (const side of ["old", "new"] as const) {
    for (const hunk of hunks) {
      const range = side === "old" ? hunk.oldRange : hunk.newRange;
      if (!usable(range) || range[0] <= lastEnd[side]) continue;
      out.push({ side, range });
      lastEnd[side] = range[1];
    }
  }
  return out;
}

/** The trailing rows: one compact line per hunk after the first. */
function hunkRowSpans(hunk: CollapsedHunk, index: number, total: number): CollapsedSpan[] {
  const label = hunk.header?.trim() || `hunk ${index + 1} of ${total}`;
  return [
    { text: "  ▸ ", tone: "muted" },
    { text: label, tone: "muted" },
  ];
}

export interface CollapsedLayout {
  rows: CollapsedRow[];
  hunkRows: { startRow: number; endRow: number }[];
}

export interface CollapsedFile {
  path: string;
  hunks: readonly CollapsedHunk[];
  additions: number;
  deletions: number;
  noteCount: number;
  viewed: boolean;
}

/** The one row a collapsed file is reduced to. */
export function collapsedSpans(file: CollapsedFile): CollapsedSpan[] {
  const hunkCount = file.hunks.length;
  const spans: CollapsedSpan[] = [
    { text: "▸ ", tone: "muted" },
    { text: file.path, tone: "accent", attributes: ["bold"] },
    { text: `  ${hunkCount} hunk${hunkCount === 1 ? "" : "s"}`, tone: "muted" },
    { text: `  +${file.additions}`, tone: "added" },
    { text: ` −${file.deletions}`, tone: "removed" },
  ];
  if (file.noteCount > 0) {
    spans.push({ text: `  ${file.noteCount} note${file.noteCount === 1 ? "" : "s"}`, tone: "accent-muted" });
  }
  if (file.viewed) spans.push({ text: "  ✓ reviewed", tone: "accent" });
  return spans;
}

/**
 * One row per hunk: row `i` stands in for hunk `i`, and row 0 also carries the
 * file summary.
 *
 * Every hunk sharing row 0 would be the tighter collapse, and the contract
 * does not forbid it -- but Hunk rejects such a layout back to raw diff, which
 * is only visible as a file that refuses to collapse. Strictly increasing,
 * disjoint extents are the shape it accepts. A single-hunk file is still a
 * single row; an N-hunk file is N rows rather than N hundred.
 *
 * `null` -- decline, leaving Hunk on raw diff -- for a file with no parsed
 * hunks: there is no body to stand in for, and no way to satisfy the
 * one-entry-per-hunk rule.
 */
export function buildCollapsedLayout(file: CollapsedFile): CollapsedLayout | null {
  if (file.hunks.length === 0) return null;
  const total = file.hunks.length;
  return {
    rows: file.hunks.map((hunk, index) => {
      // Each row declares only its own hunk's spans, so a note anchored
      // anywhere in the file resolves to the row standing in for its hunk.
      const sourceRanges = collapsedSourceRanges([hunk]);
      return {
        id: `collapsed-${index}`,
        spans: index === 0 ? collapsedSpans(file) : hunkRowSpans(hunk, index, total),
        ...(sourceRanges.length > 0 ? { sourceRanges } : {}),
      };
    }),
    hunkRows: file.hunks.map((_, index) => ({ startRow: index, endRow: index })),
  };
}

export interface AnchorableAnnotation {
  oldRange?: [number, number];
  newRange?: [number, number];
}

/**
 * Why Hunk will keep this file on raw diff whatever a view returns, or `null`
 * when nothing stands in the way. Only one cause today: a note with no range
 * to anchor to.
 */
export function rawFallbackReason(annotations: readonly AnchorableAnnotation[] | undefined): string | null {
  if (!annotations) return null;
  const unanchored = annotations.filter((a) => a.oldRange === undefined && a.newRange === undefined).length;
  if (unanchored === 0) return null;
  return `${unanchored} file-scoped note${unanchored === 1 ? "" : "s"} with no line range`;
}
