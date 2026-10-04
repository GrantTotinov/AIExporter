/*
 * =========================================================
 * EXPORT FILE BUILDERS
 * =========================================================
 *
 * Turns a conversation's messages into the file the person
 * downloads - Markdown, plain text, JSON, CSV, or a ZIP with
 * its images - and names it. Shared by the popup, which exports
 * the open chat, and the bulk export page, which exports many.
 */
import { SEPARATOR_TEXT, loadSettings, type Settings } from "./settings.ts";
import { stripMarkdown } from "./markdown-strip.ts";
import { createZipBlob, decodeBase64 } from "./zip.ts";
import { normalizeMathMarkdown } from "./math.ts";
import { renderFileName } from "./file-names.ts";
import {
  CHAT_SITE_NAMES,
  getChatSite,
  stripChatSiteSuffix,
} from "./chat-sites.ts";
import {
  bracketNotes,
  bracketSourceList,
  markdownFootnoteDefinitions,
  markdownFootnotes,
  sourceLabel,
  stripNotes,
  type MessageSource,
} from "./source-notes.ts";

export type { MessageSource } from "./source-notes.ts";

export interface Message {
  id: string;
  role: "user" | "assistant";
  /* Markdown; a reply's citations are notes (see source-notes.ts). */
  content: string;
  order: number;
  imagePaths?: string[];
  /* The reasoning a reply's model showed before answering (Markdown). */
  thinking?: string;
  /* The web pages a reply drew on, numbered as its notes cite them. */
  sources?: MessageSource[];
}

/*
 * The messages the way the settings want them in the file: notes
 * and sources only while "Sources" is on, thinking only while
 * "Thinking" is.
 */
export function applyContentSettings(
  messages: Message[],
  settings: Pick<Settings, "includeSources" | "includeThinking">,
): Message[] {
  return messages.map((message) => {
    const { thinking, sources, ...rest } = message;
    const exported: Message = {
      ...rest,
      content:
        settings.includeSources === false
          ? stripNotes(message.content)
          : message.content,
    };

    if (settings.includeThinking === true && thinking?.trim()) {
      exported.thinking = thinking;
    }

    if (settings.includeSources !== false && sources && sources.length > 0) {
      exported.sources = sources;
    }

    return exported;
  });
}

export interface ExportImageFile {
  path: string;
  mimeType: string;
  base64: string;
  sizeBytes: number;
}

export type ExportFormat =
  | "md"
  | "txt"
  | "json"
  | "csv"
  | "pdf"
  | "docx"
  | "html";
export type FilenameExtension = ExportFormat | "zip";

export const EXPORT_FORMATS: readonly ExportFormat[] = [
  "pdf",
  "docx",
  "html",
  "md",
  "txt",
  "json",
  "csv",
];

/* Before a new chat gets its title, the tab shows only the site */
export const SITE_ONLY_TITLE =
  /^(?:ChatGPT|Claude|(?:Google\s+)?Gemini|DeepSeek(?:\s*[-|·–—]\s*Into the Unknown)?|Grok|Perplexity(?:\s+AI)?)$/i;

/*
 * ---------------------------------------------------------
 * FILENAME
 * ---------------------------------------------------------
 *
 * Names the file after the chat, its site and the date, the way
 * the person chose in the settings (`template`, see
 * file-names.ts) - by default
 * "chatgpt-export-easypay-transfer-help-2026-08-30.md".
 */
export function buildFilename(
  tabTitle: string | undefined,
  tabUrl: string | undefined,
  extension: FilenameExtension,
  template = "",
  date = new Date(),
): string {
  const title = stripChatSiteSuffix(tabTitle ?? "");

  return `${renderFileName(template, {
    title: SITE_ONLY_TITLE.test(title) ? "" : title,
    site: getChatSite(tabUrl),
    date,
  })}.${extension}`;
}

/*
 * ---------------------------------------------------------
 * JSON / CSV BUILDERS
 * ---------------------------------------------------------
 */
/*
 * A reply's notes become "[1]" in its content, and its sources and
 * thinking get fields of their own when it has any.
 */
export function buildJson(messages: Message[]): string {
  return JSON.stringify(
    messages.map((message) => ({
      role: message.role,
      content: bracketNotes(message.content, message.sources ?? []),
      ...(message.thinking ? { thinking: message.thinking } : {}),
      ...(message.sources?.length
        ? {
            sources: message.sources.map(({ title, url }) => ({ title, url })),
          }
        : {}),
    })),
    null,
    2,
  );
}

function escapeCsvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }

  return value;
}

/*
 * "thinking" and "sources" columns are only added when a message
 * has any, so a chat without them keeps the two columns it always
 * had.
 */
export function buildCsv(messages: Message[]): string {
  const withThinking = messages.some((message) => message.thinking);
  const withSources = messages.some((message) => message.sources?.length);
  const header = [
    "role",
    "content",
    ...(withThinking ? ["thinking"] : []),
    ...(withSources ? ["sources"] : []),
  ].join(",");

  const rows = messages.map((message) => {
    const sources = message.sources ?? [];
    const cells = [
      message.role,
      bracketNotes(message.content, sources),
      ...(withThinking ? [message.thinking ?? ""] : []),
      ...(withSources
        ? [
            sources
              .map((source, index) =>
                [`[${index + 1}] ${sourceLabel(source)}`, source.url]
                  .filter(Boolean)
                  .join(" - "),
              )
              .join("\n"),
          ]
        : []),
    ];

    return cells.map(escapeCsvField).join(",");
  });

  return [header, ...rows].join("\r\n");
}

/*
 * ---------------------------------------------------------
 * BUILD MARKDOWN FROM MESSAGES
 * ---------------------------------------------------------
 *
 * Replies' math formulas are rewritten in the $...$ / $$...$$
 * form Markdown apps render (see math.ts). With `properties`
 * (Markdown files, when Settings.markdownProperties is on) the
 * file starts with YAML front matter, which Obsidian and other
 * note apps show as the note's properties; the export time, when
 * it's included, goes there instead of into a line of its own.
 */
export interface MarkdownSource {
  tabTitle: string | undefined;
  tabUrl: string | undefined;
  properties: boolean;
  /*
   * How a reply's citations are written: "footnotes" are Markdown
   * footnotes (Markdown files and GitHub), "brackets" a plain "[1]"
   * with the list of sources under the reply - for text files and
   * copied chats, which are read as they are.
   */
  notes?: "footnotes" | "brackets";
}

/*
 * The thinking ahead of a reply: folded away in a Markdown file
 * (Obsidian and GitHub show <details> as a section that opens on a
 * click), a quote in text that's read as it is.
 */
function thinkingMarkdown(
  thinking: string,
  style: NonNullable<MarkdownSource["notes"]>,
): string {
  if (style === "footnotes") {
    return `<details>\n<summary>Thinking</summary>\n\n${thinking}\n\n</details>`;
  }

  const quoted = thinking
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");

  return `> **Thinking**\n>\n${quoted}`;
}

/*
 * A JSON string is also a valid YAML double-quoted string, so
 * quotes, colons, "#" or a leading "-" in a chat title can't break
 * the front matter.
 */
function yamlString(value: string): string {
  return JSON.stringify(value);
}

/* "2026-10-03T14:05" - the form Obsidian reads as a date and time. */
function localDateTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function buildFrontMatter(
  messages: Message[],
  source: MarkdownSource,
  exportedAt: Date | null,
): string {
  const site = getChatSite(source.tabUrl);
  const title = stripChatSiteSuffix(source.tabTitle ?? "").trim();
  const lines = ["---"];

  if (title && !SITE_ONLY_TITLE.test(title)) {
    lines.push(`title: ${yamlString(title)}`);
  }

  if (source.tabUrl) {
    lines.push(`source: ${yamlString(source.tabUrl)}`);
  }

  if (site) {
    lines.push(`site: ${CHAT_SITE_NAMES[site]}`);
  }

  lines.push(`messages: ${messages.length}`);

  if (exportedAt) {
    lines.push(`exported: ${localDateTime(exportedAt)}`);
  }

  lines.push("tags:", "  - ai-chat");

  if (site) {
    lines.push(`  - ${site}`);
  }

  lines.push("---", "", "");
  return lines.join("\n");
}

export async function buildMarkdownFromMessages(
  messages: Message[],
  source: MarkdownSource,
): Promise<string> {
  const settings = await loadSettings();
  const site = getChatSite(source.tabUrl);
  const now = new Date();
  const properties = source.properties && settings.markdownProperties;
  const noteStyle = source.notes ?? "footnotes";
  let noteOffset = 0;

  const header = properties
    ? buildFrontMatter(
        messages,
        source,
        settings.includeTimestamp ? now : null,
      )
    : settings.includeTimestamp
      ? `_Exported ${now.toLocaleString()}_\n\n`
      : "";

  return (
    header +
    applyContentSettings(messages, settings)
      .map((message) => {
        const isReply = message.role === "assistant";
        const sources = message.sources ?? [];
        let content = isReply
          ? normalizeMathMarkdown(message.content, site)
          : message.content;
        let sourceList = "";

        if (noteStyle === "footnotes") {
          content = markdownFootnotes(content, sources, noteOffset);
          sourceList = markdownFootnoteDefinitions(sources, noteOffset);
          noteOffset += sources.length;
        } else {
          content = bracketNotes(content, sources);
          sourceList = sources.length > 0 ? bracketSourceList(sources) : "";
        }

        const thinking = message.thinking
          ? thinkingMarkdown(
              isReply
                ? normalizeMathMarkdown(message.thinking, site)
                : message.thinking,
              noteStyle,
            )
          : "";

        content = [thinking, content, sourceList].filter(Boolean).join("\n\n");

        const roleLabel = message.role === "user" ? "User" : "Assistant";

        let heading: string;

        switch (settings.headingStyle) {
          case "bold":
            heading = `**${roleLabel}:**`;
            break;
          case "none":
            heading = "";
            break;
          case "h2":
          default:
            heading = `## ${roleLabel}`;
            break;
        }

        return heading ? `${heading}\n\n${content}` : content;
      })
      .join(SEPARATOR_TEXT[settings.messageSeparator])
  );
}

/*
 * `markdown` is built for the format already (with "brackets" notes
 * for plain text); JSON and CSV are built from the messages, after
 * the settings are applied to them.
 */
export function buildContentForFormat(
  format: ExportFormat,
  markdown: string,
  allMessages: Message[],
  settings: Pick<Settings, "includeSources" | "includeThinking">,
): { content: string; mimeType: string } {
  const messages = applyContentSettings(allMessages, settings);

  switch (format) {
    case "txt":
      return {
        content: stripMarkdown(
          markdown.replace(
            /!\[([^\]]*)\]\(([^)]+)\)/g,
            (_match, altText: string, imagePath: string) =>
              `${altText}: ${imagePath}`,
          ),
        ),
        mimeType: "text/plain",
      };
    case "json":
      return { content: buildJson(messages), mimeType: "application/json" };
    case "csv":
      return { content: buildCsv(messages), mimeType: "text/csv" };
    case "md":
    default:
      return { content: markdown, mimeType: "text/markdown" };
  }
}

export function createExportZipBlob(
  content: string,
  documentFilename: string,
  images: ExportImageFile[],
): Blob {
  const rootFolder = documentFilename.replace(/\.[^.]+$/, "");
  const encoder = new TextEncoder();
  const entries = [
    { path: `${rootFolder}/`, bytes: new Uint8Array() },
    {
      path: `${rootFolder}/${documentFilename}`,
      bytes: encoder.encode(content),
    },
    { path: `${rootFolder}/images/`, bytes: new Uint8Array() },
    ...images.map((image) => ({
      path: `${rootFolder}/${image.path}`,
      bytes: decodeBase64(image.base64),
    })),
  ];

  return createZipBlob(entries);
}
