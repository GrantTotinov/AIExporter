/*
 * =========================================================
 * AI Exporter - markdown-parse.ts
 * =========================================================
 *
 * The small Markdown parser every rich export format shares -
 * PDF (pdf-export.ts), HTML (html-export.ts), Word
 * (docx-export.ts) and Notion (notion-blocks.ts): it cleans up a
 * message's raw Markdown (preprocessRawContent), fences pasted
 * code in user messages (fenceUserContent), and splits the text
 * into blocks (parseBlocks) and styled inline runs (parseInline).
 * Needs a DOM, for decoding HTML entities.
 */
import { MATH_CLOSE, MATH_OPEN } from "./math.ts";
import { NOTE_CLOSE, NOTE_OPEN, stripNotes } from "./source-notes.ts";

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
  let text = stripNotes(decodeHtmlEntities(raw));
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
export interface InlineRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: string;
  /* Index of a formula placeholder (see extractMath) - text is "". */
  math?: number;
  /*
   * A note citing these of the message's sources, counted from 1
   * (see source-notes.ts) - text is "".
   */
  notes?: number[];
  /*
   * Set by the renderer, not the parser: a right-to-left word the
   * run's own font can't draw is set upright and/or in the
   * proportional font instead (see runForText).
   */
  upright?: boolean;
  sans?: boolean;
  /*
   * Also set by the renderer: a note's number, drawn small and
   * raised; and text in the muted color (a source's site name).
   */
  sup?: boolean;
  muted?: boolean;
}

export type InlineStyle = Omit<InlineRun, "text">;

const INLINE_TOKEN_RE = new RegExp(
  `${MATH_OPEN}([0-9]+)${MATH_CLOSE}|` +
    `${NOTE_OPEN}([0-9,]{0,200})${NOTE_CLOSE}|` +
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
      notePayload,
      linkText,
      linkUrl,
      boldItalicText,
      boldText,
      codeText,
      italicText,
    ] = match;

    if (mathIndex !== undefined) {
      runs.push({ ...style, text: "", math: Number(mathIndex) });
    } else if (notePayload !== undefined) {
      const notes = notePayload
        .split(",")
        .map(Number)
        .filter((number) => Number.isInteger(number) && number >= 1);

      if (notes.length > 0) {
        runs.push({ ...style, text: "", notes });
      }
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
export type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "code"; code: string; lang?: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "table"; header: string[]; rows: string[][] }
  | { type: "blockquote"; text: string }
  | { type: "hr" };

export function isTableSeparatorLine(line: string): boolean {
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
      // The info string after the opening fence (```python) names
      // the language the block is highlighted as.
      const lang = line.trim().slice(fenceMatch[1].length).trim();
      blocks.push({
        type: "code",
        // A citation note never shows inside code.
        code: stripNotes(codeLines.join("\n")),
        ...(lang ? { lang } : {}),
      });
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
