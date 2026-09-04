/**
 * The spellings of one reviewed file's path, and the `@path#Lx` reference form.
 *
 * Hunk hands extensions a repo-root-relative path (`ExtensionDiffFile.path`),
 * which is already the spelling you want to paste into an agent nine times out
 * of ten -- so it leads, and everything else is derived from it. The absolute
 * form needs the repo root, which the extension API does not carry, hence the
 * `.git` walk below.
 *
 * Variants that collapse into one another are dropped rather than listed twice:
 * a file at the repo root has no distinct filename, and hunk launched at the
 * repo root has no distinct CWD-relative path. A select dialog offering the
 * same string under two labels asks the user to make a difference that isn't
 * there.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** Walk up from `startDir` looking for `.git`. Null at the filesystem root. */
export function findRepoRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    // A file, not just a directory: that is what a worktree and a submodule have.
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The `@path#Lx` form an agent reads as a file reference.
 *
 * Hunk's current-line marker addresses a single line rather than a range, so
 * there is no `#Lx-Ly` spelling to produce here. With no marker on, the bare
 * `@path` is still a reference -- just a less precise one.
 */
export function formatReference(repoPath: string, line: number | null): string {
  return line === null ? `@${repoPath}` : `@${repoPath}#L${line}`;
}

export interface PathVariant {
  readonly label: string;
  readonly value: string;
}

export interface VariantInput {
  /** Repo-root-relative, exactly as hunk reports it. */
  readonly repoPath: string;
  /** Null when the review is not inside a git repository. */
  readonly repoRoot: string | null;
  readonly cwd: string;
  /** One-based source line under the current-line marker, or null. */
  readonly line: number | null;
}

/**
 * Every distinct spelling worth copying, in the order they are offered.
 *
 * Always non-empty: `Relative` is the input itself, so it survives whatever
 * else collapses.
 */
export function buildVariants(input: VariantInput): PathVariant[] {
  const absolute = input.repoRoot
    ? path.resolve(input.repoRoot, input.repoPath)
    : path.resolve(input.cwd, input.repoPath);

  const candidates: PathVariant[] = [
    { label: "Relative", value: input.repoPath },
    { label: "Absolute", value: absolute },
    { label: "CWD relative", value: path.relative(input.cwd, absolute) },
    { label: "Filename", value: path.basename(input.repoPath) },
  ];

  if (input.line !== null) {
    candidates.push({ label: "Reference", value: formatReference(input.repoPath, input.line) });
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (candidate.value === "" || seen.has(candidate.value)) return false;
    seen.add(candidate.value);
    return true;
  });
}
