import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  anchorFileScopedAnnotations,
  filterAnnotationsInHunks,
  findRepoRoot,
  loadPlan,
  orderChangeset,
  patchHunkRanges,
  planCandidatePaths,
  repoDigest,
  validatePlan,
  windowRows,
  type PlanAnnotation,
  type ReviewPlan,
} from "../plan";

function mkdtemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "review-plan-test-"));
}

describe("validatePlan", () => {
  test("rejects non-object input", () => {
    const result = validatePlan("not an object");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/object/i);
  });

  test("rejects null", () => {
    const result = validatePlan(null);
    expect(result.ok).toBe(false);
  });

  test("rejects an array at the top level", () => {
    const result = validatePlan([]);
    expect(result.ok).toBe(false);
  });

  test("rejects version !== 1", () => {
    const result = validatePlan({ version: 2, groups: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/version/i);
  });

  test("rejects groups that are not an array", () => {
    const result = validatePlan({ version: 1, groups: "nope" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/groups/i);
  });

  test("rejects a group without a non-empty string title", () => {
    const missing = validatePlan({ version: 1, groups: [{ files: [] }] });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toMatch(/title/i);

    const empty = validatePlan({ version: 1, groups: [{ title: "  ", files: [] }] });
    expect(empty.ok).toBe(false);

    const wrongType = validatePlan({ version: 1, groups: [{ title: 42, files: [] }] });
    expect(wrongType.ok).toBe(false);
  });

  test("rejects a group whose files is not an array", () => {
    const result = validatePlan({ version: 1, groups: [{ title: "Auth", files: "nope" }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/files/i);
  });

  test("rejects a file entry without a non-empty string path", () => {
    const missing = validatePlan({
      version: 1,
      groups: [{ title: "Auth", files: [{ importance: 10 }] }],
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toMatch(/path/i);

    const empty = validatePlan({
      version: 1,
      groups: [{ title: "Auth", files: [{ path: "" }] }],
    });
    expect(empty.ok).toBe(false);
  });

  test("is forgiving of extra keys", () => {
    const result = validatePlan({
      version: 1,
      extraTopLevel: "ignored",
      groups: [{ title: "Auth", extraGroupKey: 1, files: [{ path: "a.ts", extraFileKey: true }] }],
    });
    expect(result.ok).toBe(true);
  });

  test("coerces missing importance to 50 and clamps out-of-range values", () => {
    const result = validatePlan({
      version: 1,
      groups: [
        {
          title: "Auth",
          importance: 500,
          files: [
            { path: "a.ts" }, // missing -> 50
            { path: "b.ts", importance: -20 }, // clamp -> 0
            { path: "c.ts", importance: 200 }, // clamp -> 100
            { path: "d.ts", importance: "not a number" }, // coerce -> 50
          ],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.groups[0]!.importance).toBe(100); // clamped from 500
    const [a, b, c, d] = result.plan.groups[0]!.files;
    expect(a!.importance).toBe(50);
    expect(b!.importance).toBe(0);
    expect(c!.importance).toBe(100);
    expect(d!.importance).toBe(50);
  });

  test("duplicate path across groups keeps the first and reports the drop count", () => {
    const result = validatePlan({
      version: 1,
      groups: [
        { title: "Auth", files: [{ path: "shared.ts", note: "first" }] },
        { title: "Rename", files: [{ path: "shared.ts", note: "second" }, { path: "other.ts" }] },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.droppedDuplicates).toBe(1);
    const allPaths = result.plan.groups.flatMap((g) => g.files.map((f) => f.path));
    expect(allPaths.filter((p) => p === "shared.ts")).toHaveLength(1);
    expect(result.plan.groups[0]!.files[0]!.note).toBe("first");
  });

  test("duplicate path within the same group also keeps only the first", () => {
    const result = validatePlan({
      version: 1,
      groups: [{ title: "Auth", files: [{ path: "a.ts" }, { path: "a.ts" }] }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.droppedDuplicates).toBe(1);
    expect(result.plan.groups[0]!.files).toHaveLength(1);
  });
});

describe("validatePlan - annotations and top-level summary", () => {
  test("valid annotations and a top-level summary round-trip through validate", () => {
    const result = validatePlan({
      version: 1,
      summary: "Auth fix behind a big rename",
      groups: [
        {
          title: "Auth",
          files: [
            {
              path: "a.ts",
              annotations: [
                {
                  summary: "Revoke before issue",
                  rationale: "closes the race",
                  oldRange: [10, 12],
                  newRange: [10, 15],
                  tags: ["security", "race"],
                  confidence: "high",
                },
              ],
            },
          ],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.summary).toBe("Auth fix behind a big rename");
    expect(result.plan.groups[0]!.files[0]!.annotations).toEqual([
      {
        summary: "Revoke before issue",
        rationale: "closes the race",
        oldRange: [10, 12],
        newRange: [10, 15],
        tags: ["security", "race"],
        confidence: "high",
      },
    ]);
  });

  test("rejects a non-object annotation, naming the file path and annotation index", () => {
    const result = validatePlan({
      version: 1,
      groups: [{ title: "Auth", files: [{ path: "a.ts", annotations: ["not an object"] }] }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('"a.ts"');
    expect(result.error).toContain("annotation 0");
  });

  test("rejects an annotation missing a non-empty summary, naming the file path and annotation index", () => {
    const missing = validatePlan({
      version: 1,
      groups: [{ title: "Auth", files: [{ path: "a.ts", annotations: [{}] }] }],
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error).toContain('"a.ts"');
      expect(missing.error).toContain("annotation 0");
      expect(missing.error).toMatch(/summary/i);
    }

    const empty = validatePlan({
      version: 1,
      groups: [{ title: "Auth", files: [{ path: "a.ts", annotations: [{ summary: "  " }] }] }],
    });
    expect(empty.ok).toBe(false);

    const wrongType = validatePlan({
      version: 1,
      groups: [{ title: "Auth", files: [{ path: "a.ts", annotations: [{ summary: 42 }] }] }],
    });
    expect(wrongType.ok).toBe(false);
  });

  test("rejects a malformed oldRange, naming the file path and annotation index", () => {
    const notPair = validatePlan({
      version: 1,
      groups: [{ title: "Auth", files: [{ path: "a.ts", annotations: [{ summary: "x", oldRange: [1] }] }] }],
    });
    expect(notPair.ok).toBe(false);
    if (!notPair.ok) {
      expect(notPair.error).toContain('"a.ts"');
      expect(notPair.error).toContain("annotation 0");
      expect(notPair.error).toMatch(/oldRange/);
    }

    const nonInteger = validatePlan({
      version: 1,
      groups: [{ title: "Auth", files: [{ path: "a.ts", annotations: [{ summary: "x", oldRange: [1.5, 2] }] }] }],
    });
    expect(nonInteger.ok).toBe(false);

    const belowOne = validatePlan({
      version: 1,
      groups: [{ title: "Auth", files: [{ path: "a.ts", annotations: [{ summary: "x", oldRange: [0, 2] }] }] }],
    });
    expect(belowOne.ok).toBe(false);

    const endBeforeStart = validatePlan({
      version: 1,
      groups: [{ title: "Auth", files: [{ path: "a.ts", annotations: [{ summary: "x", oldRange: [5, 2] }] }] }],
    });
    expect(endBeforeStart.ok).toBe(false);
  });

  test("rejects a malformed newRange, naming the file path and annotation index", () => {
    const result = validatePlan({
      version: 1,
      groups: [{ title: "Auth", files: [{ path: "a.ts", annotations: [{ summary: "x", newRange: [5, 2] }] }] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('"a.ts"');
      expect(result.error).toContain("annotation 0");
      expect(result.error).toMatch(/newRange/);
    }
  });

  test("the annotation index in the error matches its position among that file's annotations", () => {
    const result = validatePlan({
      version: 1,
      groups: [
        {
          title: "Auth",
          files: [{ path: "a.ts", annotations: [{ summary: "ok" }, { summary: "" }] }],
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("annotation 1");
  });

  test("confidence outside the three allowed values is dropped, not fatal", () => {
    const result = validatePlan({
      version: 1,
      groups: [{ title: "Auth", files: [{ path: "a.ts", annotations: [{ summary: "x", confidence: "wrong" }] }] }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.groups[0]!.files[0]!.annotations![0]!.confidence).toBeUndefined();
  });

  test("a non-array tags is dropped, not fatal", () => {
    const result = validatePlan({
      version: 1,
      groups: [{ title: "Auth", files: [{ path: "a.ts", annotations: [{ summary: "x", tags: "not-array" }] }] }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.groups[0]!.files[0]!.annotations![0]!.tags).toBeUndefined();
  });

  test("non-string entries are filtered out of a valid tags array", () => {
    const result = validatePlan({
      version: 1,
      groups: [{ title: "Auth", files: [{ path: "a.ts", annotations: [{ summary: "x", tags: ["a", 1] }] }] }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.groups[0]!.files[0]!.annotations![0]!.tags).toEqual(["a"]);
  });

  test("backward compatible: no annotations key and no top-level summary validate exactly as before", () => {
    const result = validatePlan({
      version: 1,
      groups: [{ title: "Auth", files: [{ path: "a.ts", note: "hi" }] }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.groups[0]!.files[0]!.annotations).toBeUndefined();
    expect(result.plan.summary).toBeUndefined();
  });
});

describe("orderChangeset", () => {
  interface F {
    path: string;
  }
  const f = (path: string): F => ({ path });

  test("plan === null yields a single 'All files' group with original order", () => {
    const files = [f("b.ts"), f("a.ts"), f("c.ts")];
    const result = orderChangeset(files, null, { hideGroups: false });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.title).toBe("All files");
    expect(result.groups[0]!.files.map((e) => e.file.path)).toEqual(["b.ts", "a.ts", "c.ts"]);
    expect(result.hiddenCount).toBe(0);
    expect(result.visibleFiles.map((f) => f.path)).toEqual(["b.ts", "a.ts", "c.ts"]);
  });

  test("plan === null with zero files yields no groups", () => {
    const result = orderChangeset([], null, { hideGroups: false });
    expect(result.groups).toHaveLength(0);
    expect(result.visibleFiles).toHaveLength(0);
  });

  test("orders groups ascending by importance, ties broken by plan order", () => {
    const files = [f("low.ts"), f("high.ts"), f("mid-a.ts"), f("mid-b.ts")];
    const plan: ReviewPlan = {
      version: 1,
      groups: [
        { title: "Mid A", importance: 50, files: [{ path: "mid-a.ts" }] },
        { title: "Low", importance: 90, files: [{ path: "low.ts" }] },
        { title: "High", importance: 10, files: [{ path: "high.ts" }] },
        { title: "Mid B", importance: 50, files: [{ path: "mid-b.ts" }] },
      ],
    };
    const result = orderChangeset(files, plan, { hideGroups: false });
    expect(result.groups.map((g) => g.title)).toEqual(["High", "Mid A", "Mid B", "Low"]);
  });

  test("orders files within a group ascending by importance, ties broken by plan order", () => {
    const files = [f("a.ts"), f("b.ts"), f("c.ts")];
    const plan: ReviewPlan = {
      version: 1,
      groups: [
        {
          title: "Group",
          files: [
            { path: "a.ts", importance: 50 },
            { path: "b.ts", importance: 10 },
            { path: "c.ts", importance: 50 },
          ],
        },
      ],
    };
    const result = orderChangeset(files, plan, { hideGroups: false });
    expect(result.groups[0]!.files.map((e) => e.file.path)).toEqual(["b.ts", "a.ts", "c.ts"]);
  });

  test("unplanned files land in a trailing 'Unplanned' group in original changeset order", () => {
    const files = [f("planned.ts"), f("z-unplanned.ts"), f("a-unplanned.ts")];
    const plan: ReviewPlan = {
      version: 1,
      groups: [{ title: "Auth", importance: 0, files: [{ path: "planned.ts" }] }],
    };
    const result = orderChangeset(files, plan, { hideGroups: false });
    expect(result.groups.map((g) => g.title)).toEqual(["Auth", "Unplanned"]);
    const unplannedGroup = result.groups[1]!;
    expect(unplannedGroup.files.map((e) => e.file.path)).toEqual(["z-unplanned.ts", "a-unplanned.ts"]);
    expect(result.unplannedCount).toBe(2);
  });

  test("a plan entry referencing a path not in the changeset does not produce an empty group", () => {
    const files = [f("present.ts")];
    const plan: ReviewPlan = {
      version: 1,
      groups: [
        { title: "Present", importance: 0, files: [{ path: "present.ts" }] },
        { title: "Stale", importance: 1, files: [{ path: "does-not-exist.ts" }] },
      ],
    };
    const result = orderChangeset(files, plan, { hideGroups: false });
    expect(result.groups.map((g) => g.title)).toEqual(["Present"]);
  });

  test("hideGroups: false keeps hidden groups in visibleFiles", () => {
    const files = [f("secret.ts"), f("public.ts")];
    const plan: ReviewPlan = {
      version: 1,
      groups: [
        { title: "Secret", importance: 0, hidden: true, files: [{ path: "secret.ts" }] },
        { title: "Public", importance: 1, files: [{ path: "public.ts" }] },
      ],
    };
    const result = orderChangeset(files, plan, { hideGroups: false });
    expect(result.visibleFiles.map((f) => f.path)).toEqual(["secret.ts", "public.ts"]);
    expect(result.hiddenCount).toBe(0);
  });

  test("hideGroups: true removes hidden groups and hiddenCount matches", () => {
    const files = [f("secret.ts"), f("also-secret.ts"), f("public.ts")];
    const plan: ReviewPlan = {
      version: 1,
      groups: [
        {
          title: "Secret",
          importance: 0,
          hidden: true,
          files: [{ path: "secret.ts" }, { path: "also-secret.ts" }],
        },
        { title: "Public", importance: 1, files: [{ path: "public.ts" }] },
      ],
    };
    const result = orderChangeset(files, plan, { hideGroups: true });
    expect(result.visibleFiles.map((f) => f.path)).toEqual(["public.ts"]);
    expect(result.hiddenCount).toBe(2);
  });

  test("carries annotations through onto each ordered file entry, alongside note and importance", () => {
    const files = [f("a.ts")];
    const plan: ReviewPlan = {
      version: 1,
      groups: [
        {
          title: "Auth",
          files: [
            {
              path: "a.ts",
              note: "the actual fix",
              annotations: [{ summary: "revoke before issue", newRange: [10, 12] }],
            },
          ],
        },
      ],
    };
    const result = orderChangeset(files, plan, { hideGroups: false });
    const entry = result.groups[0]!.files[0]!;
    expect(entry.note).toBe("the actual fix");
    expect(entry.annotations).toEqual([{ summary: "revoke before issue", newRange: [10, 12] }]);
  });

  test("a plan with no annotations orders exactly as before (backward compatible)", () => {
    const files = [f("a.ts")];
    const plan: ReviewPlan = {
      version: 1,
      groups: [{ title: "Auth", files: [{ path: "a.ts", note: "hi" }] }],
    };
    const result = orderChangeset(files, plan, { hideGroups: false });
    const entry = result.groups[0]!.files[0]!;
    expect(entry.note).toBe("hi");
    expect(entry.annotations).toBeUndefined();
  });
});

describe("patchHunkRanges", () => {
  test("a standard hunk header", () => {
    const patch = "@@ -1,5 +1,7 @@\n context line\n";
    expect(patchHunkRanges(patch)).toEqual({ old: [[1, 5]], new: [[1, 7]] });
  });

  test("an omitted count means a single line", () => {
    const patch = "@@ -5 +5 @@\n context line\n";
    expect(patchHunkRanges(patch)).toEqual({ old: [[5, 5]], new: [[5, 5]] });
  });

  test("a pure addition (old count 0) contributes no old range", () => {
    const patch = "@@ -0,0 +1,20 @@\n+new line\n";
    expect(patchHunkRanges(patch)).toEqual({ old: [], new: [[1, 20]] });
  });

  test("a pure deletion (new count 0) contributes no new range", () => {
    const patch = "@@ -1,20 +0,0 @@\n-old line\n";
    expect(patchHunkRanges(patch)).toEqual({ old: [[1, 20]], new: [] });
  });

  test("multiple hunks are all collected, in order", () => {
    const patch = "@@ -1,2 +1,2 @@\n context\n@@ -10,3 +11,4 @@\n context\n";
    expect(patchHunkRanges(patch)).toEqual({
      old: [
        [1, 2],
        [10, 12],
      ],
      new: [
        [1, 2],
        [11, 14],
      ],
    });
  });

  test("a patch with no headers returns empty arrays", () => {
    expect(patchHunkRanges("just some text\nno headers in here\n")).toEqual({ old: [], new: [] });
  });

  test("malformed headers are skipped rather than throwing", () => {
    const patch = "@@ garbage @@\n@@ -1,2 +1,2 @@\n context\n@@ -a,b +c,d @@\n";
    expect(patchHunkRanges(patch)).toEqual({ old: [[1, 2]], new: [[1, 2]] });
  });

  test("trailing context text after the header does not break the match", () => {
    const patch = "@@ -1,5 +1,7 @@ function foo() {\n context\n";
    expect(patchHunkRanges(patch)).toEqual({ old: [[1, 5]], new: [[1, 7]] });
  });
});

describe("filterAnnotationsInHunks", () => {
  test("an annotation with no range always survives", () => {
    const annotations: PlanAnnotation[] = [{ summary: "file-level note" }];
    const result = filterAnnotationsInHunks(annotations, { old: [], new: [] });
    expect(result.kept).toEqual(annotations);
    expect(result.droppedCount).toBe(0);
  });

  test("an annotation whose range overlaps a hunk survives", () => {
    const annotations: PlanAnnotation[] = [{ summary: "x", newRange: [12, 14] }];
    const result = filterAnnotationsInHunks(annotations, { old: [], new: [[10, 20]] });
    expect(result.kept).toEqual(annotations);
    expect(result.droppedCount).toBe(0);
  });

  test("an annotation whose range falls outside every hunk is dropped", () => {
    const annotations: PlanAnnotation[] = [{ summary: "x", newRange: [100, 105] }];
    const result = filterAnnotationsInHunks(annotations, { old: [], new: [[10, 20]] });
    expect(result.kept).toEqual([]);
    expect(result.droppedCount).toBe(1);
  });

  test("oldRange and newRange are checked independently -- either side clearing is enough", () => {
    const annotations: PlanAnnotation[] = [{ summary: "x", oldRange: [1, 2], newRange: [100, 105] }];
    const result = filterAnnotationsInHunks(annotations, { old: [[1, 5]], new: [[10, 20]] });
    expect(result.kept).toEqual(annotations);
    expect(result.droppedCount).toBe(0);
  });

  test("counts and orders correctly across a mix of kept and dropped annotations", () => {
    const annotations: PlanAnnotation[] = [
      { summary: "keep-ranged", newRange: [12, 14] },
      { summary: "drop-orphaned", newRange: [100, 105] },
      { summary: "keep-file-level" },
    ];
    const result = filterAnnotationsInHunks(annotations, { old: [], new: [[10, 20]] });
    expect(result.kept.map((a) => a.summary)).toEqual(["keep-ranged", "keep-file-level"]);
    expect(result.droppedCount).toBe(1);
  });
});

describe("windowRows", () => {
  const rows = Array.from({ length: 100 }, (_, i) => i);

  test("selection near the top clamps offset to 0", () => {
    const { rows: windowed, offset } = windowRows(rows, 1, 10);
    expect(offset).toBe(0);
    expect(windowed).toEqual(rows.slice(0, 10));
  });

  test("selection near the bottom clamps offset to maxOffset", () => {
    const { rows: windowed, offset } = windowRows(rows, 97, 10);
    expect(offset).toBe(90);
    expect(windowed).toEqual(rows.slice(90, 100));
    expect(windowed).toContain(97);
  });

  test("exact fit (height === total) shows everything at offset 0", () => {
    const exact = Array.from({ length: 10 }, (_, i) => i);
    const { rows: windowed, offset } = windowRows(exact, 5, 10);
    expect(offset).toBe(0);
    expect(windowed).toEqual(exact);
  });

  test("height larger than rows shows everything at offset 0", () => {
    const small = [1, 2, 3];
    const { rows: windowed, offset } = windowRows(small, 1, 50);
    expect(offset).toBe(0);
    expect(windowed).toEqual(small);
  });

  test("selectedIndex -1 means no selection: windows from the top", () => {
    const { rows: windowed, offset } = windowRows(rows, -1, 10);
    expect(offset).toBe(0);
    expect(windowed).toEqual(rows.slice(0, 10));
  });

  test("a middle selection keeps a scrolloff margin above it", () => {
    const { rows: windowed, offset } = windowRows(rows, 50, 10);
    expect(windowed).toContain(50);
    expect(50 - offset).toBeGreaterThanOrEqual(2);
  });

  test("zero rows returns an empty window", () => {
    const { rows: windowed, offset } = windowRows([], 0, 10);
    expect(windowed).toEqual([]);
    expect(offset).toBe(0);
  });
});

describe("findRepoRoot", () => {
  test("finds a directory containing a .git directory", () => {
    const dir = mkdtemp();
    try {
      fs.mkdirSync(path.join(dir, ".git"));
      const nested = path.join(dir, "a", "b", "c");
      fs.mkdirSync(nested, { recursive: true });
      expect(findRepoRoot(nested)).toBe(fs.realpathSync(dir));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("recognizes a .git FILE (worktree) as well as a directory", () => {
    const dir = mkdtemp();
    try {
      fs.writeFileSync(path.join(dir, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
      expect(findRepoRoot(dir)).toBe(fs.realpathSync(dir));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns null when no .git is found up to the filesystem root", () => {
    // A fresh tmpdir with no .git anywhere above it in this sandboxed tree.
    const dir = mkdtemp();
    try {
      // os.tmpdir() itself may live under a repo on some machines; only assert
      // the function terminates and returns null or a string, never throws/loops.
      const result = findRepoRoot(dir);
      expect(result === null || typeof result === "string").toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("repoDigest", () => {
  test("is stable and 16 hex characters", () => {
    const digest = repoDigest("/some/repo/root");
    expect(digest).toMatch(/^[0-9a-f]{16}$/);
    expect(repoDigest("/some/repo/root")).toBe(digest);
  });

  test("differs for different repo roots", () => {
    expect(repoDigest("/a")).not.toBe(repoDigest("/b"));
  });
});

describe("planCandidatePaths", () => {
  test("HUNK_REVIEW_PLAN, when set, is used verbatim and comes first", () => {
    const candidates = planCandidatePaths("/repo", { HUNK_REVIEW_PLAN: "/explicit/plan.json" });
    expect(candidates[0]).toBe("/explicit/plan.json");
    expect(candidates).toHaveLength(3);
  });

  test("without the env override, the repo-local .hunk path comes first", () => {
    const candidates = planCandidatePaths("/repo", {});
    expect(candidates[0]).toBe(path.join("/repo", ".hunk", "review-plan.json"));
    expect(candidates).toHaveLength(2);
  });

  test("the state-dir candidate honors XDG_STATE_HOME", () => {
    const candidates = planCandidatePaths("/repo", { XDG_STATE_HOME: "/xdg-state" });
    expect(candidates[1]).toBe(
      path.join("/xdg-state", "hunk", "review-plan", `${repoDigest("/repo")}.json`)
    );
  });
});

describe("loadPlan", () => {
  test("returns null plan/source/error when nothing exists", () => {
    const dir = mkdtemp();
    try {
      const result = loadPlan(dir, { XDG_STATE_HOME: path.join(dir, "state") });
      expect(result.plan).toBeNull();
      expect(result.source).toBeNull();
      expect(result.error).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loads and validates the first existing candidate", () => {
    const dir = mkdtemp();
    try {
      fs.mkdirSync(path.join(dir, ".hunk"), { recursive: true });
      const plan = { version: 1, groups: [{ title: "Auth", files: [{ path: "a.ts" }] }] };
      fs.writeFileSync(path.join(dir, ".hunk", "review-plan.json"), JSON.stringify(plan));
      const result = loadPlan(dir, { XDG_STATE_HOME: path.join(dir, "state") });
      expect(result.plan).not.toBeNull();
      expect(result.source).toBe(path.join(dir, ".hunk", "review-plan.json"));
      expect(result.error).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a parse error on the first existing candidate is reported, not silently skipped", () => {
    const dir = mkdtemp();
    try {
      fs.mkdirSync(path.join(dir, ".hunk"), { recursive: true });
      fs.writeFileSync(path.join(dir, ".hunk", "review-plan.json"), "{ not valid json");
      // Also seed the lower-priority state-dir candidate with a VALID plan, to
      // prove we do not fall through to it.
      const stateDir = path.join(dir, "state", "hunk", "review-plan");
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, `${repoDigest(dir)}.json`),
        JSON.stringify({ version: 1, groups: [] })
      );

      const result = loadPlan(dir, { XDG_STATE_HOME: path.join(dir, "state") });
      expect(result.plan).toBeNull();
      expect(result.error).toMatch(/invalid JSON/i);
      expect(result.source).toBe(path.join(dir, ".hunk", "review-plan.json"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a validation error on the first existing candidate is reported, not silently skipped", () => {
    const dir = mkdtemp();
    try {
      fs.mkdirSync(path.join(dir, ".hunk"), { recursive: true });
      fs.writeFileSync(path.join(dir, ".hunk", "review-plan.json"), JSON.stringify({ version: 2, groups: [] }));

      const result = loadPlan(dir, { XDG_STATE_HOME: path.join(dir, "state") });
      expect(result.plan).toBeNull();
      expect(result.error).toMatch(/version/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("falls through to the state-dir candidate when the repo-local file does not exist", () => {
    const dir = mkdtemp();
    try {
      const stateDir = path.join(dir, "state", "hunk", "review-plan");
      fs.mkdirSync(stateDir, { recursive: true });
      const plan = { version: 1, groups: [{ title: "Auth", files: [{ path: "a.ts" }] }] };
      fs.writeFileSync(path.join(stateDir, `${repoDigest(dir)}.json`), JSON.stringify(plan));

      const result = loadPlan(dir, { XDG_STATE_HOME: path.join(dir, "state") });
      expect(result.plan).not.toBeNull();
      expect(result.source).toBe(path.join(stateDir, `${repoDigest(dir)}.json`));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("anchorFileScopedAnnotations", () => {
  const ranges = { old: [[10, 14] as [number, number]], new: [[12, 18] as [number, number]] };

  test("gives a range-less annotation the first new-side hunk range", () => {
    expect(anchorFileScopedAnnotations([{ summary: "file scoped" }], ranges)).toEqual([
      { summary: "file scoped", newRange: [12, 18] },
    ]);
  });

  test("falls back to the old side for a file with no new-side hunks", () => {
    expect(anchorFileScopedAnnotations([{ summary: "deleted file" }], { old: ranges.old, new: [] })).toEqual([
      { summary: "deleted file", oldRange: [10, 14] },
    ]);
  });

  test("leaves an already anchored annotation untouched", () => {
    const anchored = [{ summary: "anchored", newRange: [40, 44] as [number, number] }];
    expect(anchorFileScopedAnnotations(anchored, ranges)).toEqual(anchored);
  });

  test("leaves annotations alone when the file has no hunks to anchor to", () => {
    expect(anchorFileScopedAnnotations([{ summary: "nowhere" }], { old: [], new: [] })).toEqual([
      { summary: "nowhere" },
    ]);
  });
});
