# copy-path

Copies the selected file's path out of a hunk review -- repo-relative,
absolute, filename, or as an `@path#Lx` reference -- on a keystroke.

> **Installing this?** Run `./install.sh` at the root of this repository; it
> points hunk at this directory by absolute path. The root
> [`README.md`](../../README.md) explains why extensions here are registered by
> real path rather than symlinked.

## Why it exists

Hunk has no copy-path command. Its command registry carries exactly one entry
with "copy" in the name -- `hunk.view.toggleCopyDecorations` -- and that only
controls whether line numbers and `+`/`-` markers ride along when you drag a
mouse selection. Copying anything at all is mouse-driven, which is no use when
the thing you want is the *path*, and the reason you want it is to paste it
into an agent.

`[keybindings]` cannot close the gap: it rebinds commands that already exist.
So this adds them. Command ids live under this extension's own id, and `hunk`
is a reserved id, so nothing here can shadow a built-in -- now or after a
future upstream release adds its own copy commands.

## Key bindings

| Key | Command | Copies |
| --- | --- | --- |
| `y` | Copy file path | `extension/copy-path/index.ts` -- repo-relative, no dialog |
| `Y` | Copy file path (choose form) | A select dialog over every distinct spelling |
| `ctrl+y` | Copy `@path#Lx` reference | `@extension/copy-path/index.ts#L42` |

None of the three chords is claimed by hunk 0.20.1, and none collides with
[`review-plan`](../review-plan/README.md) next door, which takes `v x V n p`.

## The forms `Y` offers

| Label | Value |
| --- | --- |
| `Relative` | Repo-root-relative -- exactly what hunk reports |
| `Absolute` | Repo root joined to it |
| `CWD relative` | Relative to the directory hunk was launched in |
| `Filename` | Basename alone |
| `Reference` | `@path#Lx` for the current line |

Forms that collapse into each other are dropped rather than listed twice: a
file at the repo root has no distinct `Filename`, hunk launched at the repo
root has no distinct `CWD relative`, and `Reference` is absent without a
current line. `Relative` is the input itself, so the list is never empty.

## The current-line marker

`ctrl+y` and the `Reference` row both need `selection.currentLine`, which hunk
leaves `null` until its current-line marker is on. The marker is **off by
default**, and both commands that turn it on -- `hunk.view.cursorLineRow` and
`hunk.view.cursorLineNumber` -- ship **unbound**. So out of the box a reference
has no line to carry.

Rather than degrade silently, `ctrl+y` copies the bare `@path` and says why:

```
Copied: @extension/copy-path/index.ts -- no current-line marker --
set cursor_line in hunk's config, or bind hunk.view.cursorLineNumber
```

Either fix works. In `~/.config/hunk/config.toml`:

```toml
cursor_line = "number"          # or "row"

[keybindings]
"hunk.view.cursorLineNumber" = "C"
```

## Config (`[extension.copy-path]`)

```toml
[extension.copy-path]
command = ["wl-copy", "--type", "text/plain"]   # force one; omit to auto-detect
osc52 = "auto"                                   # "auto" | "always" | "never"
```

A configured `command` is used verbatim, with the text on stdin, and nothing is
probed. A bare string is accepted as a one-word command.

## How the text reaches the clipboard

The extension API deliberately has none -- *"The API touches nothing outside the
review. No clipboard, no filesystem"* -- so this shells out, by two routes that
fail in opposite situations.

**A local helper**, chosen in this order, each gated on its display variable as
well as on the binary existing:

| Tool | Requires |
| --- | --- |
| `wl-copy --type text/plain` | `WAYLAND_DISPLAY` |
| `pbcopy` | nothing -- on macOS it is simply there |
| `xclip -selection clipboard` | `DISPLAY` |
| `xsel --input --clipboard` | `DISPLAY` |

The display gate matters: `wl-copy` is installed on plenty of machines not
currently running Wayland, and spawning it there fails quietly instead of
falling through to something that works.

**OSC 52**, written to `/dev/tty`, which hands the text to the terminal emulator
instead -- so it lands on the machine whose keyboard you are typing on. Under
`auto` this fires when `TMUX`, `SSH_TTY` or `SSH_CONNECTION` is set, and as a
last resort whenever no local helper was found at all.

Under tmux or SSH both routes run, because which of them targets the machine
you are actually sitting at is not knowable from inside hunk. Either one
succeeding counts as success.

The sequence is emitted plain -- `ESC ] 52 ; c ; <base64> ESC \` -- with no
`tmux;` passthrough wrapper, matching Neovim's own `vim.ui.clipboard.osc52` and
what hunk emits for a mouse selection. It needs `set-clipboard on` in tmux.

Nothing is marked `--sensitive`. A copied path is exactly the kind of thing you
want to find again in clipboard history.

## Contributing

```sh
cd extension/copy-path
bun install
bun test
bun run typecheck
```

`paths.ts` and `clipboard.ts` are plain modules with no host imports, and carry
all the logic worth testing -- path-variant building, reference formatting, the
repo-root walk, clipboard strategy selection, OSC 52 framing. `index.ts` is the
thin host-facing layer: three commands, one spawn, and the messaging.

The only import from hunk anywhere in the extension is `import type`, erased at
transpile time. That makes this extension immune to the symlink trap documented
in the root README: with no `react` or `@opentui/*` specifier to rewrite, it
does not matter whether hunk's `onLoad` hook fires.
