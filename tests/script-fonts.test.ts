import { describe, expect, it } from "vitest";
import {
  FALLBACK_FONTS,
  cjkBreakPieces,
  fallbackFontFor,
  fallbackFontsFor,
  isWideChar,
  splitByFont,
  wrapByColumns,
  type FallbackFont,
} from "../src/script-fonts";

const family = (font: FallbackFont | null | undefined) => font?.family ?? null;

describe("the fallback fonts", () => {
  it("are picked by the scripts in the text", () => {
    expect(
      fallbackFontsFor(["Hello, Привет, مرحبا, שלום"]).map((font) => font.family),
    ).toEqual([]);
    expect(
      fallbackFontsFor(["你好", "こんにちは", "안녕", "नमस्ते", "สวัสดี"]).map(
        (font) => font.family,
      ),
    ).toEqual(["DroidSansFallback", "NotoSansKR", "NotoSansDevanagari", "NotoSansThai"]);
  });

  it("cover the scripts of China, Japan, Korea, India and South-East Asia", () => {
    expect(family(fallbackFontFor("中".codePointAt(0)!))).toBe("DroidSansFallback");
    expect(family(fallbackFontFor("カ".codePointAt(0)!))).toBe("DroidSansFallback");
    expect(family(fallbackFontFor("，".codePointAt(0)!))).toBe("DroidSansFallback");
    expect(family(fallbackFontFor("한".codePointAt(0)!))).toBe("NotoSansKR");
    expect(family(fallbackFontFor("ব".codePointAt(0)!))).toBe("NotoSansBengali");
    expect(family(fallbackFontFor("த".codePointAt(0)!))).toBe("NotoSansTamil");
    expect(family(fallbackFontFor("ക".codePointAt(0)!))).toBe("NotoSansMalayalam");
    expect(family(fallbackFontFor("ក".codePointAt(0)!))).toBe("NotoSansKhmer");
    expect(fallbackFontFor("A".codePointAt(0)!)).toBeUndefined();
  });

  it("each have a file in public/fonts", async () => {
    const { existsSync } = await import("node:fs");

    for (const font of FALLBACK_FONTS) {
      expect(existsSync(`public/fonts/${font.file}`), font.file).toBe(true);
    }
  });
});

describe("splitByFont", () => {
  const latin = (code: number) => code < 0x0900;
  const all = () => true;

  it("gives each stretch the font that has it", () => {
    expect(
      splitByFont("Hi 你好, नमस्ते!", latin, all).map((segment) => [
        segment.text,
        family(segment.font),
      ]),
    ).toEqual([
      ["Hi ", null],
      ["你好", "DroidSansFallback"],
      [", ", null],
      ["नमस्ते", "NotoSansDevanagari"],
      ["!", null],
    ]);
  });

  it("keeps joiners with the letters they join", () => {
    const text = "क्‍ष";

    expect(splitByFont(text, latin, all)).toEqual([
      { text, font: expect.objectContaining({ family: "NotoSansDevanagari" }) },
    ]);
  });

  it("leaves a character no loaded font has to the export's font", () => {
    expect(splitByFont("中", latin, () => false)).toEqual([{ text: "中", font: null }]);
  });
});

describe("Chinese and Japanese line breaks", () => {
  it("may break between characters, but not before a closing mark or after an opening one", () => {
    expect(cjkBreakPieces("他说：「你好。」")).toEqual(["他", "说：", "「你", "好。」"]);
    expect(cjkBreakPieces("ちょっと")).toEqual(["ちょっ", "と"]);
  });
});

describe("code columns", () => {
  it("counts Chinese, Japanese and Korean characters as two", () => {
    expect(isWideChar("中".codePointAt(0)!)).toBe(true);
    expect(isWideChar("한".codePointAt(0)!)).toBe(true);
    expect(isWideChar("Ａ".codePointAt(0)!)).toBe(true);
    expect(isWideChar("a".codePointAt(0)!)).toBe(false);
    expect(isWideChar("न".codePointAt(0)!)).toBe(false);
  });

  it("wraps a line of code by columns", () => {
    expect(wrapByColumns("abcdef", 4)).toEqual(["abcd", "ef"]);
    expect(wrapByColumns("中文注释ab", 4)).toEqual(["中文", "注释", "ab"]);
    expect(wrapByColumns("", 4)).toEqual([""]);
  });

  it("never splits a surrogate pair or a combining mark from its letter", () => {
    expect(wrapByColumns("𠀀𠀀", 2)).toEqual(["𠀀", "𠀀"]);
    expect(wrapByColumns("ab́c", 2)).toEqual(["ab́", "c"]);
  });
});
