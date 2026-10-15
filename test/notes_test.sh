#!/usr/bin/env bash
#
# Tests for `hunk-plan notes`, which reads back the notes journal the
# review-plan extension writes (extension/review-plan/journal.ts). Pure bash,
# like wait_test.sh, so it runs anywhere hunk-plan itself runs (bash, git, jq).
#
#   test/notes_test.sh
#
# Runs against a throwaway git repo and a throwaway XDG_STATE_HOME. The
# journal lines are written here the way the extension writes them.
#
# Set TEST_BASH=/bin/bash to pin the interpreter, as in render_test.sh.

set -uo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
HUNK_PLAN="$REPO_ROOT/bin/hunk-plan"

run_plan() {
  if [[ -n ${TEST_BASH:-} ]]; then
    "$TEST_BASH" "$HUNK_PLAN" "$@"
  else
    "$HUNK_PLAN" "$@"
  fi
}

PASS=0
FAIL=0

ok() {
  PASS=$((PASS + 1))
  printf '  ok   %s\n' "$1"
}
no() {
  FAIL=$((FAIL + 1))
  printf '  FAIL %s\n' "$1"
}
assert_eq() {
  if [[ "$1" == "$2" ]]; then ok "$3"; else no "$3 (want '$2', got '$1')"; fi
}
assert_no_file() {
  if [[ -e $1 ]]; then no "$2 (still there: $1)"; else ok "$2"; fi
}
assert_file() {
  if [[ -e $1 ]]; then ok "$2"; else no "$2 (missing: $1)"; fi
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

export XDG_STATE_HOME="$TMP/state"

FIXTURE="$TMP/repo"
mkdir -p "$FIXTURE"
cd "$FIXTURE" || exit 1
git init -q .
git -c user.email=t@example.com -c user.name=t commit -q --allow-empty -m init

VIEWED=$(run_plan viewed)
JOURNAL="${VIEWED%.viewed.json}.notes.jsonl"
OUT="$TMP/out.txt"
ERR="$TMP/err.txt"

# run_notes <args...>: sets RC, stdout in $OUT, stderr in $ERR.
run_notes() {
  run_plan notes "$@" >"$OUT" 2>"$ERR"
  RC=$?
}

# ids: the note ids `notes --json` prints, comma-separated, in output order.
ids() {
  jq -r '[.notes[].id] | join(",")' "$OUT"
}

# created <window> <planId> <id> <file> <line> <body>: a saved note's line.
created() {
  jq -cn --arg w "$1" --arg p "$2" --arg id "$3" --arg f "$4" --argjson l "$5" --arg b "$6" '{
    v: 1, event: "created", at: "2026-10-15T12:00:00.000Z", planId: $p, head: null, window: $w,
    note: {id: $id, source: "user", file: $f, side: "new", line: $l, hunkIndex: 0, summary: $b}
  }' >>"$JOURNAL"
}

# snapshot <window> <planId> <notes-json>: a snapshot line.
snapshot() {
  jq -cn --arg w "$1" --arg p "$2" --argjson n "$3" '{
    v: 1, event: "snapshot", at: "2026-10-15T12:05:00.000Z", planId: $p, head: null, window: $w,
    trigger: "toggleViewed", notes: $n
  }' >>"$JOURNAL"
}

echo "no journal yet"

run_notes
assert_eq "$RC" "0" "no journal: exit 0"
grep -q 'no notes journal' "$ERR" && ok "says there is none yet" || no "says there is none yet ($(cat "$ERR"))"
run_notes --json
assert_eq "$(jq -r '.notes | length' "$OUT")" "0" "--json prints an empty list"
assert_eq "$(jq -r '.journal' "$OUT")" "$JOURNAL" "and names the journal path"

printf '{"version":1,"groups":[]}' | run_plan write >/dev/null 2>&1
PLAN=$(run_plan path)
PLAN_ID=$(jq -r '.planId' "$PLAN")
W1="111@2026-10-15T11:00:00.000Z"
W2="222@2026-10-15T11:30:00.000Z"

echo
echo "saved notes, no snapshot yet"

created "$W1" "$PLAN_ID" "user:1-1" "src/b.ts" 7 "why is this here?"
created "$W1" "$PLAN_ID" "user:1-2" "src/a.ts" 3 $'first line\nsecond line'
run_notes --json
assert_eq "$RC" "0" "exit 0"
assert_eq "$(ids)" "user:1-2,user:1-1" "every saved note, sorted by file and line"
assert_eq "$(jq -r '.planId' "$OUT")" "$PLAN_ID" "for the current plan"
assert_eq "$(jq -r '.notes[0].summary' "$OUT")" $'first line\nsecond line' "keeps a multi-line body"

run_notes
grep -q '^2 notes from ' "$OUT" && ok "text: counts the notes" || no "text: counts the notes ($(head -1 "$OUT"))"
grep -q '^src/a.ts:3 (new)  \[user\]$' "$OUT" && ok "text: file, line, side and source" || no "text: file, line, side and source"
grep -q '^  second line$' "$OUT" && ok "text: indents every line of the body" || no "text: indents every line of the body"

echo
echo "snapshots: replies, deletions, later notes"

snapshot "$W1" "$PLAN_ID" '[
  {"id":"user:1-1","source":"user","file":"src/b.ts","side":"new","line":7,"summary":"why is this here?","resolution":"active"},
  {"id":"agent:1","parentId":"user:1-1","source":"agent","file":"src/b.ts","side":"new","line":7,"summary":"it guards the retry","resolution":"active"}
]'
created "$W1" "$PLAN_ID" "user:1-3" "src/c.ts" 1 "saved after the snapshot"
run_notes --json
assert_eq "$(ids)" "user:1-1,agent:1,user:1-3" "the snapshot stands (with the agent reply), and a later note is added"
assert_eq "$(jq -r '[.notes[].id] | index("user:1-2")' "$OUT")" "null" "a note the snapshot no longer holds was deleted"

run_notes
grep -q '\[agent, reply to user:1-1\]' "$OUT" && ok "text: marks a reply" || no "text: marks a reply"

echo
echo "windows, plans, damage"

created "$W2" "$PLAN_ID" "user:1-1" "src/d.ts" 2 "another window, same id"
run_notes --json
assert_eq "$(jq -r '.notes | length' "$OUT")" "4" "a second window's notes are kept apart, even with a colliding id"

created "$W1" "an-earlier-plan" "user:9-9" "src/old.ts" 1 "from an earlier review"
run_notes --json
assert_eq "$(jq -r '[.notes[].id] | index("user:9-9")' "$OUT")" "null" "another plan's notes are left out"
run_notes --all --json
assert_eq "$(jq -r '[.notes[] | select(.id == "user:9-9") | .planId] | first' "$OUT")" "an-earlier-plan" "--all includes them, with their plan"
assert_eq "$(jq -r '.planId' "$OUT")" "null" "--all names no single plan"

# A line cut short by a crash, as the extension leaves it behind: with no
# newline, so its next append starts one first (journal.ts appendEntry).
printf '{"v":1,"event":"created","at":"2026-10-15T12:\n' >>"$JOURNAL"
created "$W1" "$PLAN_ID" "user:1-4" "src/e.ts" 1 "after a cut-short line"
run_notes --json
assert_eq "$RC" "0" "a line cut short by a crash is not fatal"
assert_eq "$(jq -r '[.notes[].id] | index("user:1-4") != null' "$OUT")" "true" "and the lines after it still count"

echo
echo "cleanup"

ORPHAN_FRESH="$XDG_STATE_HOME/hunk/review-plan/0123456789abcdef.notes.jsonl"
ORPHAN_OLD="$XDG_STATE_HOME/hunk/review-plan/fedcba9876543210.notes.jsonl"
echo '{}' >"$ORPHAN_FRESH"
echo '{}' >"$ORPHAN_OLD"
touch -t 202001010000 "$ORPHAN_OLD"
run_plan gc --yes >/dev/null 2>&1
assert_file "$ORPHAN_FRESH" "gc keeps a recent notes journal that has no plan"
assert_no_file "$ORPHAN_OLD" "and removes one older than --older-than"

run_plan clear --yes >/dev/null 2>&1
assert_no_file "$JOURNAL" "clear removes this repo's journal with the plan"

echo
echo "$PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
