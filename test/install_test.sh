#!/usr/bin/env bash
#
# Tests for install.sh's destination checks: it replaces a symlink only when
# the link resolves into the checkout, and it refuses a destination folder that
# resolves into the checkout under any spelling. Pure bash.
#
#   test/install_test.sh
#
# Runs a copy of the installer against a throwaway HOME and XDG_CONFIG_HOME, so
# nothing outside the temp directory is read or written, and a failing guard
# can only write into the copy, never into this checkout.
#
# Set TEST_BASH=/bin/bash to pin the interpreter, as in render_test.sh.

set -uo pipefail

REPO_ROOT=$(CDPATH='' cd -- "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null && pwd)

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

TMP_RAW=$(mktemp -d) || exit 1
TMP=$(CDPATH='' cd -- "$TMP_RAW" >/dev/null && pwd -P) || {
  rm -rf "$TMP_RAW"
  exit 1
}
trap 'rm -rf "$TMP"' EXIT

# A minimal checkout: the installer, the skills it links, the CLI, and one
# extension folder so the extension step has something to register.
CO="$TMP/co"
mkdir -p "$CO/extension/fake"
cp "$REPO_ROOT/install.sh" "$CO/"
cp -R "$REPO_ROOT/skills" "$REPO_ROOT/bin" "$CO/"

OUT="$TMP/out.txt"
ERR="$TMP/err.txt"

# run_install <home> [args...]: sets RC, stdout in $OUT, stderr in $ERR.
run_install() {
  local home=$1
  shift
  # SHIM_DIR, when set, goes first on PATH (the BSD readlink stand-in below).
  if [[ -n ${TEST_BASH:-} ]]; then
    PATH="${SHIM_DIR:+$SHIM_DIR:}$PATH" HOME="$home" XDG_CONFIG_HOME="$home/.config" "$TEST_BASH" "$CO/install.sh" "$@" >"$OUT" 2>"$ERR"
  else
    PATH="${SHIM_DIR:+$SHIM_DIR:}$PATH" HOME="$home" XDG_CONFIG_HOME="$home/.config" "$CO/install.sh" "$@" >"$OUT" 2>"$ERR"
  fi
  RC=$?
}

new_home() {
  mkdir -p "$1/.claude"
}

echo "a fresh install"

H1="$TMP/h1"
new_home "$H1"
run_install "$H1"
assert_eq "$RC" "0" "exit 0"
assert_eq "$(readlink "$H1/.agents/skills/hunk-review")" "$CO/skills/hunk-review" "skill linked into the checkout"
run_install "$H1"
assert_eq "$RC" "0" "second run: exit 0"
assert_match "$OUT" 'already linked' "second run: says already linked"

echo "a symlink this checkout did not make"

mkdir -p "$TMP/foreign"
rm "$H1/.agents/skills/hunk-review"
ln -s "$TMP/foreign" "$H1/.agents/skills/hunk-review"
rm "$H1/.claude/skills/hunk-review"
run_install "$H1"
assert_eq "$RC" "1" "exit 1"
assert_match "$ERR" 'hunk-review.*did not make' "names the path and says it is not ours"
assert_eq "$(readlink "$H1/.agents/skills/hunk-review")" "$TMP/foreign" "the foreign link is left as it was"
assert_eq "$(readlink "$H1/.claude/skills/hunk-review")" "$CO/skills/hunk-review" "the installer goes on and recreates the other destination"
run_install "$H1" --dry-run
assert_eq "$(readlink "$H1/.agents/skills/hunk-review")" "$TMP/foreign" "dry run leaves it too"

echo "a dangling symlink to somewhere else"

rm "$H1/.agents/skills/hunk-review"
ln -s "$TMP/nowhere/at-all" "$H1/.agents/skills/hunk-review"
run_install "$H1"
assert_eq "$RC" "1" "exit 1"
assert_match "$ERR" 'did not make' "says it is not ours"
assert_eq "$(readlink "$H1/.agents/skills/hunk-review")" "$TMP/nowhere/at-all" "the dangling link is left as it was"

echo "an old link into the checkout"

rm "$H1/.agents/skills/hunk-review"
ln -s "$CO/skills/hunk-review-old" "$H1/.agents/skills/hunk-review"
run_install "$H1" --dry-run
assert_match "$OUT" 'would relink' "dry run says it would relink"
assert_eq "$(readlink "$H1/.agents/skills/hunk-review")" "$CO/skills/hunk-review-old" "dry run changes nothing"
run_install "$H1"
assert_eq "$RC" "0" "exit 0"
assert_eq "$(readlink "$H1/.agents/skills/hunk-review")" "$CO/skills/hunk-review" "replaced with the current path"

echo "a real file at the destination"

rm "$H1/.agents/skills/hunk-review"
printf 'mine\n' >"$H1/.agents/skills/hunk-review"
run_install "$H1"
assert_eq "$RC" "1" "exit 1"
assert_match "$ERR" 'is not a symlink' "says it is not a symlink"
assert_eq "$(cat "$H1/.agents/skills/hunk-review")" "mine" "the file is untouched"

echo "stale links when readlink -f fails on a missing target (BSD)"

# BSD readlink -f fails when the final target is missing. This shim does the
# same on any system: it fails -f unless the resolved path exists.
mkdir -p "$TMP/shim"
REAL_READLINK=$(command -v readlink)
export REAL_READLINK
cat >"$TMP/shim/readlink" <<'SHIM'
#!/usr/bin/env bash
if [[ ${1:-} == -f ]]; then
  out=$("$REAL_READLINK" "$@") || exit 1
  [[ -e $out ]] || exit 1
  printf '%s\n' "$out"
  exit 0
fi
exec "$REAL_READLINK" "$@"
SHIM
chmod +x "$TMP/shim/readlink"
SHIM_DIR="$TMP/shim"

rm "$H1/.agents/skills/hunk-review"
ln -s "$CO/skills/hunk-review-old" "$H1/.agents/skills/hunk-review"
run_install "$H1"
assert_eq "$RC" "0" "absolute stale link: exit 0"
assert_eq "$(readlink "$H1/.agents/skills/hunk-review")" "$CO/skills/hunk-review" "absolute stale link: replaced"

rm "$H1/.agents/skills/hunk-review"
ln -s "../../../co/skills/hunk-review-old" "$H1/.agents/skills/hunk-review"
run_install "$H1"
assert_eq "$RC" "0" "relative stale link: exit 0"
assert_eq "$(readlink "$H1/.agents/skills/hunk-review")" "$CO/skills/hunk-review" "relative stale link: replaced"

rm "$H1/.agents/skills/hunk-review"
ln -s "$TMP/foreign/missing" "$H1/.agents/skills/hunk-review"
run_install "$H1"
assert_eq "$RC" "1" "stale foreign link: exit 1"
assert_eq "$(readlink "$H1/.agents/skills/hunk-review")" "$TMP/foreign/missing" "stale foreign link: left as it was"

rm "$H1/.agents/skills/hunk-review"
ln -s "$TMP/nowhere/at-all" "$H1/.agents/skills/hunk-review"
run_install "$H1"
assert_eq "$RC" "1" "link whose parent folder is missing: exit 1"
assert_eq "$(readlink "$H1/.agents/skills/hunk-review")" "$TMP/nowhere/at-all" "link whose parent folder is missing: left as it was"
SHIM_DIR=

echo "a destination folder that resolves into the checkout"

# The checkout reached through a second spelling: ALIAS is a symlink to it.
ln -s "$CO" "$TMP/alias"
H2="$TMP/h2"
new_home "$H2"
mkdir -p "$H2/.agents"
ln -s "$TMP/alias/skills" "$H2/.agents/skills"
BEFORE=$(find "$CO/skills" | sort | wc -l)
run_install "$H2"
assert_eq "$RC" "1" "exit 1"
assert_match "$ERR" 'resolves into this repo' "says why"
assert_eq "$(find "$CO/skills" | sort | wc -l)" "$BEFORE" "nothing was written into the checkout"

H3="$TMP/h3"
new_home "$H3"
mkdir -p "$H3/.local"
ln -s "$TMP/alias/bin" "$H3/.local/bin"
BEFORE=$(find "$CO/bin" | sort | wc -l)
run_install "$H3"
assert_eq "$RC" "1" "bin folder: exit 1"
assert_match "$ERR" 'resolves into this repo' "bin folder: says why"
assert_eq "$(find "$CO/bin" | sort | wc -l)" "$BEFORE" "bin folder: nothing written into the checkout"

echo
echo "$PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
