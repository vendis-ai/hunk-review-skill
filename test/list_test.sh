#!/usr/bin/env bash
#
# Tests for `hunk-plan list`, which reads every review's state files back into
# one row per plan, and for the head and branch `hunk-plan write` stamps for
# it. Pure bash, like notes_test.sh, so it runs anywhere hunk-plan itself runs
# (bash, git, jq).
#
#   test/list_test.sh
#
# Runs against throwaway git repos and a throwaway XDG_STATE_HOME. The state
# files the extension writes (window.json, last.json, the viewed marks, the
# notes journal) are written here the way the extension writes them. `hunk` is
# a stub on PATH, so the live-session column never asks a real daemon.
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
assert_match() {
  if grep -Eq -- "$2" "$1"; then ok "$3"; else no "$3 (no line matches /$2/ in: $(cat "$1"))"; fi
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

export XDG_STATE_HOME="$TMP/state"
SDIR="$XDG_STATE_HOME/hunk/review-plan"
OUT="$TMP/out.txt"
ERR="$TMP/err.txt"

# A stub `hunk` ahead of any real one: `hunk session list --json` prints
# $TMP/sessions.json, and fails while that file is missing.
mkdir -p "$TMP/bin"
cat >"$TMP/bin/hunk" <<'STUB'
#!/usr/bin/env bash
[[ ${1:-} == session && ${2:-} == list ]] || exit 2
[[ -f $HUNK_STUB_SESSIONS ]] || exit 1
cat "$HUNK_STUB_SESSIONS"
STUB
chmod +x "$TMP/bin/hunk"
export PATH="$TMP/bin:$PATH"
export HUNK_STUB_SESSIONS="$TMP/sessions.json"

commit() {
  git -c user.email=t@example.com -c user.name=t commit -q --allow-empty -m "$1"
}

# run_list <args...>: sets RC, stdout in $OUT, stderr in $ERR.
run_list() {
  run_plan list "$@" >"$OUT" 2>"$ERR"
  RC=$?
}

# row <jq filter>: that filter on the one row for $KEY, from `list --json`.
row() {
  run_plan list --json 2>/dev/null | jq -r --arg k "$KEY" ".reviews[] | select(.key == \$k) | $1"
}

PLAN_JSON='{"version":1,"groups":[
  {"title":"Core","importance":1,"door":"one-way","files":[{"path":"src/a.ts"},{"path":"src/b.ts"}]},
  {"title":"Docs","importance":8,"door":"two-way","files":[{"path":"docs/x.md"},{"path":"src/a.ts"}]},
  {"title":"Misc","files":[{"path":"misc.txt"}]}],
  "mergeDanger":{"door":"one-way","depth":"critical","disagreements":[
    {"field":"depth","verdict":"critical","review":"review","group":"Core","reason":"r"}]}}'

echo "nothing yet"

mkdir -p "$TMP/elsewhere"
cd "$TMP/elsewhere" || exit 1
run_list
assert_eq "$RC" "0" "no state directory: exit 0"
grep -q 'no review plans' "$ERR" && ok "says there are none" || no "says there are none ($(cat "$ERR"))"
run_list --json
assert_eq "$(jq -r '.reviews | length' "$OUT")" "0" "--json prints an empty list, outside any repo"

echo
echo "write stamps head and branch"

R1="$TMP/repo-one"
mkdir -p "$R1"
cd "$R1" || exit 1
git init -q .
git checkout -q -b review-branch
printf '{"version":1,"groups":[]}' | run_plan write >/dev/null 2>&1
PLAN=$(run_plan path)
assert_eq "$(jq -r 'has("head")' "$PLAN")" "false" "an unborn HEAD leaves head out"
assert_eq "$(jq -r '.branch' "$PLAN")" "review-branch" "but the branch is known"

commit init
H1=$(git rev-parse HEAD)
printf '{"version":1,"groups":[],"head":"0000","branch":"made-up"}' | run_plan write >/dev/null 2>&1
assert_eq "$(jq -r '.head' "$PLAN")" "$H1" "head is the commit the plan was written on"
assert_eq "$(jq -r '.branch' "$PLAN")" "review-branch" "and replaces what the input carried"

git checkout -q --detach
printf '{"version":1,"groups":[]}' | run_plan write >/dev/null 2>&1
assert_eq "$(jq -r 'has("branch")' "$PLAN")" "false" "a detached HEAD leaves branch out"
git checkout -q review-branch

echo
echo "a review's row"

printf '%s' "$PLAN_JSON" | run_plan write >/dev/null 2>&1
KEY=$(basename "$PLAN" .json)
PLAN_ID=$(jq -r '.planId' "$PLAN")
assert_eq "$(row '.repo')" "$R1" "names the repo"
assert_eq "$(row '.repoExists')" "true" "which exists"
assert_eq "$(row '.branch')" "review-branch" "and its branch"
assert_eq "$(row '.planId')" "$PLAN_ID" "the plan id"
assert_eq "$(row '.writtenAt | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z$")')" "true" "when it was written, from the id"
assert_eq "$(row '[.groups, .doors, .oneWay] | join(",")')" "3,2,1" "groups, door calls and one-way groups"
assert_eq "$(row '.planFiles | join(",")')" "docs/x.md,misc.txt,src/a.ts,src/b.ts" "the plan's files, once each"
assert_eq "$(row '.mergeDanger | "\(.door)/\(.depth)/\(.disagreements)"')" "one-way/critical/1" "the merge-danger verdict"
assert_eq "$(row '.head.moved')" "0" "the branch has not moved"
assert_eq "$(row '[.window, .notes, .lastHandoff, .writeup.html] | map(tostring) | join(",")')" "null,null,null,null" \
  "no window, journal, hand-off or writeup yet: null, not zero"
assert_eq "$(row '.session')" "null" "a daemon that does not answer leaves the session unknown"

run_list
assert_match "$OUT" '^AGE +REPO +BRANCH +HEAD +WINDOW +LIVE +NOTES +VIEWED +SENDS$' "text: a header"
assert_match "$OUT" '^0m +repo-one +review-branch +\+0 +- +\? +- +0/4 +0$' "text: one line for the review"

echo
echo "the branch moves on"

commit second
assert_eq "$(row '"\(.head.moved) \(.head.rebased)"')" "1 false" "one commit since the plan"
run_list
assert_match "$OUT" ' repo-one +review-branch +\+1 ' "text: +1"

printf '%s' "$PLAN_JSON" | run_plan write >/dev/null 2>&1 # a plan on the second commit
PLAN_ID=$(jq -r '.planId' "$PLAN")
git reset -q --hard "$H1"
commit rewritten
assert_eq "$(row '"\(.head.moved) \(.head.rebased)"')" "1 true" "a plan commit that is no longer an ancestor reads as rebased"
run_list
assert_match "$OUT" ' review-branch +rebased ' "text: rebased"
jq '.head = "0123456789012345678901234567890123456789"' "$PLAN" >"$TMP/p" && mv "$TMP/p" "$PLAN"
assert_eq "$(row '"\(.head.moved) \(.head.rebased)"')" "null true" "so does one git no longer has"

echo
echo "the Hunk window and the session"

LOOP="${PLAN%.json}.loop"
mkdir -p "$LOOP"
jq -n --arg id "$PLAN_ID" --argjson pid $$ '{version: 1, pid: $pid, startedAt: "2026-10-15T11:00:00.000Z", planId: $id}' >"$LOOP/window.json"
assert_eq "$(row '"\(.window.state) \(.window.showsPlan)"')" "open true" "a running window that shows this plan"
jq -n --argjson pid $$ '{version: 1, pid: $pid, planId: "an-earlier-plan"}' >"$LOOP/window.json"
run_list
assert_match "$OUT" ' rebased +earlier ' "text: earlier, for a window still showing an earlier plan"
jq -n --arg id "$PLAN_ID" --argjson pid $$ '{version: 1, pid: $pid, planId: $id, closedAt: "2026-10-15T12:00:00.000Z"}' >"$LOOP/window.json"
assert_eq "$(row '.window.state')" "closed" "a window that says it closed"
sleep 0 &
DEAD=$!
wait "$DEAD"
jq -n --arg id "$PLAN_ID" --argjson pid "$DEAD" '{version: 1, pid: $pid, planId: $id}' >"$LOOP/window.json"
assert_eq "$(row '.window.state')" "closed" "a window whose process is gone"

jq -n --arg r "$R1" '{sessions: [{repoRoot: "/somewhere/else", files: []}, {repoRoot: $r, files: [{path: "x"}]}]}' >"$HUNK_STUB_SESSIONS"
assert_eq "$(row '.session')" "true" "a live session for the repo"
run_list
assert_match "$OUT" ' closed +yes ' "text: yes"
jq -n '{sessions: [{repoRoot: "/somewhere/else"}]}' >"$HUNK_STUB_SESSIONS"
assert_eq "$(row '.session')" "false" "none for the repo"

echo
echo "notes, sends and viewed marks"

JOURNAL="${PLAN%.json}.notes.jsonl"
W="111@2026-10-15T11:00:00.000Z"
note() { # note <id> <source> <file> <line> <createdAt>
  jq -cn --arg id "$1" --arg s "$2" --arg f "$3" --argjson l "$4" --arg at "$5" \
    '{id: $id, source: $s, file: $f, side: "new", line: $l, summary: "x", resolution: "active", createdAt: $at}'
}
snapshot() { # snapshot <planId> <trigger> <notes-json>
  jq -cn --arg p "$1" --arg t "$2" --arg w "$W" --argjson n "$3" \
    '{v: 1, event: "snapshot", at: "2026-10-15T12:05:00.000Z", planId: $p, head: null, window: $w, trigger: $t, notes: $n}' >>"$JOURNAL"
}
U1=$(note user:1 user src/a.ts 3 2026-10-15T12:00:00.000Z)
U2=$(note user:2 user src/b.ts 9 2026-10-15T12:01:00.000Z)
U3=$(note user:3 user src/b.ts 20 2026-10-15T12:02:00.000Z)
A_OLD=$(note mcp:0 agent src/b.ts 20 2026-10-15T11:00:00.000Z)
A1=$(note mcp:1 agent src/a.ts 3 2026-10-15T12:10:00.000Z)
A2=$(jq -c '. + {parentId: "user:2", line: 1}' <<<"$(note mcp:2 agent src/b.ts 1 2026-10-15T12:11:00.000Z)")
snapshot "$PLAN_ID" sendToAgent "[$U1,$U2,$U3,$A_OLD]"
snapshot "$PLAN_ID" toggleViewed "[$U1,$U2,$U3,$A_OLD,$A1,$A2]"
snapshot "an-earlier-plan" sendToAgent "[$U1]"
assert_eq "$(row '"\(.notes.user) \(.notes.agent) \(.notes.open)"')" "3 3 1" \
  "a reply at the note's line or naming it as parent answers it; an older agent note does not"
assert_eq "$(row '"\(.notes.sends) \(.notes.notesSent) \(.notes.approved)"')" "1 3 false" \
  "this plan's sends and the notes they held, not an earlier plan's"
snapshot "$PLAN_ID" approveReview "[$U1,$U2,$U3,$A_OLD,$A1,$A2]"
assert_eq "$(row '.notes.approved')" "true" "an approval"
run_list
assert_match "$OUT" ' 1/3 +0/4 +1 A$' "text: open/all notes, viewed, sends and A"

jq -n '{version: 1, entries: {"src/a.ts": "1111", "docs/x.md": "2222", "not-in-plan.rb": "3333"}}' >"${PLAN%.json}.viewed.json"
assert_eq "$(row '"\(.viewed.marked)/\(.viewed.of)"')" "2/4" "viewed counts marks on the plan's files"
assert_eq "$(row '.viewedFiles | join(",")')" "docs/x.md,not-in-plan.rb,src/a.ts" "viewedFiles lists every mark"

jq -n --arg id "$PLAN_ID" '{version: 1, kind: "go", mode: "fix-clear", planId: $id, createdAt: "2026-10-15T12:06:00.000Z", notes: [{id: "user:1"}, {id: "user:2"}]}' >"$LOOP/last.json"
assert_eq "$(row '.lastHandoff | "\(.kind) \(.mode) \(.notes) \(.forPlan)"')" "go fix-clear 2 true" "the last hand-off"
printf '{"version":' >"$LOOP/last.json"
assert_eq "$(row '.lastHandoff')" "null" "a hand-off cut short reads as none, and the row survives"

REPORT="${PLAN%.json}.report"
mkdir -p "$REPORT"
echo "An overview." >"$REPORT/_overview.md"
: >"$REPORT/_glossary.md"
echo "<html></html>" >"${PLAN%.json}.html"
assert_eq "$(row '"\(.writeup.html != null) \(.writeup.overview) \(.writeup.glossary)"')" "true true false" \
  "the writeup, with its overview, and an empty glossary counts as none"

echo
echo "other reviews: newer, unknown, gone, broken"

# Make the first review older, so the order is certain.
jq '.planId = "20260101T000000Z-00000001"' "$PLAN" >"$TMP/p" && mv "$TMP/p" "$PLAN"

R2="$TMP/repo-two"
mkdir -p "$R2"
cd "$R2" || exit 1
git init -q .
git checkout -q -b second
commit init
printf '{"version":1,"groups":[]}' | run_plan write >/dev/null 2>&1

R3="$TMP/repo-gone"
mkdir -p "$R3"
cd "$R3" || exit 1
git init -q .
git checkout -q -b gone-branch
commit init
printf '{"version":1,"groups":[]}' | run_plan write >/dev/null 2>&1
GONE_KEY=$(basename "$(run_plan path)" .json)
jq '.planId = "20260201T000000Z-00000002"' "$(run_plan path)" >"$TMP/p" && mv "$TMP/p" "$(run_plan path)"
cd "$TMP" || exit 1
rm -rf "$R3"

cp "$PLAN" "$SDIR/0123456789abcdef.json"
echo '{not json' >"$SDIR/fedcba9876543210.json"

cd "$TMP/elsewhere" || exit 1
run_list --json
assert_eq "$(jq -r '.reviews | length' "$OUT")" "5" "one row per plan in the state directory"
assert_eq "$(jq -r '.reviews[0].repo | split("/") | last' "$OUT")" "repo-two" "newest first"
assert_eq "$(jq -r '[.reviews[] | select(.error == null) | .writtenAt] | last' "$OUT")" "2026-01-01T00:00:00Z" \
  "the oldest last"
assert_eq "$(jq -r '.reviews[] | select(.key == "0123456789abcdef") | .repo' "$OUT")" "null" "a plan no manifest names: repo null"
assert_eq "$(jq -r --arg k "$GONE_KEY" '.reviews[] | select(.key == $k) | "\(.repoExists) \(.branch)"' "$OUT")" \
  "false gone-branch" "a deleted worktree still lists, with the branch the plan recorded"
assert_eq "$(jq -r '.reviews[] | select(.key == "fedcba9876543210") | .error' "$OUT")" "unreadable plan" \
  "a plan that does not parse is a row with an error"

run_list
assert_eq "$RC" "0" "text: exit 0 with a broken plan among them"
assert_match "$OUT" '^[0-9]+[mhd] +\? 0123456789abcdef ' "text: an unknown repo shows its key"
assert_match "$OUT" ' repo-gone \(gone\) +gone-branch ' "text: a deleted worktree is marked gone"
grep -q 'fedcba9876543210.json: unreadable plan' "$ERR" && ok "text: the broken plan is named on stderr" ||
  no "text: the broken plan is named on stderr ($(cat "$ERR"))"
assert_eq "$(grep -c 'fedcba9876543210' "$OUT")" "0" "and left out of the table"

echo
echo "--here"

cd "$R2" || exit 1
run_list --here --json
assert_eq "$(jq -r '[.reviews[].repo] | join(",")' "$OUT")" "$R2" "only this repo's plan"
cd "$TMP/elsewhere" || exit 1
git init -q .
run_list --here
assert_eq "$RC" "0" "a repo with no plan: exit 0"
grep -q 'no review plan for' "$ERR" && ok "and says so" || no "and says so ($(cat "$ERR"))"

echo
echo "$PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
