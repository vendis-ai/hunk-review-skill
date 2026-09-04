import { describe, expect, test } from "bun:test";
import { blendHex } from "../color";

describe("blendHex", () => {
  test("amount 0 returns the source untouched", () => {
    expect(blendHex("#ff8800", "#000000", 0)).toBe("#ff8800");
  });

  test("amount 1 returns the target", () => {
    expect(blendHex("#ff8800", "#101820", 1)).toBe("#101820");
  });

  test("mixes halfway", () => {
    expect(blendHex("#000000", "#ffffff", 0.5)).toBe("#808080");
  });

  test("expands three-digit hex on both sides", () => {
    expect(blendHex("#fff", "#000", 0.5)).toBe("#808080");
  });

  test("accepts hex without a leading hash", () => {
    expect(blendHex("ffffff", "000000", 0.5)).toBe("#808080");
  });

  test("is case-insensitive and normalises to lowercase", () => {
    expect(blendHex("#FF0000", "#00FF00", 0.5)).toBe("#808000");
  });

  test("clamps an out-of-range amount instead of overshooting", () => {
    expect(blendHex("#000000", "#ffffff", 2)).toBe("#ffffff");
    expect(blendHex("#ff8800", "#ffffff", -1)).toBe("#ff8800");
  });

  test("returns the source verbatim when either color is unparseable", () => {
    expect(blendHex("rebeccapurple", "#000000", 0.5)).toBe("rebeccapurple");
    expect(blendHex("#ff8800", "not-a-color", 0.5)).toBe("#ff8800");
    expect(blendHex("#ff88", "#000000", 0.5)).toBe("#ff88");
  });

  test("returns the source verbatim for a non-finite amount", () => {
    expect(blendHex("#ff8800", "#000000", Number.NaN)).toBe("#ff8800");
  });
});
