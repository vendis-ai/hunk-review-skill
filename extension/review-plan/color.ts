/**
 * Foreground fading for pane rows.
 *
 * A terminal cell has no alpha channel, so a row cannot be drawn at reduced
 * opacity. The equivalent is to mix its foreground toward the background it
 * actually sits on and paint the result opaquely -- which is why `blendHex`
 * takes the background as an argument rather than assuming one: a selected
 * row sits on `selectedHunk`, an ordinary one on `panel`, and fading toward
 * the wrong one is what makes a "dimmed" row unreadable when selected.
 *
 * Theme tokens are typed as plain strings, so an unparseable value is
 * returned untouched. A file that fails to fade is a cosmetic miss; one that
 * throws out of a pane component takes the whole pane down with it.
 */

const SHORT_HEX_RE = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const LONG_HEX_RE = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

type Rgb = [number, number, number];

function parseHex(value: string): Rgb | null {
  const short = SHORT_HEX_RE.exec(value);
  if (short) {
    return [
      Number.parseInt(`${short[1]}${short[1]}`, 16),
      Number.parseInt(`${short[2]}${short[2]}`, 16),
      Number.parseInt(`${short[3]}${short[3]}`, 16),
    ];
  }
  const long = LONG_HEX_RE.exec(value);
  if (long) {
    return [Number.parseInt(long[1]!, 16), Number.parseInt(long[2]!, 16), Number.parseInt(long[3]!, 16)];
  }
  return null;
}

function toHex(channel: number): string {
  return Math.round(channel).toString(16).padStart(2, "0");
}

/**
 * Mix `from` toward `toward` by `amount` (0 = unchanged, 1 = fully `toward`).
 * Either color unparseable, or a non-finite amount, returns `from` verbatim.
 */
export function blendHex(from: string, toward: string, amount: number): string {
  if (!Number.isFinite(amount)) return from;
  const ratio = Math.min(1, Math.max(0, amount));
  if (ratio === 0) return from;

  const source = parseHex(from);
  const target = parseHex(toward);
  if (!source || !target) return from;

  const mixed = source.map((channel, index) => channel + (target[index]! - channel) * ratio) as Rgb;
  return `#${toHex(mixed[0])}${toHex(mixed[1])}${toHex(mixed[2])}`;
}
