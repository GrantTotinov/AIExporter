/*
 * =========================================================
 * AI Exporter - notion-blocks.ts
 * =========================================================
 *
 * Turns a conversation into Notion blocks (the JSON the Notion
 * API takes for a page's content). Runs in the popup, which has
 * the DOM the Markdown parser needs (see markdown-parse.ts);
 * notion.ts sends the blocks from background.ts.
 *
 * Everything maps to Notion's own block types, so the page is as
 * editable as one written in Notion: headings, lists, quotes,
 * tables, dividers, code blocks with their language, and formulas
 * as real Notion equations. Notion's limits are kept to here -
 * 2000 characters per piece of text, 100 pieces per block, 100
 * rows per table, 1000 characters per equation.
 *
 * Downloaded images aren't copied: the Notion API only embeds
 * images from a public web address.
 */
import type { Settings } from "./settings.ts";
import { CHAT_SITE_NAMES, getChatSite } from "./chat-sites.ts";
import { resolveLanguage } from "./code-highlight.ts";
import { parseInline, type Block, type InlineRun } from "./markdown-parse.ts";
import type { MathSpan } from "./math.ts";
import {
  ROLE_LABELS,
  documentTitle,
  prepareConversation,
} from "./export-document.ts";
import { applyContentSettings, type Message } from "./export-builders.ts";
import {
  sourceHost,
  sourceLabel,
  type MessageSource,
} from "./source-notes.ts";

export interface NotionBlock {
  object: "block";
  type: string;
  [key: string]: unknown;
}

interface RichText {
  type: "text" | "equation";
  text?: { content: string; link?: { url: string } | null };
  equation?: { expression: string };
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    code?: boolean;
    color?: string;
  };
}

const MAX_TEXT = 2000;
const MAX_RICH_TEXT = 100;
const MAX_CHILDREN = 100;
const MAX_TABLE_ROWS = 100;
const MAX_EQUATION = 1000;
const MAX_URL = 2000;
const MAX_TITLE = 1900;

const SAFE_LINK_RE = /^https?:\/\/\S+$/i;

/*
 * Notion's code block languages, by the names code-highlight.ts
 * (or a fence's info string) uses.
 */
const NOTION_LANGUAGES = new Set([
  "abap", "arduino", "bash", "basic", "c", "clojure", "coffeescript",
  "c++", "c#", "css", "dart", "diff", "docker", "elixir", "elm",
  "erlang", "flow", "fortran", "f#", "gherkin", "glsl", "go", "graphql",
  "groovy", "haskell", "html", "java", "javascript", "json", "julia",
  "kotlin", "latex", "less", "lisp", "livescript", "lua", "makefile",
  "markdown", "markup", "matlab", "mermaid", "nix", "objective-c",
  "ocaml", "pascal", "perl", "php", "plain text", "powershell",
  "prolog", "protobuf", "python", "r", "reason", "ruby", "rust", "sass",
  "scala", "scheme", "scss", "shell", "solidity", "sql", "swift",
  "typescript", "vb.net", "verilog", "vhdl", "visual basic",
  "webassembly", "xml", "yaml", "toml",
]);

const LANGUAGE_ALIASES: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  python3: "python",
  rb: "ruby",
  rs: "rust",
  sh: "shell",
  zsh: "shell",
  console: "shell",
  shellsession: "shell",
  ps1: "powershell",
  pwsh: "powershell",
  cpp: "c++",
  cc: "c++",
  hpp: "c++",
  cs: "c#",
  csharp: "c#",
  fsharp: "f#",
  kt: "kotlin",
  yml: "yaml",
  md: "markdown",
  dockerfile: "docker",
  tex: "latex",
  objc: "objective-c",
  vb: "visual basic",
  svg: "xml",
  htm: "html",
  patch: "diff",
  jsonc: "json",
  text: "plain text",
  plaintext: "plain text",
  txt: "plain text",
};

export function notionLanguage(info: string | undefined): string {
  const name = info
    ?.trim()
    .split(/[\s{},]/)
    .find(Boolean)
    ?.replace(/^language-/, "")
    .toLowerCase();
  const candidates = [
    name && (LANGUAGE_ALIASES[name] ?? name),
    resolveLanguage(info),
  ];

  for (const candidate of candidates) {
    const mapped = candidate ? (LANGUAGE_ALIASES[candidate] ?? candidate) : "";

    if (NOTION_LANGUAGES.has(mapped)) {
      return mapped;
    }
  }

  return "plain text";
}

function splitText(text: string, size = MAX_TEXT): string[] {
  const chars = Array.from(text);
  const parts: string[] = [];

  for (let index = 0; index < chars.length; index += size) {
    parts.push(chars.slice(index, index + size).join(""));
  }

  return parts;
}

function textPieces(
  content: string,
  annotations: RichText["annotations"] = {},
  link?: string,
): RichText[] {
  const linked =
    link && SAFE_LINK_RE.test(link) && link.length <= MAX_URL
      ? { url: link }
      : null;
  const active = Object.fromEntries(
    Object.entries(annotations).filter(([, value]) => value),
  );

  return splitText(content).map((part) => ({
    type: "text",
    text: { content: part, ...(linked ? { link: linked } : {}) },
    ...(Object.keys(active).length > 0 ? { annotations: active } : {}),
  }));
}

function block(type: string, content: Record<string, unknown>): NotionBlock {
  return { object: "block", type, [type]: content };
}

/*
 * One block per 100 pieces of text: Notion refuses a longer
 * rich_text list.
 */
function richTextBlocks(
  type: string,
  richText: RichText[],
  extra: Record<string, unknown> = {},
): NotionBlock[] {
  if (richText.length === 0) {
    return [block(type, { rich_text: [], ...extra })];
  }

  const blocks: NotionBlock[] = [];

  for (let index = 0; index < richText.length; index += MAX_RICH_TEXT) {
    blocks.push(
      block(type, {
        rich_text: richText.slice(index, index + MAX_RICH_TEXT),
        ...extra,
      }),
    );
  }

  return blocks;
}

export interface NotionPageContent {
  title: string;
  blocks: NotionBlock[];
}

/* The new page's name: the chat's title, or the site's name */
export function notionPageTitle(
  tabTitle: string | undefined,
  tabUrl: string | undefined,
): string {
  const site = getChatSite(tabUrl);
  const title =
    documentTitle(tabTitle) || (site ? `${CHAT_SITE_NAMES[site]} chat` : "Chat");

  return Array.from(title).slice(0, MAX_TITLE).join("");
}

export function buildNotionPage(
  messages: Message[],
  settings: Settings,
  source: { tabTitle: string | undefined; tabUrl: string | undefined },
): NotionPageContent {
  const conversation = prepareConversation(
    applyContentSettings(messages, settings),
    [],
    source.tabTitle,
    source.tabUrl,
  );
  const formulas: MathSpan[] = conversation.formulas;
  const site = getChatSite(source.tabUrl);
  const siteName = site ? CHAT_SITE_NAMES[site] : "";
  const blocks: NotionBlock[] = [];
  /* The sources the message being converted cites */
  let currentSources: MessageSource[] = [];

  function runText(run: InlineRun, base: RichText["annotations"] = {}): RichText[] {
    // Notion has no raised text: a note is a gray "[1]" that links
    // to its source.
    if (run.notes) {
      return run.notes.flatMap((number) =>
        textPieces(
          `[${number}]`,
          { color: "gray" },
          currentSources[number - 1]?.url,
        ),
      );
    }

    if (run.math !== undefined) {
      const formula = formulas[run.math];

      if (!formula) {
        return [];
      }

      return formula.tex.length <= MAX_EQUATION
        ? [{ type: "equation", equation: { expression: formula.tex } }]
        : textPieces(formula.tex, { code: true });
    }

    return textPieces(
      run.text,
      {
        bold: base.bold || run.bold,
        italic: base.italic || run.italic,
        code: run.code,
        ...(base.color ? { color: base.color } : {}),
      },
      run.link,
    );
  }

  /*
   * Hard line breaks ("\n", see joinLines) stay line breaks inside
   * the block; a display formula becomes an equation block of its
   * own between the text before and after it.
   */
  function inlineBlocks(
    text: string,
    type: string,
    base: RichText["annotations"] = {},
  ): NotionBlock[] {
    const out: NotionBlock[] = [];
    let current: RichText[] = [];

    const flush = (force = false): void => {
      if (current.length > 0 || force) {
        out.push(...richTextBlocks(type, current));
        current = [];
      }
    };

    text.split("\n").forEach((segment, index) => {
      if (index > 0 && current.length > 0) {
        current.push(...textPieces("\n"));
      }

      for (const run of parseInline(segment)) {
        const formula = run.math !== undefined ? formulas[run.math] : undefined;

        if (formula?.display && formula.tex.length <= MAX_EQUATION) {
          flush();
          out.push(block("equation", { expression: formula.tex }));
        } else {
          current.push(...runText(run, base));
        }
      }
    });

    flush(out.length === 0);
    return out;
  }

  function cellText(text: string, header: boolean): RichText[] {
    return text
      .split("\n")
      .flatMap((segment, index) => [
        ...(index > 0 ? textPieces("\n") : []),
        ...parseInline(segment).flatMap((run) =>
          runText(run, header ? { bold: true } : {}),
        ),
      ])
      .slice(0, MAX_RICH_TEXT);
  }

  function tableBlocks(table: Extract<Block, { type: "table" }>): NotionBlock[] {
    const width = Math.max(1, table.header.length);
    const row = (cells: string[], header: boolean): NotionBlock =>
      block("table_row", {
        cells: Array.from({ length: width }, (_, column) =>
          cellText(cells[column] ?? "", header),
        ),
      });
    const out: NotionBlock[] = [];
    const bodyRows = table.rows.length > 0 ? table.rows : [];

    // A table longer than Notion allows continues in another one,
    // under the same header.
    for (
      let start = 0;
      start < Math.max(1, bodyRows.length);
      start += MAX_TABLE_ROWS - 1
    ) {
      out.push(
        block("table", {
          table_width: width,
          has_column_header: true,
          has_row_header: false,
          children: [
            row(table.header, true),
            ...bodyRows
              .slice(start, start + MAX_TABLE_ROWS - 1)
              .map((cells) => row(cells, false)),
          ],
        }),
      );
    }

    return out;
  }

  function codeBlocks(code: string, lang?: string): NotionBlock[] {
    const pieces = splitText(code).map(
      (part): RichText => ({ type: "text", text: { content: part } }),
    );

    return richTextBlocks("code", pieces, { language: notionLanguage(lang) });
  }

  function convert(item: Block): NotionBlock[] {
    switch (item.type) {
      case "heading":
        // Notion has three heading levels, and the role labels use
        // the second; a reply's own headings come below them.
        return item.level <= 2
          ? inlineBlocks(item.text, "heading_3")
          : inlineBlocks(item.text, "paragraph", { bold: true });
      case "paragraph":
        return inlineBlocks(item.text, "paragraph");
      case "blockquote":
        return inlineBlocks(item.text, "quote");
      case "list":
        return item.items.flatMap((entry) =>
          inlineBlocks(
            entry,
            item.ordered ? "numbered_list_item" : "bulleted_list_item",
          ),
        );
      case "table":
        return tableBlocks(item);
      case "code":
        return codeBlocks(item.code, item.lang);
      case "hr":
        return [block("divider", {})];
    }
  }

  /*
   * The reasoning ahead of a reply, folded into a toggle that opens
   * on a click. Notion takes only two levels of blocks in one
   * request and 100 in a list, so tables inside it are flattened to
   * lines and the list is cut at 100.
   */
  function thinkingToggle(thinking: Block[]): NotionBlock {
    const children = thinking.flatMap((item): NotionBlock[] => {
      if (item.type === "table") {
        return [item.header, ...item.rows].flatMap((cells) =>
          inlineBlocks(cells.join(" | "), "paragraph"),
        );
      }

      if (item.type === "heading") {
        return inlineBlocks(item.text, "paragraph", { bold: true });
      }

      return convert(item);
    });

    return block("toggle", {
      rich_text: textPieces("Thinking", { bold: true, color: "gray" }),
      children: children.slice(0, MAX_CHILDREN),
    });
  }

  /* The reply's sources, numbered as its notes cite them */
  function sourceBlocks(sources: MessageSource[]): NotionBlock[] {
    return [
      block("paragraph", {
        rich_text: textPieces("Sources", { bold: true, color: "gray" }),
      }),
      ...sources.map((source) => {
        const label = sourceLabel(source);
        const host = sourceHost(source.url);

        return block("numbered_list_item", {
          rich_text: [
            ...textPieces(label, {}, source.url),
            ...(host && host !== label
              ? textPieces(` · ${host}`, { color: "gray" })
              : []),
          ].slice(0, MAX_RICH_TEXT),
        });
      }),
    ];
  }

  /* Where the chat came from, in small gray type */
  const meta = [
    siteName && `Saved from ${siteName}`,
    `${messages.length} ${messages.length === 1 ? "message" : "messages"}`,
    settings.includeTimestamp ? new Date().toLocaleString() : "",
  ].filter(Boolean);
  const header: RichText[] = textPieces(meta.join(" · "), { color: "gray" });

  if (source.tabUrl && SAFE_LINK_RE.test(source.tabUrl)) {
    header.push(
      ...textPieces(" · ", { color: "gray" }),
      ...textPieces("Open the original chat", { color: "gray" }, source.tabUrl),
    );
  }

  blocks.push(...richTextBlocks("paragraph", header));

  for (const [index, message] of conversation.messages.entries()) {
    if (index > 0 && settings.messageSeparator === "rule") {
      blocks.push(block("divider", {}));
    }

    if (settings.headingStyle !== "none") {
      blocks.push(
        block("heading_2", {
          rich_text: textPieces(ROLE_LABELS[message.role], {
            color: message.role === "user" ? "blue" : "purple",
          }),
        }),
      );
    }

    currentSources = message.sources;

    if (message.thinking.length > 0) {
      blocks.push(thinkingToggle(message.thinking));
    }

    for (const item of message.blocks) {
      blocks.push(...convert(item));
    }

    if (message.sources.length > 0) {
      blocks.push(...sourceBlocks(message.sources));
    }
  }

  return { title: notionPageTitle(source.tabTitle, source.tabUrl), blocks };
}
