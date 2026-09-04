import { describe, expect, test } from "bun:test";
import {
  buildCollapsedLayout,
  collapsedSourceRanges,
  collapsedSpans,
  rawFallbackReason,
  type CollapsedFile,
} from "../collapsed";

function file(overrides: Partial<CollapsedFile> = {}): CollapsedFile {
  return {
    path: "src/a.ts",
    hunks: [
      { oldRange: [1, 5], newRange: [1, 7] },
      { oldRange: [20, 24], newRange: [22, 26] },
      { oldRange: [40, 44], newRange: [42, 46] },
    ],
    additions: 12,
    deletions: 4,
    noteCount: 0,
    viewed: false,
    ...overrides,
  };
}

function textOf(spans: readonly { text: string }[]): string {
  return spans.map((span) => span.text).join("");
}

describe("collapsedSpans", () => {
  test("leads with the path and carries hunk count and stats", () => {
    const text = textOf(collapsedSpans(file()));
    expect(text).toContain("src/a.ts");
    expect(text).toContain("3 hunks");
    expect(text).toContain("+12");
    expect(text).toContain("−4");
  });

  test("singularises a one-hunk file", () => {
    expect(textOf(collapsedSpans(file({ hunks: [{ oldRange: [1, 5], newRange: [1, 7] }] })))).toContain("1 hunk ");
  });

  test("shows a note count only when the file has notes", () => {
    expect(textOf(collapsedSpans(file()))).not.toContain("note");
    expect(textOf(collapsedSpans(file({ noteCount: 1 })))).toContain("1 note");
    expect(textOf(collapsedSpans(file({ noteCount: 2 })))).toContain("2 notes");
  });

  test("marks a reviewed file", () => {
    expect(textOf(collapsedSpans(file({ viewed: false })))).not.toContain("✓");
    expect(textOf(collapsedSpans(file({ viewed: true })))).toContain("✓ reviewed");
  });
});

describe("buildCollapsedLayout", () => {
  test("gives each hunk its own row, in strictly increasing disjoint extents", () => {
    const layout = buildCollapsedLayout(
      file({ hunks: [{ newRange: [1, 2] }, { newRange: [5, 6] }, { newRange: [9, 10] }, { newRange: [13, 14] }] })
    );
    expect(layout).not.toBeNull();
    expect(layout!.rows).toHaveLength(4);
    expect(layout!.hunkRows).toEqual([
      { startRow: 0, endRow: 0 },
      { startRow: 1, endRow: 1 },
      { startRow: 2, endRow: 2 },
      { startRow: 3, endRow: 3 },
    ]);
  });

  test("a single-hunk file is still a single row", () => {
    const layout = buildCollapsedLayout(file({ hunks: [{ newRange: [1, 9] }] }));
    expect(layout!.rows).toHaveLength(1);
    expect(layout!.hunkRows).toEqual([{ startRow: 0, endRow: 0 }]);
  });

  test("row 0 carries the file summary, later rows carry their hunk header", () => {
    const layout = buildCollapsedLayout(
      file({ hunks: [{ newRange: [1, 2], header: "@@ -1,2 +1,2 @@" }, { newRange: [5, 6], header: "@@ -5,2 +5,2 @@" }] })
    );
    expect(textOf(layout!.rows[0]!.spans)).toContain("src/a.ts");
    expect(textOf(layout!.rows[1]!.spans)).toContain("@@ -5,2 +5,2 @@");
  });

  test("falls back to a hunk ordinal when the header is missing", () => {
    const layout = buildCollapsedLayout(file({ hunks: [{ newRange: [1, 2] }, { newRange: [5, 6] }] }));
    expect(textOf(layout!.rows[1]!.spans)).toContain("hunk 2 of 2");
  });

  test("declines a file with no parsed hunks", () => {
    expect(buildCollapsedLayout(file({ hunks: [] }))).toBeNull();
  });

  test("each row carries only its own hunk's ranges, so every note can anchor", () => {
    const layout = buildCollapsedLayout(file());
    expect(layout!.rows.map((row) => row.sourceRanges)).toEqual([
      [
        { side: "old", range: [1, 5] },
        { side: "new", range: [1, 7] },
      ],
      [
        { side: "old", range: [20, 24] },
        { side: "new", range: [22, 26] },
      ],
      [
        { side: "old", range: [40, 44] },
        { side: "new", range: [42, 46] },
      ],
    ]);
  });
});

describe("rawFallbackReason", () => {
  test("no annotations, no obstacle", () => {
    expect(rawFallbackReason([])).toBeNull();
    expect(rawFallbackReason(undefined)).toBeNull();
  });

  test("anchored annotations are fine on either side", () => {
    expect(rawFallbackReason([{ newRange: [4, 9] }, { oldRange: [1, 2] }])).toBeNull();
  });

  test("names a range-less annotation as the blocker", () => {
    expect(rawFallbackReason([{ newRange: [4, 9] }, {}])).toBe("1 file-scoped note with no line range");
    expect(rawFallbackReason([{}, {}])).toBe("2 file-scoped notes with no line range");
  });
});

describe("collapsedSourceRanges", () => {
  test("keeps both sides of every hunk", () => {
    expect(collapsedSourceRanges([{ oldRange: [1, 4], newRange: [1, 6] }])).toEqual([
      { side: "old", range: [1, 4] },
      { side: "new", range: [1, 6] },
    ]);
  });

  test("skips a side a hunk does not touch", () => {
    expect(collapsedSourceRanges([{ newRange: [1, 6] }])).toEqual([{ side: "new", range: [1, 6] }]);
  });

  test("drops degenerate ranges rather than emitting an invalid layout", () => {
    expect(collapsedSourceRanges([{ oldRange: [0, 0] }, { newRange: [9, 4] }])).toEqual([]);
  });

  test("drops a range overlapping the previous one on the same side", () => {
    expect(
      collapsedSourceRanges([{ newRange: [1, 10] }, { newRange: [5, 12] }, { newRange: [20, 22] }])
    ).toEqual([
      { side: "new", range: [1, 10] },
      { side: "new", range: [20, 22] },
    ]);
  });
});
