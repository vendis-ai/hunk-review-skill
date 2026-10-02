import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildMarker,
  deliveredIds,
  loopDir,
  markerPath,
  MODE_CHOICES,
  modeFromLabel,
  readHead,
  readWindow,
  rememberFileKeys,
  settleSent,
  windowClosed,
  windowOpened,
  windowPath,
  writeJsonAtomic,
  type BuildMarkerInput,
  type SnapshotLike,
  type SnapshotNoteLike,
} from "../go";
import { repoDigest } from "../plan";

function mkdtemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "review-plan-go-test-"));
}

const NOW = new Date("2026-10-01T12:00:00.000Z");

function note(overrides: Partial<SnapshotNoteLike> = {}): SnapshotNoteLike {
  return {
    id: "user:1-1",
    source: "user",
    fileKey: "file:a",
    anchor: { newRange: [10, 12], preferred: { side: "new", line: 11 } },
    summary: "why is this here?",
    resolution: "active",
    ...overrides,
  };
}

function input(overrides: Partial<BuildMarkerInput> = {}): BuildMarkerInput {
  return {
    kind: "go",
    mode: "fix-clear",
    instruction: null,
    repoRoot: "/repo",
    head: "a".repeat(40),
    now: NOW,
    snapshot: { files: [{ fileKey: "file:a", path: "src/a.ts" }], notes: [note()] },
    fileKeyPaths: new Map(),
    notePaths: new Map(),
    sentIds: new Set(),
    ...overrides,
  };
}

describe("modeFromLabel", () => {
  test("maps every offered label back to its mode", () => {
    for (const choice of MODE_CHOICES) expect(modeFromLabel(choice.label)).toBe(choice.mode);
  });

  test("offers the ask-about-the-rest mode first, as the default", () => {
    expect(MODE_CHOICES[0]?.mode).toBe("fix-clear");
  });

  test("a cancelled dialog or an unknown label is no mode", () => {
    expect(modeFromLabel(null)).toBeNull();
    expect(modeFromLabel("something else")).toBeNull();
  });
});

describe("paths", () => {
  test("live in a .loop directory next to the plan, keyed by the repo digest", () => {
    const env = { XDG_STATE_HOME: "/state" };
    const dir = `/state/hunk/review-plan/${repoDigest("/repo")}.loop`;
    expect(loopDir("/repo", env)).toBe(dir);
    expect(markerPath("/repo", env)).toBe(`${dir}/go.json`);
    expect(windowPath("/repo", env)).toBe(`${dir}/window.json`);
  });
});

describe("buildMarker", () => {
  test("carries mode, trimmed instruction, head and time", () => {
    const marker = buildMarker(input({ instruction: "  also rename foo  " }));
    expect(marker).toMatchObject({
      version: 1,
      kind: "go",
      mode: "fix-clear",
      instruction: "also rename foo",
      repoRoot: "/repo",
      head: "a".repeat(40),
      createdAt: "2026-10-01T12:00:00.000Z",
    });
  });

  test("a blank instruction is no instruction", () => {
    expect(buildMarker(input({ instruction: "   " })).instruction).toBeNull();
    expect(buildMarker(input({ instruction: "" })).instruction).toBeNull();
  });

  test("an approval carries no mode", () => {
    expect(buildMarker(input({ kind: "approve", mode: "fix-all" })).mode).toBeNull();
  });

  test("resolves a note's path through the snapshot's own files", () => {
    const [first] = buildMarker(input()).notes;
    expect(first).toMatchObject({ id: "user:1-1", file: "src/a.ts", side: "new", line: 11, newRange: [10, 12] });
  });

  test("falls back to paths learned earlier, then to note_created paths, then null", () => {
    const snapshot: SnapshotLike = {
      files: [],
      notes: [
        note({ id: "user:1-1", fileKey: "file:gone" }),
        note({ id: "user:1-2", fileKey: "file:never-seen" }),
        note({ id: "user:1-3", fileKey: "file:unknown" }),
      ],
    };
    const marker = buildMarker(
      input({
        snapshot,
        fileKeyPaths: new Map([["file:gone", "src/gone.ts"]]),
        notePaths: new Map([["user:1-2", "src/created.ts"]]),
      })
    );
    expect(marker.notes.map((n) => n.file)).toEqual(["src/gone.ts", "src/created.ts", null]);
  });

  test("takes the line from the preferred anchor, then the new side, then the old side", () => {
    const snapshot: SnapshotLike = {
      files: [{ fileKey: "file:a", path: "a.ts" }],
      notes: [
        note({ id: "n1", anchor: { newRange: [5, 7] } }),
        note({ id: "n2", anchor: { oldRange: [3, 3] } }),
        note({ id: "n3", anchor: {} }),
      ],
    };
    const lines = buildMarker(input({ snapshot })).notes.map((n) => [n.side, n.line]);
    expect(lines).toEqual([
      ["new", 5],
      ["old", 3],
      [null, null],
    ]);
  });

  test("marks only user notes no consumed send delivered as new", () => {
    const snapshot: SnapshotLike = {
      files: [{ fileKey: "file:a", path: "a.ts" }],
      notes: [
        note({ id: "user:1-1" }),
        note({ id: "user:1-2" }),
        note({ id: "mcp:9", source: "agent", parentId: "user:1-1", summary: "Fixed." }),
      ],
    };
    const marker = buildMarker(input({ snapshot, sentIds: new Set(["user:1-1"]) }));
    expect(marker.notes.map((n) => [n.id, n.new])).toEqual([
      ["user:1-1", false],
      ["user:1-2", true],
      ["mcp:9", false],
    ]);
    expect(marker.notes[2]?.parentId).toBe("user:1-1");
  });

  test("copies ranges instead of sharing the host's arrays", () => {
    const range: [number, number] = [1, 2];
    const snapshot: SnapshotLike = {
      files: [{ fileKey: "file:a", path: "a.ts" }],
      notes: [note({ anchor: { oldRange: range } })],
    };
    const marker = buildMarker(input({ snapshot }));
    expect(marker.notes[0]?.oldRange).toEqual([1, 2]);
    expect(marker.notes[0]?.oldRange).not.toBe(range);
  });

  test("a missing snapshot still yields a marker, with no notes", () => {
    expect(buildMarker(input({ snapshot: null })).notes).toEqual([]);
  });

  test("deliveredIds lists the new user notes", () => {
    const snapshot: SnapshotLike = {
      files: [{ fileKey: "file:a", path: "a.ts" }],
      notes: [note({ id: "user:1-1" }), note({ id: "user:1-2" }), note({ id: "mcp:1", source: "agent" })],
    };
    const marker = buildMarker(input({ snapshot, sentIds: new Set(["user:1-1"]) }));
    expect([...deliveredIds(marker)]).toEqual(["user:1-2"]);
  });
});

describe("settleSent", () => {
  test("a consumed marker's notes count as sent", () => {
    const next = settleSent(new Set(["a"]), new Set(["b"]), false);
    expect([...next].sort()).toEqual(["a", "b"]);
  });

  test("a marker still pending keeps its notes new, so a second send re-delivers them", () => {
    const next = settleSent(new Set(["a"]), new Set(["b"]), true);
    expect([...next]).toEqual(["a"]);
  });

  test("never mutates its inputs", () => {
    const sent = new Set(["a"]);
    settleSent(sent, new Set(["b"]), false);
    expect([...sent]).toEqual(["a"]);
  });
});

describe("rememberFileKeys", () => {
  test("adds the snapshot's files and keeps what it already knew", () => {
    const known = new Map([["file:old", "old.ts"]]);
    const next = rememberFileKeys(known, { files: [{ fileKey: "file:new", path: "new.ts" }], notes: [] });
    expect([...next.entries()].sort()).toEqual([
      ["file:new", "new.ts"],
      ["file:old", "old.ts"],
    ]);
    expect(known.size).toBe(1);
  });
});

describe("window presence", () => {
  test("closing marks the window closed when it is still ours", () => {
    const opened = windowOpened(42, NOW);
    expect(windowClosed(opened, 42, new Date("2026-10-01T13:00:00.000Z"))).toEqual({
      version: 1,
      pid: 42,
      startedAt: "2026-10-01T12:00:00.000Z",
      closedAt: "2026-10-01T13:00:00.000Z",
    });
  });

  test("closing leaves another window's record alone", () => {
    expect(windowClosed(windowOpened(42, NOW), 7, NOW)).toBeNull();
    expect(windowClosed(null, 7, NOW)).toBeNull();
  });

  test("round-trips through disk, and a missing or corrupt file reads as null", () => {
    const dir = mkdtemp();
    const file = path.join(dir, "nested", "window.json");
    expect(readWindow(file)).toBeNull();
    expect(writeJsonAtomic(file, windowOpened(42, NOW))).toBe(true);
    expect(readWindow(file)).toEqual(windowOpened(42, NOW));
    fs.writeFileSync(file, "{not json");
    expect(readWindow(file)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ version: 2, pid: 1, startedAt: "x" }));
    expect(readWindow(file)).toBeNull();
  });
});

describe("writeJsonAtomic", () => {
  test("creates the parent directory and leaves no temp file behind", () => {
    const dir = mkdtemp();
    const file = path.join(dir, "a", "b", "go.json");
    expect(writeJsonAtomic(file, { version: 1 })).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ version: 1 });
    expect(fs.readdirSync(path.dirname(file))).toEqual(["go.json"]);
  });

  test("reports failure instead of throwing", () => {
    const dir = mkdtemp();
    const blocker = path.join(dir, "file");
    fs.writeFileSync(blocker, "");
    expect(writeJsonAtomic(path.join(blocker, "go.json"), {})).toBe(false);
  });
});

describe("readHead", () => {
  test("reads the commit HEAD points at", () => {
    const dir = mkdtemp();
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
        stdio: "ignore",
      });
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "init");
    expect(readHead(dir)).toMatch(/^[0-9a-f]{40}$/);
  });

  test("is null outside a repository", () => {
    expect(readHead(mkdtemp())).toBeNull();
  });
});
