import { describe, expect, test } from "bun:test";
import { osc52Payload, planClipboard, readClipboardConfig } from "../clipboard";

type Which = (binary: string) => boolean;

/** A `which` stand-in: every listed binary is present, nothing else is. */
function present(...binaries: string[]): Which {
  const set = new Set(binaries);
  return (binary) => set.has(binary);
}

const NONE: Which = () => false;

function plan(
  env: NodeJS.ProcessEnv,
  which: Which = NONE,
  overrides: Partial<Parameters<typeof planClipboard>[0]> = {}
) {
  return planClipboard({ env, which, command: null, osc52: "auto", ...overrides });
}

describe("planClipboard command selection", () => {
  test("prefers wl-copy on Wayland", () => {
    const result = plan({ WAYLAND_DISPLAY: "wayland-1" }, present("wl-copy", "xclip"));
    expect(result.command).toEqual(["wl-copy", "--type", "text/plain"]);
  });

  test("ignores wl-copy when there is no Wayland display to copy into", () => {
    const result = plan({}, present("wl-copy"));
    expect(result.command).toBe(null);
  });

  test("falls back to pbcopy, which needs no display variable", () => {
    const result = plan({}, present("pbcopy"));
    expect(result.command).toEqual(["pbcopy"]);
  });

  test("falls back to xclip on X11", () => {
    const result = plan({ DISPLAY: ":0" }, present("xclip"));
    expect(result.command).toEqual(["xclip", "-selection", "clipboard"]);
  });

  test("falls back to xsel when xclip is absent", () => {
    const result = plan({ DISPLAY: ":0" }, present("xsel"));
    expect(result.command).toEqual(["xsel", "--input", "--clipboard"]);
  });

  test("ignores X11 tools when there is no X display", () => {
    expect(plan({}, present("xclip", "xsel")).command).toBe(null);
  });

  test("takes wl-copy over xclip when both displays are set", () => {
    const result = plan({ WAYLAND_DISPLAY: "wayland-1", DISPLAY: ":0" }, present("wl-copy", "xclip"));
    expect(result.command).toEqual(["wl-copy", "--type", "text/plain"]);
  });

  test("a configured command wins outright and probes nothing", () => {
    const which = () => {
      throw new Error("which must not be consulted when a command is configured");
    };
    const result = plan({ WAYLAND_DISPLAY: "wayland-1" }, which, { command: ["my-copy", "--stdin"] });
    expect(result.command).toEqual(["my-copy", "--stdin"]);
  });

  test("has no command when nothing is available", () => {
    expect(plan({}, NONE).command).toBe(null);
  });
});

describe("planClipboard OSC 52 decision", () => {
  test("auto stays off for a plain local session that has a clipboard tool", () => {
    expect(plan({ WAYLAND_DISPLAY: "wayland-1" }, present("wl-copy")).osc52).toBe(false);
  });

  test("auto turns on inside tmux", () => {
    const env = { WAYLAND_DISPLAY: "wayland-1", TMUX: "/tmp/tmux-1000/default,1,0" };
    expect(plan(env, present("wl-copy")).osc52).toBe(true);
  });

  test("auto turns on over SSH", () => {
    expect(plan({ SSH_TTY: "/dev/pts/3" }, NONE).osc52).toBe(true);
    expect(plan({ SSH_CONNECTION: "10.0.0.1 22 10.0.0.2 22" }, NONE).osc52).toBe(true);
  });

  test("auto turns on as a last resort when nothing else can copy", () => {
    expect(plan({}, NONE).osc52).toBe(true);
  });

  test("always turns it on even beside a working local tool", () => {
    const result = plan({ WAYLAND_DISPLAY: "wayland-1" }, present("wl-copy"), { osc52: "always" });
    expect(result.osc52).toBe(true);
  });

  test("never keeps it off even when there is no other way to copy", () => {
    const result = plan({}, NONE, { osc52: "never" });
    expect(result).toEqual({ command: null, osc52: false });
  });
});

describe("osc52Payload", () => {
  const PREFIX = "\x1b]52;c;";
  const TERMINATOR = "\x1b\\";

  test("frames base64 as OSC 52 for the clipboard selection, ST-terminated", () => {
    expect(osc52Payload("hi")).toBe(`${PREFIX}${btoa("hi")}${TERMINATOR}`);
  });

  test("encodes non-ASCII as UTF-8 rather than throwing", () => {
    const payload = osc52Payload("café");
    expect(payload.startsWith(PREFIX)).toBe(true);
    expect(payload.endsWith(TERMINATOR)).toBe(true);
    const encoded = payload.slice(PREFIX.length, -TERMINATOR.length);
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe("café");
  });

  test("encodes the empty string without special-casing it", () => {
    expect(osc52Payload("")).toBe(`${PREFIX}${TERMINATOR}`);
  });
});

describe("readClipboardConfig", () => {
  test("defaults to auto detection with no forced command", () => {
    expect(readClipboardConfig({})).toEqual({ command: null, osc52: "auto" });
  });

  test("accepts a command as an array of strings", () => {
    expect(readClipboardConfig({ command: ["wl-copy", "--primary"] }).command).toEqual(["wl-copy", "--primary"]);
  });

  test("accepts a bare string command", () => {
    expect(readClipboardConfig({ command: "pbcopy" }).command).toEqual(["pbcopy"]);
  });

  test("ignores an empty or non-string command rather than spawning nonsense", () => {
    expect(readClipboardConfig({ command: [] }).command).toBe(null);
    expect(readClipboardConfig({ command: ["wl-copy", 7] }).command).toBe(null);
    expect(readClipboardConfig({ command: 7 }).command).toBe(null);
    expect(readClipboardConfig({ command: "   " }).command).toBe(null);
  });

  test("accepts the three osc52 modes and falls back to auto for anything else", () => {
    expect(readClipboardConfig({ osc52: "always" }).osc52).toBe("always");
    expect(readClipboardConfig({ osc52: "never" }).osc52).toBe("never");
    expect(readClipboardConfig({ osc52: "auto" }).osc52).toBe("auto");
    expect(readClipboardConfig({ osc52: "yes" }).osc52).toBe("auto");
    expect(readClipboardConfig({ osc52: true }).osc52).toBe("auto");
  });
});
