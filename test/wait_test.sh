#!/usr/bin/env bash
#
# Tests for `hunk-plan wait`, the agent's half of the review loop. Pure bash,
# like render_test.sh, so it runs anywhere hunk-plan itself runs (bash, git, jq).
#
#   test/wait_test.sh
#
# Runs against a throwaway git repo, a throwaway XDG_STATE_HOME and a fake
# `hunk` on PATH, so it never touches the real state directory or a live Hunk
# session. The hand-off files are written here the way the review-plan
# extension writes them (see extension/review-plan/go.ts).
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
assert_file() {
  if [[ -e $1 ]]; then ok "$2"; else no "$2 (missing: $1)"; fi
}
assert_no_file() {
  if [[ -e $1 ]]; then no "$2 (still there: $1)"; else ok "$2"; fi
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

export XDG_STATE_HOME="$TMP/state"

# A fake hunk: `session comment list` prints $TMP/comments.json (or an empty
# list), `session comment rm` logs its arguments. Nothing reaches a real daemon.
mkdir -p "$TMP/bin"
cat >"$TMP/bin/hunk" <<SH
#!/usr/bin/env bash
case "\$*" in
  "session comment list"*) cat "$TMP/comments.json" 2>/dev/null || echo '{"comments":[]}' ;;
  "session comment rm"*) echo "\$*" >>"$TMP/hunk-rm.log" ;;
  *) exit 1 ;;
esac
SH
chmod +x "$TMP/bin/hunk"
export PATH="$TMP/bin:$PATH"

FIXTURE="$TMP/repo"
mkdir -p "$FIXTURE"
cd "$FIXTURE" || exit 1
git init -q .
git -c user.email=t@example.com -c user.name=t commit -q --allow-empty -m init

VIEWED=$(run_plan viewed)
LOOP="${VIEWED%.viewed.json}.loop"
OUT="$TMP/out.json"
ERR="$TMP/err.txt"

# run_wait <args...>: sets RC, stdout in $OUT, stderr in $ERR.
run_wait() {
  run_plan wait "$@" >"$OUT" 2>"$ERR"
  RC=$?
}

# write_marker <kind>: a hand-off as the extension writes it.
write_marker() {
  mkdir -p "$LOOP"
  cat >"$LOOP/go.json" <<JSON
{
  "version": 1,
  "kind": "$1",
  "mode": $([[ $1 == go ]] && echo '"fix-clear"' || echo null),
  "instruction": null,
  "repoRoot": "$FIXTURE",
  "head": null,
  "createdAt": "2026-10-01T12:00:00.000Z",
  "notes": [
    { "id": "user:1-1", "source": "user", "file": "src/a.ts", "side": "new", "line": 3,
      "summary": "why?", "resolution": "active", "new": true }
  ]
}
JSON
}

# write_window <pid> [closed]: Hunk's presence record.
write_window() {
  mkdir -p "$LOOP"
  if [[ ${2:-} == closed ]]; then
    printf '{"version":1,"pid":%s,"startedAt":"x","closedAt":"y"}\n' "$1" >"$LOOP/window.json"
  else
    printf '{"version":1,"pid":%s,"startedAt":"x"}\n' "$1" >"$LOOP/window.json"
  fi
}

echo "nothing to wait on"

run_wait --timeout 5
assert_eq "$RC" "3" "no plan and no Hunk window: exit 3 at once"
grep -q 'nothing to wait on' "$ERR" && ok "says why" || no "says why ($(cat "$ERR"))"

write_window $$
run_wait --timeout 0
assert_eq "$RC" "2" "no plan, but Hunk has the repo open: keeps waiting"
rm -f "$LOOP/window.json"

printf '{"version":1,"groups":[]}' | run_plan write >/dev/null 2>&1
PLAN=$(run_plan path)

echo
echo "waiting"

run_wait --timeout 0
assert_eq "$RC" "2" "a plan with no hand-off yet: exit 2"
assert_eq "$(wc -c <"$OUT" | tr -d ' ')" "0" "prints nothing on stdout while waiting"
grep -q "run 'hunk-plan wait' again" "$ERR" && ok "tells the agent to call again" || no "tells the agent to call again"

echo
echo "hand-off from the extension"

write_marker go
run_wait --timeout 5
assert_eq "$RC" "0" "a go marker: exit 0"
assert_eq "$(jq -r '.kind + " " + .mode' "$OUT")" "go fix-clear" "prints kind and mode"
assert_eq "$(jq -r '.notes[0].file' "$OUT")" "src/a.ts" "prints the notes"
assert_no_file "$LOOP/go.json" "the marker is consumed"
assert_file "$LOOP/last.json" "and kept as last.json"

run_wait --timeout 0
assert_eq "$RC" "2" "a consumed marker is not delivered twice"

write_marker approve
run_wait --timeout 5
assert_eq "$RC" "10" "an approve marker: exit 10"
assert_eq "$(jq -r '.kind' "$OUT")" "approve" "prints the approval"

(
  sleep 1
  write_marker go
) &
run_wait --timeout 10
assert_eq "$RC" "0" "a marker that arrives mid-wait is picked up"
wait

mkdir -p "$LOOP"
echo '{"nope":true}' >"$LOOP/go.json"
run_wait --timeout 5
assert_eq "$RC" "1" "an unreadable marker is an error"
assert_file "$LOOP/invalid.json" "and is kept for inspection"
assert_no_file "$LOOP/go.json" "instead of being retried forever"

echo
echo "Hunk window"

write_window $$
run_wait --timeout 0
assert_eq "$RC" "2" "an open window: keeps waiting"

write_window $$ closed
run_wait --timeout 5
assert_eq "$RC" "3" "a window closed since the plan: exit 3"
grep -q 'Hunk was closed' "$ERR" && ok "says Hunk was closed" || no "says Hunk was closed ($(cat "$ERR"))"

sleep 0 &
DEAD=$!
wait "$DEAD"
write_window "$DEAD"
run_wait --timeout 5
assert_eq "$RC" "3" "a window whose process is gone: exit 3"

write_window $$ closed
touch -t 202001010000 "$LOOP/window.json"
run_wait --timeout 0
assert_eq "$RC" "2" "a window closed before this plan was written belongs to an older review"

write_window $$ closed
write_marker go
run_wait --timeout 5
assert_eq "$RC" "0" "a hand-off left behind by a closed window is still delivered"
rm -f "$LOOP/window.json"

echo
echo "GO / APPROVE notes, without the extension"

cat >"$TMP/comments.json" <<'JSON'
{ "comments": [
  { "noteId": "user:1-1", "source": "user", "filePath": "src/a.ts", "newRange": [3, 3], "body": "why is this here?" },
  { "noteId": "user:1-2", "source": "user", "filePath": "src/a.ts", "newRange": [9, 9], "body": "GO: also rename foo\n" }
] }
JSON
run_wait --timeout 5
assert_eq "$RC" "0" "a GO note: exit 0"
assert_eq "$(jq -r '.mode' "$OUT")" "fix-clear" "takes the default mode"
assert_eq "$(jq -r '.instruction' "$OUT")" "also rename foo" "the text after GO is the instruction"
assert_eq "$(jq -r '[.notes[].id] | join(",")' "$OUT")" "user:1-1" "the GO note itself is not one of the notes"
assert_eq "$(jq -r '.notes[0].line' "$OUT")" "3" "notes keep their line"
grep -q 'user:1-2' "$TMP/hunk-rm.log" && ok "removes the GO note from the session" || no "removes the GO note from the session"

run_wait --timeout 0
assert_eq "$RC" "2" "a GO note fires once, even if it could not be removed"

cat >"$TMP/comments.json" <<'JSON'
{ "comments": [
  { "noteId": "user:2-1", "source": "user", "filePath": "a", "newRange": [1, 1], "body": "go through this again" },
  { "noteId": "user:2-2", "source": "user", "filePath": "a", "newRange": [2, 2], "body": "GOT it, thanks" },
  { "noteId": "user:2-3", "source": "user", "filePath": "a", "newRange": [3, 3], "body": "fix this\nGO" }
] }
JSON
run_wait --timeout 0
assert_eq "$RC" "2" "ordinary notes that merely contain go do not fire"

cat >"$TMP/comments.json" <<'JSON'
{ "comments": [ { "noteId": "user:3-1", "source": "user", "filePath": "a", "newRange": [1, 1], "body": "APPROVE" } ] }
JSON
run_wait --timeout 5
assert_eq "$RC" "10" "an APPROVE note: exit 10"
rm -f "$TMP/comments.json"

echo
echo "cleanup"

write_marker go
run_plan clear --yes >/dev/null 2>&1
assert_no_file "$LOOP" "clear removes the loop directory with the plan"
assert_no_file "$PLAN" "and the plan itself"

ORPHAN="$XDG_STATE_HOME/hunk/review-plan/0123456789abcdef.loop"
mkdir -p "$ORPHAN"
run_plan gc --dry-run >"$TMP/gc.txt" 2>&1
grep -q '0123456789abcdef' "$TMP/gc.txt" && ok "gc lists a loop directory with no plan" || no "gc lists a loop directory with no plan"
run_plan gc --yes >/dev/null 2>&1
assert_no_file "$ORPHAN" "gc removes it"

echo
echo "$PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
