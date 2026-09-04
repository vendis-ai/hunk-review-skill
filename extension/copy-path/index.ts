/**
 * copy-path: copies the selected file's path, in whichever spelling you need,
 * without reaching for the mouse.
 *
 * Hunk ships no copy-path command -- copying is mouse-selection only, and the
 * one command with "copy" in its name (`hunk.view.toggleCopyDecorations`) only
 * controls whether line numbers ride along with a drag. This fills that gap the
 * way the extension contract intends: commands under this extension's own id,
 * which can never shadow a built-in.
 *
 * The pure logic (path variants, reference formatting, clipboard strategy)
 * lives in ./paths.ts and ./clipboard.ts, unit-tested under `bun test`. This
 * file is the thin host-facing layer: three commands, the process spawn, and
 * the messaging.
 *
 * Unlike the review-plan extension next door, nothing here is imported from the
 * host at runtime -- `hunkdiff/extension` is a type-only import, erased at
 * transpile time. That makes this extension immune to the symlink trap in
 * hunk's `onLoad` specifier rewriting: with no `react` or `@opentui/*` import
 * to rewrite, it does not matter whether the hook fires.
 */
import type { ExtensionCommandContext, HunkExtensionAPI } from "hunkdiff/extension";
import * as fs from "node:fs";
import {
  osc52Payload,
  planClipboard,
  readClipboardConfig,
  type ClipboardConfig,
} from "./clipboard";
import { buildVariants, findRepoRoot, formatReference, type PathVariant } from "./paths";

const MIN_API_VERSION = 8;

/**
 * Why a reference came back without a line number.
 *
 * Hunk's current-line marker is off by default and both commands that turn it
 * on ship unbound, so `selection.currentLine` is null until the user has done
 * something about it. Degrading silently to a path-only reference would look
 * like the command half-working forever, so it says so, and names both fixes.
 */
const NO_CURRENT_LINE =
  "no current-line marker -- set cursor_line in hunk's config, or bind hunk.view.cursorLineNumber";

type DeliveryResult = { ok: true } | { ok: false; detail: string };

/**
 * Put `text` on the clipboard by every route the plan allows.
 *
 * Both routes are tried when both are planned, and either one succeeding is
 * success: under tmux or SSH they target different machines, and which of them
 * is the one the user is sitting at is not knowable from here.
 */
async function deliver(config: ClipboardConfig, text: string): Promise<DeliveryResult> {
  const plan = planClipboard({
    ...config,
    env: process.env,
    which: (binary) => Bun.which(binary) !== null,
  });

  let delivered = false;
  let detail = "no clipboard command found -- install wl-copy, or set [extension.copy-path] command";

  if (plan.command) {
    try {
      const proc = Bun.spawn(plan.command as string[], {
        stdin: new TextEncoder().encode(text),
        stdout: "ignore",
        stderr: "ignore",
      });
      const code = await proc.exited;
      if (code === 0) delivered = true;
      else detail = `${plan.command[0]} exited ${code}`;
    } catch (error) {
      detail = `${plan.command[0]} failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  if (plan.osc52) {
    try {
      // The controlling terminal rather than stdout: hunk owns stdout, and on a
      // remote session this is the sequence that reaches the local machine.
      fs.writeFileSync("/dev/tty", osc52Payload(text));
      delivered = true;
    } catch (error) {
      if (!plan.command) {
        detail = `OSC 52 write failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }

  return delivered ? { ok: true } : { ok: false, detail };
}

/** Copy, then say what happened. `note` is appended to a successful message. */
async function copyAndReport(
  ctx: ExtensionCommandContext,
  config: ClipboardConfig,
  text: string,
  note?: string
): Promise<void> {
  const result = await deliver(config, text);
  if (!result.ok) {
    ctx.notify(`copy-path: ${result.detail}`, "error");
    return;
  }
  ctx.notify(note ? `Copied: ${text} -- ${note}` : `Copied: ${text}`, note ? "warning" : "info");
}

/** The current line, as `buildVariants` and `formatReference` want it. */
function currentLine(ctx: ExtensionCommandContext): number | null {
  return ctx.selection.currentLine?.line ?? null;
}

/** `Relative: src/a.ts` -- what one row of the select dialog reads as. */
function renderVariant(variant: PathVariant): string {
  return `${variant.label}: ${variant.value}`;
}

export default function copyPath(hunk: HunkExtensionAPI): void {
  if (hunk.apiVersion < MIN_API_VERSION) return;

  const config = readClipboardConfig(hunk.config);

  hunk.registerCommand({ id: "path", title: "Copy file path", key: "y" }, async (ctx) => {
    const file = ctx.selection.file;
    if (!file) {
      ctx.notify("copy-path: no file selected", "warning");
      return;
    }
    // Hunk reports paths repo-root-relative already, which is the spelling
    // worth having on one keystroke. Everything else is behind `Y`.
    await copyAndReport(ctx, config, file.path);
  });

  hunk.registerCommand({ id: "pathVariant", title: "Copy file path (choose form)", key: "Y" }, async (ctx) => {
    const file = ctx.selection.file;
    if (!file) {
      ctx.notify("copy-path: no file selected", "warning");
      return;
    }

    const variants = buildVariants({
      repoPath: file.path,
      repoRoot: findRepoRoot(ctx.cwd),
      cwd: ctx.cwd,
      line: currentLine(ctx),
    });

    // The dialog answers with the row's text, so the mapping back has to be
    // built here rather than recovered by parsing the label off the front --
    // a path may itself contain ": ".
    const values = new Map(variants.map((variant) => [renderVariant(variant), variant.value]));
    const choice = await ctx.dialogs.select({ title: "Copy path", options: [...values.keys()] });
    if (choice === null) return;

    const value = values.get(choice);
    if (value === undefined) return;
    await copyAndReport(ctx, config, value);
  });

  hunk.registerCommand({ id: "reference", title: "Copy @path#Lx reference", key: "ctrl+y" }, async (ctx) => {
    const file = ctx.selection.file;
    if (!file) {
      ctx.notify("copy-path: no file selected", "warning");
      return;
    }
    const line = currentLine(ctx);
    await copyAndReport(ctx, config, formatReference(file.path, line), line === null ? NO_CURRENT_LINE : undefined);
  });
}
