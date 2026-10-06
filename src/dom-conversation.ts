/*
 * =========================================================
 * AI Exporter - dom-conversation.ts
 * =========================================================
 *
 * Reads a conversation from the page itself, for the sites whose
 * web apps have no API AI Exporter can read it from: Mistral's Le
 * Chat (chat.mistral.ai) and Meta AI (www.meta.ai). Both show the
 * whole conversation on the page, each message an element that
 * says whose it is:
 *
 *   Le Chat   [data-message-author-role="user" | "assistant"],
 *             the reply's answer in [data-message-part-type="answer"]
 *   Meta AI   [data-message-id$="_user" | "_assistant"]
 *
 * A question is taken as the person typed it (the page's own line
 * breaks), and a reply turned back into the Markdown the other
 * sites' APIs answer with (see elementToMarkdown): headings,
 * lists, tables, code blocks with their language, links, and
 * formulas as their LaTeX.
 *
 * Imported only by content.ts, so Rollup inlines it into
 * content.js - see the top of claude-conversation.ts.
 */
import type { SiteMessage, SiteMessagePart } from "./site-json.ts";

export type DomSite = "mistral" | "meta";

interface DomSiteRules {
  messages: string;
  role(element: Element): "user" | "assistant" | null;
  content(element: Element, role: "user" | "assistant"): Element;
  /* Parts of a reply that aren't its text: status lines, citations' pills... */
  skip: string;
}

const RULES: Record<DomSite, DomSiteRules> = {
  mistral: {
    messages: "[data-message-author-role]",
    role: (element) => {
      const role = element.getAttribute("data-message-author-role");

      return role === "user" || role === "assistant" ? role : null;
    },
    content: (element, role) =>
      (role === "user"
        ? element.querySelector(".select-text")
        : element.querySelector('[data-message-part-type="answer"]')) ?? element,
    skip: "",
  },
  meta: {
    messages: '[data-message-id$="_user"], [data-message-id$="_assistant"]',
    role: (element) => {
      const id = element.getAttribute("data-message-id") ?? "";

      return id.endsWith("_user") ? "user" : id.endsWith("_assistant") ? "assistant" : null;
    },
    content: (element, role) =>
      (role === "user"
        ? element.querySelector('[data-slot="text"].text-response, .whitespace-pre-wrap')
        : null) ?? element,
    skip: [
      '[data-testid="citation-pill"]',
      '[data-testid="thinking-status"]',
      '[data-streamdown="code-block-header"]',
    ].join(", "),
  },
};

/* Never part of a message's text */
const ALWAYS_SKIP = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "button",
  "input",
  "textarea",
  "select",
  "[role='button']",
  "[aria-hidden='true']",
].join(", ");

/*
 * ---------------------------------------------------------
 * HTML TO MARKDOWN
 * ---------------------------------------------------------
 */

/* Where an image goes in the text, until it's made a part of its own */
const IMAGE_OPEN = "";
const IMAGE_CLOSE = "";

interface Context {
  skip: string;
  images: { url: string; alt: string }[];
}

interface Output {
  blocks: string[];
  line: string;
}

const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "header",
  "main",
  "nav",
  "section",
  "summary",
]);

function flush(out: Output): void {
  const line = out.line
    .replace(/ {2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .trim();

  if (line) {
    out.blocks.push(line);
  }

  out.line = "";
}

function isSkipped(element: Element, context: Context): boolean {
  return (
    element.matches(ALWAYS_SKIP) ||
    (context.skip !== "" && element.matches(context.skip))
  );
}

/* A web address worth linking to; Meta AI's redirects are unwrapped */
function linkTarget(href: string | null): string | null {
  if (!href) {
    return null;
  }

  try {
    const url = new URL(href, "https://invalid.example/");

    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return null;
    }

    if (/^l\.(?:meta\.ai|facebook\.com|instagram\.com)$/.test(url.hostname)) {
      return linkTarget(url.searchParams.get("u"));
    }

    return url.hostname === "invalid.example" ? null : url.href;
  } catch {
    return null;
  }
}

/* A formula's LaTeX, as KaTeX and MathJax keep it for screen readers */
function texOf(element: Element): string | null {
  const annotation = element.querySelector('annotation[encoding="application/x-tex"]');
  const tex = annotation?.textContent?.trim() || element.getAttribute("data-latex")?.trim();

  return tex || null;
}

function isDisplayMath(element: Element): boolean {
  return (
    element.matches(".katex-display") ||
    element.closest(".katex-display") !== null ||
    element.getAttribute("display") === "true" ||
    element.getAttribute("display") === "block"
  );
}

function wrapInline(marker: string, text: string): string {
  const trimmed = text.trim();

  if (!trimmed) {
    return text;
  }

  const lead = text.match(/^\s*/)?.[0] ?? "";
  const tail = text.match(/\s*$/)?.[0] ?? "";

  return `${lead}${marker}${trimmed}${marker}${tail}`;
}

function inlineCode(text: string): string {
  const fence = text.includes("`") ? "``" : "`";

  return `${fence}${fence === "``" ? " " : ""}${text}${fence === "``" ? " " : ""}${fence}`;
}

/* The element's inline content, as one line of Markdown */
function inline(element: Element, context: Context): string {
  const out: Output = { blocks: [], line: "" };

  walkChildren(element, out, context);
  flush(out);

  return out.blocks.join(" ");
}

/* The element's content, as Markdown blocks */
function blocks(element: Element, context: Context): string[] {
  const out: Output = { blocks: [], line: "" };

  walkChildren(element, out, context);
  flush(out);

  return out.blocks;
}

function walkChildren(element: Element, out: Output, context: Context): void {
  for (const child of Array.from(element.childNodes)) {
    walk(child, out, context);
  }
}

/*
 * The text in an element outside its <pre> and the parts that are
 * skipped anyway (a code block's copy button).
 */
function textOutside(element: Element, pre: Element, context: Context): string {
  let text = "";

  for (const child of Array.from(element.childNodes)) {
    if (child === pre) {
      continue;
    }

    if (child.nodeType === 3) {
      text += child.textContent ?? "";
    } else if (child.nodeType === 1 && !isSkipped(child as Element, context)) {
      text += ` ${textOutside(child as Element, pre, context)} `;
    }
  }

  return text;
}

const LANGUAGE = /^[A-Za-z][\w+#.-]{0,23}$/;

function languageOf(root: Element, pre: Element, label: string): string {
  const code = pre.querySelector("code");
  const fromClass = [code, pre]
    .map((element) => element?.className.match(/(?:^|\s)(?:language|lang)-([\w+#.-]+)/)?.[1])
    .find(Boolean);
  const fromData = [pre, root, root.querySelector("[data-language]")]
    .map((element) => element?.getAttribute("data-language"))
    .find((value) => value && LANGUAGE.test(value));

  return (fromClass ?? fromData ?? (LANGUAGE.test(label) ? label : "")).toLowerCase();
}

function codeBlock(root: Element, pre: Element, label: string): string {
  const text = ((pre.querySelector("code") ?? pre).textContent ?? "").replace(/\n$/, "");
  let fence = "```";

  while (text.includes(fence)) {
    fence += "`";
  }

  return `${fence}${languageOf(root, pre, label)}\n${text}\n${fence}`;
}

/*
 * A code block's wrapper - its <pre>, a label with the language and
 * buttons - is written as just the code block. Anything else with
 * text besides its <pre> is walked as usual.
 */
function asCodeWrapper(element: Element, context: Context): string | null {
  const pres = element.querySelectorAll("pre");

  if (pres.length !== 1) {
    return null;
  }

  const label = textOutside(element, pres[0], context).replace(/\s+/g, " ").trim();

  return label === "" || LANGUAGE.test(label) ? codeBlock(element, pres[0], label) : null;
}

function list(element: Element, context: Context): string {
  const ordered = element.tagName.toLowerCase() === "ol";
  let number = Number(element.getAttribute("start")) || 1;
  const items: string[] = [];

  for (const item of Array.from(element.children)) {
    if (item.tagName.toLowerCase() !== "li" || isSkipped(item, context)) {
      continue;
    }

    const marker = ordered ? `${number++}.` : "-";
    const indent = " ".repeat(marker.length + 1);
    const lines = blocks(item, context).join("\n").split("\n");

    items.push(
      [`${marker} ${lines[0] ?? ""}`.trimEnd(), ...lines.slice(1).map((line) => (line ? indent + line : line))].join(
        "\n",
      ),
    );
  }

  return items.join("\n");
}

function tableCell(cell: Element, context: Context): string {
  return inline(cell, context).replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}

function markdownTable(cells: string[][]): string {
  if (cells.length === 0) {
    return "";
  }

  const width = Math.max(...cells.map((row) => row.length));
  const line = (row: string[]) =>
    `| ${Array.from({ length: width }, (_, index) => row[index] ?? "").join(" | ")} |`;

  return [
    line(cells[0]),
    `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
    ...cells.slice(1).map(line),
  ].join("\n");
}

function table(element: Element, context: Context): string {
  const rows = Array.from(element.querySelectorAll("tr")).filter(
    (row) => row.closest("table") === element,
  );

  return markdownTable(
    rows
      .map((row) =>
        Array.from(row.children)
          .filter((cell) => /^t[hd]$/i.test(cell.tagName))
          .map((cell) => tableCell(cell, context)),
      )
      .filter((row) => row.length > 0),
  );
}

/*
 * A table drawn with ARIA roles instead of <table>: its rows, or -
 * when it lists only cells - the cells, as many to a row as it has
 * column headers.
 */
function ariaTable(element: Element, context: Context): string {
  const rows = Array.from(element.querySelectorAll('[role="row"]'));

  if (rows.length > 0) {
    return markdownTable(
      rows.map((row) =>
        Array.from(row.querySelectorAll('[role="columnheader"], [role="cell"], [role="gridcell"]')).map(
          (cell) => tableCell(cell, context),
        ),
      ),
    );
  }

  const headers = Array.from(element.querySelectorAll('[role="columnheader"]'));
  const cells = Array.from(element.querySelectorAll('[role="cell"], [role="gridcell"]'));
  const width = headers.length;

  if (width === 0) {
    return "";
  }

  const body: string[][] = [];

  for (let start = 0; start < cells.length; start += width) {
    body.push(cells.slice(start, start + width).map((cell) => tableCell(cell, context)));
  }

  return markdownTable([headers.map((cell) => tableCell(cell, context)), ...body]);
}

function walk(node: Node, out: Output, context: Context): void {
  if (node.nodeType === 3) {
    out.line += (node.textContent ?? "").replace(/\s+/g, " ");
    return;
  }

  if (node.nodeType !== 1) {
    return;
  }

  const element = node as Element;
  const tag = element.tagName.toLowerCase();

  // Formulas first: KaTeX hides its drawing from screen readers.
  if (element.matches(".katex, .katex-display, mjx-container, math")) {
    const tex = texOf(element);

    if (tex) {
      if (isDisplayMath(element)) {
        flush(out);
        out.blocks.push(`\\[${tex}\\]`);
      } else {
        out.line += `\\(${tex}\\)`;
      }

      return;
    }
  }

  if (isSkipped(element, context)) {
    return;
  }

  // Le Chat keeps the table it draws as HTML in an attribute.
  const tableHtml = element.getAttribute("data-rich-table-inner-html");

  if (tableHtml) {
    const parsed = new DOMParser().parseFromString(tableHtml, "text/html").querySelector("table");

    flush(out);
    out.blocks.push(parsed ? table(parsed, context) : "");
    return;
  }

  if (element.getAttribute("role") === "table") {
    flush(out);
    out.blocks.push(ariaTable(element, context));
    return;
  }

  if (/^h[1-6]$/.test(tag)) {
    flush(out);
    out.blocks.push(`${"#".repeat(Number(tag[1]))} ${inline(element, context)}`);
    return;
  }

  switch (tag) {
    case "br":
      out.line += "\n";
      return;
    case "hr":
      flush(out);
      out.blocks.push("---");
      return;
    case "pre": {
      // Le Chat wraps a whole code block - its label, buttons and
      // the <pre> with the code - in another <pre>.
      const inner = element.querySelector("pre") ?? element;
      const label =
        inner === element ? "" : textOutside(element, inner, context).replace(/\s+/g, " ").trim();

      flush(out);
      out.blocks.push(codeBlock(element, inner, LANGUAGE.test(label) ? label : ""));
      return;
    }
    case "ul":
    case "ol":
      flush(out);
      out.blocks.push(list(element, context));
      return;
    case "table":
      flush(out);
      out.blocks.push(table(element, context));
      return;
    case "blockquote":
      flush(out);
      out.blocks.push(
        blocks(element, context)
          .join("\n\n")
          .split("\n")
          .map((line) => (line ? `> ${line}` : ">"))
          .join("\n"),
      );
      return;
    case "p":
      flush(out);
      walkChildren(element, out, context);
      flush(out);
      return;
    case "strong":
    case "b":
      out.line += wrapInline("**", inline(element, context));
      return;
    case "em":
    case "i":
      out.line += wrapInline("*", inline(element, context));
      return;
    case "del":
    case "s":
    case "strike":
      out.line += wrapInline("~~", inline(element, context));
      return;
    case "code":
      out.line += inlineCode((element.textContent ?? "").replace(/\s+/g, " "));
      return;
    case "a": {
      const text = inline(element, context).trim();
      const target = linkTarget(element.getAttribute("href"));

      out.line += target && text ? `[${text.replace(/[[\]]/g, "")}](${target})` : text;
      return;
    }
    case "img": {
      const url = linkTarget(element.getAttribute("src"));
      const width = Number(element.getAttribute("width"));
      const height = Number(element.getAttribute("height"));

      // Icons (a source's favicon) aren't the reply's pictures.
      if (url && !(width > 0 && width < 32) && !(height > 0 && height < 32)) {
        context.images.push({ url, alt: element.getAttribute("alt") ?? "" });
        out.line += `${IMAGE_OPEN}${context.images.length - 1}${IMAGE_CLOSE}`;
      }

      return;
    }
  }

  if (BLOCK_TAGS.has(tag)) {
    const wrapped = asCodeWrapper(element, context);

    flush(out);

    if (wrapped !== null) {
      out.blocks.push(wrapped);
    } else {
      walkChildren(element, out, context);
      flush(out);
    }

    return;
  }

  walkChildren(element, out, context);
}

/*
 * A reply's Markdown, and the pictures in it, each where a
 * "n" marks it.
 */
export function elementToMarkdown(
  element: Element,
  skip = "",
): { markdown: string; images: { url: string; alt: string }[] } {
  const context: Context = { skip, images: [] };

  return {
    markdown: blocks(element, context).join("\n\n"),
    images: context.images,
  };
}

/*
 * A question as typed: the browser's own rendering of its line
 * breaks where it has one (innerText), otherwise the text with a
 * line break per <br> and block.
 */
export function plainText(element: Element): string {
  const rendered = (element as HTMLElement).innerText;

  if (typeof rendered === "string") {
    return rendered.trim();
  }

  let text = "";

  const visit = (node: Node) => {
    if (node.nodeType === 3) {
      text += node.textContent ?? "";
    } else if (node.nodeType === 1) {
      const child = node as Element;

      if (child.matches(ALWAYS_SKIP)) {
        return;
      }

      if (child.tagName.toLowerCase() === "br") {
        text += "\n";
        return;
      }

      const block = BLOCK_TAGS.has(child.tagName.toLowerCase()) || child.tagName.toLowerCase() === "p";

      if (block && text && !text.endsWith("\n")) {
        text += "\n";
      }

      child.childNodes.forEach(visit);

      if (block && !text.endsWith("\n")) {
        text += "\n";
      }
    }
  };

  visit(element);

  return text.trim();
}

/* A reply's Markdown split around its pictures */
function partsOf(markdown: string, images: { url: string; alt: string }[]): SiteMessagePart[] {
  const parts: SiteMessagePart[] = [];
  const pattern = new RegExp(`${IMAGE_OPEN}(\\d+)${IMAGE_CLOSE}`, "g");
  let last = 0;

  for (const match of markdown.matchAll(pattern)) {
    const text = markdown.slice(last, match.index).trim();
    const image = images[Number(match[1])];

    if (text) {
      parts.push({ kind: "text", text });
    }

    if (image) {
      const name = new URL(image.url).pathname.split("/").pop() || "image";

      parts.push({ kind: "image", image: { url: image.url, fileName: name } });
    }

    last = match.index + match[0].length;
  }

  const rest = markdown.slice(last).trim();

  if (rest) {
    parts.push({ kind: "text", text: rest });
  }

  return parts;
}

/*
 * The conversation on the page. Messages inside another message
 * (a site nesting its markers) count once, as the outer one.
 */
export function readDomConversation(site: DomSite, root: ParentNode): SiteMessage[] {
  const rules = RULES[site];
  const found = Array.from(root.querySelectorAll(rules.messages));
  const outer = found.filter(
    (element) => !found.some((other) => other !== element && other.contains(element)),
  );

  return outer.flatMap((element, index): SiteMessage[] => {
    const role = rules.role(element);

    if (!role) {
      return [];
    }

    const content = rules.content(element, role);
    const id =
      element.getAttribute("data-message-id") ?? element.id ?? `${role}-${index}`;

    if (role === "user") {
      const text = plainText(content);

      return text ? [{ id: id || `user-${index}`, role, parts: [{ kind: "text", text }] }] : [];
    }

    const { markdown, images } = elementToMarkdown(content, rules.skip);
    const parts = partsOf(markdown, images);

    return parts.length > 0 ? [{ id: id || `assistant-${index}`, role, parts }] : [];
  });
}
