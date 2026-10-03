/*
 * =========================================================
 * AI Exporter - arabic-shaping.ts
 * =========================================================
 *
 * Joins Arabic letters for the PDF export. Arabic is cursive: each
 * letter has up to four shapes - isolated, final, initial, medial -
 * depending on whether it connects to its neighbors. Fonts draw
 * those shapes from the "presentation form" characters, so the text
 * is rewritten to use them, in reading order, before bidi.ts puts
 * it into visual order.
 *
 * jsPDF's own shaper was the reason this exists: it counts harakat
 * (vowel marks) as letters, so "ذهبتُ" got an initial teh at the end
 * of the word, and it turns "الله" into a ligature character DejaVu
 * Sans has no glyph for. Here marks are transparent to joining
 * (Unicode's rule), lam + alef become the lam-alef ligature, and
 * the Persian and Urdu letters DejaVu covers are included.
 */

/*
 * Base letter -> [isolated, final, initial, medial]. A letter with
 * only two forms joins the letter before it but never the one after
 * (alef, dal, reh, waw...).
 */
const FORMS: Record<number, number[]> = {
  0x0621: [0xfe80],
  0x0622: [0xfe81, 0xfe82],
  0x0623: [0xfe83, 0xfe84],
  0x0624: [0xfe85, 0xfe86],
  0x0625: [0xfe87, 0xfe88],
  0x0626: [0xfe89, 0xfe8a, 0xfe8b, 0xfe8c],
  0x0627: [0xfe8d, 0xfe8e],
  0x0628: [0xfe8f, 0xfe90, 0xfe91, 0xfe92],
  0x0629: [0xfe93, 0xfe94],
  0x062a: [0xfe95, 0xfe96, 0xfe97, 0xfe98],
  0x062b: [0xfe99, 0xfe9a, 0xfe9b, 0xfe9c],
  0x062c: [0xfe9d, 0xfe9e, 0xfe9f, 0xfea0],
  0x062d: [0xfea1, 0xfea2, 0xfea3, 0xfea4],
  0x062e: [0xfea5, 0xfea6, 0xfea7, 0xfea8],
  0x062f: [0xfea9, 0xfeaa],
  0x0630: [0xfeab, 0xfeac],
  0x0631: [0xfead, 0xfeae],
  0x0632: [0xfeaf, 0xfeb0],
  0x0633: [0xfeb1, 0xfeb2, 0xfeb3, 0xfeb4],
  0x0634: [0xfeb5, 0xfeb6, 0xfeb7, 0xfeb8],
  0x0635: [0xfeb9, 0xfeba, 0xfebb, 0xfebc],
  0x0636: [0xfebd, 0xfebe, 0xfebf, 0xfec0],
  0x0637: [0xfec1, 0xfec2, 0xfec3, 0xfec4],
  0x0638: [0xfec5, 0xfec6, 0xfec7, 0xfec8],
  0x0639: [0xfec9, 0xfeca, 0xfecb, 0xfecc],
  0x063a: [0xfecd, 0xfece, 0xfecf, 0xfed0],
  0x0641: [0xfed1, 0xfed2, 0xfed3, 0xfed4],
  0x0642: [0xfed5, 0xfed6, 0xfed7, 0xfed8],
  0x0643: [0xfed9, 0xfeda, 0xfedb, 0xfedc],
  0x0644: [0xfedd, 0xfede, 0xfedf, 0xfee0],
  0x0645: [0xfee1, 0xfee2, 0xfee3, 0xfee4],
  0x0646: [0xfee5, 0xfee6, 0xfee7, 0xfee8],
  0x0647: [0xfee9, 0xfeea, 0xfeeb, 0xfeec],
  0x0648: [0xfeed, 0xfeee],
  0x0649: [0xfeef, 0xfef0, 0xfbe8, 0xfbe9],
  0x064a: [0xfef1, 0xfef2, 0xfef3, 0xfef4],
  0x0679: [0xfb66, 0xfb67, 0xfb68, 0xfb69],
  0x067e: [0xfb56, 0xfb57, 0xfb58, 0xfb59],
  0x0686: [0xfb7a, 0xfb7b, 0xfb7c, 0xfb7d],
  0x0688: [0xfb88, 0xfb89],
  0x0691: [0xfb8c, 0xfb8d],
  0x0698: [0xfb8a, 0xfb8b],
  0x06a4: [0xfb6a, 0xfb6b, 0xfb6c, 0xfb6d],
  0x06a9: [0xfb8e, 0xfb8f, 0xfb90, 0xfb91],
  0x06af: [0xfb92, 0xfb93, 0xfb94, 0xfb95],
  0x06ba: [0xfb9e, 0xfb9f],
  0x06be: [0xfbaa, 0xfbab, 0xfbac, 0xfbad],
  0x06cc: [0xfbfc, 0xfbfd, 0xfbfe, 0xfbff],
};

/* Lam + (alef with madda / hamza above / hamza below / plain alef). */
const LAM = 0x0644;
const LAM_ALEF: Record<number, [number, number]> = {
  0x0622: [0xfef5, 0xfef6],
  0x0623: [0xfef7, 0xfef8],
  0x0625: [0xfef9, 0xfefa],
  0x0627: [0xfefb, 0xfefc],
};

const TATWEEL = 0x0640;
const TRANSPARENT_RE = /\p{Mn}/u;

function joinsAfter(cp: number | undefined): boolean {
  return cp === TATWEEL || (cp !== undefined && (FORMS[cp]?.length ?? 0) === 4);
}

function joinsBefore(cp: number | undefined): boolean {
  return cp === TATWEEL || (cp !== undefined && (FORMS[cp]?.length ?? 0) >= 2);
}

export function shapeArabicText(text: string): string {
  const chars = Array.from(text);
  const codes = chars.map((char) => char.codePointAt(0) ?? 0);

  // The nearest letter before/after `i`, skipping vowel marks.
  function neighbor(i: number, step: -1 | 1): number | undefined {
    for (let j = i + step; j >= 0 && j < chars.length; j += step) {
      if (!TRANSPARENT_RE.test(chars[j])) {
        return codes[j];
      }
    }

    return undefined;
  }

  let out = "";

  for (let i = 0; i < chars.length; i++) {
    const code = codes[i];
    const forms = FORMS[code];

    if (!forms) {
      out += chars[i];
      continue;
    }

    const before = neighbor(i, -1);
    const linkedBefore = joinsAfter(before) && joinsBefore(code);

    if (code === LAM) {
      // Find the alef, past any marks on the lam.
      let j = i + 1;

      while (j < chars.length && TRANSPARENT_RE.test(chars[j])) {
        j++;
      }

      const ligature = LAM_ALEF[codes[j]];

      if (ligature) {
        out += String.fromCodePoint(ligature[linkedBefore ? 1 : 0]);
        // The lam's marks, then the alef's.
        out += chars.slice(i + 1, j).join("");
        i = j;
        continue;
      }
    }

    const linkedAfter = joinsAfter(code) && joinsBefore(neighbor(i, 1));
    const index = linkedBefore ? (linkedAfter ? 3 : 1) : linkedAfter ? 2 : 0;

    out += String.fromCodePoint(forms[index] ?? forms[linkedBefore ? 1 : 0] ?? forms[0]);
  }

  return out;
}
