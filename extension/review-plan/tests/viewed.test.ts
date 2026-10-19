import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { classify, patchDigest, prune, readViewed, shownOf, toggle, writeViewed, type ViewedState } from "../viewed";

function mkdtemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "review-plan-viewed-test-"));
}

const PATCH_A = "diff --git a/a.ts b/a.ts\n+hello\n";
const PATCH_A2 = "diff --git a/a.ts b/a.ts\n+hello world\n";

describe("patchDigest", () => {
  test("is stable and 16 hex characters", () => {
    const digest = patchDigest(PATCH_A);
    expect(digest).toMatch(/^[0-9a-f]{16}$/);
    expect(patchDigest(PATCH_A)).toBe(digest);
  });

  test("differs for different patch text", () => {
    expect(patchDigest(PATCH_A)).not.toBe(patchDigest(PATCH_A2));
  });
});

describe("classify", () => {
  test("unseen when nothing stored", () => {
    const state: ViewedState = { version: 1, entries: {} };
    const result = classify(state, [{ path: "a.ts", patch: PATCH_A }]);
    expect(result.get("a.ts")).toBe("unseen");
  });

  test("viewed when the stored digest matches the current patch", () => {
    const state: ViewedState = { version: 1, entries: { "a.ts": patchDigest(PATCH_A) } };
    const result = classify(state, [{ path: "a.ts", patch: PATCH_A }]);
    expect(result.get("a.ts")).toBe("viewed");
  });

  test("changed when the stored digest differs from the current patch", () => {
    const state: ViewedState = { version: 1, entries: { "a.ts": patchDigest(PATCH_A) } };
    const result = classify(state, [{ path: "a.ts", patch: PATCH_A2 }]);
    expect(result.get("a.ts")).toBe("changed");
  });

  test("classifies a whole batch of files at once", () => {
    const state: ViewedState = { version: 1, entries: { "a.ts": patchDigest(PATCH_A) } };
    const result = classify(state, [
      { path: "a.ts", patch: PATCH_A },
      { path: "b.ts", patch: PATCH_A },
    ]);
    expect(result.get("a.ts")).toBe("viewed");
    expect(result.get("b.ts")).toBe("unseen");
  });
});

describe("toggle", () => {
  test("marking an unseen file sets it to viewed against the current digest", () => {
    const state: ViewedState = { version: 1, entries: {} };
    const next = toggle(state, "a.ts", PATCH_A);
    expect(classify(next, [{ path: "a.ts", patch: PATCH_A }]).get("a.ts")).toBe("viewed");
  });

  test("toggling a viewed file removes the entry (back to unseen)", () => {
    const viewed: ViewedState = { version: 1, entries: { "a.ts": patchDigest(PATCH_A) } };
    const next = toggle(viewed, "a.ts", PATCH_A);
    expect(next.entries["a.ts"]).toBeUndefined();
    expect(classify(next, [{ path: "a.ts", patch: PATCH_A }]).get("a.ts")).toBe("unseen");
  });

  test("toggling a 'changed' file re-marks it against the NEW digest rather than clearing it", () => {
    const stale: ViewedState = { version: 1, entries: { "a.ts": patchDigest(PATCH_A) } };
    expect(classify(stale, [{ path: "a.ts", patch: PATCH_A2 }]).get("a.ts")).toBe("changed");

    const next = toggle(stale, "a.ts", PATCH_A2);
    expect(next.entries["a.ts"]).toBe(patchDigest(PATCH_A2));
    expect(classify(next, [{ path: "a.ts", patch: PATCH_A2 }]).get("a.ts")).toBe("viewed");
  });

  test("is pure: does not mutate the input state", () => {
    const state: ViewedState = { version: 1, entries: {} };
    const before = JSON.stringify(state);
    toggle(state, "a.ts", PATCH_A);
    expect(JSON.stringify(state)).toBe(before);
  });
});

describe("prune", () => {
  test("drops entries for paths no longer present and returns a new object", () => {
    const state: ViewedState = {
      version: 1,
      entries: { "a.ts": "digest-a", "b.ts": "digest-b" },
    };
    const pruned = prune(state, ["a.ts"]);
    expect(pruned).not.toBe(state);
    expect(pruned.entries).toEqual({ "a.ts": "digest-a" });
    expect(state.entries).toEqual({ "a.ts": "digest-a", "b.ts": "digest-b" }); // untouched
  });

  test("keeps everything when all paths are still present", () => {
    const state: ViewedState = { version: 1, entries: { "a.ts": "digest-a" } };
    const pruned = prune(state, ["a.ts", "b.ts"]);
    expect(pruned.entries).toEqual({ "a.ts": "digest-a" });
  });
});

describe("shownOf", () => {
  const PATCH_B = "diff --git a/b.ts b/b.ts\n+b\n";
  const files = [
    { path: "a.ts", patch: PATCH_A2 },
    { path: "b.ts", patch: PATCH_B },
    { path: "c.ts", patch: PATCH_B },
  ];

  test("names the files shown, the ones whose mark matches, and the ones that changed since", () => {
    const state: ViewedState = {
      version: 1,
      entries: { "a.ts": patchDigest(PATCH_A), "b.ts": patchDigest(PATCH_B), "gone.ts": "x" },
    };
    expect(shownOf(state, files, "plan-1", new Date("2026-10-19T10:00:00.000Z"))).toEqual({
      planId: "plan-1",
      at: "2026-10-19T10:00:00.000Z",
      files: ["a.ts", "b.ts", "c.ts"],
      viewed: ["b.ts"],
      changed: ["a.ts"],
    });
  });

  test("names a file once, however often it is listed", () => {
    const shown = shownOf({ version: 1, entries: {} }, [...files, files[0]!], null, new Date());
    expect(shown.files).toEqual(["a.ts", "b.ts", "c.ts"]);
  });
});

describe("readViewed / writeViewed round trip", () => {
  test("readViewed on a missing file returns an empty state without throwing", () => {
    const dir = mkdtemp();
    try {
      const result = readViewed(path.join(dir, "does-not-exist.json"));
      expect(result).toEqual({ version: 1, entries: {} });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("readViewed on corrupt JSON returns an empty state without throwing", () => {
    const dir = mkdtemp();
    try {
      const filePath = path.join(dir, "viewed.json");
      fs.writeFileSync(filePath, "{ not valid json");
      const result = readViewed(filePath);
      expect(result).toEqual({ version: 1, entries: {} });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("readViewed on a structurally wrong JSON shape returns an empty state", () => {
    const dir = mkdtemp();
    try {
      const filePath = path.join(dir, "viewed.json");
      fs.writeFileSync(filePath, JSON.stringify({ version: 2, entries: {} }));
      expect(readViewed(filePath)).toEqual({ version: 1, entries: {} });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("writeViewed creates parent directories and round-trips through readViewed", () => {
    const dir = mkdtemp();
    try {
      const filePath = path.join(dir, "nested", "deep", "viewed.json");
      const state: ViewedState = { version: 1, entries: { "a.ts": "digest-a" } };
      const ok = writeViewed(filePath, state);
      expect(ok).toBe(true);
      expect(fs.existsSync(filePath)).toBe(true);
      expect(readViewed(filePath)).toEqual(state);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("writeViewed writes what the window showed next to the marks, and readViewed reads only the marks", () => {
    const dir = mkdtemp();
    try {
      const filePath = path.join(dir, "viewed.json");
      const state: ViewedState = { version: 1, entries: { "a.ts": patchDigest(PATCH_A) } };
      const shown = shownOf(state, [{ path: "a.ts", patch: PATCH_A }], "plan-1", new Date());
      expect(writeViewed(filePath, state, shown)).toBe(true);
      expect(JSON.parse(fs.readFileSync(filePath, "utf8")).shown).toEqual(shown);
      expect(readViewed(filePath)).toEqual(state);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("writeViewed writes atomically (no leftover .tmp file after success)", () => {
    const dir = mkdtemp();
    try {
      const filePath = path.join(dir, "viewed.json");
      writeViewed(filePath, { version: 1, entries: {} });
      expect(fs.existsSync(`${filePath}.tmp`)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("writeViewed never throws even for an unwritable path", () => {
    // A path under a file (not a directory) can never be mkdir'd into.
    const dir = mkdtemp();
    try {
      const blocker = path.join(dir, "blocker");
      fs.writeFileSync(blocker, "x");
      const impossiblePath = path.join(blocker, "viewed.json");
      expect(() => writeViewed(impossiblePath, { version: 1, entries: {} })).not.toThrow();
      expect(writeViewed(impossiblePath, { version: 1, entries: {} })).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
