/*
 * =========================================================
 * AI Exporter - bidi.ts
 * =========================================================
 *
 * Right-to-left text (Hebrew, Arabic, Persian, Urdu...) for the
 * PDF export. A PDF draws every string left to right, glyph by
 * glyph, so text has to be put into visual order before it's
 * drawn - the job a browser's bidi engine does for the chat page.
 *
 * This is the Unicode Bidirectional Algorithm (UAX #9) for one
 * line of plain text: weak types (W1-W7), neutrals (N1-N2),
 * implicit levels (I1-I2), trailing whitespace (L1), reordering
 * (L2) and mirrored brackets (L4), with combining marks kept after
 * their base letter (L3) so harakat and niqqud land on the right
 * glyph. Explicit embeddings and isolates (RLE, LRI...), which chat
 * replies don't use, are treated as neutrals.
 */

export type BidiClass =
  | "L"
  | "R"
  | "AL"
  | "EN"
  | "AN"
  | "ES"
  | "ET"
  | "CS"
  | "NSM"
  | "WS"
  | "ON";

/*
 * Stands for an object that isn't text - an inline formula - so it
 * takes part in reordering as one left-to-right unit.
 */
export const OBJECT_CHAR = String.fromCharCode(0xfffc);

const MARK_RE = /\p{M}/u;
const LETTER_RE = /\p{L}/u;
const RTL_RE = /[֐-ࣿיִ-﷿ﹰ-ﻼ]/;
const ARABIC_RE = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-ﻼ]/;

export function bidiClass(char: string): BidiClass {
  const cp = char.codePointAt(0) ?? 0;

  if (char === OBJECT_CHAR) {
    return "L";
  }

  if (cp >= 0x30 && cp <= 0x39) {
    return "EN";
  }

  // Arabic-Indic digits and the Arabic decimal/thousands separators.
  if ((cp >= 0x660 && cp <= 0x669) || cp === 0x66b || cp === 0x66c) {
    return "AN";
  }

  // Extended (Persian/Urdu) digits are European numbers to UAX #9.
  if (cp >= 0x6f0 && cp <= 0x6f9) {
    return "EN";
  }

  if (MARK_RE.test(char)) {
    return "NSM";
  }

  if ((cp >= 0x590 && cp <= 0x5ff) || (cp >= 0xfb1d && cp <= 0xfb4f)) {
    return "R";
  }

  if (ARABIC_RE.test(char)) {
    return "AL";
  }

  if (/\s/.test(char)) {
    return "WS";
  }

  if (char === "+" || char === "-" || char === "−") {
    return "ES";
  }

  if (/[#$%¢-¥°±‰‱₠-⃏]/.test(char)) {
    return "ET";
  }

  if (/[,./: ،]/.test(char)) {
    return "CS";
  }

  if (LETTER_RE.test(char) || /\p{N}/u.test(char)) {
    return "L";
  }

  return "ON";
}

export function hasRtl(text: string): boolean {
  return RTL_RE.test(text);
}

export function hasArabic(text: string): boolean {
  return ARABIC_RE.test(text);
}

/*
 * A paragraph's direction is that of its first strong character
 * (rule P2) - the "dir=auto" chat sites put on every message - so a
 * Hebrew reply reads right to left even when it starts with "1." or
 * a quote mark, and an English one stays left to right.
 */
export function isRtlParagraph(text: string): boolean {
  for (const char of text) {
    const type = bidiClass(char);

    if (type === "L") {
      return false;
    }

    if (type === "R" || type === "AL") {
      return true;
    }
  }

  return false;
}

/*
 * Resolves the embedding level of every character (code point) of
 * one line.
 */
export function bidiLevels(chars: string[], rtl: boolean): number[] {
  const base = rtl ? 1 : 0;
  const sos: BidiClass = rtl ? "R" : "L";
  const types = chars.map(bidiClass);

  // W1: a mark takes the type of what it's attached to.
  types.forEach((type, i) => {
    if (type === "NSM") {
      types[i] = i === 0 ? sos : types[i - 1];
    }
  });

  // W2: a number after Arabic letters is an Arabic number. W3: AL is R.
  let lastStrong: BidiClass = sos;

  types.forEach((type, i) => {
    if (type === "EN" && lastStrong === "AL") {
      types[i] = "AN";
    }

    if (type === "L" || type === "R" || type === "AL") {
      lastStrong = type;
    }
  });

  types.forEach((type, i) => {
    if (type === "AL") {
      types[i] = "R";
    }
  });

  // W4: one separator between two numbers of a kind joins them.
  for (let i = 1; i < types.length - 1; i++) {
    const [before, after] = [types[i - 1], types[i + 1]];

    if (types[i] === "ES" && before === "EN" && after === "EN") {
      types[i] = "EN";
    } else if (types[i] === "CS" && before === after && (before === "EN" || before === "AN")) {
      types[i] = before;
    }
  }

  // W5: currency and percent signs next to a number belong to it.
  for (let i = 0; i < types.length; i++) {
    if (types[i] !== "ET") {
      continue;
    }

    let end = i;

    while (end < types.length && types[end] === "ET") {
      end++;
    }

    if (types[i - 1] === "EN" || types[end] === "EN") {
      types.fill("EN", i, end);
    }

    i = end - 1;
  }

  // W6: other separators are neutral. W7: numbers in Latin text are L.
  lastStrong = sos;

  types.forEach((type, i) => {
    if (type === "ES" || type === "ET" || type === "CS") {
      types[i] = "ON";
    }

    if (type === "L" || type === "R") {
      lastStrong = type;
    }

    if (types[i] === "EN" && lastStrong === "L") {
      types[i] = "L";
    }
  });

  // N1/N2: neutrals between two runs of one direction take it;
  // otherwise the paragraph's. Numbers count as R here.
  const strength = (type: BidiClass | undefined): "L" | "R" | null =>
    type === "L" ? "L" : type === "R" || type === "EN" || type === "AN" ? "R" : null;

  for (let i = 0; i < types.length; i++) {
    if (strength(types[i]) !== null) {
      continue;
    }

    let end = i;

    while (end < types.length && strength(types[end]) === null) {
      end++;
    }

    const before = i === 0 ? sos : strength(types[i - 1]);
    const after = end === types.length ? sos : strength(types[end]);
    const resolved = before === after && before ? before : sos;
    types.fill(resolved, i, end);
    i = end - 1;
  }

  // I1/I2
  const levels = types.map((type) => {
    if (base === 0) {
      return type === "R" ? 1 : type === "AN" || type === "EN" ? 2 : 0;
    }

    return type === "L" || type === "EN" || type === "AN" ? 2 : 1;
  });

  // L1: whitespace at the end of the line goes back to the base level.
  for (let i = chars.length - 1; i >= 0 && /\s/.test(chars[i]); i--) {
    levels[i] = base;
  }

  return levels;
}

/*
 * * L2 with L3: the logical indices of `chars` in visual (left to
 * right) order. A letter and the marks after it move as one, so a
 * reversed word still has each mark right after its letter.
 */
export function visualOrder(chars: string[], levels: number[]): number[] {
  const clusters: { indices: number[]; level: number }[] = [];

  chars.forEach((char, i) => {
    if (MARK_RE.test(char) && clusters.length > 0) {
      clusters[clusters.length - 1].indices.push(i);
    } else {
      clusters.push({ indices: [i], level: levels[i] });
    }
  });

  const highest = Math.max(0, ...clusters.map((cluster) => cluster.level));
  const lowestOdd = Math.min(
    ...clusters.map((cluster) => cluster.level).filter((level) => level % 2 === 1),
    Infinity,
  );

  for (let level = highest; level >= lowestOdd && level > 0; level--) {
    for (let i = 0; i < clusters.length; i++) {
      if (clusters[i].level < level) {
        continue;
      }

      let end = i;

      while (end < clusters.length && clusters[end].level >= level) {
        end++;
      }

      const reversed = clusters.slice(i, end).reverse();
      clusters.splice(i, end - i, ...reversed);
      i = end - 1;
    }
  }

  /*
   * DejaVu draws a mark to the right of where it's placed (fonts
   * expect a shaping engine to position it), so in right-to-left
   * text - drawn left to right here - the mark has to come just
   * before its letter to land on it.
   */
  return clusters.flatMap((cluster) =>
    cluster.level % 2 === 1 ? [...cluster.indices].reverse() : cluster.indices,
  );
}

const MIRRORS: Record<string, string> = {
  "(": ")",
  ")": "(",
  "[": "]",
  "]": "[",
  "{": "}",
  "}": "{",
  "<": ">",
  ">": "<",
  "«": "»",
  "»": "«",
  "‹": "›",
  "›": "‹",
};

/* L4: a bracket in right-to-left text is drawn facing the other way. */
export function mirrorChar(char: string, level: number): string {
  return level % 2 === 1 ? (MIRRORS[char] ?? char) : char;
}

/* One line of plain text in visual order. */
export function toVisual(text: string, rtl: boolean): string {
  const chars = Array.from(text);

  if (!rtl && !hasRtl(text)) {
    return text;
  }

  const levels = bidiLevels(chars, rtl);

  return visualOrder(chars, levels)
    .map((i) => mirrorChar(chars[i], levels[i]))
    .join("");
}
