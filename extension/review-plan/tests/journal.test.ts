import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MarkerNote } from "../go";
import {
  appendEntry,
  createdEntry,
  journalPath,
  snapshotDue,
  snapshotEntry,
  snapshotKey,
  type JournalContext,
  type SavedNoteLike,
} from "../journal";
import { repoDigest } from "../plan";

function mkdtemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "review-plan-journal-test-"));
}

const CTX: JournalContext = {
  now: new Date("2026-10-15T12:00:00.000Z"),
  planId: "plan-1",
  head: "a".repeat(40),
  window: "42@2026-10-15T11:00:00.000Z",
};

function saved(overrides: Partial<SavedNoteLike> = {}): SavedNoteLike {
  return {
    id: "user:1-1",
    filePath: "src/a.ts",
    hunkIndex: 0,
    side: "new",
    line: 11,
    body: "why is this here?",
    draft: false,
    ...overrides,
  };
}

function marked(overrides: Partial<MarkerNote> = {}): MarkerNote {
  return {
    id: "user:1-1",
    source: "user",
    file: "src/a.ts",
    side: "new",
    line: 11,
    summary: "why is this here?",
    resolution: "active",
    new: true,
    ...overrides,
  };
}

describe("journalPath", () => {
  test("sits next to the plan, keyed by the repo digest", () => {
    expect(journalPath("/repo", { XDG_STATE_HOME: "/state" })).toBe(
      `/state/hunk/review-plan/${repoDigest("/repo")}.notes.jsonl`
    );
  });
});

describe("createdEntry", () => {
  test("records a saved note with its body, place, plan and window", () => {
    expect(createdEntry(saved(), CTX)).toEqual({
      v: 1,
      event: "created",
      at: "2026-10-15T12:00:00.000Z",
      planId: "plan-1",
      head: "a".repeat(40),
      window: "42@2026-10-15T11:00:00.000Z",
      note: {
        id: "user:1-1",
        source: "user",
        file: "src/a.ts",
        side: "new",
        line: 11,
        hunkIndex: 0,
        summary: "why is this here?",
      },
    });
  });

  test("skips a draft, which is not a saved note yet", () => {
    expect(createdEntry(saved({ draft: true }), CTX)).toBeNull();
  });
});

describe("snapshotEntry", () => {
  test("records the whole review and the command that took it, without the hand-off's new flag", () => {
    const entry = snapshotEntry([marked(), marked({ id: "agent:1", source: "agent", parentId: "user:1-1" })], "toggleViewed", CTX);
    expect(entry).toMatchObject({ v: 1, event: "snapshot", trigger: "toggleViewed", planId: "plan-1" });
    expect(entry.notes.map((n) => n.id)).toEqual(["user:1-1", "agent:1"]);
    expect(entry.notes.every((n) => !("new" in n))).toBe(true);
    expect(entry.notes[1]?.parentId).toBe("user:1-1");
  });
});

describe("snapshotKey", () => {
  test("ignores note order and the new flag", () => {
    const a = marked({ id: "a" });
    const b = marked({ id: "b" });
    expect(snapshotKey([a, b])).toBe(snapshotKey([marked({ id: "b", new: false }), a]));
  });

  test("changes when a note is added, edited, resolved or deleted", () => {
    const base = snapshotKey([marked()]);
    expect(snapshotKey([marked(), marked({ id: "b" })])).not.toBe(base);
    expect(snapshotKey([marked({ summary: "edited" })])).not.toBe(base);
    expect(snapshotKey([marked({ resolution: "stale" })])).not.toBe(base);
    expect(snapshotKey([])).not.toBe(base);
  });
});

describe("snapshotDue", () => {
  const key = snapshotKey([marked()]);

  test("skips a snapshot whose notes match the last line", () => {
    expect(snapshotDue(key, key, "toggleViewed")).toBe(false);
    expect(snapshotDue(key, snapshotKey([]), "toggleViewed")).toBe(true);
  });

  test("journals every send and approval, even with the same notes", () => {
    expect(snapshotDue(key, key, "sendToAgent")).toBe(true);
    expect(snapshotDue(key, key, "approveReview")).toBe(true);
  });
});

describe("appendEntry", () => {
  test("creates the parent directory and appends one line per entry", () => {
    const file = path.join(mkdtemp(), "a", "b", "x.notes.jsonl");
    const first = createdEntry(saved(), CTX);
    const second = createdEntry(saved({ id: "user:1-2", body: "line one\nline two" }), CTX);
    if (!first || !second) throw new Error("entries expected");
    expect(appendEntry(file, first)).toBe(true);
    expect(appendEntry(file, second)).toBe(true);
    const lines = fs.readFileSync(file, "utf8").split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("");
    expect(JSON.parse(lines[1] ?? "").note.summary).toBe("line one\nline two");
  });

  test("starts a new line after one a crash cut short, so only that line is lost", () => {
    const file = path.join(mkdtemp(), "x.notes.jsonl");
    fs.writeFileSync(file, '{"v":1,"event":"created","at":"2026-10-15T12:');
    const entry = createdEntry(saved(), CTX);
    if (!entry) throw new Error("entry expected");
    expect(appendEntry(file, entry)).toBe(true);
    const lines = fs.readFileSync(file, "utf8").split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[1] ?? "").note.id).toBe("user:1-1");
  });

  test("reports failure instead of throwing", () => {
    const blocker = path.join(mkdtemp(), "file");
    fs.writeFileSync(blocker, "");
    const entry = createdEntry(saved(), CTX);
    if (!entry) throw new Error("entry expected");
    expect(appendEntry(path.join(blocker, "x.notes.jsonl"), entry)).toBe(false);
  });
});
