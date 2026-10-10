/*
 * =========================================================
 * AI Exporter - pdf-export.ts
 * =========================================================
 *
 * Renders a conversation straight to a PDF Blob with jsPDF.
 * Runs in the popup's DOM context (not the background service
 * worker), since both image embedding (canvas) and HTML entity
 * decoding (a detached <textarea>) need real DOM APIs.
 *
 * jsPDF has no markdown support of its own - it only draws
 * plain, pre-positioned text - so it uses the small Markdown
 * parser in markdown-parse.ts (parseBlocks/parseInline), which turns
 * our generated Markdown into block/inline structure the
 * renderer can lay out: paragraphs, headings, code fences,
 * tables, lists and blockquotes at the block level; bold,
 * italic, inline code, links and math formulas at the inline
 * level (math is typeset by MathJax and drawn as vector paths -
 * see math.ts, math-render.ts and svg-pdf.ts). Links are
 * drawn as their visible label only (with a doc.link annotation
 * over it), never as raw printed URLs, so they can never wrap
 * mid-URL. User messages are pasted input rather than authored
 * Markdown, so pasted code/terminal output in them is detected and
 * rendered verbatim (see fenceUserContent).
 *
 * Table of contents strategy: the body is rendered once,
 * tracking which page each message starts on. Afterwards,
 * jsPDF's insertPage() prepends blank pages at the front for
 * the TOC and shifts every existing page down - so the TOC can
 * be written last, with the now-correct (shifted) page numbers,
 * without a separate dry-run render pass.
 */
import jsPDF from "jspdf";
import type { Settings, PdfSettings } from "./settings.ts";
import { encodeBlobBase64 } from "./zip.ts";
import { getChatSite, roleLabel as siteRoleLabel, stripChatSiteSuffix } from "./chat-sites.ts";
import { extractMath, type MathSpan } from "./math.ts";
import {
  fenceUserContent,
  isTableSeparatorLine,
  parseBlocks,
  parseInline,
  preprocessRawContent,
  type Block,
  type InlineRun,
  type InlineStyle,
} from "./markdown-parse.ts";

/*
 * The parser lives in markdown-parse.ts (the HTML, Word and Notion
 * exports share it); re-exported for the code that imports it from
 * here.
 */
export { fenceUserContent, parseBlocks, parseInline, preprocessRawContent };
import type { RenderedMath } from "./math-render.ts";
import {
  drawMath,
  tracePath,
  type Matrix,
  type MathTextStyle,
} from "./svg-pdf.ts";
import {
  cannotEndLine,
  cannotStartLine,
  cjkBreakPieces,
  fallbackFontFor,
  fallbackFontsFor,
  splitByFont,
  wrapByColumns,
  type FallbackFont,
} from "./script-fonts.ts";
import type { ShapedText, Shaper } from "./text-shaping.ts";
import { shapeArabicText } from "./arabic-shaping.ts";
import { highlightCode, type TokenKind } from "./code-highlight.ts";
import {
  OBJECT_CHAR,
  bidiLevels,
  hasArabic,
  hasRtl,
  isRtlParagraph,
  mirrorChar,
  toVisual,
  visualOrder,
} from "./bidi.ts";
import {
  applyContentSettings,
  type ExportImageFile,
  type Message,
} from "./export-builders.ts";
import {
  isSafeSourceUrl,
  normalizeNotes,
  sourceHost,
  sourceLabel,
  stripNotes,
  type MessageSource,
} from "./source-notes.ts";
import { messageDetails } from "./message-details.ts";

const PT_TO_MM = 25.4 / 72;

/*
 * A note's numbers are set this much smaller than the text, and
 * raised by this share of the text's size - like a footnote's.
 */
const NOTE_SCALE = 0.68;
const NOTE_RISE = 0.36;

function mm(pt: number): number {
  return pt * PT_TO_MM;
}

/*
 * ---------------------------------------------------------
 * EMBEDDED UNICODE FONT (DejaVu Sans)
 * ---------------------------------------------------------
 *
 * jsPDF's built-in "helvetica"/"courier" are the 14 core PDF
 * fonts, which only cover WinAnsi (Latin) - any Cyrillic,
 * Greek, arrows or other non-Latin glyph falls back to garbage
 * (overlapping glyph-index-0 boxes). DejaVu Sans/Sans Mono
 * cover a much wider Unicode range (Cyrillic, Greek, arrows,
 * box drawing, ...), so they're embedded as real TTFs instead.
 * The .ttf files live in public/fonts/ (copied verbatim into
 * the built extension) and are fetched + base64-encoded once
 * per popup session, then cached for the rest of it.
 */
const SANS_FONT = "DejaVuSans";
const MONO_FONT = "DejaVuSansMono";

interface EmbeddedFont {
  file: string;
  path: string;
  family: string;
  style: "normal" | "bold" | "italic" | "bolditalic";
}

const EMBEDDED_FONTS: EmbeddedFont[] = [
  {
    file: "DejaVuSans.ttf",
    path: "fonts/DejaVuSans.ttf",
    family: SANS_FONT,
    style: "normal",
  },
  {
    file: "DejaVuSans-Bold.ttf",
    path: "fonts/DejaVuSans-Bold.ttf",
    family: SANS_FONT,
    style: "bold",
  },
  {
    file: "DejaVuSans-Oblique.ttf",
    path: "fonts/DejaVuSans-Oblique.ttf",
    family: SANS_FONT,
    style: "italic",
  },
  {
    file: "DejaVuSans-BoldOblique.ttf",
    path: "fonts/DejaVuSans-BoldOblique.ttf",
    family: SANS_FONT,
    style: "bolditalic",
  },
  {
    file: "DejaVuSansMono.ttf",
    path: "fonts/DejaVuSansMono.ttf",
    family: MONO_FONT,
    style: "normal",
  },
  {
    file: "DejaVuSansMono-Bold.ttf",
    path: "fonts/DejaVuSansMono-Bold.ttf",
    family: MONO_FONT,
    style: "bold",
  },
];

interface LoadedFont {
  base64: string;
  coverage: Set<number>;
}

let fontDataPromise: Promise<Map<string, LoadedFont>> | null = null;

function loadFontData(): Promise<Map<string, LoadedFont>> {
  fontDataPromise ??= Promise.all(
    EMBEDDED_FONTS.map(async ({ file, path }) => {
      const response = await fetch(chrome.runtime.getURL(path));
      const blob = await response.blob();
      const coverage = readCmapCoverage(
        new Uint8Array(await blob.arrayBuffer()),
      );
      return [
        file,
        { base64: await encodeBlobBase64(blob), coverage },
      ] as const;
    }),
  ).then((entries) => new Map(entries));

  return fontDataPromise;
}

/*
 * ---------------------------------------------------------
 * FALLBACK FONTS (see script-fonts.ts)
 * ---------------------------------------------------------
 *
 * Fetched the first time a conversation needs one, then kept for
 * the rest of the popup session like the DejaVu fonts. A "shaped"
 * font also gets a HarfBuzz shaper; should HarfBuzz fail to load,
 * its script is drawn as plain text in the font instead - letters
 * in the wrong order, but letters.
 */
interface LoadedFallback {
  font: FallbackFont;
  base64: string;
  coverage: Set<number>;
  shaper?: Shaper;
}

const fallbackFontCache = new Map<string, Promise<LoadedFallback>>();

function loadFallbackFont(font: FallbackFont): Promise<LoadedFallback> {
  let pending = fallbackFontCache.get(font.file);

  if (!pending) {
    pending = (async () => {
      const response = await fetch(chrome.runtime.getURL(`fonts/${font.file}`));
      const blob = await response.blob();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let shaper: Shaper | undefined;

      if (font.kind === "shaped") {
        try {
          shaper = (await import("./text-shaping.ts")).createShaper(bytes);
        } catch {
          shaper = undefined;
        }
      }

      return {
        font,
        base64: await encodeBlobBase64(blob),
        coverage: readCmapCoverage(bytes),
        ...(shaper ? { shaper } : {}),
      };
    })();

    // A font that couldn't be read is tried again by the next export.
    pending.catch(() => fallbackFontCache.delete(font.file));
    fallbackFontCache.set(font.file, pending);
  }

  return pending;
}

function registerFonts(doc: jsPDF, fontData: Map<string, LoadedFont>): void {
  for (const { file, family, style } of EMBEDDED_FONTS) {
    const font = fontData.get(file);

    if (font) {
      doc.addFileToVFS(file, font.base64);
      doc.addFont(file, family, style);
    }
  }
}

/*
 * Returns the BMP code points a TrueType font maps to a real glyph,
 * read from its format-4 cmap subtable - the only subtable jsPDF's
 * own TTF parser uses. That matters because jsPDF (pdfEscape16)
 * silently stops writing a string at the first character that maps
 * to glyph 0, dropping everything after it on that line: a tab, an
 * emoji or a CJK character took the rest of a code line with it.
 * Knowing the exact coverage lets fitToFont() replace such
 * characters before jsPDF ever sees them.
 */
export function readCmapCoverage(bytes: Uint8Array): Set<number> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const coverage = new Set<number>();
  const tableCount = view.getUint16(4);
  let cmapOffset = -1;

  for (let i = 0; i < tableCount; i++) {
    const record = 12 + i * 16;
    const tag = String.fromCharCode(...bytes.subarray(record, record + 4));

    if (tag === "cmap") {
      cmapOffset = view.getUint32(record + 8);
      break;
    }
  }

  if (cmapOffset < 0) {
    return coverage;
  }

  const subtableCount = view.getUint16(cmapOffset + 2);

  for (let i = 0; i < subtableCount; i++) {
    const record = cmapOffset + 4 + i * 8;
    const platformId = view.getUint16(record);
    const encodingId = view.getUint16(record + 2);
    const offset = cmapOffset + view.getUint32(record + 4);
    const isUnicode =
      platformId === 0 || (platformId === 3 && encodingId === 1);

    if (!isUnicode || view.getUint16(offset) !== 4) {
      continue;
    }

    const segCountX2 = view.getUint16(offset + 6);
    const endCodes = offset + 14;
    const startCodes = endCodes + segCountX2 + 2;
    const idDeltas = startCodes + segCountX2;
    const idRangeOffsets = idDeltas + segCountX2;

    for (let seg = 0; seg < segCountX2; seg += 2) {
      const end = view.getUint16(endCodes + seg);
      const start = view.getUint16(startCodes + seg);
      const delta = view.getInt16(idDeltas + seg);
      const rangeOffset = view.getUint16(idRangeOffsets + seg);

      for (let code = start; code <= end && code !== 0xffff; code++) {
        let glyph: number;

        if (rangeOffset === 0) {
          glyph = (code + delta) & 0xffff;
        } else {
          const raw = view.getUint16(
            idRangeOffsets + seg + rangeOffset + (code - start) * 2,
          );
          glyph = raw === 0 ? 0 : (raw + delta) & 0xffff;
        }

        if (glyph !== 0) {
          coverage.add(code);
        }
      }
    }

    break;
  }

  return coverage;
}

/*
 * ---------------------------------------------------------
 * GLYPH COVERAGE
 * ---------------------------------------------------------
 *
 * Every string is passed through fitToFont() with the exact font
 * it will be drawn in, right before it is measured and drawn:
 *
 *  - characters the font has are kept - including ✓ ✗ ✔ ★ ♥ ☺ ⚠
 *    © ↔ ▶, which DejaVu draws fine and an emoji regex used to
 *    strip;
 *  - common emoji the font lacks fall back to the closest glyph it
 *    does have (✅ -> ✓, ❌ -> ✗, 😄 -> ☺, ...), so a verdict column
 *    of ✅/❌ doesn't come out empty;
 *  - other emoji, their modifiers/joiners and invisible format
 *    characters are dropped;
 *  - any other missing character is tried as its NFKC compatibility
 *    form (𝐁𝐨𝐥𝐝 -> Bold, full-width letters -> ASCII) and otherwise
 *    shown as U+FFFD, so missing text (e.g. CJK, which DejaVu does
 *    not cover) stays visible as missing instead of vanishing.
 */
const GLYPH_FALLBACKS = new Map<string, string>([
  ["✅", "✓"],
  ["❌", "✗"],
  ["❎", "✗"],
  ["❓", "?"],
  ["❔", "?"],
  ["❗", "!"],
  ["❕", "!"],
  ["⭐", "★"],
  ["🌟", "★"],
  ["⏳", "…"],
  ["⌛", "…"],
  ["💡", "•"],
  ["📌", "•"],
  ["👉", "☞"],
  ["🔹", "◆"],
  ["🔸", "◆"],
  ["🔷", "◆"],
  ["🔶", "◆"],
  ["🔴", "●"],
  ["🟠", "●"],
  ["🟡", "●"],
  ["🟢", "●"],
  ["🔵", "●"],
  ["🟣", "●"],
  ["🟤", "●"],
  ["⚫", "●"],
  ["⚪", "○"],
  ["😀", "☺"],
  ["😃", "☺"],
  ["😄", "☺"],
  ["😁", "☺"],
  ["😆", "☺"],
  ["😅", "☺"],
  ["😊", "☺"],
  ["🙂", "☺"],
  ["😉", "☺"],
  ["🙁", "☹"],
  ["😞", "☹"],
  ["😟", "☹"],
  ["😢", "☹"],
  ["🔟", "10"],
]);

// Never drawn, whatever the font says: variation selectors, the
// keycap combiner, skin-tone modifiers, flag letters and format
// characters (ZWJ, ZWSP, soft hyphen, bidi marks, tag characters).
const ALWAYS_DROP_RE =
  /[\p{Variation_Selector}\p{Emoji_Modifier}\p{Regional_Indicator}\p{Cf}]|\u{20E3}/u;
const DROP_IF_MISSING_RE =
  /[\p{Extended_Pictographic}\p{M}\p{Cc}\p{Co}\p{Cs}]/u;
const REPLACEMENT_CHARACTER = "\u{FFFD}";

export function fitToFont(text: string, coverage: Set<number>): string {
  let out = "";

  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;

    if (ALWAYS_DROP_RE.test(char)) {
      continue;
    }

    if (code <= 0xffff && coverage.has(code)) {
      out += char;
      continue;
    }

    const fallback = GLYPH_FALLBACKS.get(char);

    if (fallback !== undefined) {
      out += fallback;
    } else if (/\s/.test(char)) {
      out += " ";
    } else if (!DROP_IF_MISSING_RE.test(char)) {
      const compatible = char.normalize("NFKC");
      const usable =
        compatible !== char &&
        [...compatible].every((c) => coverage.has(c.codePointAt(0) ?? 0));

      out += usable ? compatible : REPLACEMENT_CHARACTER;
    }
  }

  return out;
}


/* A run, and the fallback font its text is drawn in (see withFace) */
type RunStyle = InlineStyle & { face?: string };
type FaceRun = InlineRun & { face?: string };

interface TocEntry {
  label: string;
  snippet: string;
  page: number;
  top: number;
}

type FontStyle = EmbeddedFont["style"];
type Rgb = [number, number, number];

const TEXT_COLOR: Rgb = [20, 20, 20];
const CODE_TEXT_COLOR: Rgb = [40, 40, 40];

/*
 * Syntax colors for code blocks, after GitHub's light theme: dark
 * enough to read on the light gray block background, and still
 * distinguishable from each other when printed in grayscale.
 */
const CODE_TOKEN_COLORS: Record<TokenKind, Rgb> = {
  plain: CODE_TEXT_COLOR,
  keyword: [207, 34, 46],
  literal: [5, 80, 174],
  string: [10, 48, 105],
  comment: [110, 119, 129],
  number: [5, 80, 174],
  function: [130, 80, 223],
  type: [149, 56, 0],
  property: [5, 80, 174],
  variable: [149, 56, 0],
  meta: [110, 119, 129],
  tag: [17, 99, 41],
  attribute: [5, 80, 174],
  inserted: [17, 99, 41],
  deleted: [130, 7, 30],
};
const LINK_COLOR: Rgb = [31, 91, 199];
const MUTED_COLOR: Rgb = [110, 110, 110];

/*
 * Plain-text preview of a message for its bookmark title: the
 * first words of its prose, without markdown syntax or code.
 */
function messageSnippet(markdown: string, maxLength = 60): string {
  const text = markdown
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .split("\n")
    .filter((line) => !isTableSeparatorLine(line))
    .map((line) => line.replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/, ""))
    .join(" ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|\*|`|\|/g, " ")
    .replace(/\p{Cf}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(text);

  return chars.length > maxLength
    ? `${chars
        .slice(0, maxLength - 1)
        .join("")
        .trimEnd()}…`
    : text;
}

function expandTabs(line: string, tabSize = 4): string {
  let out = "";

  for (const char of line) {
    out += char === "\t" ? " ".repeat(tabSize - (out.length % tabSize)) : char;
  }

  return out;
}

export async function buildPdfBlob(
  allMessages: Message[],
  images: ExportImageFile[],
  settings: Settings,
  tabTitle: string | undefined,
  tabUrl?: string,
): Promise<Blob> {
  const pdf: PdfSettings = settings.pdf;
  // Thinking and sources only when the settings ask for them.
  const messages = applyContentSettings(allMessages, settings);

  /*
   * compress: jsPDF writes every content and font stream raw by
   * default - with text drawn span by span, that made a 70-page
   * export ~2.7 MB. Fonts were never the problem: jsPDF already
   * subsets them to the glyphs actually used (it just doesn't add
   * the "ABCDEF+" subset tag to the font name, which is why
   * pdffonts reports them as not subset).
   */
  const doc = new jsPDF({
    orientation: pdf.orientation,
    unit: "mm",
    format: pdf.pageFormat,
    putOnlyUsedFonts: true,
    compress: true,
  });

  const fontData = await loadFontData();
  registerFonts(doc, fontData);

  const coverageByFont = new Map<string, Set<number>>();

  for (const { file, family, style } of EMBEDDED_FONTS) {
    coverageByFont.set(
      `${family}/${style}`,
      fontData.get(file)?.coverage ?? new Set(),
    );
  }

  function fit(text: string, family: string, style: FontStyle): string {
    return fitToFont(
      text,
      coverageByFont.get(`${family}/${style}`) ?? new Set(),
    );
  }

  /*
   * Right-to-left text (see bidi.ts). jsPDF has two hooks of its own
   * on every doc.text() call, and both misfire on text that's
   * already in visual order: one joins Arabic letters - on the
   * reversed string, so it joins the wrong neighbors (the alef and
   * lam of "بالكتاب" became a lam-alef ligature) - and the other
   * reorders bidi text again, with a direction it guesses once from
   * the first string it ever sees, which reversed the letters of
   * every other Hebrew line. Both are removed for this document;
   * text is joined by arabic-shaping.ts instead, in reading order,
   * and reordered by bidi.ts. The bidi hook is found by what it
   * calls, since the function's own name doesn't survive
   * minification.
   */
  const topics = doc.internal.events.getTopics();
  const textHooks = [
    ...Object.entries(topics.preProcessText ?? {}),
    ...Object.entries(topics.postProcessText ?? {}),
  ];

  for (const [token, [callback]] of textHooks) {
    if (
      callback === doc.processArabic ||
      String(callback).includes("doBidiReorder")
    ) {
      doc.internal.events.unsubscribe(token);
    }
  }

  function shapeArabic(text: string): string {
    return hasArabic(text) ? shapeArabicText(text) : text;
  }

  /*
   * A plain one-line string - a title, a list marker, the footer -
   * joined and in visual order, ready for doc.text().
   */
  function visualPlain(text: string, rtl = isRtlParagraph(text)): string {
    return hasRtl(text) || rtl ? toVisual(shapeArabic(text), rtl) : text;
  }

  const documentTitle = stripChatSiteSuffix(tabTitle ?? "");

  if (documentTitle) {
    doc.setProperties({ title: documentTitle });
  }

  /*
   * The fonts for scripts DejaVu doesn't have, loaded for the text
   * this document will draw (see script-fonts.ts). A font that
   * fails to load leaves its script as U+FFFD, as before.
   */
  const fallbacks = new Map<FallbackFont, LoadedFallback>();
  const neededFallbacks = fallbackFontsFor([
    documentTitle,
    pdf.userInfoText,
    settings.includeTimestamp ? new Date().toLocaleString() : "",
    ...messages.flatMap((message) => [
      message.content,
      message.thinking ?? "",
      messageDetails(message),
      ...(message.sources ?? []).map((source) => source.title),
    ]),
  ]);

  for (const result of await Promise.allSettled(
    neededFallbacks.map(loadFallbackFont),
  )) {
    if (result.status === "fulfilled") {
      const loaded = result.value;

      doc.addFileToVFS(loaded.font.file, loaded.base64);
      doc.addFont(loaded.font.file, loaded.font.family, "normal");
      coverageByFont.set(`${loaded.font.family}/normal`, loaded.coverage);
      fallbacks.set(loaded.font, loaded);
    }
  }

  /* A loaded fallback font that has the character */
  function fallbackCovers(font: FallbackFont, code: number): boolean {
    return fallbacks.get(font)?.coverage.has(code) ?? false;
  }

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const contentWidth = pageWidth - pdf.marginLeft - pdf.marginRight;

  /*
   * Where blocks are laid out, and the color of their text: the
   * full text width in the usual color - or, while a reply's
   * thinking is drawn, set in from the line on its left, in gray.
   */
  let blockLeft = pdf.marginLeft;
  let blockWidth = contentWidth;
  let textColor: Rgb = TEXT_COLOR;

  /* The sources the message being drawn cites (see noteWords) */
  let currentSources: MessageSource[] = [];

  const footerReserve = pdf.includePageNumbers || pdf.includeUserInfo ? 8 : 0;
  const contentBottom = pageHeight - pdf.marginBottom - footerReserve;

  const bodyFontSize = pdf.fontSize;
  const headingFontSize = pdf.fontSize + 2;
  const codeFontSize = Math.max(6, pdf.fontSize - 1);
  const bodyLineHeight = mm(bodyFontSize) * 1.32;
  const headingLineHeight = mm(headingFontSize) * 1.32;
  const codeLineHeight = mm(codeFontSize) * 1.3;

  /*
   * Math: each reply's formulas are swapped for placeholder tokens
   * up front (see math.ts), so MathJax - a large module - is only
   * loaded when the conversation has math at all, and every
   * formula is typeset once, before layout needs its size. User
   * messages are left alone: no chat site renders math in them.
   * A formula MathJax can't typeset, or a failed load, prints the
   * formula's source in code style instead.
   */
  const site = getChatSite(tabUrl);
  const formulas: MathSpan[] = [];
  const messageContents = messages.map((message) =>
    message.role === "assistant"
      ? extractMath(message.content, site, formulas)
      : message.content,
  );
  const thinkingContents = messages.map((message) =>
    message.role === "assistant" && message.thinking
      ? extractMath(message.thinking, site, formulas)
      : "",
  );
  let renderedFormulas: (RenderedMath | null)[] = [];

  /*
   * The font for text inside a formula (\text{...}): Chinese,
   * Japanese or Korean there is set in their fallback font.
   */
  function mathTextFont(style: MathTextStyle, text = ""): [string, FontStyle] {
    const [family, fontStyle]: [string, FontStyle] = style.monospace
      ? [MONO_FONT, style.bold ? "bold" : "normal"]
      : runFont(style);
    const coverage = coverageByFont.get(`${family}/${fontStyle}`);

    for (const char of text) {
      const code = char.codePointAt(0) ?? 0;
      const fallback = fallbackFontFor(code);

      if (
        fallback?.kind === "cjk" &&
        !coverage?.has(code) &&
        fallbackCovers(fallback, code)
      ) {
        return [fallback.family, "normal"];
      }
    }

    return [family, fontStyle];
  }

  // Text inside formulas is measured in the font it's drawn in.
  function measureMathText(text: string, style: MathTextStyle): number {
    const [family, fontStyle] = mathTextFont(style, text);
    doc.setFont(family, fontStyle);
    return doc.getStringUnitWidth(fit(text, family, fontStyle));
  }

  if (formulas.length > 0) {
    try {
      const { renderTex } = await import("./math-render.ts");
      renderedFormulas = formulas.map((formula) =>
        renderTex(formula.tex, formula.display, measureMathText),
      );
    } catch {
      renderedFormulas = [];
    }
  }

  let y = pdf.marginTop;
  const imagesByPath = new Map(images.map((image) => [image.path, image]));
  const pngCache = new Map<
    string,
    { dataUrl: string; width: number; height: number } | null
  >();

  function newPage(): void {
    doc.addPage();
    y = pdf.marginTop;
  }

  function ensureSpace(height: number): void {
    if (y + height > contentBottom) {
      newPage();
    }
  }

  function runFont(run: RunStyle): [string, FontStyle] {
    if (run.face) {
      return [run.face, "normal"];
    }

    const italic = run.italic && !run.upright;

    if (run.code && !run.sans) {
      return [MONO_FONT, run.bold ? "bold" : "normal"];
    }

    if (run.bold && italic) {
      return [SANS_FONT, "bolditalic"];
    }

    if (run.bold) {
      return [SANS_FONT, "bold"];
    }

    return [SANS_FONT, italic ? "italic" : "normal"];
  }

  function fontCovers(run: InlineRun, text: string): boolean {
    const coverage = coverageByFont.get(runFont(run).join("/"));

    for (const char of text) {
      if (!/\s/.test(char) && !coverage?.has(char.codePointAt(0) ?? 0)) {
        return false;
      }
    }

    return true;
  }

  /*
   * DejaVu's oblique fonts have no Arabic, and its monospace font
   * no Hebrew, so a right-to-left word in an italic quote or in
   * `inline code` is set upright, or in the proportional font,
   * rather than turning into "?" boxes.
   */
  const fallbackRuns = new WeakMap<InlineRun, InlineRun[]>();

  function runForText(run: InlineRun, text: string): InlineRun {
    if (!hasRtl(text) || fontCovers(run, text)) {
      return run;
    }

    let candidates = fallbackRuns.get(run);

    if (!candidates) {
      candidates = [
        { ...run, upright: true },
        { ...run, upright: true, sans: true },
      ];
      fallbackRuns.set(run, candidates);
    }

    return candidates.find((candidate) => fontCovers(candidate, text)) ?? run;
  }

  function setRunFont(run: RunStyle, fontSize: number): void {
    doc.setFont(...runFont(run));
    doc.setFontSize(run.sup ? fontSize * NOTE_SCALE : fontSize);
  }

  /*
   * The same run drawn in a fallback font: one object per run and
   * font, so consecutive words in it still share a doc.text() call.
   */
  const faceRuns = new WeakMap<InlineRun, Map<string, FaceRun>>();

  function withFace(run: InlineRun, family: string): FaceRun {
    let byFamily = faceRuns.get(run);

    if (!byFamily) {
      byFamily = new Map();
      faceRuns.set(run, byFamily);
    }

    let faceRun = byFamily.get(family);

    if (!faceRun) {
      faceRun = { ...run, face: family };
      byFamily.set(family, faceRun);
    }

    return faceRun;
  }

  function runColor(run: InlineStyle): Rgb {
    return run.link
      ? LINK_COLOR
      : run.code
        ? CODE_TEXT_COLOR
        : run.muted
          ? MUTED_COLOR
          : textColor;
  }

  /* Bold text in a fallback font, which has no bold of its own */
  function fauxBoldWidth(fontSize: number): number {
    return mm(fontSize) * 0.035;
  }

  /*
   * A typeset formula's size on the page. `unit` is mm per viewBox
   * unit (an em is 1000); `offset` centers a display formula on
   * its own line.
   */
  interface MathLayout {
    rendered: RenderedMath;
    unit: number;
    ascent: number;
    descent: number;
    display: boolean;
    offset: number;
  }

  interface Word {
    text: string;
    run: FaceRun;
    width: number;
    math?: MathLayout;
    /*
     * Kept on the line of the word before it: a note's number, a
     * comma after a Hindi word, a "。" after an English one.
     */
    glue?: boolean;
    /*
     * A line may break before it although no space comes first:
     * Chinese and Japanese, and words right next to them.
     */
    breakBefore?: boolean;
    /* A piece of Chinese or Japanese a line may break around */
    breaksAnywhere?: boolean;
    /* The fallback font it's drawn in, if any */
    fallback?: string;
    /* Glyphs HarfBuzz placed (see text-shaping.ts) */
    shaped?: { loaded: LoadedFallback; text: ShapedText; scale: number; size: number };
  }

  function isSpace(word: Word): boolean {
    return word.math === undefined && /^\s+$/.test(word.text);
  }

  /*
   * TeX's Computer Modern has a much smaller x-height than DejaVu
   * Sans, so formulas are set a little larger than the text around
   * them to look the same size - as chat sites do too.
   */
  const MATH_SCALE = 1.15;

  function mathWord(
    run: InlineRun,
    index: number,
    rendered: RenderedMath,
    fontSize: number,
  ): Word {
    const unit = (mm(fontSize) * MATH_SCALE) / 1000;
    const [, minY, width, height] = rendered.viewBox;

    return {
      text: "",
      run,
      width: width * unit,
      math: {
        rendered,
        unit,
        ascent: -minY * unit,
        descent: (minY + height) * unit,
        display: formulas[index]?.display ?? false,
        offset: 0,
      },
    };
  }

  /* Shrinks a formula wider than the line until it fits. */
  function fitMath(word: Word, maxWidth: number): Word {
    if (!word.math || word.width <= maxWidth) {
      return word;
    }

    const factor = maxWidth / word.width;

    return {
      ...word,
      width: maxWidth,
      math: {
        ...word.math,
        unit: word.math.unit * factor,
        ascent: word.math.ascent * factor,
        descent: word.math.descent * factor,
      },
    };
  }

  /*
   * A note becomes a small raised "[1]" per source it cites, each
   * linking to its source's page, like a footnote's number.
   */
  function noteWords(run: InlineRun, fontSize: number): Word[] {
    return (run.notes ?? []).map((number) => {
      const url = currentSources[number - 1]?.url ?? "";
      const noteRun: InlineRun = {
        text: `[${number}]`,
        sup: true,
        ...(isSafeSourceUrl(url) ? { link: url } : {}),
      };

      setRunFont(noteRun, fontSize);

      return {
        text: noteRun.text,
        run: noteRun,
        width: doc.getTextWidth(noteRun.text),
        glue: true,
      };
    });
  }

  function tokenizeRuns(runs: InlineRun[], fontSize: number): Word[] {
    const words: Word[] = [];

    for (const original of runs) {
      let run = original;

      if (run.notes) {
        words.push(...noteWords(run, fontSize));
        continue;
      }

      if (run.math !== undefined) {
        const rendered = renderedFormulas[run.math];

        if (rendered) {
          words.push(mathWord(run, run.math, rendered, fontSize));
          continue;
        }

        run = {
          ...run,
          math: undefined,
          code: true,
          text: (formulas[run.math]?.tex ?? "").replace(/\s*\n\s*/g, " "),
        };
      }

      if (hasRtl(run.text)) {
        words.push(...tokenizeRtlRun(run, fontSize));
        continue;
      }

      tokenizeScripts(run, fontSize, words);
    }

    return words;
  }

  /*
   * Adds a word, deciding whether a line may break between it and
   * the word before it when no space comes between them.
   */
  function addWord(words: Word[], word: Word): void {
    const before = words[words.length - 1];

    if (
      before &&
      !word.glue &&
      !before.math &&
      !isSpace(word) &&
      !isSpace(before)
    ) {
      if (cannotStartLine(word.text) || cannotEndLine(before.text)) {
        word.glue = true;
      } else if (word.breaksAnywhere || before.breaksAnywhere) {
        word.breakBefore = true;
      } else if ((word.fallback ?? "") !== (before.fallback ?? "")) {
        word.glue = true;
      }
    }

    words.push(word);
  }

  /*
   * A left-to-right run's words, each piece in a font that has its
   * letters: the run's own font, or a fallback for Chinese,
   * Japanese, Korean, and the scripts HarfBuzz shapes.
   */
  function tokenizeScripts(run: InlineRun, fontSize: number, words: Word[]): void {
    const [family, style] = runFont(run);
    const coverage = coverageByFont.get(`${family}/${style}`);
    const segments =
      fallbacks.size === 0
        ? [{ text: run.text, font: null }]
        : splitByFont(
            run.text,
            (code) => coverage?.has(code) ?? false,
            fallbackCovers,
          );

    for (const segment of segments) {
      const loaded = segment.font ? fallbacks.get(segment.font) : undefined;

      if (!loaded) {
        // Collapse the double spaces a dropped emoji leaves behind.
        const text = fit(segment.text, family, style).replace(/ {2,}/g, " ");
        setRunFont(run, fontSize);

        for (const part of text.split(/(\s+)/)) {
          if (part !== "") {
            addWord(words, { text: part, run, width: doc.getTextWidth(part) });
          }
        }

        continue;
      }

      // A fallback's stretch never holds a space (see splitByFont).
      if (loaded.shaper) {
        addWord(words, shapedWord(segment.text, run, loaded, fontSize));
        continue;
      }

      const faceRun = withFace(run, loaded.font.family);
      const text = fit(segment.text, loaded.font.family, "normal");
      const breaksAnywhere = loaded.font.breaksAnywhere === true;

      setRunFont(faceRun, fontSize);

      for (const piece of breaksAnywhere ? cjkBreakPieces(text) : [text]) {
        if (piece !== "") {
          addWord(words, {
            text: piece,
            run: faceRun,
            width: doc.getTextWidth(piece),
            fallback: loaded.font.family,
            ...(breaksAnywhere ? { breaksAnywhere } : {}),
          });
        }
      }
    }
  }

  function shapedWord(
    text: string,
    run: InlineRun,
    loaded: LoadedFallback,
    fontSize: number,
  ): Word {
    const shaper = loaded.shaper!;
    const size = run.sup ? fontSize * NOTE_SCALE : fontSize;
    const shapedText = shaper.shape(text);
    const scale = mm(size) / shaper.unitsPerEm;

    return {
      text,
      run,
      width: shapedText.advance * scale,
      fallback: loaded.font.family,
      shaped: { loaded, text: shapedText, scale, size },
    };
  }

  /*
   * A shaped word's glyphs, filled as one path - and its text laid
   * over them invisibly, stretched to the same width, so the PDF
   * can be searched and its text copied.
   */
  function drawShapedWord(word: Word, x: number, baseline: number, color: Rgb): void {
    const { loaded, text, scale, size } = word.shaped!;
    const shaper = loaded.shaper!;
    let penX = x;
    let traced = false;

    for (const glyph of text.glyphs) {
      const matrix: Matrix = [
        scale,
        0,
        0,
        -scale,
        penX + glyph.dx * scale,
        baseline - glyph.dy * scale,
      ];

      traced = tracePath(doc, shaper.outline(glyph.id), matrix) || traced;
      penX += glyph.advance * scale;
    }

    if (traced) {
      doc.setFillColor(...color);

      if (word.run.bold) {
        const lineWidth = doc.getLineWidth();

        doc.setDrawColor(...color);
        doc.setLineWidth(fauxBoldWidth(size));
        doc.fillStroke();
        doc.setLineWidth(lineWidth);
      } else {
        doc.fill();
      }
    }

    const family = loaded.font.family;
    const searchable = fit(word.text, family, "normal");

    if (searchable.trim() !== "") {
      doc.setFont(family, "normal");
      doc.setFontSize(size);

      const natural = doc.getTextWidth(searchable);

      // The scaling would stay on for all the text after it (PDF
      // keeps it in the graphics state), hence the save and restore.
      doc.saveGraphicsState();
      doc.text(searchable, x, baseline, {
        renderingMode: "invisible",
        ...(natural > 0 ? { horizontalScale: word.width / natural } : {}),
      });
      doc.restoreGraphicsState();
    }
  }

  /*
   * Arabic is joined (and measured) in reading order, and each word
   * gets a font that has its letters.
   */
  function tokenizeRtlRun(run: InlineRun, fontSize: number): Word[] {
    const words: Word[] = [];

    for (const part of shapeArabic(run.text).split(/(\s+)/)) {
      const partRun = runForText(run, part);
      const text = fit(part, ...runFont(partRun));
      const last = words[words.length - 1];

      if (text === "" || (/^\s+$/.test(text) && last && isSpace(last))) {
        continue;
      }

      setRunFont(partRun, fontSize);
      words.push({ text, run: partRun, width: doc.getTextWidth(text) });
    }

    return words;
  }

  /*
   * Puts one wrapped line into visual order (see bidi.ts): each
   * word's letters come out reversed where they read right to left,
   * a word that mixes directions splits into pieces, and an inline
   * formula moves as one left-to-right unit. A right-to-left line
   * is also pushed against the right margin by a blank spacer.
   * Lines are wrapped in reading order first, so a line holds the
   * same words either way.
   */
  function visualLine(
    line: Word[],
    rtl: boolean,
    maxWidth: number,
    fontSize: number,
  ): Word[] {
    const plain = line.map((word) =>
      word.math || word.shaped ? OBJECT_CHAR : word.text,
    );

    if (
      line.length === 0 ||
      line[0].math?.display ||
      (!rtl && !hasRtl(plain.join("")))
    ) {
      return line;
    }

    const chars: string[] = [];
    const owners: number[] = [];

    plain.forEach((text, index) => {
      for (const char of text) {
        chars.push(char);
        owners.push(index);
      }
    });

    const levels = bidiLevels(chars, rtl);
    const order = visualOrder(chars, levels);
    const visual: Word[] = [];

    for (let i = 0; i < order.length; ) {
      const owner = owners[order[i]];
      const word = line[owner];

      if (word.math || word.shaped) {
        visual.push(word);
        i++;
        continue;
      }

      let text = "";

      while (i < order.length && owners[order[i]] === owner) {
        text += mirrorChar(chars[order[i]], levels[order[i]]);
        i++;
      }

      setRunFont(word.run, fontSize);
      visual.push({ ...word, text, width: doc.getTextWidth(text) });
    }

    if (rtl) {
      const width = visual.reduce((sum, word) => sum + word.width, 0);

      if (width < maxWidth) {
        visual.unshift({ text: "", run: { text: "" }, width: maxWidth - width });
      }
    }

    return visual;
  }

  /*
   * Hard-breaks a single token that's wider than the available
   * width all on its own (a long identifier, path or inline code
   * span with no spaces to wrap on) into width-bounded chunks, so
   * it can never overflow past the right margin. Rare in normal
   * prose; realistic for `inline code` spans.
   */
  function splitOversizedWord(
    word: Word,
    maxWidth: number,
    fontSize: number,
  ): Word[] {
    setRunFont(word.run, fontSize);

    const chunks: Word[] = [];
    let remaining = word.text;

    while (remaining.length > 0) {
      let end = 1;

      while (
        end < remaining.length &&
        doc.getTextWidth(remaining.slice(0, end + 1)) <= maxWidth
      ) {
        end++;
      }

      const chunkText = remaining.slice(0, end);
      chunks.push({
        text: chunkText,
        run: word.run,
        width: doc.getTextWidth(chunkText),
      });
      remaining = remaining.slice(end);
    }

    return chunks;
  }

  function wrapWords(
    words: Word[],
    maxWidth: number,
    fontSize: number,
  ): Word[][] {
    const lines: Word[][] = [];
    let current: Word[] = [];
    let currentWidth = 0;

    function dropTrailingSpace(): void {
      while (current.length && isSpace(current[current.length - 1])) {
        currentWidth -= current.pop()?.width ?? 0;
      }
    }

    for (const word of words) {
      if (isSpace(word)) {
        if (current.length > 0) {
          current.push(word);
          currentWidth += word.width;
        }

        continue;
      }

      // A display formula gets a line of its own, centered.
      if (word.math?.display) {
        dropTrailingSpace();

        if (current.length > 0) {
          lines.push(current);
        }

        const fitted = fitMath(word, maxWidth);
        lines.push([
          {
            ...fitted,
            math: { ...fitted.math!, offset: (maxWidth - fitted.width) / 2 },
          },
        ]);
        current = [];
        currentWidth = 0;
        continue;
      }

      const parts = word.math
        ? [fitMath(word, maxWidth)]
        : word.width > maxWidth && !word.shaped
          ? splitOversizedWord(word, maxWidth, fontSize)
          : [word];

      for (const part of parts) {
        if (currentWidth + part.width > maxWidth && current.length > 0) {
          let carried: Word[] = [];

          // A note's number moves to the next line together with the
          // word it belongs to, so no line starts with one - and so
          // does a closing mark. The word starts after the last space,
          // or where Chinese or Japanese let the line break.
          if (part.glue) {
            let start = current.length;

            while (start > 0 && !isSpace(current[start - 1])) {
              start--;

              if (current[start].breakBefore) {
                break;
              }
            }

            if (start > 0) {
              carried = current.splice(start);
            }
          }

          dropTrailingSpace();
          lines.push(current);
          current = carried;
          currentWidth = carried.reduce((sum, word) => sum + word.width, 0);
        }

        current.push(part);
        currentWidth += part.width;
      }
    }

    dropTrailingSpace();

    if (current.length > 0 || lines.length === 0) {
      lines.push(current);
    }

    const rtl = isRtlParagraph(
      words.map((word) => (word.math ? OBJECT_CHAR : word.text)).join(""),
    );

    return lines.map((line) => visualLine(line, rtl, maxWidth, fontSize));
  }

  /*
   * How far a line's formulas reach above and below the space a
   * line of text normally takes (its baseline sits about three
   * quarters of the way down), so a tall fraction gets room instead
   * of overlapping the lines around it. A display formula also gets
   * some air above and below.
   */
  function lineExtras(
    line: Word[],
    lineHeight: number,
  ): { above: number; below: number } {
    let above = 0;
    let below = 0;

    for (const { math } of line) {
      if (!math) {
        continue;
      }

      const pad = math.display ? lineHeight * 0.35 : 0;
      above = Math.max(above, Math.max(0, math.ascent - lineHeight * 0.75) + pad);
      below = Math.max(below, Math.max(0, math.descent - lineHeight * 0.25) + pad);
    }

    return { above, below };
  }

  function lineBoxHeight(line: Word[], lineHeight: number): number {
    const { above, below } = lineExtras(line, lineHeight);
    return lineHeight + above + below;
  }

  /*
   * Characters MathJax has no glyph outlines for (Cyrillic, CJK...
   * inside \text{}) come through as <text>; they're drawn with the
   * embedded DejaVu fonts like the rest of the document.
   */
  function drawMathText(
    text: string,
    x: number,
    baseline: number,
    size: number,
    style: MathTextStyle,
    color: Rgb,
  ): void {
    const [family, fontStyle] = mathTextFont(style, text);

    doc.setFont(family, fontStyle);
    doc.setFontSize(size / PT_TO_MM);
    doc.setTextColor(...color);
    doc.text(fit(text, family, fontStyle), x, baseline);
  }

  /*
   * Calls `draw` once per maximal span of consecutive words that
   * share a non-undefined key, with the span's edge whitespace
   * trimmed off.
   */
  function forEachSpan<K>(
    line: Word[],
    keyOf: (word: Word) => K | undefined,
    draw: (first: number, last: number, key: K) => void,
  ): void {
    let i = 0;

    while (i < line.length) {
      const key = keyOf(line[i]);

      if (key === undefined) {
        i++;
        continue;
      }

      let end = i;

      while (end + 1 < line.length && keyOf(line[end + 1]) === key) {
        end++;
      }

      let first = i;
      let last = end;

      while (first <= last && isSpace(line[first])) {
        first++;
      }

      while (last >= first && isSpace(line[last])) {
        last--;
      }

      if (first <= last) {
        draw(first, last, key);
      }

      i = end + 1;
    }
  }

  /*
   * Draws pre-wrapped lines starting at the current `y`. When
   * `manage` is false, page breaks are the caller's
   * responsibility (used for table cells, where the whole row's
   * height was already reserved up front).
   *
   * Each line is painted in spans rather than word by word: one
   * background per inline code span, one underline and one
   * clickable area per link (a multi-word link used to become one
   * annotation per word, with gaps at the spaces), and one text
   * call per run of same-styled words.
   */
  function drawWrappedLines(
    lines: Word[][],
    x: number,
    fontSize: number,
    lineHeight: number,
    manage: boolean,
  ): void {
    for (const line of lines) {
      const { above, below } = lineExtras(line, lineHeight);

      if (manage) {
        ensureSpace(lineHeight + above + below);
      }

      y += above;

      const starts: number[] = [];
      let cursorX = x + (line[0]?.math?.offset ?? 0);

      for (const word of line) {
        starts.push(cursorX);
        cursorX += word.width;
      }

      const spanWidth = (first: number, last: number) =>
        starts[last] + line[last].width - starts[first];

      forEachSpan(
        line,
        (word) => (word.run.code ? word.run : undefined),
        (first, last) => {
          doc.setFillColor(245, 245, 245);
          doc.rect(
            starts[first] - 0.3,
            y - lineHeight * 0.62,
            spanWidth(first, last) + 0.6,
            lineHeight * 0.82,
            "F",
          );
        },
      );

      forEachSpan(
        line,
        (word) => word.run.link,
        (first, last, url) => {
          const width = spanWidth(first, last);

          // A note's number is clickable but not underlined.
          if (!line[first].run.sup) {
            doc.setDrawColor(...LINK_COLOR);
            doc.line(starts[first], y + 0.7, starts[first] + width, y + 0.7);
          }

          doc.link(
            starts[first],
            y - mm(fontSize) * 0.9,
            width,
            mm(fontSize) * 1.2,
            {
              url,
            },
          );
        },
      );

      forEachSpan(
        line,
        (word) =>
          word.math || word.shaped || word.text === "" ? undefined : word.run,
        (first, last, run) => {
          const color = runColor(run);

          setRunFont(run, fontSize);
          doc.setTextColor(...color);

          // A fallback font has no bold: its letters get an outline.
          const fauxBold = Boolean(run.face && run.bold);
          const lineWidth = doc.getLineWidth();

          if (fauxBold) {
            doc.setDrawColor(...color);
            doc.setLineWidth(fauxBoldWidth(fontSize));
          }

          doc.text(
            line
              .slice(first, last + 1)
              .map((word) => word.text)
              .join(""),
            starts[first],
            run.sup ? y - mm(fontSize) * NOTE_RISE : y,
            fauxBold ? { renderingMode: "fillThenStroke" } : undefined,
          );

          if (fauxBold) {
            doc.setLineWidth(lineWidth);
          }
        },
      );

      line.forEach((word, i) => {
        if (word.shaped) {
          drawShapedWord(
            word,
            starts[i],
            word.run.sup ? y - mm(fontSize) * NOTE_RISE : y,
            runColor(word.run),
          );
        }

        if (word.math) {
          drawMath(doc, word.math.rendered, starts[i], y, word.math.unit, {
            color: word.run.link ? LINK_COLOR : textColor,
            drawText: drawMathText,
          });
        }
      });

      doc.setTextColor(...TEXT_COLOR);
      y += lineHeight + below;
    }
  }

  function renderInlineParagraph(
    runs: InlineRun[],
    fontSize: number,
    lineHeight: number,
    x: number,
    width: number,
  ): void {
    const words = tokenizeRuns(runs, fontSize);

    if (words.every(isSpace)) {
      return;
    }

    const lines = wrapWords(words, width, fontSize);
    drawWrappedLines(lines, x, fontSize, lineHeight, true);
  }

  /*
   * A line of plain text - a role label, a message's details - laid
   * out like any other, so it gets the fallback fonts too.
   */
  function writePlainLine(
    text: string,
    fontSize: number,
    lineHeight: number,
    style: "normal" | "bold" | "italic" = "normal",
    color: Rgb = TEXT_COLOR,
  ): void {
    const run: InlineRun = {
      text,
      ...(style === "bold" ? { bold: true } : {}),
      ...(style === "italic" ? { italic: true } : {}),
    };
    const savedColor = textColor;

    textColor = color;
    drawWrappedLines(
      wrapWords(tokenizeRuns([run], fontSize), contentWidth, fontSize),
      pdf.marginLeft,
      fontSize,
      lineHeight,
      true,
    );
    textColor = savedColor;
    doc.setTextColor(...TEXT_COLOR);
  }

  function renderHeading(block: Extract<Block, { type: "heading" }>): void {
    const fontSize = headingFontSize + Math.max(0, 3 - block.level);
    const lineHeight = mm(fontSize) * 1.32;

    // Keep the heading with the first lines under it.
    ensureSpace(lineHeight * 1.2 + bodyLineHeight * 2);
    y += lineHeight * 0.2;
    renderInlineParagraph(
      parseInline(block.text, { bold: true }),
      fontSize,
      lineHeight,
      blockLeft,
      blockWidth,
    );
    y += bodyLineHeight * 0.2;
  }

  /*
   * Renders "\n"-separated segments (see joinLines) as forced line
   * breaks; an empty segment - a blank line inside a quoted draft,
   * or two hard breaks in a row - becomes a half-line gap.
   */
  function renderSegments(
    text: string,
    style: InlineStyle,
    indent: number,
  ): void {
    for (const segment of text.split("\n")) {
      if (segment.trim() === "") {
        y += bodyLineHeight * 0.5;
        continue;
      }

      // A right-to-left quote is indented from the right.
      const rtl = isRtlParagraph(segment);

      renderInlineParagraph(
        parseInline(segment, style),
        bodyFontSize,
        bodyLineHeight,
        blockLeft + (rtl ? 0 : indent),
        blockWidth - indent,
      );
    }

    y += bodyLineHeight * 0.3;
  }

  function renderParagraph(text: string): void {
    renderSegments(text, {}, 0);
  }

  function renderBlockquote(text: string): void {
    renderSegments(text, { italic: true }, 5);
  }

  function renderList(block: Extract<Block, { type: "list" }>): void {
    const indent = 6;

    block.items.forEach((itemText, index) => {
      // A right-to-left item has its marker on the right ("1." reads
      // ".1" there, as in a browser).
      const rtl = isRtlParagraph(itemText);
      const prefix = visualPlain(block.ordered ? `${index + 1}.` : "•", rtl);
      const lines = wrapWords(
        tokenizeRuns(parseInline(itemText), bodyFontSize),
        blockWidth - indent,
        bodyFontSize,
      );
      // The marker sits on the first line's baseline, which a tall
      // formula on that line pushes down.
      const { above } = lineExtras(lines[0], bodyLineHeight);

      ensureSpace(lineBoxHeight(lines[0], bodyLineHeight));
      doc.setFont(SANS_FONT, "normal");
      doc.setFontSize(bodyFontSize);
      doc.setTextColor(...textColor);
      doc.text(
        prefix,
        rtl
          ? blockLeft + blockWidth - doc.getTextWidth(prefix)
          : blockLeft,
        y + above,
      );
      drawWrappedLines(
        lines,
        blockLeft + (rtl ? 0 : indent),
        bodyFontSize,
        bodyLineHeight,
        true,
      );
    });

    y += bodyLineHeight * 0.3;
  }

  /*
   * Code lines are wrapped by a fixed character count rather
   * than doc.splitTextToSize()'s word-boundary wrapping: a code
   * line frequently has no spaces at all near its overflow point
   * (long identifiers, string literals, ...), which left
   * splitTextToSize with nothing to break on and let the line
   * run straight past the right margin. DejaVuSansMono is a true
   * monospace font - every glyph shares one advance width - so
   * a single measurement gives an exact, cheap character budget
   * instead of re-measuring per line. Tabs are expanded to spaces
   * first: no DejaVu font has a tab glyph, and jsPDF drops the rest
   * of a line at the first character its font lacks, which blanked
   * every tab-indented line.
   *
   * Lines are syntax highlighted (see code-highlight.ts) as the
   * fence's language, or one guessed from the code: each line is a
   * run of colored tokens, wrapped by the same character count and
   * drawn piece by piece.
   */
  function renderCodeBlock(code: string, lang?: string): void {
    doc.setFont(MONO_FONT, "normal");
    doc.setFontSize(codeFontSize);

    const monoCoverage = coverageByFont.get(`${MONO_FONT}/normal`);
    const monoCovers = (code: number) => monoCoverage?.has(code) ?? false;

    /*
     * A code token fitted to the monospace font - except Chinese,
     * Japanese, Korean or a shaped script, kept for its fallback
     * font (a comment in Chinese is common).
     */
    function fitCode(text: string): string {
      if (fallbacks.size === 0) {
        return fit(text, MONO_FONT, "normal");
      }

      return splitByFont(text, monoCovers, fallbackCovers)
        .map((piece) => (piece.font ? piece.text : fit(piece.text, MONO_FONT, "normal")))
        .join("");
    }

    /* Text in one color, each piece in its font; returns where it ends */
    function drawCodeRun(text: string, x: number, color: Rgb): number {
      const pieces =
        fallbacks.size === 0
          ? [{ text, font: null }]
          : splitByFont(text, monoCovers, fallbackCovers);

      for (const piece of pieces) {
        const loaded = piece.font ? fallbacks.get(piece.font) : undefined;

        if (loaded?.shaper) {
          const word = shapedWord(piece.text, { text: piece.text }, loaded, codeFontSize);

          drawShapedWord(word, x, y, color);
          x += word.width;
          continue;
        }

        doc.setFont(loaded ? loaded.font.family : MONO_FONT, "normal");
        doc.setFontSize(codeFontSize);
        doc.text(piece.text, x, y);
        x += doc.getTextWidth(piece.text);
      }

      doc.setFont(MONO_FONT, "normal");
      doc.setFontSize(codeFontSize);

      return x;
    }

    const codeInnerWidth = blockWidth - 4;
    const charWidth = doc.getTextWidth("M") || 1;
    const maxChars = Math.max(1, Math.floor(codeInnerWidth / charWidth));
    // One column is reserved for the wrap-continuation marker
    // below, so a hard-wrapped line never grows back past
    // maxChars once the marker is appended.
    const wrapMaxChars = Math.max(1, maxChars - 1);
    const WRAP_MARKER = "↪";

    /*
     * Code stays left to right, but a Hebrew or Arabic comment or
     * string in it is put into visual order, and letters the
     * monospace font lacks (Hebrew) are drawn in the proportional
     * one.
     */
    function drawCodeText(text: string, x: number): void {
      const pieces: { text: string; mono: boolean }[] = [];

      for (const char of text) {
        const mono =
          /\s/.test(char) || Boolean(monoCoverage?.has(char.codePointAt(0) ?? 0));
        const last = pieces[pieces.length - 1];

        if (last && last.mono === mono) {
          last.text += char;
        } else {
          pieces.push({ text: char, mono });
        }
      }

      for (const piece of pieces) {
        const family = piece.mono ? MONO_FONT : SANS_FONT;
        const pieceText = fit(piece.text, family, "normal");
        doc.setFont(family, "normal");
        doc.text(pieceText, x, y);
        x += doc.getTextWidth(pieceText);
      }

      doc.setFont(MONO_FONT, "normal");
    }

    /*
     * A segment's characters drawn in their token colors, one
     * doc.text() call per run of a single color.
     */
    function drawHighlighted(segment: TokenKind[], text: string): void {
      let x = blockLeft + 2;
      let start = 0;

      for (let index = 1; index <= text.length; index++) {
        if (index < text.length && segment[index] === segment[start]) {
          continue;
        }

        const run = text.slice(start, index);
        const color = CODE_TOKEN_COLORS[segment[start]];

        doc.setTextColor(...color);
        x = drawCodeRun(run, x, color);
        start = index;
      }

      doc.setTextColor(...CODE_TEXT_COLOR);
    }

    const expandedCode = code.split("\n").map((line) => expandTabs(line));
    const highlighted = highlightCode(expandedCode.join("\n"), lang);

    expandedCode.forEach((expanded, lineIndex) => {
      const rtlText = hasRtl(expanded);
      // The line as fitted to the font, with each character's token
      // kind alongside; a right-to-left line is drawn uncolored.
      let line = "";
      const kinds: TokenKind[] = [];

      if (rtlText) {
        line = shapeArabic(expanded);
      } else {
        for (const token of highlighted[lineIndex] ?? []) {
          const text = fitCode(token.text);
          line += text;
          kinds.push(...Array<TokenKind>(text.length).fill(token.kind));
        }
      }

      // Wrapped by columns, a Chinese character taking two.
      const segments = rtlText
        ? line.length === 0
          ? [""]
          : (line.match(new RegExp(`.{1,${wrapMaxChars}}`, "g")) ?? [""])
        : wrapByColumns(line, wrapMaxChars);
      let offset = 0;

      segments.forEach((segment, segmentIndex) => {
        const isHardWrap = segmentIndex < segments.length - 1;
        const segmentKinds = kinds.slice(offset, offset + segment.length);
        offset += segment.length;

        ensureSpace(codeLineHeight);
        doc.setFillColor(245, 245, 245);
        doc.rect(
          blockLeft,
          y - codeLineHeight * 0.72,
          blockWidth,
          codeLineHeight,
          "F",
        );
        doc.setTextColor(...CODE_TEXT_COLOR);

        if (rtlText) {
          drawCodeText(
            `${toVisual(segment, false)}${isHardWrap ? WRAP_MARKER : ""}`,
            blockLeft + 2,
          );
        } else {
          drawHighlighted(
            isHardWrap ? [...segmentKinds, "plain"] : segmentKinds,
            isHardWrap ? `${segment}${WRAP_MARKER}` : segment,
          );
        }

        y += codeLineHeight;
      });
    });

    doc.setTextColor(...TEXT_COLOR);
    y += bodyLineHeight * 0.5;
  }

  /*
   * `y` is the next line's baseline, so the rule is drawn a little
   * above it and the next baseline pushed a full line below the
   * rule; drawing the rule at `y` itself left the following text's
   * ascenders touching it (most visibly the role label under a
   * message separator). A rule that would open a page is skipped -
   * the page break already separates.
   */
  function renderHr(): void {
    ensureSpace(bodyLineHeight);

    if (y <= pdf.marginTop) {
      return;
    }

    const ruleY = y - bodyLineHeight * 0.3;
    doc.setDrawColor(200);
    doc.line(blockLeft, ruleY, blockLeft + blockWidth, ruleY);
    y += bodyLineHeight * 0.9;
  }

  function renderTable(block: Extract<Block, { type: "table" }>): void {
    const colCount = block.header.length;

    if (colCount === 0) {
      return;
    }

    const cellPaddingX = 2;
    const cellPaddingY = 1.6;
    const cellFontSize = Math.max(6, bodyFontSize - 1);
    const cellLineHeight = mm(cellFontSize) * 1.3;
    const colWidth = blockWidth / colCount;
    // A table whose header reads right to left has its first column
    // on the right, as the chat page shows it.
    const rtlTable = isRtlParagraph(block.header.join(" "));
    const innerWidth = colWidth - cellPaddingX * 2;

    interface RowLayout {
      cells: string[];
      lines: Word[][][];
      height: number;
    }

    /*
     * Rows are padded/truncated to the header's column count
     * (a short row used to crash the export on the missing cell).
     */
    function layoutRow(rawCells: string[]): RowLayout {
      const cells = Array.from(
        { length: colCount },
        (_, col) => rawCells[col] ?? "",
      );
      const lines = cells.map((cell) => {
        // Diff/changeset tables often carry literal "<br>" tags
        // (GitHub renders these as line breaks in its own HTML
        // table cells) - turn each into a real forced break
        // instead of printing the raw tag.
        const cellLines: Word[][] = [];

        for (const subLine of cell.split(/<br\s*\/?>/gi)) {
          const words = tokenizeRuns(parseInline(subLine), cellFontSize);
          cellLines.push(...wrapWords(words, innerWidth, cellFontSize));
        }

        return cellLines;
      });
      const contentHeight = Math.max(
        ...lines.map((cellLines) =>
          Math.max(
            cellLineHeight,
            cellLines.reduce(
              (sum, line) => sum + lineBoxHeight(line, cellLineHeight),
              0,
            ),
          ),
        ),
      );

      return {
        cells,
        lines,
        height: contentHeight + cellPaddingY * 2,
      };
    }

    const pageUsableHeight = contentBottom - pdf.marginTop;

    /*
     * Fallback for a row whose content is taller than an entire
     * page - which only happens when a block got misidentified as
     * a table row (e.g. a large pasted diff/changeset that
     * happens to contain pipe characters). The fixed-height grid
     * cell drawing below assumes a row fits on one page; forcing
     * that assumption here would silently draw past the bottom
     * margin and overlap whatever comes next. Falling back to
     * plain, fully page-break-managed paragraphs per cell loses
     * the grid look for that one row, but guarantees every line
     * actually lands on the page it's drawn on.
     */
    function renderOversizedRowAsParagraphs(cells: string[]): void {
      for (const cell of cells) {
        if (cell.trim() === "") {
          continue;
        }

        for (const subLine of cell.split(/<br\s*\/?>/gi)) {
          renderInlineParagraph(
            parseInline(subLine),
            cellFontSize,
            cellLineHeight,
            blockLeft,
            blockWidth,
          );
        }

        y += cellLineHeight * 0.3;
      }
    }

    const headerRow = layoutRow(block.header);
    const bodyRows = block.rows.map(layoutRow);

    /*
     * Redraws the header at the top of a fresh page whenever a
     * body row's ensureSpace() call breaks to one, so a table
     * that spans pages doesn't lose its column labels partway
     * through.
     */
    function drawRow(row: RowLayout, isHeader: boolean): void {
      if (row.height > pageUsableHeight) {
        // `y` is the previous row's bottom border here; start the
        // text a line below it instead of on top of it.
        y += cellLineHeight;
        renderOversizedRowAsParagraphs(row.cells);
        return;
      }

      const pageBefore = doc.getNumberOfPages();
      ensureSpace(row.height);

      if (!isHeader && doc.getNumberOfPages() !== pageBefore) {
        drawRow(headerRow, true);
      }

      const rowTop = y;

      if (isHeader) {
        doc.setFillColor(240, 240, 240);
        doc.rect(blockLeft, rowTop, blockWidth, row.height, "F");
      }

      doc.setDrawColor(200);

      for (let col = 0; col < colCount; col++) {
        const cellX =
          blockLeft + (rtlTable ? colCount - 1 - col : col) * colWidth;
        doc.rect(cellX, rowTop, colWidth, row.height);

        y = rowTop + cellPaddingY + cellLineHeight * 0.78;
        drawWrappedLines(
          row.lines[col],
          cellX + cellPaddingX,
          cellFontSize,
          cellLineHeight,
          false,
        );
      }

      y = rowTop + row.height;
    }

    // Keep the header with the first body row, so a page never
    // ends on a lone header row.
    const firstRowsHeight = headerRow.height + (bodyRows[0]?.height ?? 0);

    if (firstRowsHeight <= pageUsableHeight) {
      ensureSpace(firstRowsHeight);
    }

    drawRow(headerRow, true);

    for (const row of bodyRows) {
      drawRow(row, false);
    }

    // A larger gap than other blocks get: `y` is now the table's
    // bottom border, and the next block's first baseline needs a
    // full line below it to clear its ascenders comfortably.
    y += bodyLineHeight;
  }

  function renderBlock(block: Block): void {
    switch (block.type) {
      case "heading":
        renderHeading(block);
        break;
      case "paragraph":
        renderParagraph(block.text);
        break;
      case "code":
        renderCodeBlock(block.code, block.lang);
        break;
      case "list":
        renderList(block);
        break;
      case "table":
        renderTable(block);
        break;
      case "blockquote":
        renderBlockquote(block.text);
        break;
      case "hr":
        renderHr();
        break;
    }
  }

  /* A small gray label in capitals over a section: THINKING, SOURCES */
  function writeLabel(text: string): void {
    const size = Math.max(7, bodyFontSize - 2.5);
    const lineHeight = mm(size) * 1.7;

    ensureSpace(lineHeight + bodyLineHeight);
    doc.setFont(SANS_FONT, "bold");
    doc.setFontSize(size);
    doc.setTextColor(...MUTED_COLOR);
    doc.text(text.toUpperCase(), pdf.marginLeft, y);
    doc.setTextColor(...TEXT_COLOR);
    y += lineHeight;
  }

  /*
   * A reply's thinking, ahead of its answer: gray, and set in from
   * a line down its left side - drawn last, page by page, since the
   * thinking can run over a page break.
   */
  function renderThinking(blocks: Block[]): void {
    const indent = 5;

    writeLabel("Thinking");

    const startPage = doc.getNumberOfPages();
    const startY = y - bodyLineHeight * 0.8;

    blockLeft = pdf.marginLeft + indent;
    blockWidth = contentWidth - indent;
    textColor = MUTED_COLOR;

    try {
      for (const [index, block] of blocks.entries()) {
        if (isLeadIn(block)) {
          ensureSpace(keepWithNextHeight(blocks, index));
        }

        renderBlock(block);
      }
    } finally {
      blockLeft = pdf.marginLeft;
      blockWidth = contentWidth;
      textColor = TEXT_COLOR;
    }

    const endPage = doc.getNumberOfPages();
    const endY = y - bodyLineHeight * 0.9;
    const lineWidth = doc.getLineWidth();

    doc.setDrawColor(208, 215, 222);
    doc.setLineWidth(0.6);

    for (let page = startPage; page <= endPage; page++) {
      doc.setPage(page);

      const top = page === startPage ? startY : pdf.marginTop - bodyLineHeight * 0.8;
      const bottom = page === endPage ? endY : contentBottom;

      if (bottom > top) {
        doc.line(pdf.marginLeft + 1, top, pdf.marginLeft + 1, bottom);
      }
    }

    doc.setLineWidth(lineWidth);
    y += bodyLineHeight * 0.4;
  }

  /*
   * The reply's sources under it, numbered as its notes cite them:
   * each title links to its page, with the site's name after it.
   */
  function renderSources(sources: MessageSource[]): void {
    const fontSize = Math.max(7, bodyFontSize - 1.5);
    const lineHeight = mm(fontSize) * 1.35;
    const indent = 7;

    writeLabel("Sources");

    sources.forEach((source, index) => {
      const label = sourceLabel(source);
      const host = sourceHost(source.url);
      const runs: InlineRun[] = [
        isSafeSourceUrl(source.url)
          ? { text: label, link: source.url }
          : { text: label },
        ...(host && host !== label ? [{ text: ` · ${host}`, muted: true }] : []),
      ];
      const rtl = isRtlParagraph(label);
      const prefix = visualPlain(`${index + 1}.`, rtl);
      const lines = wrapWords(
        tokenizeRuns(runs, fontSize),
        contentWidth - indent,
        fontSize,
      );

      ensureSpace(lineBoxHeight(lines[0], lineHeight));
      doc.setFont(SANS_FONT, "normal");
      doc.setFontSize(fontSize);
      doc.setTextColor(...MUTED_COLOR);
      doc.text(
        prefix,
        rtl
          ? pdf.marginLeft + contentWidth - doc.getTextWidth(prefix)
          : pdf.marginLeft,
        y,
      );
      drawWrappedLines(
        lines,
        pdf.marginLeft + (rtl ? 0 : indent),
        fontSize,
        lineHeight,
        true,
      );
    });

    y += bodyLineHeight * 0.3;
  }

  async function writeImage(image: ExportImageFile): Promise<void> {
    let converted = pngCache.get(image.path);

    if (converted === undefined) {
      converted = await toEmbeddablePng(image.base64, image.mimeType);
      pngCache.set(image.path, converted);
    }

    if (!converted) {
      writePlainLine(`[image: ${image.path}]`, bodyFontSize, bodyLineHeight);
      return;
    }

    const maxWidthMm = contentWidth;
    const maxHeightMm = contentBottom - pdf.marginTop;
    const naturalWidthMm = (converted.width / 96) * 25.4;
    const naturalHeightMm = (converted.height / 96) * 25.4;

    const scale = Math.min(
      1,
      maxWidthMm / naturalWidthMm,
      maxHeightMm / naturalHeightMm,
    );

    const drawWidth = naturalWidthMm * scale;
    const drawHeight = naturalHeightMm * scale;

    ensureSpace(drawHeight);

    /*
     * y is the baseline of the line the image takes the place of,
     * so it starts where that line's letters would - otherwise it
     * sits a line low and touches whatever comes next.
     */
    doc.addImage(
      converted.dataUrl,
      "PNG",
      pdf.marginLeft,
      y - mm(bodyFontSize) * 0.75,
      drawWidth,
      drawHeight,
    );
    y += drawHeight + mm(bodyFontSize) * 0.6;
  }

  /*
   * ---------------------------------------------------------
   * DOCUMENT HEADER (title, chat link, export info)
   * ---------------------------------------------------------
   *
   * Opens the first page - the first table of contents page when
   * there is one, so the document still starts with its title.
   */
  const titleFontSize = headingFontSize + 5;
  const titleLineHeight = mm(titleFontSize) * 1.25;
  const metaFontSize = Math.max(7, bodyFontSize - 2);
  const metaLineHeight = mm(metaFontSize) * 1.6;
  const headerMeta = [
    settings.includeTimestamp ? `Exported ${new Date().toLocaleString()}` : "",
    `${messages.length} ${messages.length === 1 ? "message" : "messages"}`,
  ]
    .filter(Boolean)
    .join("  ·  ");

  function splitLines(
    text: string,
    fontSize: number,
    style: FontStyle,
  ): string[] {
    doc.setFont(SANS_FONT, style);
    doc.setFontSize(fontSize);
    return doc.splitTextToSize(
      fit(shapeArabic(text), SANS_FONT, style),
      contentWidth,
    );
  }

  const hasHeader = Boolean(
    documentTitle || tabUrl || settings.includeTimestamp,
  );
  // Laid out like a paragraph: a Hebrew or Arabic title is
  // right-aligned, like the reply, and a Chinese one gets its font.
  const headerTitleLines = documentTitle
    ? wrapWords(
        tokenizeRuns([{ text: documentTitle, bold: true }], titleFontSize),
        contentWidth,
        titleFontSize,
      )
    : [];
  const headerUrlLines = tabUrl
    ? splitLines(tabUrl, metaFontSize, "normal")
    : [];
  const headerHeight = hasHeader
    ? headerTitleLines.length * titleLineHeight +
      headerUrlLines.length * metaLineHeight +
      metaLineHeight * 0.5 +
      bodyLineHeight * 1.2
    : 0;

  function drawHeader(): void {
    if (!hasHeader) {
      return;
    }

    drawWrappedLines(
      headerTitleLines,
      pdf.marginLeft,
      titleFontSize,
      titleLineHeight,
      false,
    );

    doc.setFont(SANS_FONT, "normal");
    doc.setFontSize(metaFontSize);
    doc.setTextColor(...LINK_COLOR);

    for (const line of headerUrlLines) {
      doc.text(line, pdf.marginLeft, y);
      doc.link(
        pdf.marginLeft,
        y - mm(metaFontSize) * 0.9,
        doc.getTextWidth(line),
        mm(metaFontSize) * 1.2,
        { url: tabUrl },
      );
      y += metaLineHeight;
    }

    const metaTop = y;

    writePlainLine(headerMeta, metaFontSize, metaLineHeight, "normal", MUTED_COLOR);
    y = metaTop;

    const ruleY = y + metaLineHeight * 0.5;
    doc.setDrawColor(200);
    doc.line(pdf.marginLeft, ruleY, pageWidth - pdf.marginRight, ruleY);
    doc.setTextColor(...TEXT_COLOR);
    y = ruleY + bodyLineHeight * 1.2;
  }

  /*
   * ---------------------------------------------------------
   * MESSAGES
   * ---------------------------------------------------------
   */
  const tocEntries: TocEntry[] = [];

  const ROLE_COLOR: Record<Message["role"], Rgb> = {
    user: [31, 91, 199],
    assistant: [15, 118, 84],
  };
  const showRoleLabels = settings.headingStyle !== "none";
  const ruleBetweenMessages = settings.messageSeparator === "rule";

  if (!pdf.includeTableOfContents) {
    drawHeader();
  }

  /*
   * A heading or a bold label line ("**Step 1:**", a Claude
   * artifact's title) introduces the block after it, so it's kept
   * on the same page as that block's first lines - as is a run of
   * them, such as an artifact title over the document's own
   * heading.
   */
  function isLeadIn(block: Block): boolean {
    return (
      block.type === "heading" ||
      (block.type === "paragraph" && /^\*\*[^*\n]+\*\*$/.test(block.text))
    );
  }

  /*
   * The height that keeps blocks[index] - and, while they're
   * lead-ins, the blocks after it - with the first lines of what
   * they introduce. Capped at a third of a page, so a long run of
   * lead-ins can't push each one onto a page of its own.
   */
  function keepWithNextHeight(blocks: Block[], index: number): number {
    let height = bodyLineHeight * 2;

    for (let i = index; i < blocks.length && isLeadIn(blocks[i]); i++) {
      const block = blocks[i];

      height +=
        block.type === "heading"
          ? mm(headingFontSize + Math.max(0, 3 - block.level)) * 1.32 * 1.2 +
            bodyLineHeight * 0.2
          : bodyLineHeight;
    }

    return Math.min(height, (contentBottom - pdf.marginTop) / 3);
  }

  for (const [index, message] of messages.entries()) {
    const roleLabel = siteRoleLabel(message.role, tabUrl);
    const isUser = message.role === "user";
    const sources = message.sources ?? [];
    const preprocessed = preprocessRawContent(
      normalizeNotes(messageContents[index], sources.length),
    );
    const hasRule = index > 0 && ruleBetweenMessages;
    const content = isUser ? fenceUserContent(preprocessed) : preprocessed;
    const blocks = parseBlocks(content, isUser);
    // When it was sent and by which model, when they're exported
    const details = messageDetails(message);

    // Keep the separator, role label and details with the message's
    // first lines, so none is left alone at the bottom of a page.
    ensureSpace(
      (hasRule ? bodyLineHeight * 1.2 : 0) +
        (showRoleLabels ? headingLineHeight * 1.2 : 0) +
        (details ? metaLineHeight + bodyLineHeight * 0.2 : 0) +
        keepWithNextHeight(blocks, 0),
    );

    if (hasRule) {
      renderHr();
    }

    tocEntries.push({
      label: roleLabel,
      // From the text as written, so a formula in the bookmark
      // title reads as its LaTeX instead of a placeholder token.
      snippet: messageSnippet(stripNotes(preprocessRawContent(message.content))),
      page: doc.getNumberOfPages(),
      top: y - headingLineHeight,
    });

    if (showRoleLabels) {
      // Colored per role (rather than plain black like every
      // other heading in the document) so a message's start is
      // visually obvious even when message content itself has
      // its own "##"-style headings at the same nominal size -
      // otherwise nothing distinguishes where one message ends
      // and the next begins.
      writePlainLine(
        roleLabel,
        headingFontSize,
        headingLineHeight,
        "bold",
        ROLE_COLOR[message.role],
      );
      y += bodyLineHeight * 0.2;
    }

    if (details) {
      writePlainLine(details, metaFontSize, metaLineHeight, "normal", MUTED_COLOR);
      y += bodyLineHeight * 0.2;
    }

    currentSources = sources;

    if (thinkingContents[index]) {
      renderThinking(
        parseBlocks(
          preprocessRawContent(stripNotes(thinkingContents[index])),
        ),
      );
    }

    for (const [blockIndex, block] of blocks.entries()) {
      if (isLeadIn(block)) {
        ensureSpace(keepWithNextHeight(blocks, blockIndex));
      }

      renderBlock(block);
    }

    for (const path of message.imagePaths ?? []) {
      const image = imagesByPath.get(path);

      if (image) {
        await writeImage(image);
      }
    }

    if (sources.length > 0) {
      renderSources(sources);
    }

    y += bodyLineHeight * 0.4;
  }

  /*
   * ---------------------------------------------------------
   * TABLE OF CONTENTS
   * ---------------------------------------------------------
   *
   * Each entry is also a link to the exact spot its message
   * starts.
   */
  let tocPageCount = 0;

  if (pdf.includeTableOfContents) {
    const tocLineHeight = mm(bodyFontSize) * 1.5;
    const tocTitleLineHeight = mm(headingFontSize + 2) * 1.4;
    const perPage = Math.max(
      1,
      Math.floor((contentBottom - pdf.marginTop) / tocLineHeight),
    );
    const perFirstPage = Math.max(
      1,
      Math.floor(
        (contentBottom - pdf.marginTop - headerHeight - tocTitleLineHeight) /
          tocLineHeight,
      ),
    );
    tocPageCount =
      1 + Math.ceil(Math.max(0, tocEntries.length - perFirstPage) / perPage);

    for (let i = 0; i < tocPageCount; i++) {
      doc.insertPage(1);
    }

    doc.setPage(1);
    y = pdf.marginTop;
    drawHeader();

    doc.setFont(SANS_FONT, "bold");
    doc.setFontSize(headingFontSize + 2);
    doc.setTextColor(...TEXT_COLOR);
    doc.text("Table of Contents", pdf.marginLeft, y);
    y += tocTitleLineHeight;

    let currentPage = 1;

    tocEntries.forEach((entry, i) => {
      const page =
        i < perFirstPage ? 1 : 2 + Math.floor((i - perFirstPage) / perPage);

      if (page !== currentPage) {
        doc.setPage(page);
        currentPage = page;
        y = pdf.marginTop;
      }

      doc.setFont(SANS_FONT, "normal");
      doc.setFontSize(bodyFontSize);
      doc.setTextColor(...TEXT_COLOR);

      const label = `${i + 1}. ${entry.label}`;
      const pageLabel = String(entry.page + tocPageCount);
      const pageLabelWidth = doc.getTextWidth(pageLabel);

      doc.text(label, pdf.marginLeft, y);
      doc.text(pageLabel, pageWidth - pdf.marginRight - pageLabelWidth, y);

      const dotsStart = pdf.marginLeft + doc.getTextWidth(label) + 2;
      const dotsEnd = pageWidth - pdf.marginRight - pageLabelWidth - 2;

      if (dotsEnd > dotsStart) {
        doc.setDrawColor(150);
        doc.setLineDashPattern([0.5, 1.5], 0);
        doc.line(dotsStart, y - 1, dotsEnd, y - 1);
        doc.setLineDashPattern([], 0);
      }

      doc.link(
        pdf.marginLeft,
        y - mm(bodyFontSize) * 0.9,
        contentWidth,
        mm(bodyFontSize) * 1.2,
        { pageNumber: entry.page + tocPageCount, top: Math.max(0, entry.top) },
      );

      y += tocLineHeight;
    });
  }

  /*
   * ---------------------------------------------------------
   * BOOKMARKS (PDF outline)
   * ---------------------------------------------------------
   */
  tocEntries.forEach((entry, i) => {
    const title = entry.snippet
      ? `${i + 1}. ${entry.label}: ${entry.snippet}`
      : `${i + 1}. ${entry.label}`;
    doc.outline.add(null, title, { pageNumber: entry.page + tocPageCount });
  });

  /*
   * ---------------------------------------------------------
   * FOOTER (page numbers + user info)
   * ---------------------------------------------------------
   */
  const totalPages = doc.getNumberOfPages();

  if (pdf.includePageNumbers || pdf.includeUserInfo) {
    for (let page = 1; page <= totalPages; page++) {
      doc.setPage(page);
      doc.setFont(SANS_FONT, "normal");
      doc.setFontSize(9);
      doc.setTextColor(120);

      const footerY = pageHeight - pdf.marginBottom + mm(9) * 1.4;

      if (pdf.includeUserInfo && pdf.userInfoText.trim() !== "") {
        // One line, clear of the page number.
        const [firstLine = []] = wrapWords(
          tokenizeRuns([{ text: pdf.userInfoText }], 9),
          contentWidth - 20,
          9,
        );
        const saved = { y, textColor };

        y = footerY;
        textColor = [120, 120, 120];
        drawWrappedLines([firstLine], pdf.marginLeft, 9, 0, false);
        ({ y, textColor } = saved);
        doc.setFont(SANS_FONT, "normal");
        doc.setFontSize(9);
        doc.setTextColor(120);
      }

      if (pdf.includePageNumbers) {
        const label = `${page} / ${totalPages}`;
        const labelWidth = doc.getTextWidth(label);
        doc.text(label, pageWidth - pdf.marginRight - labelWidth, footerY);
      }

      doc.setTextColor(0);
    }
  }

  return doc.output("blob");
}

/*
 * Converts arbitrary browser-decodable image bytes (webp, png,
 * jpeg, gif, ...) to a PNG data URL via canvas, which is the
 * one format jsPDF's addImage() can always be trusted to accept.
 * Returns null on any failure so the caller can fall back to a
 * text placeholder instead of aborting the whole export.
 */
async function toEmbeddablePng(
  base64: string,
  mimeType: string,
): Promise<{ dataUrl: string; width: number; height: number } | null> {
  try {
    const image = new Image();
    const sourceUrl = `data:${mimeType};base64,${base64}`;

    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("image decode failed"));
      image.src = sourceUrl;
    });

    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;

    const ctx = canvas.getContext("2d");

    if (!ctx || canvas.width === 0 || canvas.height === 0) {
      return null;
    }

    ctx.drawImage(image, 0, 0);

    return {
      dataUrl: canvas.toDataURL("image/png"),
      width: image.naturalWidth,
      height: image.naturalHeight,
    };
  } catch {
    return null;
  }
}
