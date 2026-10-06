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
import {
  conversationModels,
  conversationSpan,
  isoTime,
  messageDetails,
  propertyTime,
  spreadsheetTime,
} from "./message-details.ts";

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
  /*
   * When it was sent, in milliseconds since the epoch, and the AI
   * model that wrote a reply - each when the site says.
   */
  time?: number;
  model?: string;
}

/* The settings that decide what of each message goes into the file */
export type ContentSettings = Pick<
  Settings,
  "includeSources" | "includeThinking" | "includeMessageDetails"
>;

/*
 * The messages the way the settings want them in the file: notes
 * and sources only while "Sources" is on, thinking only while
 * "Thinking" is, and times and models only while "Message dates
 * and AI model" is.
 */
export function applyContentSettings(
  messages: Message[],
  settings: ContentSettings,
): Message[] {
  return messages.map((message) => {
    const { thinking, sources, time, model, ...rest } = message;
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

    if (settings.includeMessageDetails === true) {
      if (time !== undefined) {
        exported.time = time;
      }

      if (model) {
        exported.model = model;
      }
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
  | "html"
  | "png"
  | "xlsx";
export type FilenameExtension = ExportFormat | "zip";

export const EXPORT_FORMATS: readonly ExportFormat[] = [
  "pdf",
  "docx",
  "html",
  "png",
  "md",
  "txt",
  "json",
  "csv",
  "xlsx",
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
 * thinking get fields of their own when it has any - as do its time
 * (ISO 8601, in UTC) and model.
 */
export function buildJson(messages: Message[]): string {
  return JSON.stringify(
    messages.map((message) => ({
      role: message.role,
      ...(message.time !== undefined ? { time: isoTime(message.time) } : {}),
      ...(message.model ? { model: message.model } : {}),
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
 * "time", "model", "thinking" and "sources" columns are only added
 * when a message has any, so a chat without them keeps the two
 * columns it always had. Times are local, in the form spreadsheets
 * read as a date and time.
 */
export function buildCsv(messages: Message[]): string {
  const withTime = messages.some((message) => message.time !== undefined);
  const withModel = messages.some((message) => message.model);
  const withThinking = messages.some((message) => message.thinking);
  const withSources = messages.some((message) => message.sources?.length);
  const header = [
    "role",
    ...(withTime ? ["time"] : []),
    ...(withModel ? ["model"] : []),
    "content",
    ...(withThinking ? ["thinking"] : []),
    ...(withSources ? ["sources"] : []),
  ].join(",");

  const rows = messages.map((message) => {
    const sources = message.sources ?? [];
    const cells = [
      message.role,
      ...(withTime
        ? [message.time !== undefined ? spreadsheetTime(message.time) : ""]
        : []),
      ...(withModel ? [message.model ?? ""] : []),
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

/*
 * `messages` come with the settings applied: when the chat began
 * and was last added to ("created", "updated") and the models that
 * answered are only there with "Message dates and AI model" on.
 */
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

  const span = conversationSpan(messages);

  if (span) {
    lines.push(
      `created: ${propertyTime(span.start)}`,
      `updated: ${propertyTime(span.end)}`,
    );
  }

  const models = conversationModels(messages);

  if (models.length > 0) {
    lines.push("models:", ...models.map((model) => `  - ${yamlString(model)}`));
  }

  if (exportedAt) {
    lines.push(`exported: ${propertyTime(exportedAt.getTime())}`);
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
  const exported = applyContentSettings(messages, settings);
  let noteOffset = 0;

  const header = properties
    ? buildFrontMatter(
        exported,
        source,
        settings.includeTimestamp ? now : null,
      )
    : settings.includeTimestamp
      ? `_Exported ${now.toLocaleString()}_\n\n`
      : "";

  return (
    header +
    exported
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

        // When it was sent and by which model, in italics under the
        // name: "*2026-10-03 14:05 · gpt-4o*" (a text file drops the
        // asterisks).
        const details = messageDetails(message);

        content = [details && `*${details}*`, thinking, content, sourceList]
          .filter(Boolean)
          .join("\n\n");

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
  settings: ContentSettings,
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
