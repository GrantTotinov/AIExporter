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
 * plain, pre-positioned text - so this module includes a small
 * markdown parser (parseBlocks/parseInline below) that turns
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
import { getChatSite, stripChatSiteSuffix } from "./chat-sites.ts";
import { extractMath, MATH_CLOSE, MATH_OPEN, type MathSpan } from "./math.ts";
import type { RenderedMath } from "./math-render.ts";
import { drawMath, type MathTextStyle } from "./svg-pdf.ts";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  order: number;
  imagePaths?: string[];
}

interface ExportImageFile {
  path: string;
  mimeType: string;
  base64: string;
  sizeBytes: number;
}

const PT_TO_MM = 25.4 / 72;

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

/*
 * ---------------------------------------------------------
 * TEXT NORMALIZATION
 * ---------------------------------------------------------
 *
 * Decodes HTML entities (&amp;, &#x20;, ...) via a detached
 * <textarea> - the standard safe trick, since a textarea's
 * innerHTML is always treated as literal text, never parsed
 * into child elements or executed - then unescapes markdown's
 * own backslash escapes (\& -> &). Glyph coverage (emoji etc.)
 * is handled later, per font, by fitToFont().
 */
let entityDecoder: HTMLTextAreaElement | undefined;

function decodeHtmlEntities(text: string): string {
  entityDecoder ??= document.createElement("textarea");
  entityDecoder.innerHTML = text;
  return entityDecoder.value;
}

const MARKDOWN_ESCAPE_RE = /\\([\\`*_{}[\]()#+.!&>~|-])/g;
/*
 * ChatGPT's web-search citation markers (e.g. "citeturn0search0",
 * sometimes chained as "citeturn0search0turn1news2") are
 * internal reference tokens meant to be turned into footnotes/
 * links by ChatGPT's own UI - if the exported Markdown still has
 * them raw, they're just noise to a PDF reader.
 */
const CITATION_ARTIFACT_RE = /[ \t]*cite(?:turn\d+(?:search|news)\d+)+/gi;
/*
 * ChatGPT's own copy/export path leaves raw Private-Use-Area
 * tokens in the text for url/cite/filecite annotations
 * (U+E200 .. U+E202 wrapping the payload). These never render
 * as anything meaningful in a PDF - either resolve the url
 * token back into a normal markdown link, or drop the
 * citation/filecite token (and any other bracketed PUA token)
 * entirely. Built from character codes rather than embedding the
 * raw Private Use Area characters (or an escape for one) directly
 * in this source file, since those are invisible in most editors
 * and terminals and easy to lose or mismatch during an edit.
 */
const PUA_OPEN = String.fromCharCode(0xe200);
const PUA_SEP = String.fromCharCode(0xe202);
const PUA_CLOSE = String.fromCharCode(0xe201);
const PUA_URL_TOKEN_RE = new RegExp(
  `${PUA_OPEN}url${PUA_SEP}([^${PUA_SEP}]*)${PUA_SEP}([^${PUA_CLOSE}]*)${PUA_CLOSE}`,
  "g",
);
const PUA_CITE_TOKEN_RE = new RegExp(
  `[ \\t]*${PUA_OPEN}(?:cite|filecite)${PUA_SEP}[^${PUA_CLOSE}]*${PUA_CLOSE}`,
  "g",
);
const PUA_TOKEN_FALLBACK_RE = new RegExp(
  `[ \\t]*${PUA_OPEN}[^${PUA_CLOSE}]*${PUA_CLOSE}`,
  "g",
);

/*
 * A ":::writing{variant=\"chat_message\" id=\"...\"}...:::"
 * container (seen in some exported chat pastes) has no meaning to
 * our Markdown parser and would otherwise print as raw directive
 * syntax. Converted to a blockquote - with hard line breaks, since
 * it holds a drafted message whose lines are meaningful - so it
 * still reads as quoted message content instead of noise.
 */
const WRITING_BLOCK_RE = /:::writing\{[^}]*\}[ \t]*\n([\s\S]*?)\n:::/g;

/*
 * A link whose label or title spans lines - typical of GitHub
 * pastes, where a commit link's label and its "title" both carry
 * the commit message's line breaks - can't be matched once the
 * text is split into lines, so it printed raw. Such links are
 * folded onto one line here, and every link's title (never shown
 * in a PDF, and previously leaking into the URL itself) is
 * dropped. One level of parentheses is allowed inside the URL,
 * for links like .../wiki/Curve_(disambiguation).
 */
const LINK_WITH_TITLE_RE =
  /(!?)\[((?:[^[\]\n]|\n(?![ \t]*\n)){1,500})\]\(\s*<?((?:[^()\s<>]|\([^()\s]*\))+)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?\s*\)/g;

const FENCED_CODE_RE = /(^[ \t]*```[^\n]*\n[\s\S]*?^[ \t]*```[ \t]*$)/m;

function mapOutsideFences(
  markdown: string,
  transform: (text: string) => string,
): string {
  return markdown
    .split(FENCED_CODE_RE)
    .map((part, index) => (index % 2 === 1 ? part : transform(part)))
    .join("");
}

/*
 * Runs once per message, on the raw Markdown, before block/inline
 * parsing - never inside normalizeText(), which only ever sees
 * small, already-extracted fragments (a link label, a bold span,
 * ...). A PUA url token has to become real "[label](url)" syntax
 * before parseInline's INLINE_TOKEN_RE scans the text, or the
 * freshly-built link syntax just prints as literal brackets
 * instead of becoming a clickable link.
 */
export function preprocessRawContent(raw: string): string {
  let text = raw.replace(/\r\n?/g, "\n");
  text = text.replace(PUA_URL_TOKEN_RE, "[$1]($2)");
  text = text.replace(PUA_CITE_TOKEN_RE, "");
  text = text.replace(PUA_TOKEN_FALLBACK_RE, "");
  text = text.replace(WRITING_BLOCK_RE, (_match, body: string) =>
    body
      .split("\n")
      .map((line) => (line.trim() === "" ? ">" : `> ${line}  `))
      .join("\n"),
  );

  return mapOutsideFences(text, (segment) =>
    segment.replace(
      LINK_WITH_TITLE_RE,
      (_match, bang: string, label: string, url: string) =>
        `${bang}[${label.replace(/[ \t]*\n[ \t]*/g, " ")}](${url})`,
    ),
  );
}

function normalizeText(raw: string): string {
  let text = decodeHtmlEntities(raw);
  text = text.replace(MARKDOWN_ESCAPE_RE, "$1");
  text = text.replace(CITATION_ARTIFACT_RE, "");
  text = text.replace(/[ \t]{2,}/g, " ");
  return text;
}

/*
 * ---------------------------------------------------------
 * INLINE PARSING (bold / italic / inline code / links)
 * ---------------------------------------------------------
 *
 * Images are dropped entirely at this level - a downloaded
 * image is embedded as a real image separately (see
 * writeImage below); an un-downloaded one shouldn't leave
 * leftover "image" noise in the text.
 *
 * Link labels and bold/italic spans are parsed recursively, so
 * [`3159fb8`](url) is a code-styled link and **[a](url)** a bold
 * link, rather than printing the inner syntax literally. Emphasis
 * markers must hug their text (CommonMark's flanking rule), so
 * "3 * 4 * 5" stays literal instead of italicizing " 4 ".
 */
interface InlineRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: string;
  /* Index of a formula placeholder (see extractMath) - text is "". */
  math?: number;
}

type InlineStyle = Omit<InlineRun, "text">;

const INLINE_TOKEN_RE = new RegExp(
  `${MATH_OPEN}([0-9]+)${MATH_CLOSE}|` +
    /!\[[^\]]*\]\((?:[^()\s]|\([^()\s]*\))*\)|\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))+)\)|\*\*\*(?=\S)([^*]+?)(?<=\S)\*\*\*|\*\*(?=\S)([^*]+?)(?<=\S)\*\*|`([^`]+)`|\*(?=\S)([^*]+?)(?<=\S)\*/.source,
  "g",
);

export function parseInline(raw: string, style: InlineStyle = {}): InlineRun[] {
  const runs: InlineRun[] = [];
  let lastIndex = 0;

  function pushText(text: string, extra: InlineStyle = {}): void {
    const normalized = normalizeText(text);

    if (normalized !== "") {
      runs.push({ ...style, ...extra, text: normalized });
    }
  }

  for (const match of raw.matchAll(INLINE_TOKEN_RE)) {
    const index = match.index ?? 0;

    if (index > lastIndex) {
      pushText(raw.slice(lastIndex, index));
    }

    const [
      ,
      mathIndex,
      linkText,
      linkUrl,
      boldItalicText,
      boldText,
      codeText,
      italicText,
    ] = match;

    if (mathIndex !== undefined) {
      runs.push({ ...style, text: "", math: Number(mathIndex) });
    } else if (linkText !== undefined) {
      runs.push(
        ...parseInline(linkText, { ...style, link: normalizeText(linkUrl) }),
      );
    } else if (boldItalicText !== undefined) {
      runs.push(
        ...parseInline(boldItalicText, { ...style, bold: true, italic: true }),
      );
    } else if (boldText !== undefined) {
      runs.push(...parseInline(boldText, { ...style, bold: true }));
    } else if (codeText !== undefined) {
      pushText(codeText, { code: true });
    } else if (italicText !== undefined) {
      runs.push(...parseInline(italicText, { ...style, italic: true }));
    }

    lastIndex = index + match[0].length;
  }

  if (lastIndex < raw.length) {
    pushText(raw.slice(lastIndex));
  }

  return runs;
}

/*
 * ---------------------------------------------------------
 * BLOCK PARSING
 * ---------------------------------------------------------
 */
type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "code"; code: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "table"; header: string[]; rows: string[][] }
  | { type: "blockquote"; text: string }
  | { type: "hr" };

function isTableSeparatorLine(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}

function splitTableRow(line: string): string[] {
  let trimmed = line.trim();

  if (trimmed.startsWith("|")) {
    trimmed = trimmed.slice(1);
  }

  if (trimmed.endsWith("|")) {
    trimmed = trimmed.slice(0, -1);
  }

  return trimmed
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

/*
 * `hardBreaks` mirrors the "breaks: true" option chat UIs (and
 * markdown renderers like marked.js) apply to user-authored text:
 * every single line break inside a paragraph becomes a real line
 * break instead of being soft-wrapped/reflowed into one sentence.
 * Assistant output is authored Markdown, where a lone newline is
 * just source wrapping and blank lines mark real paragraphs, so it
 * keeps the default (false) reflow behavior; a user message is
 * typically pasted, not composed, and its line breaks are always
 * meaningful (a git log entry, a status list, ...).
 */
export function parseBlocks(markdown: string, hardBreaks = false): Block[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    const fenceMatch = line.match(/^\s*(`{3,})/);

    if (fenceMatch) {
      // Only a fence at least as long closes it, so a ```` block
      // can hold ``` fences of its own.
      const closingFence = new RegExp(
        `^\\s*\`{${fenceMatch[1].length},}\\s*$`,
      );
      const codeLines: string[] = [];
      i++;

      while (i < lines.length && !closingFence.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }

      i++;
      blocks.push({ type: "code", code: codeLines.join("\n") });
      continue;
    }

    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      isTableSeparatorLine(lines[i + 1])
    ) {
      const header = splitTableRow(line);
      i += 2;
      const rows: string[][] = [];

      while (
        i < lines.length &&
        lines[i].includes("|") &&
        lines[i].trim() !== ""
      ) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }

      blocks.push({ type: "table", header, rows });
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);

    if (headingMatch) {
      blocks.push({
        type: "heading",
        level: headingMatch[1].length,
        text: headingMatch[2],
      });
      i++;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = [];

      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }

      blocks.push({
        type: "blockquote",
        text: joinLines(quoteLines, hardBreaks),
      });
      continue;
    }

    const listItemMatch = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);

    if (listItemMatch) {
      const ordered = /^\d+\.$/.test(listItemMatch[2]);
      const items: string[] = [];

      while (i < lines.length) {
        const itemMatch = lines[i].match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);

        if (!itemMatch) {
          if (
            lines[i].trim() !== "" &&
            /^\s+/.test(lines[i]) &&
            items.length > 0
          ) {
            items[items.length - 1] += ` ${lines[i].trim()}`;
            i++;
            continue;
          }

          break;
        }

        items.push(itemMatch[3]);
        i++;
      }

      blocks.push({ type: "list", ordered, items });
      continue;
    }

    const paraLines: string[] = [];

    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^\s*```/.test(lines[i]) &&
      !/^#{1,6}\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i]) &&
      !/^(\s*)([-*+]|\d+\.)\s+/.test(lines[i]) &&
      !(
        lines[i].includes("|") &&
        i + 1 < lines.length &&
        isTableSeparatorLine(lines[i + 1])
      )
    ) {
      paraLines.push(lines[i]);
      i++;
    }

    blocks.push({ type: "paragraph", text: joinLines(paraLines, hardBreaks) });
  }

  return blocks;
}

/*
 * Joins a paragraph's (or blockquote's) source lines. Markdown's
 * hard line break - a line ending in two-or-more spaces or a
 * backslash - forces a real break instead of soft-wrapping into
 * the next line; without it, six separately-authored status lines
 * collapse into one run-on sentence. `hardBreaks` makes every line
 * break hard. Breaks are encoded as "\n" and consumed by
 * renderParagraph/renderBlockquote.
 */
function joinLines(lines: string[], hardBreaks: boolean): string {
  return lines
    .map((line, index) => {
      if (index === lines.length - 1) {
        return line.replace(/ {2,}$/, "");
      }

      if (hardBreaks || / {2,}$/.test(line) || /\\$/.test(line)) {
        return `${line.replace(/ {2,}$/, "").replace(/\\$/, "")}\n`;
      }

      return `${line} `;
    })
    .join("");
}

/*
 * A user message is pasted transcript input, not authored
 * Markdown: a git log, a terminal session or raw code is common.
 * Parsed as-is, their incidental "*"/"-"/">" get misread as lists
 * or quotes, and their indentation and column alignment are lost
 * in proportional type. So pasted output/code is detected per
 * paragraph (a run of non-blank lines) and wrapped in a synthetic
 * ``` fence, which renders it verbatim in monospace. Deciding per
 * paragraph rather than per line keeps a git graph's filler lines
 * ("|\", "|/|") in the same block instead of splitting it.
 *
 * A paragraph is code when it contains a line only a terminal or
 * git could produce (a prompt, a commit hash, a diff header), or
 * when most of its lines look like source code. A paragraph that
 * is only probably code - mostly indented, like terminal output or
 * a commit message body - joins a code paragraph it touches, so
 * blank lines inside pasted code or output don't split the block.
 * A leading "Here's the log:" line and a trailing question stay
 * outside the fence.
 */
const TERMINAL_LINE_RES = [
  /^\s*PS [A-Za-z]:\\[^>]*>/,
  /^\s*[A-Za-z]:\\[^<>|"]*>/,
  /^\s*[\w.-]+@[\w.-]+:\S*\s?[$#]\s/,
  /^\s*\$ \S/,
  /^[\s|\\/]*\*[\s|\\/]*(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/,
  /^(?=[0-9a-f]*\d)[0-9a-f]{7,40} \S/,
  /^[\s|\\/*]*commit [0-9a-f]{7,40}\b/,
  /^diff --git /,
  /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/,
];
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+\.)\s/;
const CODE_KEYWORD_RE =
  /^(?:public|private|protected|internal|static|class|interface|namespace|using|import|export|function|def|func|fn|return|var|let|const|if|else|for|foreach|while|switch|case|try|catch|throw|await|async)\b/;

type ParagraphKind = "code" | "maybe" | "prose";

function isTerminalLine(line: string): boolean {
  return TERMINAL_LINE_RES.some((re) => re.test(line));
}

function isCodeLine(line: string): boolean {
  const trimmed = line.trim();

  if (/^[-+](?: {2,}|\t)\S/.test(line)) {
    return true;
  }

  if (LIST_ITEM_RE.test(line)) {
    return false;
  }

  return (
    /^(?:\/\/|\/\*|\*\/|<!--|#!\/)/.test(trimmed) ||
    /[;{]$/.test(trimmed) ||
    /^[}\])]+[;,)]*$/.test(trimmed) ||
    (/^(?: {4,}|\t)/.test(line) && /[(){}[\];=<>]/.test(trimmed)) ||
    (CODE_KEYWORD_RE.test(trimmed) && /[(){};=]/.test(trimmed))
  );
}

function classifyParagraph(lines: string[]): ParagraphKind {
  if (lines.some((line) => /^\s*```/.test(line))) {
    return "prose";
  }

  if (lines.some(isTerminalLine)) {
    return "code";
  }

  const codeShare = lines.filter(isCodeLine).length / lines.length;

  if (lines.length >= 2 && codeShare >= 0.6) {
    return "code";
  }

  if (
    /^(?:#{1,6}\s|>)/.test(lines[0].trimStart()) ||
    LIST_ITEM_RE.test(lines[0])
  ) {
    return "prose";
  }

  const indentedShare =
    lines.filter(
      (line) => /^(?: {2,}|\t)\S/.test(line) && !LIST_ITEM_RE.test(line),
    ).length / lines.length;

  return codeShare >= 0.5 || indentedShare >= 0.5 ? "maybe" : "prose";
}

function isPlainLine(line: string): boolean {
  return !/^\s/.test(line) && !isTerminalLine(line) && !isCodeLine(line);
}

function fenceCodeParagraphs(text: string): string {
  const lines = text.split("\n");
  const paragraphs: { start: number; end: number; kind: ParagraphKind }[] = [];

  for (let i = 0; i < lines.length;) {
    if (lines[i].trim() === "") {
      i++;
      continue;
    }

    const start = i;

    while (i < lines.length && lines[i].trim() !== "") {
      i++;
    }

    paragraphs.push({
      start,
      end: i,
      kind: classifyParagraph(lines.slice(start, i)),
    });
  }

  for (let changed = true; changed;) {
    changed = false;

    paragraphs.forEach((paragraph, index) => {
      if (
        paragraph.kind === "maybe" &&
        (paragraphs[index - 1]?.kind === "code" ||
          paragraphs[index + 1]?.kind === "code")
      ) {
        paragraph.kind = "code";
        changed = true;
      }
    });
  }

  const out: string[] = [];
  let cursor = 0;

  for (let index = 0; index < paragraphs.length; index++) {
    if (paragraphs[index].kind !== "code") {
      continue;
    }

    let last = index;

    while (paragraphs[last + 1]?.kind === "code") {
      last++;
    }

    let start = paragraphs[index].start;
    let end = paragraphs[last].end;

    while (
      start < end - 1 &&
      isPlainLine(lines[start]) &&
      /:\s*$/.test(lines[start])
    ) {
      start++;
    }

    while (
      end - 1 > start &&
      isPlainLine(lines[end - 1]) &&
      /\?\s*$/.test(lines[end - 1])
    ) {
      end--;
    }

    out.push(
      ...lines.slice(cursor, start),
      "```",
      ...lines.slice(start, end),
      "```",
    );
    cursor = end;
    index = last;
  }

  out.push(...lines.slice(cursor));
  return out.join("\n");
}

export function fenceUserContent(markdown: string): string {
  return mapOutsideFences(markdown, fenceCodeParagraphs);
}

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
  messages: Message[],
  images: ExportImageFile[],
  settings: Settings,
  tabTitle: string | undefined,
  tabUrl?: string,
): Promise<Blob> {
  const pdf: PdfSettings = settings.pdf;

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

  const documentTitle = stripChatSiteSuffix(tabTitle ?? "");

  if (documentTitle) {
    doc.setProperties({ title: documentTitle });
  }

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const contentWidth = pageWidth - pdf.marginLeft - pdf.marginRight;
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
  let renderedFormulas: (RenderedMath | null)[] = [];

  function mathTextFont(style: MathTextStyle): [string, FontStyle] {
    if (style.monospace) {
      return [MONO_FONT, style.bold ? "bold" : "normal"];
    }

    return runFont(style);
  }

  // Text inside formulas is measured in the font it's drawn in.
  function measureMathText(text: string, style: MathTextStyle): number {
    const [family, fontStyle] = mathTextFont(style);
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

  function runFont(run: InlineStyle): [string, FontStyle] {
    if (run.code) {
      return [MONO_FONT, run.bold ? "bold" : "normal"];
    }

    if (run.bold && run.italic) {
      return [SANS_FONT, "bolditalic"];
    }

    if (run.bold) {
      return [SANS_FONT, "bold"];
    }

    return [SANS_FONT, run.italic ? "italic" : "normal"];
  }

  function setRunFont(run: InlineStyle, fontSize: number): void {
    doc.setFont(...runFont(run));
    doc.setFontSize(fontSize);
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
    run: InlineRun;
    width: number;
    math?: MathLayout;
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

  function tokenizeRuns(runs: InlineRun[], fontSize: number): Word[] {
    const words: Word[] = [];

    for (const original of runs) {
      let run = original;

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

      // Collapse the double spaces a dropped emoji leaves behind.
      const text = fit(run.text, ...runFont(run)).replace(/ {2,}/g, " ");
      setRunFont(run, fontSize);

      for (const part of text.split(/(\s+)/)) {
        if (part !== "") {
          words.push({ text: part, run, width: doc.getTextWidth(part) });
        }
      }
    }

    return words;
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
        : word.width > maxWidth
          ? splitOversizedWord(word, maxWidth, fontSize)
          : [word];

      for (const part of parts) {
        if (currentWidth + part.width > maxWidth && current.length > 0) {
          dropTrailingSpace();
          lines.push(current);
          current = [];
          currentWidth = 0;
        }

        current.push(part);
        currentWidth += part.width;
      }
    }

    dropTrailingSpace();

    if (current.length > 0 || lines.length === 0) {
      lines.push(current);
    }

    return lines;
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
    const [family, fontStyle] = mathTextFont(style);

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
          doc.setDrawColor(...LINK_COLOR);
          doc.line(starts[first], y + 0.7, starts[first] + width, y + 0.7);
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
        (word) => (word.math ? undefined : word.run),
        (first, last, run) => {
          setRunFont(run, fontSize);
          doc.setTextColor(
            ...(run.link
              ? LINK_COLOR
              : run.code
                ? CODE_TEXT_COLOR
                : TEXT_COLOR),
          );
          doc.text(
            line
              .slice(first, last + 1)
              .map((word) => word.text)
              .join(""),
            starts[first],
            y,
          );
        },
      );

      line.forEach((word, i) => {
        if (word.math) {
          drawMath(doc, word.math.rendered, starts[i], y, word.math.unit, {
            color: word.run.link ? LINK_COLOR : TEXT_COLOR,
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

  function writePlainLine(
    text: string,
    fontSize: number,
    lineHeight: number,
    style: "normal" | "bold" | "italic" = "normal",
    color: Rgb = TEXT_COLOR,
  ): void {
    doc.setFont(SANS_FONT, style);
    doc.setFontSize(fontSize);
    doc.setTextColor(...color);

    const lines: string[] = doc.splitTextToSize(
      fit(text, SANS_FONT, style),
      contentWidth,
    );

    for (const line of lines) {
      ensureSpace(lineHeight);
      doc.text(line, pdf.marginLeft, y);
      y += lineHeight;
    }

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
      pdf.marginLeft,
      contentWidth,
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

      renderInlineParagraph(
        parseInline(segment, style),
        bodyFontSize,
        bodyLineHeight,
        pdf.marginLeft + indent,
        contentWidth - indent,
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
      const prefix = block.ordered ? `${index + 1}.` : "•";
      const lines = wrapWords(
        tokenizeRuns(parseInline(itemText), bodyFontSize),
        contentWidth - indent,
        bodyFontSize,
      );
      // The marker sits on the first line's baseline, which a tall
      // formula on that line pushes down.
      const { above } = lineExtras(lines[0], bodyLineHeight);

      ensureSpace(lineBoxHeight(lines[0], bodyLineHeight));
      doc.setFont(SANS_FONT, "normal");
      doc.setFontSize(bodyFontSize);
      doc.setTextColor(20, 20, 20);
      doc.text(prefix, pdf.marginLeft, y + above);
      drawWrappedLines(
        lines,
        pdf.marginLeft + indent,
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
   */
  function renderCodeBlock(code: string): void {
    doc.setFont(MONO_FONT, "normal");
    doc.setFontSize(codeFontSize);

    const codeInnerWidth = contentWidth - 4;
    const charWidth = doc.getTextWidth("M") || 1;
    const maxChars = Math.max(1, Math.floor(codeInnerWidth / charWidth));
    // One column is reserved for the wrap-continuation marker
    // below, so a hard-wrapped line never grows back past
    // maxChars once the marker is appended.
    const wrapMaxChars = Math.max(1, maxChars - 1);
    const WRAP_MARKER = "↪";

    for (const rawLine of code.split("\n")) {
      const line = fit(expandTabs(rawLine), MONO_FONT, "normal");
      const segments =
        line.length === 0
          ? [""]
          : (line.match(new RegExp(`.{1,${wrapMaxChars}}`, "g")) ?? [""]);

      segments.forEach((segment, segmentIndex) => {
        const isHardWrap = segmentIndex < segments.length - 1;
        const displayText = isHardWrap ? `${segment}${WRAP_MARKER}` : segment;

        ensureSpace(codeLineHeight);
        doc.setFillColor(245, 245, 245);
        doc.rect(
          pdf.marginLeft,
          y - codeLineHeight * 0.72,
          contentWidth,
          codeLineHeight,
          "F",
        );
        doc.setTextColor(...CODE_TEXT_COLOR);
        doc.text(displayText, pdf.marginLeft + 2, y);
        y += codeLineHeight;
      });
    }

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
    doc.line(pdf.marginLeft, ruleY, pageWidth - pdf.marginRight, ruleY);
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
    const colWidth = contentWidth / colCount;
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
            pdf.marginLeft,
            contentWidth,
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
        doc.rect(pdf.marginLeft, rowTop, contentWidth, row.height, "F");
      }

      doc.setDrawColor(200);

      for (let col = 0; col < colCount; col++) {
        const cellX = pdf.marginLeft + col * colWidth;
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
        renderCodeBlock(block.code);
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
    doc.addImage(
      converted.dataUrl,
      "PNG",
      pdf.marginLeft,
      y,
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
    return doc.splitTextToSize(fit(text, SANS_FONT, style), contentWidth);
  }

  const hasHeader = Boolean(
    documentTitle || tabUrl || settings.includeTimestamp,
  );
  const headerTitleLines = documentTitle
    ? splitLines(documentTitle, titleFontSize, "bold")
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

    doc.setFont(SANS_FONT, "bold");
    doc.setFontSize(titleFontSize);
    doc.setTextColor(...TEXT_COLOR);

    for (const line of headerTitleLines) {
      doc.text(line, pdf.marginLeft, y);
      y += titleLineHeight;
    }

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

    doc.setTextColor(...MUTED_COLOR);
    doc.text(fit(headerMeta, SANS_FONT, "normal"), pdf.marginLeft, y);

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
    const roleLabel = message.role === "user" ? "User" : "Assistant";
    const isUser = message.role === "user";
    const preprocessed = preprocessRawContent(messageContents[index]);
    const hasRule = index > 0 && ruleBetweenMessages;
    const content = isUser ? fenceUserContent(preprocessed) : preprocessed;
    const blocks = parseBlocks(content, isUser);

    // Keep the separator and role label with the message's first
    // lines, so neither is left alone at the bottom of a page.
    ensureSpace(
      (hasRule ? bodyLineHeight * 1.2 : 0) +
        (showRoleLabels ? headingLineHeight * 1.2 : 0) +
        keepWithNextHeight(blocks, 0),
    );

    if (hasRule) {
      renderHr();
    }

    tocEntries.push({
      label: roleLabel,
      // From the text as written, so a formula in the bookmark
      // title reads as its LaTeX instead of a placeholder token.
      snippet: messageSnippet(preprocessRawContent(message.content)),
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
        doc.text(
          fit(pdf.userInfoText, SANS_FONT, "normal"),
          pdf.marginLeft,
          footerY,
        );
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
