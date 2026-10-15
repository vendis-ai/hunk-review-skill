#!/usr/bin/env bash
#
# Smoke test for `hunk-plan report-dir --init`, `hunk-plan render` and
# `hunk-plan gc`. Pure bash -- no test framework, so it runs anywhere hunk-plan
# itself runs (bash, git, jq).
#
#   test/render_test.sh
#
# Runs against a throwaway git repo and a throwaway XDG_STATE_HOME, so it never
# touches the real ~/.local/state/hunk/review-plan.
#
# The DOM-level behaviour this frame depends on -- markdown conversion, mermaid,
# link rewriting, the script scrub, routing, scroll memory -- needs a browser and
# is not covered here. Set CHROME=<binary> to additionally run those assertions.
#
# Set TEST_BASH=/bin/bash to pin the interpreter hunk-plan runs under. macOS
# ships bash 3.2 as /bin/bash while `#!/usr/bin/env bash` finds Homebrew's bash 5
# when it is installed -- so without this the suite can pass on a Mac and still
# leave a bash-4-ism in place for everyone who has only the system shell.

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

# assert_in <needle> <file> <label>
assert_in() {
  if grep -qF -- "$1" "$2"; then ok "$3"; else no "$3 (expected to find: $1)"; fi
}
assert_not_in() {
  if grep -qF -- "$1" "$2"; then no "$3 (unexpectedly found: $1)"; else ok "$3"; fi
}
assert_eq() {
  if [[ "$1" == "$2" ]]; then ok "$3"; else no "$3 (want '$2', got '$1')"; fi
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

export XDG_STATE_HOME="$TMP/state"
FIXTURE="$TMP/repo"
mkdir -p "$FIXTURE/docs/adr"
cd "$FIXTURE" || exit 1

git init -q .
git remote add origin git@github.com:acme/widgets.git

cat >docs/adr/0001-decision.md <<'MD'
---
status: accepted
date: 2026-06-23
deciders: [alice, bob]
tags:
  - enrichment
  - pdl
decision_summary: "A very long field of the kind real ADRs carry, running well past any sensible inline length so that it must collapse rather than bury the document it describes. It mentions `reserve` in backticks and **bold** text, both of which should render as markup rather than as literal punctuation, because that is how these fields are actually written in practice and a wall of backticks reads badly."
forbids: |
  rg -n "legacy_path" app/
  - a literal dash line, not a list bullet
---

# The Decision

## Rationale

Route everything through the new path. Closes #1443.

| Field | Written by |
|-------|------------|
| `a`   | agent      |

```mermaid
flowchart LR
  A[in] --> B[out]
```

Hostile input: <script>alert(1)</script>

## Consistency Model

Reads are claimed before the write lands.

## Rollout & Backout

Feature-flagged, off by default.
MD

# A doc that is a whole HTML document, not a fragment: the <!doctype>/<head>
# wrapper must not render as text, and the <style> must not escape the pane.
mkdir -p docs/notes
cat >docs/notes/design.html <<'HTML'
<!doctype html>
<html>
<head>
  <title>Design Note</title>
  <style>body { background: hotpink !important; }</style>
</head>
<body>
  <h2>Transport Choice</h2>
  <p>We picked the boring option.</p>
  <script>alert('doc-script')</script>
</body>
</html>
HTML

# A format with no converter. Its markup must be shown as text, never guessed at.
cat >docs/notes/spec.adoc <<'ADOC'
= Widget Spec
:toc:

== Overview

An AsciiDoc heading is `==`, not `##`.
ADOC

git add -A >/dev/null
git -c user.email=t@example.com -c user.name=t commit -qm init >/dev/null

cat >plan.json <<'JSON'
{ "version": 1,
  "groups": [
    { "title": "Security boundary", "summary": "Auth changes.", "importance": 1,
      "door": "one-way",
      "blastRadius": { "scope": "tenant", "note": "Every <partner> invite already sent." },
      "files": [{ "path": "a.rb" }] },
    { "title": "Removal: Inputs", "importance": 4, "door": "two-way", "files": [{ "path": "b.rb" }] },
    { "title": "Dev tooling", "summary": "Churn.", "importance": 9,
      "files": [{ "path": "c.rb" }] }
  ] }
JSON

echo "hunk-plan report-dir --init"
run_plan write <plan.json >/dev/null 2>&1
DIR=$(run_plan report-dir --init 2>/dev/null)

[[ -f "$DIR/meta.json" ]] && ok "scaffolds meta.json" || no "scaffolds meta.json"
[[ -f "$DIR/_tldr.md" ]] && ok "scaffolds _tldr.md" || no "scaffolds _tldr.md"
[[ -f "$DIR/_overview.md" ]] && ok "scaffolds _overview.md" || no "scaffolds _overview.md"
[[ -f "$DIR/_glossary.md" ]] && ok "scaffolds _glossary.md" || no "scaffolds _glossary.md"
# Slug rule: lowercase, runs of non-alphanumerics collapse to one hyphen.
[[ -f "$DIR/security-boundary.md" ]] && ok "slugifies a plain title" || no "slugifies a plain title"
[[ -f "$DIR/removal-inputs.md" ]] &&
  ok "slugifies punctuation ('Removal: Inputs')" || no "slugifies punctuation ('Removal: Inputs')"
# A group section is three files: the orientation, the example, the bullets.
[[ -f "$DIR/security-boundary.why.md" ]] && ok "scaffolds a why per group" || no "scaffolds a why per group"
[[ -f "$DIR/security-boundary.example.md" ]] &&
  ok "scaffolds an example per group" || no "scaffolds an example per group"

echo "$$" >"$DIR/security-boundary.md"
run_plan report-dir --init >/dev/null 2>&1
assert_eq "$(cat "$DIR/security-boundary.md")" "$$" "--init never overwrites an existing body"

echo
echo "hunk-plan render"

# A design doc is not always in the repo under review.
mkdir -p "$TMP/outside"
printf '# Handbook\n\nLives outside any repo.\n' >"$TMP/outside/handbook.md"

cat >"$DIR/meta.json" <<JSON
{ "title": "Widgets Review", "subtitle": "branch vs main",
  "docs": [
    { "id": "ADR 0001", "path": "docs/adr/0001-decision.md", "citedBy": "security-boundary" },
    { "id": "Design HTML", "path": "docs/notes/design.html", "citedBy": "removal-inputs" },
    { "id": "Spec ADOC", "path": "docs/notes/spec.adoc" },
    { "id": "Outside Handbook", "path": "$TMP/outside/handbook.md" },
    { "id": "Notion PRD", "url": "https://notion.example/prd", "citedBy": "dev-tooling" },
    { "id": "Gone RFC", "path": "docs/rfc/absent.md", "citedBy": "removal-inputs" }
  ] }
JSON
printf -- '- **Goal:** Partners can no longer invite themselves in.\n' >"$DIR/_overview.md"
printf -- '- One line of TL;DR, closes #12.\n' >"$DIR/_tldr.md"
printf -- '- **Gate**: the check that runs before an invite exists.\n- **Invite**: a link that adds one user to one tenant.\n' \
  >"$DIR/_glossary.md"
printf -- '- Body for the security group.\n' >"$DIR/security-boundary.md"
printf -- '- Tooling churn only.\n' >"$DIR/dev-tooling.md"
: >"$DIR/removal-inputs.md" # deliberately empty: exercises the no-writeup path
printf 'Signup accepted any domain. The gate now runs first.\n' >"$DIR/security-boundary.why.md"
printf 'bob@partner.io signs up -> gate misses -> invite minted\n' >"$DIR/security-boundary.example.md"
# A Skim group legitimately has no example, and removal-inputs has neither:
# a report directory written before these files existed must still render.
printf 'Tooling only, no product effect.\n' >"$DIR/dev-tooling.why.md"

OUT=$(run_plan render 2>"$TMP/render.err" | sed 's/^hunk-plan: wrote //')
[[ -f $OUT ]] && ok "writes the html" || no "writes the html"

assert_in 'id="group-security-boundary"' "$OUT" "emits stable section ids"
assert_in 'badge critical">Critical' "$OUT" "importance 1 -> Critical"
assert_in 'badge review">Review' "$OUT" "importance 4 -> Review"
assert_in 'badge skim">Skim' "$OUT" "importance 9 -> Skim"

# The door is a second badge after the verdict; a group with no call gets none.
assert_in 'badge critical">Critical</span> <span class="badge door one-way">One-way</span> Security boundary</h2>' \
  "$OUT" "a one-way door is a second badge"
assert_in '<span class="badge door two-way">Two-way</span> Removal: Inputs</h2>' "$OUT" "a two-way door is a second badge"
assert_in 'badge skim">Skim</span> Dev tooling</h2>' "$OUT" "a group without a door gets no door badge"
assert_in '<p class="blast-radius">Blast radius: <strong>tenant</strong> &mdash; Every &lt;partner&gt; invite already sent.</p>' \
  "$OUT" "renders the blast radius, escaped"
assert_eq "$(grep -c 'class="blast-radius"' "$OUT")" "1" "only a group with a blast radius gets the line"

# Ordering must match the extension: [hidden, importance, declaration order].
ORDER=$(grep -o 'id="group-[a-z-]*"' "$OUT" | tr '\n' ' ')
assert_eq "$ORDER" 'id="group-security-boundary" id="group-removal-inputs" id="group-dev-tooling" ' \
  "orders groups by importance"

# Front matter, in reading order: what and why, where to look, then the terms.
# The glossary is looked up, not read, so it starts closed and says its size.
assert_in '<div class="overview"><h3>Overview</h3>' "$OUT" "renders the overview"
assert_in '<details class="glossary"><summary>Glossary (2 terms)</summary>' "$OUT" \
  "renders the glossary closed, with its term count"
assert_eq "$(grep -o 'class="overview"\|class="tldr"\|class="glossary"\|class="toc"' "$OUT" | tr '\n' ' ')" \
  'class="overview" class="tldr" class="glossary" class="toc" ' \
  "overview, TL;DR and glossary render above the contents, in that order"
assert_not_in 'no overview' "$TMP/render.err" "no overview warning when there is one"

assert_in 'No writeup was written' "$OUT" "flags a group with no body"
assert_in 'no body for group' "$TMP/render.err" "warns on stderr about a missing body"
assert_in '<div class="why"><h3>Why</h3>' "$OUT" "renders a group's why"
assert_in '<div class="example"><h3>Example</h3>' "$OUT" "renders a group's example"
assert_in 'no why for group' "$TMP/render.err" "warns on stderr about a missing why"

# Order within a section, and the two groups that omit a part: a Skim group
# carries a why but no example, and a group with neither still renders -- a
# report directory written before these files existed must not break.
SEC=$(awk '/id="group-security-boundary"/,/<\/section>/' "$OUT")
assert_eq "$(printf '%s' "$SEC" | grep -o 'class="why"\|class="example"' | tr '\n' ' ')" \
  'class="why" class="example" ' "the why renders above the example"
if printf '%s' "$(awk '/id="group-dev-tooling"/,/<\/section>/' "$OUT")" | grep -q 'class="example"'; then
  no "a group with no example gets no example block"
else
  ok "a group with no example gets no example block"
fi
if printf '%s' "$(awk '/id="group-removal-inputs"/,/<\/section>/' "$OUT")" | grep -q 'class="why"'; then
  no "a group with no why renders without one"
else
  ok "a group with no why renders without one"
fi
assert_in 'Not found on disk' "$OUT" "renders a card for a missing doc"
assert_in 'referenced doc not found' "$TMP/render.err" "warns on stderr about a missing doc"
assert_in '"repo":"acme/widgets"' "$OUT" "derives owner/repo from the origin remote"
assert_in 'data-doc="doc-adr-0001"' "$OUT" "emits a pane per declared doc"
# Returning is scroll memory's job now, so the back-link is a plain "#" and
# citedBy survives only as the label.
assert_in 'back to Security boundary' "$OUT" "the back-link names its citing group"

# The payload is base64 precisely so nothing in a doc can terminate its carrier.
assert_not_in '<script>alert(1)</script>' "$OUT" "hostile doc markup is not emitted verbatim"

# Format is decided from the extension by the renderer and travels as an
# attribute; report.js must never re-guess it.
assert_in 'data-format="md"' "$OUT" "a .md doc is tagged markdown"
assert_in 'data-format="html"' "$OUT" "a .html doc is tagged html"
assert_in 'data-format="text"' "$OUT" "a .adoc doc falls back to text"

# Out-of-repo docs.
assert_in 'data-doc="doc-outside-handbook"' "$OUT" "renders a doc referenced by absolute path"
assert_eq "$(grep -c 'referenced doc not found' "$TMP/render.err")" "1" \
  "only the genuinely absent doc warns"

# A url doc is a nav link, not a pane -- and carries no data-nav, or routing
# would try to activate a link that leaves the page.
assert_in 'class="nav-ext" href="https://notion.example/prd"' "$OUT" "a url doc becomes an external nav link"
assert_not_in 'data-doc="doc-notion-prd"' "$OUT" "a url doc gets no pane"
assert_not_in 'data-nav="doc-notion-prd"' "$OUT" "a url doc gets no data-nav"

# Ambiguous or unusable doc entries must fail loudly at render, not render wrong.
cp "$DIR/meta.json" "$TMP/meta.good.json"
printf '{"title":"x","docs":[{"id":"Both","path":"a.md","url":"https://e.example/x"}]}\n' >"$DIR/meta.json"
run_plan render -o "$TMP/bad.html" >/dev/null 2>"$TMP/bad.err" &&
  no "render rejects a doc with both path and url" || ok "render rejects a doc with both path and url"
assert_in 'both "path" and "url"' "$TMP/bad.err" "...and says why"
printf '{"title":"x","docs":[{"id":"Neither"}]}\n' >"$DIR/meta.json"
run_plan render -o "$TMP/bad.html" >/dev/null 2>"$TMP/bad2.err" &&
  no "render rejects a doc with neither path nor url" || ok "render rejects a doc with neither path nor url"
printf '{"title":"x","docs":[{"id":"Scheme","url":"javascript:alert(1)"}]}\n' >"$DIR/meta.json"
run_plan render -o "$TMP/bad.html" >/dev/null 2>"$TMP/bad3.err" &&
  no "render rejects a non-http url" || ok "render rejects a non-http url"
cp "$TMP/meta.good.json" "$DIR/meta.json"

echo
echo "hunk-plan render: readability warnings"

# Each file is put back afterwards, so nothing below sees these.
for f in _overview.md _glossary.md dev-tooling.why.md dev-tooling.md; do cp "$DIR/$f" "$TMP/keep.$f"; done
: >"$DIR/_overview.md"
LONG='This sentence is written on purpose to run well past the limit that the renderer allows, so that the readability check has something real to warn about here today.'
SPAN='`one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twenty-one twenty-two`'
{
  printf '%s Short one.\n\n' "$LONG"
  printf 'A short line with %s inside.\n\n' "$SPAN"
  printf '| %s |\n\n' "$LONG"
  printf '```text\n%s\n```\n\n' "$LONG"
  printf '<pre class="mermaid">\n%s\n</pre>\n' "$LONG"
} >"$DIR/dev-tooling.why.md"
printf -- '- First bullet is short.\n- Second bullet is short too.\n' >"$DIR/dev-tooling.md"
{
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13; do printf -- '- **Term %s**: short meaning.\n' "$i"; done
  printf -- '- **Wordy**: a definition that keeps going well past the point where a reader would stop and look elsewhere.\n'
} >"$DIR/_glossary.md"

run_plan render -o "$TMP/lint.html" >/dev/null 2>"$TMP/lint.err"
assert_eq "$(grep -c 'long sentence' "$TMP/lint.err")" "1" \
  "warns once: not for fences, tables, Mermaid, code spans or short bullets"
assert_in 'long sentence (29 words) in dev-tooling.why.md: "This sentence is written on purpose to run' \
  "$TMP/lint.err" "...and names the file and quotes the sentence"
assert_in 'glossary has 14 terms; keep it to 12' "$TMP/lint.err" "warns about an oversized glossary"
assert_in 'long glossary entry (17 words) for "Wordy"' "$TMP/lint.err" "warns about a long glossary entry"
assert_in 'no overview' "$TMP/lint.err" "warns about a missing overview"
[[ -f "$TMP/lint.html" ]] && ok "warnings never stop the render" || no "warnings never stop the render"
for f in _overview.md _glossary.md dev-tooling.why.md dev-tooling.md; do cp "$TMP/keep.$f" "$DIR/$f"; done

OUTDIR=$(dirname "$OUT")
[[ -f "$OUTDIR/marked.min.js" ]] && ok "copies marked alongside" || no "copies marked alongside"
[[ -f "$OUTDIR/mermaid.min.js" ]] && ok "copies mermaid alongside" || no "copies mermaid alongside"

echo
echo "hunk-plan write: door checks"

# A repo of its own, so these plans never replace the fixture's.
DOORS="$TMP/doors"
mkdir -p "$DOORS"
git -C "$DOORS" init -q .
# door_write <group json fields> -- writes a one-group plan, prints only stderr.
door_write() {
  (cd "$DOORS" && printf '{"version":1,"groups":[{"title":"Migration",%s"files":[{"path":"m.rb"}]}]}' "$1" |
    run_plan write >/dev/null 2>"$TMP/door.err")
  cat "$TMP/door.err"
}

ERR=$(door_write '"door":"one-way","importance":6,')
assert_eq "$ERR" 'hunk-plan: group "Migration" is one-way but ranked Skim (importance 6); rank it 5 or lower, or say in the writeup why a skim is enough' \
  "warns about a one-way group ranked Skim"
(cd "$DOORS" && run_plan show | jq -e '.groups[0].door == "one-way"' >/dev/null) &&
  ok "...and still writes the plan" || no "...and still writes the plan"
assert_eq "$(door_write '"door":"one-way","importance":5,')" "" "a one-way group at Review is fine"
assert_in 'is one-way but ranked Skim (importance 50)' <(door_write '"door":"one-way",') \
  "a one-way group with no importance is at Skim (50)"
assert_eq "$(door_write '"door":"two-way","importance":9,')" "" "a two-way group at Skim is fine"
assert_in 'group "Migration" has door "oneway"; use "one-way" or "two-way"' <(door_write '"door":"oneway",') \
  "warns about an unknown door"
assert_in 'group "Migration" has a malformed blastRadius' \
  <(door_write '"door":"two-way","blastRadius":{"scope":"two words","note":"x"},') \
  "warns about a malformed blast radius"
assert_eq "$(door_write '"door":"two-way","blastRadius":{"scope":"tenant","note":"x"},')" "" \
  "a well-formed blast radius is fine"
(cd "$DOORS" && run_plan clear --yes >/dev/null 2>&1)

echo
echo "hunk-plan danger"

# A repo of its own, with a stand-in for Vendis's bin/merge-danger that answers
# only what hunk-plan asks. MD_CHECK picks the --check outcome, MD_DIGEST and
# MD_DIGEST_COMMITTED the content digests, MD_FLOOR the fresh floor's file.
DANGER="$TMP/danger"
mkdir -p "$DANGER/bin"
git -C "$DANGER" init -q .
DGITDIR=$(git -C "$DANGER" rev-parse --absolute-git-dir)
export MD_FLOOR="$TMP/floor.json"
cat >"$TMP/merge-danger" <<'SH'
#!/usr/bin/env bash
case "$*" in
  --check)
    case ${MD_CHECK:-current} in
      current) echo "verdict current: two-way / critical" ;;
      stale)
        echo "merge-danger: verdict stale: the content changed since it was recorded; run bin/merge-danger, then bin/merge-danger --finalize --by agent with your judgement flags" >&2
        exit 1
        ;;
      *)
        echo "merge-danger: internal error: boom" >&2
        exit 2
        ;;
    esac
    ;;
  "--floor --stdout --committed") cat "$MD_FLOOR" ;;
  --digest) echo "base0 ${MD_DIGEST:-d1}" ;;
  "--digest --committed") echo "base0 ${MD_DIGEST_COMMITTED:-d1}" ;;
  *)
    echo "merge-danger: unexpected arguments: $*" >&2
    exit 2
    ;;
esac
SH
chmod +x "$TMP/merge-danger"

# The verdict: two-way / critical, the floor set by one class whose files sit
# in a Review group and outside the plan.
cat >"$TMP/verdict.json" <<'JSON'
{ "version": 1, "digest": "d1", "door": "two-way", "depth": "critical",
  "blastRadius": { "scope": "harness", "note": "Every later <PR> body." },
  "oneWayReasons": [], "overrides": [], "finalized": { "by": "agent", "at": "2026-10-15T00:00:00Z" },
  "floor": { "door": "two-way", "depth": "critical",
    "classes": [ { "id": "harness-controls", "door": "two-way", "depth": "critical",
                   "files": ["bin/x", "ci.yml", "zz.rb"], "signals": [] } ] } }
JSON
jq '.digest = "d1" | .finalized = null' "$TMP/verdict.json" >"$MD_FLOOR"

# danger_plan <plan json> -- stores a plan in the danger repo.
danger_plan() { (cd "$DANGER" && printf '%s' "$1" | run_plan write >/dev/null 2>&1); }
# danger_run -- runs `danger`; stdout, stderr and the exit code land in files.
danger_run() {
  (cd "$DANGER" && run_plan danger >"$TMP/danger.out" 2>"$TMP/danger.err")
  echo $? >"$TMP/danger.rc"
}
row() { jq -c "[.disagreements[] | select($1)] | length" "$TMP/danger.out"; }

PLAN_DOORS='{"version":1,"groups":[
  {"title":"Security boundary","importance":1,"door":"one-way","files":[{"path":"a.rb"}]},
  {"title":"Harness","importance":4,"door":"two-way","files":[{"path":"bin/x"},{"path":"ci.yml"}]},
  {"title":"Dev tooling","importance":9,"files":[{"path":"c.rb"}]}]}'
danger_plan "$PLAN_DOORS"

danger_run
assert_eq "$(cat "$TMP/danger.rc")" "0" "no bin/merge-danger: exits 0"
assert_eq "$(cat "$TMP/danger.out")" "" "...prints no object"
assert_in 'no bin/merge-danger in this repo; nothing to cross-check' "$TMP/danger.err" "...and says so"

cp "$TMP/merge-danger" "$DANGER/bin/merge-danger"
cp "$TMP/verdict.json" "$DGITDIR/merge-danger.json"

danger_run
assert_eq "$(cat "$TMP/danger.rc")" "0" "a current verdict: exits 0"
assert_eq "$(jq -r '[.source, .status, .door, .depth, .finalized, .digest] | join(" ")' "$TMP/danger.out")" \
  "verdict verdict current: two-way / critical two-way critical true d1" "...reads the stored verdict"
assert_eq "$(jq -c '.review' "$TMP/danger.out")" '{"door":"one-way","depth":"critical"}' \
  "...and the review calls: any one-way group, the top group tier"
assert_eq "$(row '.field == "door" and .class == null and .group == "Security boundary" and .needs == "review"')" "1" \
  "a one-way group against a two-way verdict is a raise, named by its group"
assert_eq "$(row '.field == "depth" and .group == "Harness" and .class == "harness-controls" and .review == "review" and .needs == "operator"')" "1" \
  "a class file in a group ranked below the class depth needs the operator"
assert_eq "$(row '.group == null and .class == "harness-controls" and .files == ["zz.rb"] and .review == "skim"')" "1" \
  "a class file outside the plan counts as Skim"
assert_eq "$(jq '.disagreements | length' "$TMP/danger.out")" "3" "...and nothing else disagrees"
assert_eq "$(jq '[.disagreements[].reason] | unique' -c "$TMP/danger.out")" '[""]' "every reason is left for the review"
assert_in '3 disagreement(s); write each "reason"' "$TMP/danger.err" "says what to do next"

# The whole-change depth row is left out when the class rows already explain a
# floor-set verdict, and kept when the verdict sits above the floor.
danger_plan "$(printf '%s' "$PLAN_DOORS" | jq -c '.groups[0].importance = 3')"
danger_run
assert_eq "$(row '.field == "depth" and .class == null')" "0" "class rows replace a whole-change row they explain"
jq '.floor.depth = "review" | .floor.classes[0].depth = "review"' "$TMP/verdict.json" >"$DGITDIR/merge-danger.json"
danger_run
assert_eq "$(row '.field == "depth" and .class == null and .group == null and .verdict == "critical" and .review == "review"')" "1" \
  "a verdict raised above the floor keeps its whole-change row"
cp "$TMP/verdict.json" "$DGITDIR/merge-danger.json"
danger_plan "$PLAN_DOORS"

MD_CHECK=stale danger_run
assert_eq "$(cat "$TMP/danger.rc")" "0" "a stale verdict: exits 0"
assert_eq "$(jq -r '[.source, .status, .finalized] | join(" | ")' "$TMP/danger.out")" \
  "floor | verdict stale: the content changed since it was recorded | false" "...and reads a fresh floor instead"

MD_CHECK=broken danger_run
assert_eq "$(cat "$TMP/danger.rc")" "0" "a failing bin/merge-danger: exits 0"
assert_eq "$(cat "$TMP/danger.out")" "" "...prints no object"
assert_in 'bin/merge-danger --check failed (exit 2): internal error: boom; no cross-check' "$TMP/danger.err" "...and says why"

danger_plan "$(printf '%s' "$PLAN_DOORS" | jq -c 'del(.groups[].door)')"
danger_run
assert_in 'no group has a door call, so the door was not compared' "$TMP/danger.err" "says when the plan has no door calls"
assert_eq "$(row '.field == "door"')" "0" "...and compares no door"

echo
echo "hunk-plan write: mergeDanger checks"

danger_plan "$PLAN_DOORS"
danger_run
MD=$(cat "$TMP/danger.out")
# danger_write <jq filter on the plan with mergeDanger> -- prints only stderr.
danger_write() {
  (cd "$DANGER" && printf '%s' "$PLAN_DOORS" | jq --argjson md "$MD" ".mergeDanger = \$md | $1" |
    run_plan write >/dev/null 2>"$TMP/dwrite.err")
  cat "$TMP/dwrite.err"
}
assert_in 'mergeDanger disagreement on door (Security boundary) has no reason; say why this review differs' \
  <(danger_write '.') "warns about a disagreement with no reason"
REASONED='.mergeDanger.disagreements |= map(.reason = "Sent <invites> stay sent.")'
assert_eq "$(danger_write "$REASONED")" "" "a reason on every row is fine"
assert_in 'mergeDanger was made for other group calls; run hunk-plan danger again' \
  <(danger_write "$REASONED | .groups[0].importance = 3") "warns when the groups changed after danger ran"
assert_in 'names a group the plan does not have' \
  <(danger_write "$REASONED | .mergeDanger.disagreements[0].group = \"Ghost\"") "warns about an unknown group"
assert_in 'mergeDanger disagreement 2 is malformed' \
  <(danger_write "$REASONED | .mergeDanger.disagreements[1].verdict = \"high\"") "warns about a malformed row"
assert_in 'mergeDanger is malformed; the writeup leaves it out' <(danger_write '.mergeDanger = []') \
  "warns about a malformed mergeDanger"
(cd "$DANGER" && run_plan show | jq -e '.mergeDanger == []' >/dev/null) &&
  ok "...and still writes the plan" || no "...and still writes the plan"

echo
echo "hunk-plan render: merge danger and the review record"

danger_write "$REASONED" >/dev/null
DDIR=$(cd "$DANGER" && run_plan report-dir --init 2>/dev/null)
printf '{"title":"Danger Review","subtitle":"","docs":[]}\n' >"$DDIR/meta.json"
danger_render() {
  (cd "$DANGER" && run_plan render 2>"$TMP/drender.err" | sed 's/^hunk-plan: wrote //')
}
DOUT=$(danger_render)
assert_in '<div class="tldr"><h3>TL;DR</h3><div class="danger">' "$DOUT" \
  "the TL;DR leads with the cross-check, even with an empty _tldr.md"
assert_in 'Merge danger: <strong>two-way / critical</strong> <span class="danger-src">(current verdict)</span>' "$DOUT" \
  "shows the verdict and where it came from"
assert_in '<p class="blast-radius">Blast radius: <strong>harness</strong> &mdash; Every later &lt;PR&gt; body.</p>' "$DOUT" \
  "shows the verdict blast radius, escaped"
assert_in '<strong>Door</strong>: the verdict says Two-way, this review says One-way (<a href="#group-security-boundary">Security boundary</a>). Sent &lt;invites&gt; stay sent. <span class="badge needs-note">Confirm in a note to raise</span>' \
  "$DOUT" "a raise links its group, gives the reason escaped, and needs a note"
assert_in '(<a href="#group-harness">Harness</a>, class <code>harness-controls</code>).' "$DOUT" "a class row names its class"
assert_in '(files outside the plan, class <code>harness-controls</code>)' "$DOUT" "a row for files outside the plan says so"
assert_eq "$(grep -o 'Operator lowering needed' "$DOUT" | wc -l | tr -d ' ')" "2" "each lower needs the operator"
assert_not_in 'for earlier content' "$DOUT" "a verdict for this content is not labelled stale"

MD_DIGEST=d2 danger_render >/dev/null
assert_in '(current verdict; for earlier content)' "$DOUT" "a verdict for other content is labelled, not dropped"

(cd "$DANGER" && run_plan show | jq '.mergeDanger.disagreements = []' | run_plan write >/dev/null 2>&1)
danger_render >/dev/null
assert_in '<p class="danger-agree">This review agrees with the verdict.</p>' "$DOUT" "says when the review agrees"

cat >"$DGITDIR/review-record.json" <<'JSON'
{ "digest": "d1",
  "polish": { "base": "b0", "batch": [
    { "rule": "STD-FIXED-1", "file": "a.rb", "line": 3, "disposition": "fixed" },
    { "rule": "STD-HELD-1", "file": "a.rb", "line": 12, "disposition": "held" },
    { "rule": "STD-WAIVED-1", "file": "ci.yml", "line": null, "disposition": "waived" },
    { "rule": "STD-<REJ>-1", "file": "bin/x", "line": 7, "disposition": "rejected" } ] },
  "gate": { "treeDigest": "t0" },
  "acceptedKnown": ["a wording nit <kept> (a.rb:1)"] }
JSON
danger_render >/dev/null
assert_in '<div class="held"><h4>Held for you</h4><ul><li><code>STD-HELD-1</code> <code>a.rb:12</code></li></ul></div></div>' \
  "$DOUT" "held items close the TL;DR"
assert_in '<details class="settled"><summary>Settled by review (3)</summary>' "$DOUT" "settled items sit in a closed block"
assert_in '<li><strong>Rejected</strong> <code>STD-&lt;REJ&gt;-1</code> <code>bin/x:7</code></li>' "$DOUT" "...escaped"
assert_in '<li><strong>Waived</strong> <code>STD-WAIVED-1</code> <code>ci.yml</code></li>' "$DOUT" "...a row with no line shows its file"
assert_in '<li><strong>Accepted as known</strong> a wording nit &lt;kept&gt; (a.rb:1)</li>' "$DOUT" "...and the accepted findings"
assert_not_in 'STD-FIXED-1' "$DOUT" "fixed items never appear"

MD_DIGEST=d2 danger_render >/dev/null
assert_not_in 'Held for you' "$DOUT" "a record for other content is left out"
assert_in 'review-record.json describes other content; left it out' "$TMP/drender.err" "...and stderr says so"

chmod -x "$DANGER/bin/merge-danger"
danger_render >/dev/null
assert_not_in 'Settled by review' "$DOUT" "a record no tool can date is left out"
assert_in 'cannot tell which content' "$TMP/drender.err" "...and stderr says so"
assert_in 'This review agrees with the verdict.' "$DOUT" "...while the plan's own mergeDanger still renders"
(cd "$DANGER" && run_plan clear --yes >/dev/null 2>&1)

echo
echo "hunk-plan gc"

STATE="$XDG_STATE_HOME/hunk/review-plan"
touch "$STATE/deadbeefdeadbeef.viewed.json" # orphan: no plan file
GC=$(run_plan gc --dry-run 2>&1)
grep -qF 'deadbeefdeadbeef' <<<"$GC" && ok "gc finds an orphan with no plan" || no "gc finds an orphan with no plan"
grep -qF 'nothing removed' <<<"$GC" && ok "gc --dry-run removes nothing" || no "gc --dry-run removes nothing"
[[ -f "$STATE/deadbeefdeadbeef.viewed.json" ]] && ok "gc --dry-run left the file" || no "gc --dry-run left the file"

# A digest whose repo is gone is only collectable because write() recorded it.
assert_in "$FIXTURE" "$STATE/repos.json" "write records digest -> repo root"

run_plan gc --yes >/dev/null 2>&1
[[ -f "$STATE/deadbeefdeadbeef.viewed.json" ]] && no "gc --yes removed the orphan" || ok "gc --yes removed the orphan"
[[ -f "$OUT" ]] && ok "gc kept a live plan's report" || no "gc kept a live plan's report"

echo
echo "hunk-plan clear"
run_plan clear --yes >/dev/null 2>&1
[[ -e $OUT ]] && no "clear removes the rendered html" || ok "clear removes the rendered html"
[[ -e $DIR ]] && no "clear removes the report directory" || ok "clear removes the report directory"

# ── optional: DOM behaviour, only with a browser ────────────────────────────
if [[ -n ${CHROME:-} ]] && command -v "$CHROME" >/dev/null 2>&1; then
  echo
  echo "DOM behaviour ($CHROME)"
  run_plan write <plan.json >/dev/null 2>&1
  DIR=$(run_plan report-dir --init 2>/dev/null)
  cat >"$DIR/meta.json" <<'JSON'
{ "title": "Widgets Review",
  "docs": [
    { "id": "ADR 0001", "path": "docs/adr/0001-decision.md", "citedBy": "security-boundary" },
    { "id": "Design HTML", "path": "docs/notes/design.html", "citedBy": "removal-inputs" },
    { "id": "Spec ADOC", "path": "docs/notes/spec.adoc" },
    { "id": "Notion PRD", "url": "https://notion.example/prd", "citedBy": "dev-tooling" }
  ] }
JSON
  printf -- '- Closes #12 and see <https://example.com/x>.\n\n```ruby\n# #999 stays plain\n```\n' \
    >"$DIR/security-boundary.md"
  # The scroll-memory harness needs a page tall enough to actually scroll.
  { printf -- '- Filler so the review pane is taller than the viewport.\n'
    for _ in $(seq 1 120); do printf -- '- padding line\n'; done; } >"$DIR/dev-tooling.md"
  printf -- '- Body for the removal group.\n' >"$DIR/removal-inputs.md"
  OUT=$(run_plan render 2>/dev/null | sed 's/^hunk-plan: wrote //')
  OUTDIR=$(dirname "$OUT")

  # dump-dom is one static render, so anything routing-dependent needs its own
  # run. Content conversion is not: every pane is converted at boot, visible or
  # not, so one dump covers md, html and text together.
  # macOS ships no timeout(1), so this is hand-rolled. A browser that never
  # returns has to fail the assertion in seconds: an un-timed --dump-dom once
  # held a CI job for 19 minutes and would have held it for the full six-hour
  # limit, because a Chrome version change made the call stop returning.
  CHROME_TIMEOUT=${CHROME_TIMEOUT:-60}
  with_timeout() { # with_timeout <seconds> <cmd...>
    local secs="$1" waited=0 pid
    shift
    "$@" &
    pid=$!
    while kill -0 "$pid" 2>/dev/null; do
      if [[ $waited -ge $secs ]]; then
        kill -9 "$pid" 2>/dev/null
        wait "$pid" 2>/dev/null
        return 124
      fi
      sleep 1
      waited=$((waited + 1))
    done
    wait "$pid"
  }

  chrome_dump() { # chrome_dump <url> <outfile>
    : >"$2"
    if with_timeout "$CHROME_TIMEOUT" "$CHROME" --headless --disable-gpu --no-sandbox \
      --user-data-dir="$TMP/chrome" --window-size=1200,900 --virtual-time-budget=8000 \
      --dump-dom "$1" >"$2" 2>/dev/null; then
      return 0
    fi
    no "chrome returned nothing for $1 (timeout ${CHROME_TIMEOUT}s or non-zero exit)"
    return 1
  }

  chrome_dump "file://$OUT#doc-adr-0001" "$TMP/dom.html"

  assert_in 'issues/12' "$TMP/dom.html" "linkifies a bare #12"
  assert_not_in 'issues/999' "$TMP/dom.html" "leaves #999 inside a code fence alone"
  assert_in 'target="_blank"' "$TMP/dom.html" "external links open in a new tab"
  assert_not_in 'alert(1)' "$TMP/dom.html" "strips a script tag out of a converted doc"
  assert_in '<table>' "$TMP/dom.html" "converts a GFM table"
  assert_in 'aria-roledescription="flowchart' "$TMP/dom.html" "renders a fenced mermaid diagram"
  assert_in 'id="pane-review" hidden' "$TMP/dom.html" "routing hides the review pane on a doc hash"

  # Frontmatter: `---\nstatus: ...\n---` otherwise parses as a setext heading,
  # rendering the metadata larger than the document's own title.
  assert_in '<dl class="fm">' "$TMP/dom.html" "frontmatter renders as a field list"
  assert_in '<dd class="fm-status">accepted</dd>' "$TMP/dom.html" "frontmatter picks out status"
  assert_in '>alice, bob</dd>' "$TMP/dom.html" "frontmatter flattens an inline array"
  assert_in '>enrichment, pdl</dd>' "$TMP/dom.html" "frontmatter flattens a block list"
  assert_in '<details class="fm-long">' "$TMP/dom.html" "a very long field collapses"
  assert_in '<code>reserve</code>' "$TMP/dom.html" "markdown inside a field value is rendered"
  # The collapsed peek is plain text, so emphasis markers are stripped not shown.
  assert_not_in '**bold** text, both' "$TMP/dom.html" "the collapsed peek strips markdown markers"
  # `key: |` is a block scalar: the value is the indented block, never "|".
  assert_not_in '<dd class="fm-short">|</dd>' "$TMP/dom.html" "a block scalar is not rendered as a bare pipe"
  assert_in 'legacy_path' "$TMP/dom.html" "a block scalar keeps its content"
  assert_in 'a literal dash line' "$TMP/dom.html" "a dash inside a block scalar stays literal"
  assert_not_in '<h2>status: accepted' "$TMP/dom.html" "frontmatter is not a setext heading"
  assert_in '>The Decision</h1>' "$TMP/dom.html" "the document title survives frontmatter"

  # ── heading anchors ──
  # Slugged by the JS twin of bin/hunk-plan's slugify(). "Rollout & Backout"
  # exercises the rule that runs of non-alphanumerics collapse to one hyphen.
  assert_in 'id="consistency-model"' "$TMP/dom.html" "doc headings get slugged ids"
  assert_in 'id="rollout-backout"' "$TMP/dom.html" "an ampersand collapses into one hyphen"
  assert_in 'class="doc-toc"' "$TMP/dom.html" "a doc with enough headings gets its own contents"
  # An <ol> keeps counting entries it does not mark, so indented h3 rows shift
  # every number after them and the contents disagrees with the doc's own
  # numbered headings.
  assert_in '<nav class="doc-toc"><ul>' "$TMP/dom.html" "the doc contents is unordered"
  assert_in 'href="#doc-adr-0001/consistency-model"' "$TMP/dom.html" "the doc contents deep-link into the pane"
  # Group bodies live beside the renderer's own group-<slug> ids; anchoring
  # them too would let agent prose collide with a section id.
  assert_not_in 'id="body-for-the-security-group"' "$TMP/dom.html" "group prose is not anchored"

  # ── an HTML doc ──
  assert_in '>Transport Choice</h2>' "$TMP/dom.html" "an html doc renders its body"
  assert_not_in 'hotpink' "$TMP/dom.html" "an html doc's <style> is stripped, not applied page-wide"
  assert_not_in "alert('doc-script')" "$TMP/dom.html" "an html doc's script is stripped"
  assert_not_in '&lt;!doctype' "$TMP/dom.html" "the doctype wrapper is not rendered as text"

  # ── a format with no converter ──
  assert_in '<pre class="plain">' "$TMP/dom.html" "an unconvertible doc renders as text"
  assert_in 'An AsciiDoc heading is' "$TMP/dom.html" "...and keeps its content"
  assert_not_in '<h2 id="overview"' "$TMP/dom.html" "...without guessing its markup"

  # ── deep link ──
  chrome_dump "file://$OUT#doc-adr-0001/consistency-model" "$TMP/deep.html"
  assert_in 'id="pane-review" hidden' "$TMP/deep.html" "a deep link opens the doc pane"
  assert_in 'class="anchor-flash"' "$TMP/deep.html" "a deep link marks the heading it landed on"
  # A heading that no longer exists must degrade to the top of the doc, never
  # to a blank pane or a stuck route.
  chrome_dump "file://$OUT#doc-adr-0001/heading-that-was-deleted" "$TMP/stale.html"
  assert_in 'id="pane-review" hidden' "$TMP/stale.html" "a stale anchor still opens the doc"
  assert_not_in 'class="anchor-flash"' "$TMP/stale.html" "a stale anchor flashes nothing"

  # ── scroll memory across a reflow ──
  # The point of storing an anchor rather than a pixel: leave the review pane,
  # change the layout while it is hidden, come back, and the same block must be
  # at the top of the viewport. An absolute scrollY fails this by construction.
  sed 's#</body>#<script src="harness.js"></script></body>#' "$OUT" >"$OUTDIR/harness.html"
  cat >"$OUTDIR/harness.js" <<'JS'
(function () {
  var out, yBefore, before;
  function navH() { var n = document.querySelector('nav.top'); return n ? n.offsetHeight : 0; }
  function topGroup() {
    var list = document.querySelectorAll('#pane-review section.group');
    var best = '';
    for (var i = 0; i < list.length; i++) {
      if (list[i].getBoundingClientRect().top <= navH() + 1) best = list[i].id;
    }
    return best;
  }
  function say(k, v) { out.textContent += k + '=' + v + ';'; }
  function step1() {
    out = document.createElement('div');
    out.id = 'scroll-result';
    document.body.appendChild(out);
    var target = document.getElementById('group-removal-inputs');
    window.scrollTo(0, target.getBoundingClientRect().top + window.pageYOffset - navH());
    setTimeout(step2, 200);
  }
  function step2() {
    before = topGroup();
    yBefore = window.pageYOffset;
    say('before', before);
    location.hash = '#doc-adr-0001';
    setTimeout(step3, 200);
  }
  function step3() {
    // Reflow while the review pane is hidden. This is exactly what invalidates
    // a remembered pixel offset: a resized window, a zoom step, a rotation.
    document.documentElement.style.fontSize = '26px';
    setTimeout(step4, 200);
  }
  function step4() { location.hash = '#'; setTimeout(step5, 300); }
  function step5() {
    say('after', topGroup());
    // Proves the test is not vacuous: if the reflow changed nothing, matching
    // before/after would say nothing about how the position was stored.
    say('moved', window.pageYOffset !== yBefore ? 'yes' : 'no');
    say('finished', '1');
  }
  var begun = false;
  function begin() { if (begun) return; begun = true; setTimeout(step1, 200); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', begin);
  else begin();
})();
JS
  chrome_dump "file://$OUTDIR/harness.html" "$TMP/scroll.html"
  RESULT=$(grep -o 'id="scroll-result">[^<]*' "$TMP/scroll.html" | sed 's/.*>//')
  field() { printf '%s' "$RESULT" | tr ';' '\n' | grep "^$1=" | cut -d= -f2; }

  assert_eq "$(field finished)" "1" "the scroll harness ran to completion"
  assert_eq "$(field moved)" "yes" "the reflow moved the required scroll position"
  assert_eq "$(field after)" "$(field before)" "the same block is at the top after a reflow"

  run_plan clear --yes >/dev/null 2>&1
  rm -f "$OUTDIR/harness.html" "$OUTDIR/harness.js"
else
  echo
  echo "  skip DOM assertions (set CHROME=<binary> to run them)"
fi

echo
echo "$PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
