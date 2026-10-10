/*
 * =========================================================
 * AI Exporter - chatgpt-components.ts
 * =========================================================
 *
 * ChatGPT writes parts of a reply as UI components - JSX-like tags
 * inside its Markdown - and the web app draws them:
 *
 *   <CodeBlock language="python" editable>...</CodeBlock>  a code editor
 *   <Cite refs={[...]}/>                                   a citation
 *   <Entity category="..." value="Japan Rail Pass" .../>   a named thing
 *   <AsyncImageGroup query={[...]} .../>, <AsyncImage/>    web image results
 *   <Link url="https://..." title="..."/>                  a link
 *   <WritingBlock id="..." variant="...">...</WritingBlock> a draft to copy
 *   <text color="secondary" size="sm">...</text>          small print
 *   <box><row><text/><title/></row><divider/>...</box>     a summary card
 *
 * Every export reads Markdown, so each becomes the Markdown that
 * shows the same thing: a fenced code block in its language, the
 * entity's name, a Markdown link, the draft's lines as paragraphs, a <small>
 * paragraph (small and gray where a format can show it; plain text
 * in plain text), and the card as a table without a header, one
 * "label | value" row per <row>. Image results go, as Gemini's do.
 * content.ts turns citations into notes, since only it has the
 * search results they name (see chatgpt-reply.ts); a <Cite> still
 * here names none of them and goes too.
 *
 * Any other component - a capitalized tag, a tag inside a card, or
 * one with {expression} attributes - is unwrapped to its text, so no
 * tag reaches an exported file. Code is left as it is: in a fenced
 * block or `inline code`, a tag is something the reply shows, not one
 * of its components.
 *
 * Runs on the export side - the popup, the "Save many chats" and
 * data export pages, and the background's shortcut and backups - when
 * a ChatGPT chat arrives, so content.js keeps no import (see the top
 * of content.ts).
 */
import type { Message } from "./export-builders.ts";

type Attrs = Record<string, string | true>;

interface Element {
  name: string;
  attrs: Attrs;
  children: Node[];
  /* On lines of its own, rather than inside a sentence */
  block: boolean;
  /* A <CodeBlock>'s code, exactly as written */
  code?: string;
}

type Node = string | Element;

interface Tag {
  name: string;
  attrs: Attrs;
  close: boolean;
  selfClose: boolean;
  /* Has an attribute={expression}, which only JSX writes */
  jsx: boolean;
  end: number;
}

/* The layout widgets cards are made of */
const LAYOUT = new Set(["box", "row", "title", "text", "divider"]);
const CARDS = new Set(["box", "row"]);

const TAG_NAME_RE = /[A-Za-z][\w.-]*/y;
const ATTR_NAME_RE = /[A-Za-z_][\w:.-]*/y;
const MAX_TAG_LENGTH = 4000;

/* Where a {...} attribute value ends, or -1 */
function expressionEnd(text: string, start: number, limit: number): number {
  let depth = 0;

  for (let i = start; i < limit; i++) {
    const char = text[i];

    if (char === '"' || char === "'" || char === "`") {
      for (i++; i < limit && text[i] !== char; i++) {
        if (text[i] === "\\") {
          i++;
        }
      }
    } else if ("{[(".includes(char)) {
      depth++;
    } else if ("}])".includes(char)) {
      depth--;

      if (depth === 0) {
        return char === "}" ? i + 1 : -1;
      }
    }
  }

  return -1;
}

/* The tag starting at the "<" at `start`, or null when there's none */
function readTag(text: string, start: number): Tag | null {
  let i = start + 1;
  const close = text[i] === "/";

  if (close) {
    i++;
  }

  TAG_NAME_RE.lastIndex = i;
  const name = TAG_NAME_RE.exec(text)?.[0];

  if (!name) {
    return null;
  }

  i += name.length;

  const attrs: Attrs = {};
  const limit = Math.min(text.length, start + MAX_TAG_LENGTH);
  let jsx = false;

  while (i < limit) {
    const spaced = /\s/.test(text[i]);

    while (i < limit && /\s/.test(text[i])) {
      i++;
    }

    if (text.startsWith("/>", i)) {
      return close ? null : { name, attrs, close, selfClose: true, jsx, end: i + 2 };
    }

    if (text[i] === ">") {
      return { name, attrs, close, selfClose: false, jsx, end: i + 1 };
    }

    ATTR_NAME_RE.lastIndex = i;
    const attr = close || !spaced ? undefined : ATTR_NAME_RE.exec(text)?.[0];

    if (!attr) {
      return null;
    }

    i += attr.length;

    if (text[i] !== "=") {
      attrs[attr] = true;
      continue;
    }

    const quote = text[++i];

    if (quote === '"' || quote === "'") {
      const end = text.indexOf(quote, i + 1);

      if (end < 0 || end >= limit) {
        return null;
      }

      attrs[attr] = text.slice(i + 1, end);
      i = end + 1;
    } else if (quote === "{") {
      const end = expressionEnd(text, i, limit);

      if (end < 0) {
        return null;
      }

      attrs[attr] = text.slice(i, end);
      jsx = true;
      i = end;
    } else {
      return null;
    }
  }

  return null;
}

function isComponent(tag: Tag, inCard: boolean, text: string): boolean {
  if (!/^[A-Z]/.test(tag.name) && !LAYOUT.has(tag.name) && !inCard && !tag.jsx) {
    return false;
  }

  // A bare tag that's never closed isn't one: "List<String>"
  return (
    tag.close ||
    tag.selfClose ||
    Object.keys(tag.attrs).length > 0 ||
    text.includes(`</${tag.name}>`, tag.end)
  );
}

/* Only spaces between `start` and the line's beginning or end */
function lineStartsAt(text: string, start: number): boolean {
  return /(?:^|\n)[ \t]*$/.test(text.slice(Math.max(0, start - 200), start));
}

function lineEndsAt(text: string, end: number): boolean {
  return /^[ \t]*(?:\n|$)/.test(text.slice(end, end + 200));
}

const FENCE_RE = /[ \t]{0,3}(`{3,}|~{3,})[^\n]*/y;

/* The end of the fenced block opened at `start` (the end of the text if it's never closed) */
function fenceEnd(text: string, start: number, fence: string): number {
  const closing = new RegExp(`^[ \\t]{0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`, "m");
  const firstLine = text.indexOf("\n", start);

  if (firstLine < 0) {
    return text.length;
  }

  const match = closing.exec(text.slice(firstLine + 1));

  return match ? firstLine + 1 + (match.index ?? 0) + match[0].length : text.length;
}

/* Where the `code span` opened by the backticks at `start` ends, or -1 */
function codeSpanEnd(text: string, start: number, ticks: number): number {
  const closing = new RegExp(`(?<!\`)\`{${ticks}}(?!\`)`, "g");
  closing.lastIndex = start + ticks;
  const match = closing.exec(text);

  if (!match || text.slice(start, match.index).includes("\n\n")) {
    return -1;
  }

  return match.index + ticks;
}

/*
 * The reply as text and component elements. Code - fenced blocks,
 * `spans` and <CodeBlock> bodies - stays text, read no further.
 */
function parse(text: string): Node[] {
  const root: Element = { name: "", attrs: {}, children: [], block: true };
  const stack: Element[] = [root];
  let plain = "";
  let i = 0;

  const flush = (): void => {
    if (plain) {
      stack[stack.length - 1].children.push(plain);
      plain = "";
    }
  };

  const openIndex = (name: string): number =>
    stack.findLastIndex((element, index) => index > 0 && element.name === name);

  while (i < text.length) {
    const char = text[i];

    if ((i === 0 || text[i - 1] === "\n") && (char === " " || char === "\t" || char === "`" || char === "~")) {
      FENCE_RE.lastIndex = i;
      const fence = FENCE_RE.exec(text);

      if (fence) {
        const end = fenceEnd(text, i, fence[1]);
        plain += text.slice(i, end);
        i = end;
        continue;
      }
    }

    if (char === "`") {
      let ticks = 1;

      while (text[i + ticks] === "`") {
        ticks++;
      }

      const end = codeSpanEnd(text, i, ticks);
      plain += text.slice(i, end < 0 ? i + ticks : end);
      i = end < 0 ? i + ticks : end;
      continue;
    }

    const tag = char === "<" ? readTag(text, i) : null;

    // A closing tag counts when its component is open.
    if (
      !tag ||
      !(
        isComponent(tag, stack.some((element) => CARDS.has(element.name)), text) ||
        (tag.close && openIndex(tag.name) > 0)
      )
    ) {
      plain += char;
      i++;
      continue;
    }

    flush();

    const parent = stack[stack.length - 1];
    const block = lineStartsAt(text, i);
    const open = tag.close || (tag.selfClose && Object.keys(tag.attrs).length === 0)
      ? openIndex(tag.name)
      : -1;

    if (open > 0) {
      // Its closing tag - "<WritingBlock/>" closes one too
      stack[open].block &&= lineEndsAt(text, tag.end);
      stack.length = open;
    } else if (tag.close) {
      // A closing tag with nothing open goes.
    } else if (tag.name === "CodeBlock" && !tag.selfClose) {
      const closing = text.indexOf("</CodeBlock>", tag.end);
      const end = closing < 0 ? text.length : closing;

      parent.children.push({
        name: tag.name,
        attrs: tag.attrs,
        children: [],
        block: true,
        code: text.slice(tag.end, end),
      });
      i = closing < 0 ? end : end + "</CodeBlock>".length;
      continue;
    } else {
      const element: Element = {
        name: tag.name,
        attrs: tag.attrs,
        children: [],
        block: block && (!tag.selfClose || lineEndsAt(text, tag.end)),
      };

      parent.children.push(element);

      if (!tag.selfClose) {
        stack.push(element);
      }
    }

    i = tag.end;
  }

  flush();

  return root.children;
}

/*
 * ---------------------------------------------------------
 * MARKDOWN
 * ---------------------------------------------------------
 */

function attr(element: Element, name: string): string {
  const value = element.attrs[name];

  return typeof value === "string" ? value : "";
}

/* Web image results: <AsyncImageGroup query={[...]}/>, <AsyncImage query="..."/> */
function isImageResults(name: string): boolean {
  return /^AsyncImage|ImageGroup$/.test(name);
}

function markdownLinkText(text: string): string {
  return text.replace(/([[\]])/g, "\\$1");
}

/* <Link url="https://..." title="Official site"/>: a Markdown link */
function link(element: Element): string {
  const label = attr(element, "title") || inlineText(element.children) || attr(element, "url");
  const url = attr(element, "url") || attr(element, "href");

  return /^https?:\/\/[^\s<>()]+$/i.test(url) && label
    ? `[${markdownLinkText(label)}](${url})`
    : label;
}

/* What an element reads as inside a sentence or a table cell */
function inlineText(nodes: Node[], bold = false): string {
  return nodes
    .map((node): string => {
      if (typeof node === "string") {
        return node;
      }

      switch (node.name) {
        case "Entity":
          return attr(node, "value") || attr(node, "name") || inlineText(node.children);
        case "Link":
          return link(node);
        case "CodeBlock": {
          const code = (node.code ?? "").trim().replace(/\s+/g, " ");
          const ticks = "`".repeat(Math.max(1, ...(code.match(/`+/g) ?? []).map((run) => run.length + 1)));

          return code ? `${ticks}${code.startsWith("`") ? " " : ""}${code}${code.endsWith("`") ? " " : ""}${ticks}` : "";
        }
        case "Cite":
        case "divider":
          return "";
        case "title": {
          const title = inlineText(node.children);

          return bold && title ? `**${title}**` : title;
        }
        default:
          return isImageResults(node.name) ? "" : inlineText(node.children);
      }
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/* The text with line breaks kept, its components read inline */
function rawText(nodes: Node[]): string {
  return nodes.map((node) => (typeof node === "string" ? node : inlineText([node]))).join("");
}

function codeFence(element: Element): string {
  const code = (element.code ?? "").replace(/^[ \t]*\n/, "").replace(/\n[ \t]*$/, "");
  const language = attr(element, "language").replace(/[^\w+#.-]/g, "");
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));

  return `${fence}${language}\n${code}\n${fence}`;
}

/* A draft's paragraphs, each line kept with a hard break */
function writingBlock(element: Element): string {
  return rawText(element.children)
    .split(/\n[ \t]*\n/)
    .map((paragraph) =>
      paragraph
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join("  \n"),
    )
    .filter(Boolean)
    .join("\n\n");
}

function tableCell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

/* Card rows as a two-column table without a header: label | value */
function cardTable(rows: string[][]): string {
  return [
    "| | |",
    "|---|---|",
    ...rows.map(([label, value]) => `| ${tableCell(label)} | ${tableCell(value)} |`),
  ].join("\n");
}

function rowCells(row: Element): string[] {
  const cells = row.children
    .map((child) => inlineText([child], true))
    .filter(Boolean);

  return [cells[0] ?? "", cells.slice(1).join(" · ")];
}

/* A card: its rows as a table, anything else around it as paragraphs */
function card(element: Element): string {
  const parts: string[] = [];
  let rows: string[][] = [];

  const flushRows = (): void => {
    if (rows.length > 0) {
      parts.push(cardTable(rows));
      rows = [];
    }
  };

  for (const child of element.children) {
    if (typeof child !== "string" && child.name === "row") {
      rows.push(rowCells(child));
      continue;
    }

    const text =
      typeof child === "string"
        ? child.trim()
        : child.name === "text"
          ? small(inlineText(child.children))
          : child.name === "title"
            ? bold(inlineText(child.children))
            : child.name === "box"
              ? card(child)
              : inlineText([child]);

    if (text) {
      flushRows();
      parts.push(text);
    }
  }

  flushRows();

  return parts.join("\n\n");
}

function small(text: string): string {
  return text ? `<small>${text}</small>` : "";
}

function bold(text: string): string {
  return text ? `**${text}**` : "";
}

class MarkdownOut {
  text = "";
  private afterBlock = false;

  inline(text: string): void {
    const added = this.afterBlock ? text.replace(/^(?:[ \t]*\n)+/, "") : text;

    if (added) {
      this.text += added;
      this.afterBlock = false;
    }
  }

  block(markdown: string): void {
    if (!markdown.trim()) {
      return;
    }

    this.text = this.text.replace(/[ \t]+$/, "");

    if (this.text && !this.text.endsWith("\n\n")) {
      this.text += this.text.endsWith("\n") ? "\n" : "\n\n";
    }

    this.text += `${markdown}\n\n`;
    this.afterBlock = true;
  }

  /* What goes leaves no gap behind: "...trip. <Cite/>" ends at "trip." */
  drop(): void {
    this.text = this.text.replace(/[ \t]+$/, "");
  }
}

function render(nodes: Node[], out: MarkdownOut): void {
  for (const node of nodes) {
    if (typeof node === "string") {
      out.inline(node);
      continue;
    }

    switch (node.name) {
      case "CodeBlock":
        out.block(codeFence(node));
        break;
      case "Cite":
      case "divider":
        out.drop();
        break;
      case "Entity":
      case "Link":
        out.inline(inlineText([node]));
        break;
      case "WritingBlock":
        out.block(writingBlock(node));
        break;
      case "text":
        if (node.block) {
          out.block(small(inlineText(node.children)));
        } else {
          out.inline(inlineText(node.children));
        }
        break;
      case "title":
        if (node.block) {
          out.block(bold(inlineText(node.children)));
        } else {
          out.inline(inlineText(node.children));
        }
        break;
      case "box":
        out.block(card(node));
        break;
      case "row":
        out.block(cardTable([rowCells(node)]));
        break;
      default:
        if (isImageResults(node.name) || node.children.length === 0) {
          out.drop();
        } else {
          render(node.children, out);
        }
    }
  }
}

/* Runs of blank lines left where components were, outside code */
function tidyBlankLines(markdown: string): string {
  return markdown
    .split(/(^[ \t]{0,3}(?:`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]{0,3}(?:`{3,}|~{3,})[ \t]*$)/m)
    .map((part, index) => (index % 2 === 1 ? part : part.replace(/\n{3,}/g, "\n\n")))
    .join("")
    .trim();
}

/* A reply's Markdown with its components turned into Markdown */
export function convertChatGptComponents(markdown: string): string {
  if (!/<\/?[A-Za-z]/.test(markdown)) {
    return markdown;
  }

  const out = new MarkdownOut();
  render(parse(markdown), out);

  return tidyBlankLines(out.text);
}

/* A ChatGPT chat's replies with their components turned into Markdown */
export function convertChatGptReplies(
  messages: Message[],
  site: string | null | undefined,
): Message[] {
  return site !== "chatgpt"
    ? messages
    : messages.map((message) =>
        message.role === "assistant"
          ? { ...message, content: convertChatGptComponents(message.content) }
          : message,
      );
}
