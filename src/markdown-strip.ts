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
export function stripMarkdown(markdown: string): string {
  let text = markdown;

  /*
   * Fenced code blocks: drop the ``` fences and any
   * language tag, keep the code content as-is.
   */
  text = text.replace(/```[^\n]*\n([\s\S]*?)```/g, (_match, code: string) =>
    code.replace(/\n$/, ""),
  );

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
   * Blockquotes: drop leading "> ".
   */
  text = text.replace(/^>\s?/gm, "");

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
   * Collapse 3+ blank lines down to at most one.
   */
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}
