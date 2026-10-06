/*
 * =========================================================
 * AI Exporter - script-fonts.ts
 * =========================================================
 *
 * The fonts a PDF export falls back to for the writing systems
 * DejaVu Sans doesn't have. Without them a reply in Chinese,
 * Japanese, Korean, Hindi, Bengali, Tamil or Thai came out as a
 * row of U+FFFD boxes (see fitToFont() in pdf-export.ts).
 *
 * Two kinds:
 *
 *  - "cjk": Chinese, Japanese and Korean. Their characters need no
 *    shaping - each one is a glyph of its own - so they're drawn
 *    as ordinary PDF text, which stays searchable and copyable.
 *    Droid Sans Fallback (Apache 2.0) has the Han characters, kana
 *    and CJK punctuation; Noto Sans KR, cut down to its Hangul,
 *    the Korean syllables Droid doesn't have.
 *  - "shaped": the Indic scripts and those of South-East Asia.
 *    Their letters change shape and order around each other (a
 *    Hindi "ि" is written before the consonant it follows), which
 *    a PDF viewer won't do and jsPDF can't either. text-shaping.ts
 *    runs them through HarfBuzz and pdf-export.ts draws the glyphs
 *    it picks as outlines, with the text itself laid invisibly on
 *    top so the PDF can still be searched and copied from. One
 *    Noto Sans font (SIL Open Font License) per script.
 *
 * The files live in public/fonts/ with DROID-NOTICE.txt and
 * NOTO-LICENSE.txt. They're only fetched when a conversation has
 * text in their scripts, so an export in English loads none.
 */

export interface FallbackFont {
  /* The family name jsPDF knows it by */
  family: string;
  /* Its file in public/fonts/ */
  file: string;
  kind: "cjk" | "shaped";
  /*
   * Chinese and Japanese don't put spaces between words: a line
   * may break after almost any character. Korean does, and is
   * broken at its spaces like English.
   */
  breaksAnywhere?: boolean;
  /* The Unicode blocks it's used for */
  ranges: readonly (readonly [number, number])[];
}

export const FALLBACK_FONTS: readonly FallbackFont[] = [
  {
    family: "DroidSansFallback",
    file: "DroidSansFallbackFull.ttf",
    kind: "cjk",
    breaksAnywhere: true,
    ranges: [
      [0x2e80, 0x2fdf], // radicals
      [0x3000, 0x303f], // CJK symbols and punctuation
      [0x3040, 0x30ff], // hiragana, katakana
      [0x3100, 0x312f], // bopomofo
      [0x31a0, 0x31ff], // bopomofo extended, strokes, katakana extensions
      [0x3200, 0x33ff], // enclosed letters, compatibility
      [0x3400, 0x4dbf], // Han, extension A
      [0x4e00, 0x9fff], // Han
      [0xf900, 0xfaff], // Han compatibility ideographs
      [0xfe30, 0xfe4f], // CJK compatibility forms
      [0xff00, 0xffef], // full-width and half-width forms
    ],
  },
  {
    family: "NotoSansKR",
    file: "NotoSansKR-Hangul.ttf",
    kind: "cjk",
    ranges: [
      [0x1100, 0x11ff], // Hangul jamo
      [0x3130, 0x318f], // Hangul compatibility jamo
      [0xa960, 0xa97f], // Hangul jamo extended A
      [0xac00, 0xd7a3], // Hangul syllables
      [0xd7b0, 0xd7ff], // Hangul jamo extended B
    ],
  },
  shaped("Devanagari", [0x0900, 0x097f], [0xa8e0, 0xa8ff], [0x1cd0, 0x1cff]),
  shaped("Bengali", [0x0980, 0x09ff]),
  shaped("Gurmukhi", [0x0a00, 0x0a7f]),
  shaped("Gujarati", [0x0a80, 0x0aff]),
  shaped("Oriya", [0x0b00, 0x0b7f]),
  shaped("Tamil", [0x0b80, 0x0bff], [0x11fc0, 0x11fff]),
  shaped("Telugu", [0x0c00, 0x0c7f]),
  shaped("Kannada", [0x0c80, 0x0cff]),
  shaped("Malayalam", [0x0d00, 0x0d7f]),
  shaped("Sinhala", [0x0d80, 0x0dff]),
  shaped("Thai", [0x0e00, 0x0e7f]),
  shaped("Lao", [0x0e80, 0x0eff]),
  shaped("Myanmar", [0x1000, 0x109f], [0xa9e0, 0xa9ff], [0xaa60, 0xaa7f]),
  shaped("Khmer", [0x1780, 0x17ff], [0x19e0, 0x19ff]),
];

function shaped(
  script: string,
  ...ranges: (readonly [number, number])[]
): FallbackFont {
  return {
    family: `NotoSans${script}`,
    file: `NotoSans${script}-Regular.ttf`,
    kind: "shaped",
    ranges,
  };
}

/* The fallback font made for the character's script, if any */
export function fallbackFontFor(code: number): FallbackFont | undefined {
  return FALLBACK_FONTS.find((font) =>
    font.ranges.some(([first, last]) => code >= first && code <= last),
  );
}

/* The fallback fonts the texts need, each once */
export function fallbackFontsFor(texts: Iterable<string>): FallbackFont[] {
  const needed = new Set<FallbackFont>();

  for (const text of texts) {
    for (const char of text) {
      const code = char.codePointAt(0) ?? 0;

      // Everything below the Indic blocks is DejaVu's.
      if (code >= 0x0900) {
        const font = fallbackFontFor(code);

        if (font) {
          needed.add(font);
        }
      }
    }
  }

  return FALLBACK_FONTS.filter((font) => needed.has(font));
}

/*
 * Joiners and combining marks belong to the letter before them,
 * whatever block they're from: a zero-width (non-)joiner picks
 * which form a Hindi conjunct takes, so it has to reach HarfBuzz
 * along with the letters around it.
 */
const JOINS_PREVIOUS = /[\p{M}‌‍◌]/u;

export interface FontSegment {
  text: string;
  /* null: the export's own font (DejaVu) */
  font: FallbackFont | null;
}

/*
 * Splits text into the stretches each font draws: the export's
 * own font wherever it has the character, otherwise the fallback
 * made for the character's script - when that one is loaded and
 * has it. A character no font has stays with the export's font,
 * which marks it as missing (U+FFFD).
 */
export function splitByFont(
  text: string,
  baseCovers: (code: number) => boolean,
  fallbackCovers: (font: FallbackFont, code: number) => boolean,
): FontSegment[] {
  const segments: FontSegment[] = [];

  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const last = segments[segments.length - 1];
    let font: FallbackFont | null = null;

    if (
      last?.font?.kind === "shaped" &&
      JOINS_PREVIOUS.test(char) &&
      fallbackCovers(last.font, code)
    ) {
      font = last.font;
    } else if (!/\s/.test(char) && !baseCovers(code)) {
      const candidate = fallbackFontFor(code);

      if (candidate && fallbackCovers(candidate, code)) {
        font = candidate;
      }
    }

    if (last && last.font === font) {
      last.text += char;
    } else {
      segments.push({ text: char, font });
    }
  }

  return segments;
}

/*
 * ---------------------------------------------------------
 * LINE BREAKS IN CHINESE AND JAPANESE
 * ---------------------------------------------------------
 *
 * Text without spaces may break between any two characters, but
 * not before a closing mark or small kana ("。", "）", "ー", "っ")
 * nor after an opening one ("「", "（") - the basic rule of
 * Japanese kinsoku shori, which Chinese typesetting follows too.
 */
const NO_BREAK_BEFORE =
  /^[、。，．：；？！）」』】〕〉》〗〙〛〟”’ー々〻ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ・…‥〜～｝］）!),.:;?\]}%]/u;
const NO_BREAK_AFTER = /[（「『【〔〈《〖〘〚〝“‘(\[{]$/u;

export function cannotStartLine(text: string): boolean {
  return NO_BREAK_BEFORE.test(text);
}

export function cannotEndLine(text: string): boolean {
  return NO_BREAK_AFTER.test(text);
}

/*
 * The pieces of a run of Chinese or Japanese a line may break
 * between: one character each, with a closing mark kept on the
 * piece before it and an opening mark on the piece after it.
 */
export function cjkBreakPieces(text: string): string[] {
  const pieces: string[] = [];

  for (const char of text) {
    const last = pieces[pieces.length - 1];

    if (
      last !== undefined &&
      (cannotStartLine(char) || cannotEndLine(last) || JOINS_PREVIOUS.test(char))
    ) {
      pieces[pieces.length - 1] = last + char;
    } else {
      pieces.push(char);
    }
  }

  return pieces;
}

/*
 * Characters that take two columns of a monospace line, as
 * terminals and code editors show them: Han, kana, Hangul and the
 * full-width forms. Code blocks are wrapped by column count.
 */
export function isWideChar(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa960 && code <= 0xa97f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

/*
 * Splits a line of code into pieces of at most `columns` columns,
 * a wide character counting as two - never between the halves of
 * a surrogate pair, nor before a combining mark.
 */
export function wrapByColumns(line: string, columns: number): string[] {
  if (line === "") {
    return [""];
  }

  const pieces: string[] = [];
  let current = "";
  let used = 0;

  for (const char of line) {
    const width = JOINS_PREVIOUS.test(char)
      ? 0
      : isWideChar(char.codePointAt(0) ?? 0)
        ? 2
        : 1;

    if (used + width > columns && current !== "") {
      pieces.push(current);
      current = "";
      used = 0;
    }

    current += char;
    used += width;
  }

  pieces.push(current);

  return pieces;
}
