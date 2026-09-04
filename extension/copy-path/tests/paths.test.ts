import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildVariants, findRepoRoot, formatReference } from "../paths";

function mkdtemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "copy-path-test-"));
}

const ROOT = "/home/dev/proj";

describe("formatReference", () => {
  test("carries the line as an @path#Lx fragment", () => {
    expect(formatReference("src/a.ts", 42)).toBe("@src/a.ts#L42");
  });

  test("drops the fragment when there is no current line", () => {
    expect(formatReference("src/a.ts", null)).toBe("@src/a.ts");
  });

  test("keeps line 1 rather than treating it as absent", () => {
    expect(formatReference("src/a.ts", 1)).toBe("@src/a.ts#L1");
  });
});

describe("buildVariants", () => {
  test("offers relative, absolute and filename when launched at the repo root", () => {
    const variants = buildVariants({ repoPath: "src/a.ts", repoRoot: ROOT, cwd: ROOT, line: null });
    expect(variants).toEqual([
      { label: "Relative", value: "src/a.ts" },
      { label: "Absolute", value: "/home/dev/proj/src/a.ts" },
      { label: "Filename", value: "a.ts" },
    ]);
  });

  test("drops CWD relative when it is the repo-relative path", () => {
    const variants = buildVariants({ repoPath: "src/a.ts", repoRoot: ROOT, cwd: ROOT, line: null });
    expect(variants.some((v) => v.label === "CWD relative")).toBe(false);
  });

  test("offers CWD relative when hunk was launched in a subdirectory", () => {
    const variants = buildVariants({
      repoPath: "src/a.ts",
      repoRoot: ROOT,
      cwd: `${ROOT}/src`,
      line: null,
    });
    expect(variants).toContainEqual({ label: "CWD relative", value: "a.ts" });
  });

  test("walks up out of the cwd when the file is above it", () => {
    const variants = buildVariants({
      repoPath: "src/a.ts",
      repoRoot: ROOT,
      cwd: `${ROOT}/src/nested`,
      line: null,
    });
    expect(variants).toContainEqual({ label: "CWD relative", value: "../a.ts" });
  });

  test("drops the filename when the file sits at the repo root", () => {
    const variants = buildVariants({ repoPath: "README.md", repoRoot: ROOT, cwd: ROOT, line: null });
    expect(variants.map((v) => v.label)).toEqual(["Relative", "Absolute"]);
  });

  test("appends the reference only when a current line exists", () => {
    const without = buildVariants({ repoPath: "src/a.ts", repoRoot: ROOT, cwd: ROOT, line: null });
    expect(without.some((v) => v.label === "Reference")).toBe(false);

    const withLine = buildVariants({ repoPath: "src/a.ts", repoRoot: ROOT, cwd: ROOT, line: 42 });
    expect(withLine.at(-1)).toEqual({ label: "Reference", value: "@src/a.ts#L42" });
  });

  test("resolves absolute against the cwd when there is no repo root", () => {
    const variants = buildVariants({ repoPath: "src/a.ts", repoRoot: null, cwd: "/tmp/work", line: null });
    expect(variants).toContainEqual({ label: "Absolute", value: "/tmp/work/src/a.ts" });
  });

  test("never returns an empty list, whatever collapses", () => {
    const variants = buildVariants({ repoPath: "a.ts", repoRoot: "/", cwd: "/", line: null });
    expect(variants.length).toBeGreaterThan(0);
    expect(variants[0]).toEqual({ label: "Relative", value: "a.ts" });
  });
});

describe("findRepoRoot", () => {
  test("finds the directory holding .git from a nested start", () => {
    const dir = mkdtemp();
    const root = fs.realpathSync(dir);
    fs.mkdirSync(path.join(root, ".git"));
    fs.mkdirSync(path.join(root, "a", "b"), { recursive: true });
    expect(findRepoRoot(path.join(root, "a", "b"))).toBe(root);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("finds a .git file, as a worktree or submodule has", () => {
    const dir = mkdtemp();
    const root = fs.realpathSync(dir);
    fs.writeFileSync(path.join(root, ".git"), "gitdir: /elsewhere\n");
    expect(findRepoRoot(root)).toBe(root);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("stops at the nearest .git when repositories nest", () => {
    const dir = mkdtemp();
    const outer = fs.realpathSync(dir);
    const inner = path.join(outer, "vendor", "inner");
    fs.mkdirSync(path.join(outer, ".git"));
    fs.mkdirSync(inner, { recursive: true });
    fs.mkdirSync(path.join(inner, ".git"));
    expect(findRepoRoot(path.join(inner, "src"))).toBe(inner);
    fs.rmSync(outer, { recursive: true, force: true });
  });

  // Not asserted as null: whether the walk runs out of ancestors depends on
  // whether anything above the temp directory happens to hold a `.git`, and
  // a stray one in /tmp is enough to make that machine-specific. What is
  // testable is that no directory is claimed on the strength of its name.
  test("never claims a directory that has no .git of its own", () => {
    const dir = mkdtemp();
    const root = fs.realpathSync(dir);
    const nested = path.join(root, "a", "b");
    fs.mkdirSync(nested, { recursive: true });
    const found = findRepoRoot(nested);
    expect(found).not.toBe(nested);
    expect(found).not.toBe(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
