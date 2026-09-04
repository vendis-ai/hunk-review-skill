#!/usr/bin/env bash
#
# Install the hunk-review skills, the hunk-plan CLI, and the hunk extensions
# from this checkout.
#
# Everything is installed as a symlink into this repository, so `git pull` is
# all that is needed to update -- with one deliberate exception: the hunk
# extensions are NOT symlinked anywhere. They are loaded from their real paths
# here, via absolute entries in hunk's own config. See the config step below
# for why that is a correctness requirement rather than a preference.
#
# Re-running is safe. Nothing is overwritten unless it is a symlink this
# script owns.

set -euo pipefail

REPO=$(cd -- "$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")" && pwd)

DRY=0
for arg in "$@"; do
  case $arg in
    -n|--dry-run) DRY=1 ;;
    -h|--help)
      sed -n '3,13p' "$0" | sed 's/^# \{0,1\}//'
      printf '\nUsage: install.sh [-n|--dry-run]\n'
      exit 0 ;;
    *) printf 'install.sh: unknown option %s\n' "$arg" >&2; exit 2 ;;
  esac
done

ok()    { printf '  \033[32m*\033[0m %s\n' "$*"; }
warn()  { printf '  \033[33m!\033[0m %s\n' "$*"; }
err()   { printf '  \033[31mx\033[0m %s\n' "$*" >&2; }
head_() { printf '\n\033[1m%s\033[0m\n' "$*"; }
would() { [ "$DRY" = 1 ]; }
# Abbreviate $HOME as ~ for display. $HOME must be quoted inside the pattern and
# the ~ escaped, or the substitution silently does nothing.
t()     { printf '%s' "${1/#"$HOME"/\~}"; }

FAILED=0

# ── guards ───────────────────────────────────────────────────────────────────
# Refuse if a destination directory is itself a symlink resolving back into
# this repo: we would then write per-skill symlinks into our own working tree.
guard_dest() {
  local dest=$1
  [ -L "$dest" ] || return 0
  local resolved
  resolved=$(readlink -f -- "$dest")
  case $resolved in
    "$REPO" | "$REPO"/*)
      err "$dest is a symlink into this repo ($resolved)."
      err "Installing would write symlinks into this checkout. Aborting."
      exit 1 ;;
  esac
}

# Symlink $2 -> $1, idempotently. Never clobbers a real file or directory.
link() {
  local src=$1 dst=$2
  if [ -L "$dst" ]; then
    if [ "$(readlink -f -- "$dst" 2>/dev/null)" = "$(readlink -f -- "$src")" ]; then
      ok "$(t "$dst") (already linked)"
      return 0
    fi
    would && { ok "would relink $(t "$dst") -> $src"; return 0; }
    rm -f -- "$dst"
  elif [ -e "$dst" ]; then
    err "$(t "$dst") exists and is not a symlink -- refusing to replace it"
    FAILED=1
    return 0
  fi
  would && { ok "would link $(t "$dst") -> $src"; return 0; }
  ln -sfn -- "$src" "$dst"
  ok "$(t "$dst") -> $src"
}

mkdirp() {
  [ -d "$1" ] && return 0
  would && { ok "would create $(t "$1")"; return 0; }
  mkdir -p -- "$1"
  ok "created $(t "$1")"
}

# ── 1. skills ────────────────────────────────────────────────────────────────
# ~/.agents/skills is the canonical cross-agent location: Codex, OpenCode,
# Cursor, Cline, Warp, Zed, Gemini CLI, Copilot and a dozen others read it
# directly and need no per-agent link. Claude Code is the sole outlier among
# the common harnesses -- it reads ~/.claude/skills and nothing else.
head_ 'Skills'

AGENTS_SKILLS="$HOME/.agents/skills"
guard_dest "$AGENTS_SKILLS"
mkdirp "$AGENTS_SKILLS"
for src in "$REPO"/skills/*/; do
  link "${src%/}" "$AGENTS_SKILLS/$(basename "$src")"
done

if [ -d "$HOME/.claude" ]; then
  CLAUDE_SKILLS="$HOME/.claude/skills"
  guard_dest "$CLAUDE_SKILLS"
  mkdirp "$CLAUDE_SKILLS"
  for src in "$REPO"/skills/*/; do
    link "${src%/}" "$CLAUDE_SKILLS/$(basename "$src")"
  done
else
  warn '~/.claude not found -- skipping Claude Code (nothing else to do)'
fi

# ── 2. hunk-plan CLI ─────────────────────────────────────────────────────────
# The skill calls `hunk-plan` as a bare command, so it has to be on the real
# user PATH -- not injected by a single harness.
head_ 'hunk-plan CLI'

BIN_DIR="$HOME/.local/bin"
guard_dest "$BIN_DIR"
mkdirp "$BIN_DIR"
link "$REPO/bin/hunk-plan" "$BIN_DIR/hunk-plan"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on your PATH -- add it, or hunk-plan will not resolve" ;;
esac

# ── 3. extensions ────────────────────────────────────────────────────────────
# NOT symlinked, on purpose, and for review-plan this is a correctness
# requirement.
#
# hunk serves `react`, `@opentui/*` and `hunkdiff/extension` to an extension by
# registering a Bun onLoad plugin and rewriting those specifiers to `hunk-host:`
# ones. registerSourceRoot() anchors that plugin's filter at dirname(entryPath),
# but Bun hands onLoad the file's REALPATH. Reached through a symlink the two
# differ, the hook never fires, nothing is rewritten, and the imports resolve as
# ordinary npm ones. Both outcomes are broken and NEITHER names the cause:
#   node_modules present -> a second React loads, the pane throws, hunk
#     quarantines it and silently restores the built-in files pane. No error is
#     shown, and the extension's non-React half keeps working -- so it looks
#     loaded and healthy.
#   node_modules absent  -> "Cannot find module 'react/jsx-dev-runtime'".
# Pointing hunk at the real path makes entry path and realpath identical.
#
# copy-path cannot hit that trap -- its only hunk import is an `import type`,
# erased at transpile time, so there is nothing for the hook to rewrite. It is
# registered by real path anyway: one rule for every extension beats a
# per-extension exception that has to be re-derived each time one is added.
#
# Fixed upstream in hunk 0.21.0 (registerSourceRoot there registers both the
# literal directory and its canonical path). Until that is what everyone runs,
# the real path is the only spelling that works on every version.
head_ 'Extensions'

HUNK_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/hunk/config.toml"

EXT_PATHS=()
for src in "$REPO"/extension/*/; do
  EXT_PATHS+=("${src%/}")
done

# The body of the TOML `paths` array: `"a", "b"`.
PATHS_TOML=""
for ext in "${EXT_PATHS[@]}"; do
  [ -n "$PATHS_TOML" ] && PATHS_TOML+=", "
  PATHS_TOML+="\"$ext\""
done

read -r -d '' CONFIG_BLOCK <<TOML || true
[extensions]
enabled = true

# Loaded from their REAL paths, never through a symlink -- hunk's Bun onLoad
# hook matches on realpath and silently fails to fire otherwise.
# Absolute, because hunk does not expand ~ in this key.
paths = [$PATHS_TOML]
TOML

if [ ! -e "$HUNK_CONFIG" ]; then
  mkdirp "$(dirname "$HUNK_CONFIG")"
  if would; then
    ok "would create $(t "$HUNK_CONFIG") with an [extensions] section"
  else
    printf '%s\n' "$CONFIG_BLOCK" > "$HUNK_CONFIG"
    ok "created $(t "$HUNK_CONFIG")"
  fi
else
  MISSING=()
  for ext in "${EXT_PATHS[@]}"; do
    if grep -qF -- "$ext" "$HUNK_CONFIG"; then
      ok "$(basename "$ext") (already in $(t "$HUNK_CONFIG"))"
    else
      MISSING+=("$ext")
    fi
  done

  if [ ${#MISSING[@]} -gt 0 ]; then
    if ! grep -qE '^[[:space:]]*\[extensions\]' "$HUNK_CONFIG"; then
      if would; then
        ok "would append an [extensions] section to $(t "$HUNK_CONFIG")"
      else
        printf '\n%s\n' "$CONFIG_BLOCK" >> "$HUNK_CONFIG"
        ok "appended an [extensions] section to $(t "$HUNK_CONFIG")"
      fi
    else
      # An [extensions] section already exists. TOML forbids a second one, and
      # rewriting the existing `paths` array from a shell script is exactly how
      # the silent-failure mode above gets introduced. Hand it to the user.
      warn "$(t "$HUNK_CONFIG") already has an [extensions] section."
      warn 'Not editing it. Add these to that section by hand:'
      printf '\n    enabled = true\n    paths = [\n'
      for ext in "${MISSING[@]}"; do
        printf '      "%s",\n' "$ext"
      done
      printf '    ]\n\n'
      warn 'If `paths` is already set, append to the existing array rather than'
      warn 'replacing it. The paths must be absolute -- hunk does not expand ~.'
    fi
  fi
fi

# ── 4. report ────────────────────────────────────────────────────────────────
head_ 'Environment'

if command -v hunk >/dev/null 2>&1; then
  ok "hunk $(hunk --version 2>/dev/null || echo '(version unknown)')"
else
  warn 'hunk is not on PATH. Install it with: mise use -g aqua:modem-dev/hunk'
fi

command -v bun >/dev/null 2>&1 \
  && ok "bun $(bun --version)" \
  || warn 'bun is not on PATH. hunk bundles its own runtime for extensions, so
    this only matters if you want to run the extension tests.'

head_ 'Next'
cat <<'NEXT'
  Verify the skill is visible to your agent:
    ls -l ~/.agents/skills/hunk-review ~/.claude/skills/hunk-review

  Verify the CLI resolves:
    hunk-plan --help

  Verify the extensions load (open hunk in any repo with changes; the files
  pane should be grouped rather than flat, and `y` should copy a path):
    hunk

  A silently quarantined extension still shows a working files pane. If groups
  do not appear, review-plan did not load -- check that hunk's `paths` entry is
  the real path printed above and contains no symlinked component.
NEXT

if [ "$FAILED" != 0 ]; then
  printf '\n'
  err 'Some steps were skipped -- see the errors above.'
  exit 1
fi

would && printf '\n  (dry run -- nothing was changed)\n'
exit 0
