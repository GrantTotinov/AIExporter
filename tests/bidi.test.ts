import { describe, expect, it } from "vitest";
import { shapeArabicText } from "../src/arabic-shaping";
import { OBJECT_CHAR, isRtlParagraph, toVisual } from "../src/bidi";

const codes = (text: string) =>
  Array.from(text).map((char) => char.codePointAt(0));

describe("isRtlParagraph", () => {
  it("follows the first letter, past numbers and punctuation", () => {
    expect(isRtlParagraph("1. שלום")).toBe(true);
    expect(isRtlParagraph("«مرحبا» hello")).toBe(true);
    expect(isRtlParagraph("Hello שלום")).toBe(false);
    expect(isRtlParagraph("123 !?")).toBe(false);
    expect(isRtlParagraph(`${OBJECT_CHAR} שלום`)).toBe(false);
  });
});

describe("toVisual", () => {
  it("leaves left-to-right text alone", () => {
    expect(toVisual("plain text (1)", false)).toBe("plain text (1)");
  });

  it("reverses right-to-left words and their order", () => {
    expect(toVisual("שלום עולם", true)).toBe("םלוע םולש");
  });

  it("keeps Latin words and numbers readable inside right-to-left text", () => {
    expect(toVisual("גרסה React 18", true)).toBe("React 18 הסרג");
    expect(toVisual("מחיר 3.14 ₪", true)).toBe("₪ 3.14 ריחמ");
    expect(toVisual("הנחה 25%", true)).toBe("25% החנה");
    expect(toVisual("טווח 1-10", true)).toBe("1-10 חווט");
  });

  it("puts a Hebrew word in its place inside an English sentence", () => {
    expect(toVisual("with עברית inside", false)).toBe("with תירבע inside");
  });

  it("mirrors brackets in right-to-left text", () => {
    expect(toVisual("(שלום)", true)).toBe("(םולש)");
    expect(toVisual("«مرحبا»", true)).toBe("«ابحرم»");
  });

  it("puts a vowel mark before its letter, where DejaVu draws it onto it", () => {
    const shin = "ש";
    const qamats = "ָ";
    const lamed = "ל";

    expect(toVisual(`${shin}${qamats}${lamed}`, true)).toBe(
      `${lamed}${qamats}${shin}`,
    );
  });

  it("treats a formula as one left-to-right unit", () => {
    expect(toVisual(`נוסחה ${OBJECT_CHAR} כאן`, true)).toBe(
      `ןאכ ${OBJECT_CHAR} החסונ`,
    );
  });
});

describe("shapeArabicText", () => {
  it("picks each letter's joined form", () => {
    // seen (initial) + lam-alef (final) + meem (isolated)
    expect(codes(shapeArabicText("سلام"))).toEqual([0xfeb3, 0xfefc, 0xfee1]);
  });

  it("looks past vowel marks to decide how letters join", () => {
    // dhal, heh (initial), beh (medial), teh (final), damma
    expect(codes(shapeArabicText("ذهبتُ"))).toEqual([
      0xfeab, 0xfeeb, 0xfe92, 0xfe96, 0x064f,
    ]);
  });

  it("writes Allah with letters the font has", () => {
    expect(codes(shapeArabicText("الله"))).toEqual([
      0xfe8d, 0xfedf, 0xfee0, 0xfeea,
    ]);
  });

  it("joins Persian letters", () => {
    // gaf (initial), cheh (final)
    expect(codes(shapeArabicText("گچ"))).toEqual([0xfb94, 0xfb7b]);
  });

  it("leaves other text alone", () => {
    expect(shapeArabicText("abc שלום 123")).toBe("abc שלום 123");
  });
});
