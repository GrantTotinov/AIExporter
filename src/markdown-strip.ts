/*
 * ---------------------------------------------------------
 * STRIP MARKDOWN
 * ---------------------------------------------------------
 *
 * Converts our generated Markdown into plain text for the
 * .txt export - same content, no ** * ` # [] etc syntax.
 * Deliberately simple/regex-based since the input is
 * Markdown we generated ourselves (htmlToMarkdown), not
 * arbitrary user-supplied Markdown, so the syntax space
 * we need to handle is limited and predictable.
 */
/* Stands in for a code block while the rest is stripped */
const HELD = String.fromCharCode(0);
const HELD_RE = new RegExp(`${HELD}(\\d+)${HELD}`, "g");

/* "| a | b |" -> ["a", "b"] */
function tableCells(row: string): string[] {
  return row
    .trim()
    .replace(/^\||\|$/g, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

export function stripMarkdown(markdown: string): string {
  const code: string[] = [];

  /*
   * Fenced code blocks: drop the ``` fences and any
   * language tag, keep the code content as-is - held aside
   * meanwhile, so nothing below touches the code (a template
   * literal's backticks, a "**kwargs").
   */
  let text = markdown.replace(
    /^[ \t]*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^[ \t]*\1[`~]*[ \t]*$/gm,
    (_match, _fence: string, body: string) => {
      code.push(body.replace(/\n$/, ""));
      return `${HELD}${code.length - 1}${HELD}`;
    },
  );

  /*
   * A table without a header row - a ChatGPT summary card's
   * "| label | value |" rows (see chatgpt-components.ts) - reads
   * "label: value", a line each.
   */
  text = text.replace(
    /^\|[ \t]*\|[ \t]*\|[ \t]*\n\|[ \t]*:?-+:?[ \t]*\|[ \t]*:?-+:?[ \t]*\|[ \t]*\n((?:\|.*\|[ \t]*(?:\n|$))+)/gm,
    (_match, rows: string) =>
      rows
        .trimEnd()
        .split("\n")
        .map((row) => {
          const [label = "", value = ""] = tableCells(row);

          return value ? `${label.replace(/:$/, "")}: ${value}` : label;
        })
        .join("\n") + "\n",
  );

  /*
   * Small print (a "<small>" paragraph): its text.
   */
  text = text.replace(/<small>([\s\S]*?)<\/small>/g, "$1");

  /*
   * Inline code.
   */
  text = text.replace(/`([^`]+)`/g, "$1");

  /*
   * Bold / italic (order matters: bold before italic
   * since ** contains *).
   */
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/\*([^*]+)\*/g, "$1");

  /*
   * Images: ![alt](url) -> alt (url). Handle the angle-
   * bracket form used for hosted image URLs before generic
   * links so the leading exclamation mark is removed too.
   */
  text = text.replace(
    /!\[([^\]]*)\]\((?:<([^>]+)>|([^)]+))\)/g,
    (
      _match,
      alt: string,
      bracketedUrl: string | undefined,
      url: string | undefined,
    ) =>
      `${alt} (${bracketedUrl ?? url ?? ""})`,
  );

  /*
   * Links: [text](url) -> text (url)
   */
  text = text.replace(/\[([^\]]*)\]\(([^)]+)\)/g, "$1 ($2)");

  /*
   * Headings: drop leading #'s.
   */
  text = text.replace(/^#{1,6}\s+/gm, "");

  /*
   * Blockquotes: drop leading "> ". Only a space or tab after the
   * ">" goes with it - not the line break of an empty quote line,
   * which would run the quote's paragraphs together.
   */
  text = text.replace(/^>[ \t]?/gm, "");

  /*
   * List markers: "- item" / "1. item" -> keep the
   * text, drop the markdown-specific marker but keep
   * a simple bullet for readability.
   */
  text = text.replace(/^(\s*)-\s+/gm, "$1• ");
  text = text.replace(/^(\s*)\d+\.\s+/gm, "$1");

  /*
   * Horizontal rules.
   */
  text = text.replace(/^---+$/gm, "----------");

  /*
   * A hard line break's trailing spaces.
   */
  text = text.replace(/[ \t]+$/gm, "");

  /*
   * Collapse 3+ blank lines down to at most one.
   */
  text = text.replace(/\n{3,}/g, "\n\n");

  return text
    .replace(HELD_RE, (_match, index: string) => code[Number(index)])
    .trim();
}
