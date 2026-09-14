#!/usr/bin/env bash
#
# Fail when a hunk release has claimed a key chord one of this repo's
# extensions binds.
#
# hunk's built-ins win every chord conflict. buildExtensionAppCommands drops
# the extension's chord, the command is left unbound, and the only evidence is
# a startup notice inside a running session -- which is how `v`, `y` and `n`
# stopped working the day 0.22.0 shipped, silently, until someone pressed one.
#
# This reads the same catalog hunk builds its own defaults from and compares it
# against what the extensions declare, so the next collision arrives as a red
# job rather than a dead key. Like the missing-Chrome guard in ci.yml, it fails
# loudly: a check that skips itself when the network is down is worse than one
# that goes red.
#
# No credentials. Tags come from `git ls-remote`, the catalog from
# raw.githubusercontent.com.

set -euo pipefail

REPO_URL=https://github.com/modem-dev/hunk
RAW_URL=https://raw.githubusercontent.com/modem-dev/hunk
ROOT=$(cd "$(dirname "$0")/.." && pwd)

# The catalog moved into packages/ in 0.22.0 (modem-dev/hunk#997). Both
# spellings are tried so this keeps working against older tags.
CATALOG_PATHS=(
  packages/hunk/src/core/run/commandCatalog.ts
  src/core/run/commandCatalog.ts
)

# Newest stable tag. Betas are excluded deliberately: what matters is what a
# user installs, and a beta's catalog can still change before it ships.
latest_tag() {
  git ls-remote --tags --refs "$REPO_URL" 'v*' \
    | sed 's#.*refs/tags/##' \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
    | sort -V \
    | tail -1
}

fetch_catalog() {
  local tag=$1 path
  for path in "${CATALOG_PATHS[@]}"; do
    if curl -fsSL "$RAW_URL/$tag/$path"; then
      return 0
    fi
  done
  return 1
}

# Every chord in a `defaultKeys: [...]` array. The array is one line today, but
# it is accumulated to the closing bracket so a reformat upstream cannot make
# this silently see fewer keys than hunk has.
builtin_chords() {
  awk '
    collecting            { buf = buf " " $0 }
    !collecting && /defaultKeys:/ { buf = $0; collecting = 1 }
    collecting && buf ~ /\]/ {
      sub(/\].*/, "]", buf)
      print buf
      collecting = 0
      buf = ""
    }
  ' | grep -o '"[^"]*"' | tr -d '"'
}

# What the extensions declare. Both files keep a registerCommand descriptor on
# one line, which keeps this a grep rather than a TypeScript parse; the count
# below catches it if that ever stops being true.
extension_chords() {
  grep -ho 'key: *\("[^"]*"\|\[[^]]*\]\)' \
    "$ROOT/extension/review-plan/index.tsx" \
    "$ROOT/extension/copy-path/index.ts" \
    | grep -o '"[^"]*"' | tr -d '"'
}

# hunk spells a shifted letter as the uppercase character and says so in
# docs/keybindings.md, but `shift+v` parses to the same chord as `V`. Folding
# one onto the other stops a rewording upstream from hiding a real collision.
normalize() {
  awk '{ if ($0 ~ /^shift\+[a-z]$/) print toupper(substr($0, 7)); else print }'
}

main() {
  local tag catalog ours theirs conflicts

  tag=$(latest_tag)
  if [ -z "$tag" ]; then
    echo "keymap_check: could not resolve a stable hunk tag from $REPO_URL" >&2
    exit 1
  fi

  if ! catalog=$(fetch_catalog "$tag"); then
    echo "keymap_check: no command catalog at $tag; tried ${CATALOG_PATHS[*]}" >&2
    exit 1
  fi

  theirs=$(printf '%s\n' "$catalog" | builtin_chords | normalize | sort -u)
  ours=$(extension_chords | normalize | sort -u)

  if [ -z "$theirs" ]; then
    echo "keymap_check: parsed no chords out of the $tag catalog; the format moved" >&2
    exit 1
  fi
  if [ -z "$ours" ]; then
    echo "keymap_check: parsed no chords out of the extensions; the format moved" >&2
    exit 1
  fi

  echo "hunk $tag declares $(printf '%s\n' "$theirs" | wc -l | tr -d ' ') built-in chords"
  echo "this repo declares  $(printf '%s\n' "$ours" | wc -l | tr -d ' ') extension chords"

  conflicts=$(comm -12 <(printf '%s\n' "$theirs") <(printf '%s\n' "$ours"))
  if [ -z "$conflicts" ]; then
    echo "no collisions"
    return 0
  fi

  echo >&2
  echo "keymap_check: hunk $tag claims chords these extensions bind." >&2
  echo "A built-in wins, so each of these is already a dead key:" >&2
  while IFS= read -r chord; do
    [ -n "$chord" ] || continue
    echo >&2
    echo "  \"$chord\" is bound by:" >&2
    grep -n "key: .*\"$chord\"" \
      "$ROOT/extension/review-plan/index.tsx" \
      "$ROOT/extension/copy-path/index.ts" >&2 || true
  done <<< "$conflicts"
  echo >&2
  echo "Rebind them, preferring shifted letters or punctuation: hunk holds 21 of" >&2
  echo "the 26 lowercase letters and keeps taking more." >&2
  exit 1
}

main "$@"
