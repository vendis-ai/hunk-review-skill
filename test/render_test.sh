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
# link rewriting, the script scrub, routing -- needs a browser and is not
# covered here. Set CHROME=<binary> to additionally run those assertions.

set -uo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
HUNK_PLAN="$REPO_ROOT/bin/hunk-plan"

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
MD

git add -A >/dev/null
git -c user.email=t@example.com -c user.name=t commit -qm init >/dev/null

cat >plan.json <<'JSON'
{ "version": 1,
  "groups": [
    { "title": "Security boundary", "summary": "Auth changes.", "importance": 1,
      "files": [{ "path": "a.rb" }] },
    { "title": "Removal: Inputs", "importance": 4, "files": [{ "path": "b.rb" }] },
    { "title": "Dev tooling", "summary": "Churn.", "importance": 9,
      "files": [{ "path": "c.rb" }] }
  ] }
JSON

echo "hunk-plan report-dir --init"
"$HUNK_PLAN" write <plan.json >/dev/null 2>&1
DIR=$("$HUNK_PLAN" report-dir --init 2>/dev/null)

[[ -f "$DIR/meta.json" ]] && ok "scaffolds meta.json" || no "scaffolds meta.json"
[[ -f "$DIR/_tldr.md" ]] && ok "scaffolds _tldr.md" || no "scaffolds _tldr.md"
# Slug rule: lowercase, runs of non-alphanumerics collapse to one hyphen.
[[ -f "$DIR/security-boundary.md" ]] && ok "slugifies a plain title" || no "slugifies a plain title"
[[ -f "$DIR/removal-inputs.md" ]] &&
  ok "slugifies punctuation ('Removal: Inputs')" || no "slugifies punctuation ('Removal: Inputs')"

echo "$$" >"$DIR/security-boundary.md"
"$HUNK_PLAN" report-dir --init >/dev/null 2>&1
assert_eq "$(cat "$DIR/security-boundary.md")" "$$" "--init never overwrites an existing body"

echo
echo "hunk-plan render"

cat >"$DIR/meta.json" <<'JSON'
{ "title": "Widgets Review", "subtitle": "branch vs main",
  "docs": [
    { "id": "ADR 0001", "path": "docs/adr/0001-decision.md", "citedBy": "security-boundary" },
    { "id": "Gone RFC", "path": "docs/rfc/absent.md", "citedBy": "removal-inputs" }
  ] }
JSON
printf -- '- One line of TL;DR, closes #12.\n' >"$DIR/_tldr.md"
printf -- '- Body for the security group.\n' >"$DIR/security-boundary.md"
printf -- '- Tooling churn only.\n' >"$DIR/dev-tooling.md"
: >"$DIR/removal-inputs.md" # deliberately empty: exercises the no-writeup path

OUT=$("$HUNK_PLAN" render 2>"$TMP/render.err" | sed 's/^hunk-plan: wrote //')
[[ -f $OUT ]] && ok "writes the html" || no "writes the html"

assert_in 'id="group-security-boundary"' "$OUT" "emits stable section ids"
assert_in 'badge critical">Critical' "$OUT" "importance 1 -> Critical"
assert_in 'badge review">Review' "$OUT" "importance 4 -> Review"
assert_in 'badge skim">Skim' "$OUT" "importance 9 -> Skim"

# Ordering must match the extension: [hidden, importance, declaration order].
ORDER=$(grep -o 'id="group-[a-z-]*"' "$OUT" | tr '\n' ' ')
assert_eq "$ORDER" 'id="group-security-boundary" id="group-removal-inputs" id="group-dev-tooling" ' \
  "orders groups by importance"

assert_in 'No writeup was written' "$OUT" "flags a group with no body"
assert_in 'no body for group' "$TMP/render.err" "warns on stderr about a missing body"
assert_in 'Not found in the working tree' "$OUT" "renders a card for a missing doc"
assert_in 'referenced doc not found' "$TMP/render.err" "warns on stderr about a missing doc"
assert_in '"repo":"acme/widgets"' "$OUT" "derives owner/repo from the origin remote"
assert_in 'data-doc="doc-adr-0001"' "$OUT" "emits a pane per declared doc"
assert_in 'href="#group-security-boundary"' "$OUT" "doc links back to its citing group"

# The payload is base64 precisely so nothing in a doc can terminate its carrier.
assert_not_in '<script>alert(1)</script>' "$OUT" "hostile doc markup is not emitted verbatim"

OUTDIR=$(dirname "$OUT")
[[ -f "$OUTDIR/marked.min.js" ]] && ok "copies marked alongside" || no "copies marked alongside"
[[ -f "$OUTDIR/mermaid.min.js" ]] && ok "copies mermaid alongside" || no "copies mermaid alongside"

echo
echo "hunk-plan gc"

STATE="$XDG_STATE_HOME/hunk/review-plan"
touch "$STATE/deadbeefdeadbeef.viewed.json" # orphan: no plan file
GC=$("$HUNK_PLAN" gc --dry-run 2>&1)
grep -qF 'deadbeefdeadbeef' <<<"$GC" && ok "gc finds an orphan with no plan" || no "gc finds an orphan with no plan"
grep -qF 'nothing removed' <<<"$GC" && ok "gc --dry-run removes nothing" || no "gc --dry-run removes nothing"
[[ -f "$STATE/deadbeefdeadbeef.viewed.json" ]] && ok "gc --dry-run left the file" || no "gc --dry-run left the file"

# A digest whose repo is gone is only collectable because write() recorded it.
assert_in "$FIXTURE" "$STATE/repos.json" "write records digest -> repo root"

"$HUNK_PLAN" gc --yes >/dev/null 2>&1
[[ -f "$STATE/deadbeefdeadbeef.viewed.json" ]] && no "gc --yes removed the orphan" || ok "gc --yes removed the orphan"
[[ -f "$OUT" ]] && ok "gc kept a live plan's report" || no "gc kept a live plan's report"

echo
echo "hunk-plan clear"
"$HUNK_PLAN" clear --yes >/dev/null 2>&1
[[ -e $OUT ]] && no "clear removes the rendered html" || ok "clear removes the rendered html"
[[ -e $DIR ]] && no "clear removes the report directory" || ok "clear removes the report directory"

# ── optional: DOM behaviour, only with a browser ────────────────────────────
if [[ -n ${CHROME:-} ]] && command -v "$CHROME" >/dev/null 2>&1; then
  echo
  echo "DOM behaviour ($CHROME)"
  "$HUNK_PLAN" write <plan.json >/dev/null 2>&1
  DIR=$("$HUNK_PLAN" report-dir --init 2>/dev/null)
  cat >"$DIR/meta.json" <<'JSON'
{ "title": "Widgets Review",
  "docs": [{ "id": "ADR 0001", "path": "docs/adr/0001-decision.md", "citedBy": "security-boundary" }] }
JSON
  printf -- '- Closes #12 and see <https://example.com/x>.\n\n```ruby\n# #999 stays plain\n```\n' \
    >"$DIR/security-boundary.md"
  OUT=$("$HUNK_PLAN" render 2>/dev/null | sed 's/^hunk-plan: wrote //')

  "$CHROME" --headless --disable-gpu --no-sandbox --user-data-dir="$TMP/chrome" \
    --virtual-time-budget=8000 --dump-dom "file://$OUT#doc-adr-0001" >"$TMP/dom.html" 2>/dev/null

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
  assert_in '<h1>The Decision</h1>' "$TMP/dom.html" "the document title survives frontmatter"

  "$HUNK_PLAN" clear --yes >/dev/null 2>&1
else
  echo
  echo "  skip DOM assertions (set CHROME=<binary> to run them)"
fi

echo
echo "$PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
