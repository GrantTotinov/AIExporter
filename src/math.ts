/*
 * =========================================================
 * AI Exporter - math.ts
 * =========================================================
 *
 * Finds the math formulas (LaTeX) in a chat reply. Each site
 * marks math its own way, and only these delimiters are math to
 * its own renderer:
 *
 *   ChatGPT  \( inline \)  and  \[ display \]
 *   Claude   $$ math $$ - inline when it shares its line with
 *            other text, display when it stands on its own lines
 *   Gemini   $ inline $  and  $$ display $$
 *
 * A lone "$" is only math on Gemini; on ChatGPT and Claude it is
 * just a dollar sign ("costs $5 and $10"). Even on Gemini a "$"
 * only opens math when the next character isn't a space, and only
 * closes it when the previous one isn't and no digit follows - the
 * rule Pandoc and Obsidian use - so prices stay prices. Nothing
 * inside code (fenced blocks or `inline code`) is ever math.
 *
 * Markdown exports get every formula in the $...$ / $$...$$ form
 * Obsidian, GitHub, Typora and VS Code all render (ChatGPT's \( \)
 * and \[ \] show up there as plain brackets, since "\[" is just an
 * escaped "["). PDF exports swap each formula for a placeholder
 * token that the PDF renderer draws as typeset math.
 */
import type { ChatSite } from "./chat-sites.ts";

export interface MathSpan {
  tex: string;
  display: boolean;
}

/*
 * One piece of a message: plain Markdown, or a formula along with
 * the line prefix (indentation, "> ") of the line it starts on, so
 * a display formula moved onto lines of its own stays inside the
 * list item or quote it belonged to.
 */
type Piece = string | (MathSpan & { prefix: string });

const FENCE_RE = /^[ \t]*(`{3,}|~{3,})/;

/*
 * The text between two delimiters may wrap across lines but never
 * across a blank line: a stray "$$" or "\[" must not swallow the
 * rest of the reply.
 */
const BODY = String.raw`((?:(?!\n[ \t>]*\n)[\s\S])+?)`;

/*
 * Group 1 is a whole `code span` (group 2 its backtick run), so
 * code is skipped before any delimiter inside it is looked at.
 * Groups 3-6 are the formula bodies.
 */
const CODE_SPAN = String.raw`(\`+)[\s\S]*?(?<!\`)\2(?!\`)`;
const DISPLAY_DOLLAR = String.raw`(?<!\\)\$\$${BODY}(?<!\\)\$\$`;
const DISPLAY_BRACKET = String.raw`\\\[${BODY}\\\]`;
const INLINE_PAREN = String.raw`\\\(${BODY}\\\)`;
const INLINE_DOLLAR = String.raw`(?<![\\$])\$(?![\s$])((?:\\\$|[^$\n])+?)(?<![\s\\])\$(?![\d$])`;

const MATH_RE = new RegExp(
  [`(${CODE_SPAN})`, DISPLAY_DOLLAR, DISPLAY_BRACKET, INLINE_PAREN].join("|"),
  "g",
);
const MATH_WITH_DOLLAR_RE = new RegExp(
  [
    `(${CODE_SPAN})`,
    DISPLAY_DOLLAR,
    DISPLAY_BRACKET,
    INLINE_PAREN,
    INLINE_DOLLAR,
  ].join("|"),
  "g",
);

/*
 * Gemini, and the Chinese sites' models, write inline formulas
 * between single dollar signs.
 */
const SINGLE_DOLLAR_SITES: readonly (ChatSite | null)[] = [
  "gemini",
  "kimi",
  "doubao",
  "qwen",
  "qianwen",
  "yuanbao",
  "zai",
];

export function usesSingleDollarMath(site: ChatSite | null): boolean {
  return SINGLE_DOLLAR_SITES.includes(site);
}

function linePrefix(line: string): string {
  return line.match(/^[ \t]*(?:>[ \t]?)*[ \t]*/)?.[0] ?? "";
}

function cleanTex(tex: string, prefix: string): string {
  const quoted = prefix.includes(">");

  return tex
    .split("\n")
    .map((line) => (quoted ? line.replace(/^[ \t]*(?:>[ \t]?)*/, "") : line))
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("\n");
}

function splitProse(text: string, singleDollar: boolean): Piece[] {
  const pieces: Piece[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(
    singleDollar ? MATH_WITH_DOLLAR_RE : MATH_RE,
  )) {
    const [whole, codeSpan, , displayDollar, displayBracket, inlineParen] =
      match;

    if (codeSpan !== undefined) {
      continue;
    }

    const index = match.index ?? 0;
    const before = text.slice(text.lastIndexOf("\n", index - 1) + 1, index);
    const prefix = linePrefix(before);
    const after = text.slice(index + whole.length).match(/^[^\n]*/)?.[0] ?? "";
    const midLine =
      before.slice(prefix.length).trim() !== "" || after.trim() !== "";
    const tex = cleanTex(
      displayDollar ?? displayBracket ?? inlineParen ?? match[6] ?? "",
      prefix,
    );

    if (tex === "") {
      continue;
    }

    // "$$...$$" in the middle of a sentence is inline math (that's
    // how Claude and Gemini show it); "\[...\]" is always display.
    const display =
      displayBracket !== undefined || (displayDollar !== undefined && !midLine);

    pieces.push(text.slice(lastIndex, index), { tex, display, prefix });
    lastIndex = index + whole.length;
  }

  pieces.push(text.slice(lastIndex));
  return pieces;
}

/*
 * Splits a message into Markdown and formulas. Fenced code blocks
 * pass through untouched, so a "$" in a shell script never starts
 * math.
 */
function splitMath(markdown: string, site: ChatSite | null): Piece[] {
  const singleDollar = usesSingleDollarMath(site);
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const pieces: Piece[] = [];
  let prose: string[] = [];
  let fence: string | null = null;

  lines.forEach((line, index) => {
    const isLast = index === lines.length - 1;
    const fenceMatch = line.match(FENCE_RE);

    if (fence === null && !fenceMatch) {
      prose.push(line);

      if (isLast) {
        pieces.push(...splitProse(prose.join("\n"), singleDollar));
      }

      return;
    }

    if (prose.length > 0) {
      pieces.push(...splitProse(`${prose.join("\n")}\n`, singleDollar));
      prose = [];
    }

    if (fence === null) {
      fence = fenceMatch?.[1] ?? null;
    } else if (
      fenceMatch &&
      fenceMatch[1][0] === fence[0] &&
      fenceMatch[1].length >= fence.length &&
      line.trim() === fenceMatch[1]
    ) {
      fence = null;
    }

    pieces.push(isLast ? line : `${line}\n`);
  });

  return pieces;
}

export function containsMath(markdown: string, site: ChatSite | null): boolean {
  return splitMath(markdown, site).some((piece) => typeof piece !== "string");
}

/*
 * Rewrites every formula as $inline$ or as a $$ block on lines of
 * its own, keeping list indentation and quote markers.
 */
export function normalizeMathMarkdown(
  markdown: string,
  site: ChatSite | null,
): string {
  const pieces = splitMath(markdown, site);

  if (pieces.every((piece) => typeof piece === "string")) {
    return markdown;
  }

  let out = "";

  for (const [i, piece] of pieces.entries()) {
    if (typeof piece === "string") {
      out += piece;
      continue;
    }

    if (!piece.display) {
      out += `$${piece.tex.replace(/\s*\n\s*/g, " ")}$`;
      continue;
    }

    const { prefix } = piece;
    const body = piece.tex
      .split("\n")
      .map((line) => `${prefix}${line}`)
      .join("\n");

    // Text before the formula on the same line ends that line.
    if (!/(^|\n)[ \t>]*$/.test(out)) {
      out = `${out.replace(/[ \t]+$/, "")}\n${prefix}`;
    }

    out += `$$\n${body}\n${prefix}$$`;

    // Text after it on the same line starts a new one.
    const next = pieces[i + 1];

    if (typeof next === "string" && !/^[ \t]*(\n|$)/.test(next)) {
      pieces[i + 1] = `\n${prefix}${next.replace(/^[ \t]+/, "")}`;
    }
  }

  return out;
}

/*
 * PDF placeholders: a formula becomes MATH_OPEN + its index in
 * `formulas` + MATH_CLOSE. Private Use Area characters never occur
 * in chat text (ChatGPT's own PUA tokens use U+E200-U+E202 and are
 * stripped separately), so the token can't be confused with
 * anything, and it carries none of the "|", "*" or "`" a formula
 * may contain that the Markdown parser would otherwise act on.
 * Built from character codes rather than written literally, since
 * raw PUA characters are invisible in most editors.
 */
export const MATH_OPEN = String.fromCharCode(0xe300);
export const MATH_CLOSE = String.fromCharCode(0xe301);

export function extractMath(
  markdown: string,
  site: ChatSite | null,
  formulas: MathSpan[],
): string {
  return splitMath(markdown, site)
    .map((piece) => {
      if (typeof piece === "string") {
        return piece;
      }

      formulas.push({ tex: piece.tex, display: piece.display });
      return `${MATH_OPEN}${formulas.length - 1}${MATH_CLOSE}`;
    })
    .join("");
}
