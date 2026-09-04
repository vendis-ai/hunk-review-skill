/**
 * Getting text onto the clipboard from inside hunk.
 *
 * The extension API deliberately has none -- "The API touches nothing outside
 * the review. No clipboard, no filesystem" -- so this shells out, and the whole
 * of the decision is a pure function over the environment so it can be tested
 * without a display, a terminal, or a running compositor.
 *
 * Two mechanisms, not one, because they fail in opposite situations. A local
 * helper (`wl-copy` and friends) reaches the clipboard of the machine hunk is
 * running on, which is the wrong machine the moment you review over SSH. OSC 52
 * hands the text to the terminal emulator instead, so it lands on the machine
 * whose keyboard you are typing on -- but only if the terminal (or tmux, via
 * `set-clipboard`) honours it. Under tmux or SSH both run, and whichever works
 * wins.
 *
 * The OSC 52 sequence is emitted plain, with no `tmux;` passthrough wrapper.
 * That is what Neovim's own `vim.ui.clipboard.osc52` does, and what hunk itself
 * emits for a mouse selection.
 */

export type Osc52Mode = "auto" | "always" | "never";

export interface ClipboardConfig {
  /** A command to run instead of probing, or null to auto-detect. */
  readonly command: readonly string[] | null;
  readonly osc52: Osc52Mode;
}

/** `[extension.copy-path]`, defaulted and sanity-checked. Never throws. */
export function readClipboardConfig(raw: Record<string, unknown>): ClipboardConfig {
  const osc52 = raw.osc52 === "always" || raw.osc52 === "never" || raw.osc52 === "auto" ? raw.osc52 : "auto";

  const rawCommand = raw.command;
  if (typeof rawCommand === "string") {
    const trimmed = rawCommand.trim();
    return { command: trimmed === "" ? null : [trimmed], osc52 };
  }
  if (Array.isArray(rawCommand) && rawCommand.length > 0 && rawCommand.every((arg) => typeof arg === "string")) {
    return { command: rawCommand as string[], osc52 };
  }
  return { command: null, osc52 };
}

export interface ClipboardPlan {
  /** Spawn this with the text on stdin, or null when nothing local can copy. */
  readonly command: readonly string[] | null;
  /** Also write `osc52Payload(text)` to the terminal. */
  readonly osc52: boolean;
}

export interface PlanInput extends ClipboardConfig {
  readonly env: NodeJS.ProcessEnv;
  readonly which: (binary: string) => boolean;
}

function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}

/**
 * Pick a local clipboard command, in preference order.
 *
 * Each display-server tool is gated on its display variable as well as on the
 * binary existing: `wl-copy` is installed on plenty of machines that are not
 * currently running Wayland, and spawning it there fails slowly and silently
 * rather than falling through to something that works. `pbcopy` has no such
 * variable -- on macOS it is simply there.
 */
function detectCommand(env: NodeJS.ProcessEnv, which: (binary: string) => boolean): readonly string[] | null {
  if (isSet(env.WAYLAND_DISPLAY) && which("wl-copy")) return ["wl-copy", "--type", "text/plain"];
  if (which("pbcopy")) return ["pbcopy"];
  if (isSet(env.DISPLAY)) {
    if (which("xclip")) return ["xclip", "-selection", "clipboard"];
    if (which("xsel")) return ["xsel", "--input", "--clipboard"];
  }
  return null;
}

/** How this copy should be delivered. Pure: the only inputs are `env` and `which`. */
export function planClipboard(input: PlanInput): ClipboardPlan {
  const command = input.command ?? detectCommand(input.env, input.which);

  if (input.osc52 === "never") return { command, osc52: false };
  if (input.osc52 === "always") return { command, osc52: true };

  // Remote first: under tmux or SSH the local clipboard is very likely the
  // wrong machine's, so emit both and let the one that lands, land. Then last
  // resort: with no command at all, OSC 52 is the only way left to copy.
  const remote = isSet(input.env.TMUX) || isSet(input.env.SSH_TTY) || isSet(input.env.SSH_CONNECTION);
  return { command, osc52: remote || command === null };
}

/** The OSC 52 escape sequence setting the clipboard selection to `text`. */
export function osc52Payload(text: string): string {
  const base64 = Buffer.from(text, "utf8").toString("base64");
  return `\x1b]52;c;${base64}\x1b\\`;
}
