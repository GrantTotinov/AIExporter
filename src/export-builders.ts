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
import { SEPARATOR_TEXT, loadSettings } from "./settings.ts";
import { stripMarkdown } from "./markdown-strip.ts";
import { createZipBlob, decodeBase64 } from "./zip.ts";
import { normalizeMathMarkdown } from "./math.ts";
import {
  CHAT_SITE_NAMES,
  getChatSite,
  stripChatSiteSuffix,
} from "./chat-sites.ts";

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  order: number;
  imagePaths?: string[];
}

export interface ExportImageFile {
  path: string;
  mimeType: string;
  base64: string;
  sizeBytes: number;
}

export type ExportFormat = "md" | "txt" | "json" | "csv" | "pdf";
export type FilenameExtension = ExportFormat | "zip";

export const EXPORT_FORMATS: readonly ExportFormat[] = [
  "pdf",
  "md",
  "txt",
  "json",
  "csv",
];

/* Before a new chat gets its title, the tab shows only the site */
export const SITE_ONLY_TITLE = /^(?:ChatGPT|Claude|(?:Google\s+)?Gemini)$/i;

/*
 * ---------------------------------------------------------
 * FILENAME
 * ---------------------------------------------------------
 *
 * Builds a filesystem-safe filename from the site, the tab
 * title and today's date, e.g.
 * "chatgpt-export-easypay-transfer-help-2026-08-30.md",
 * "claude-export-easypay-transfer-help-2026-08-30.md" or
 * "gemini-export-easypay-transfer-help-2026-08-30.md".
 */
export function buildFilename(
  tabTitle: string | undefined,
  tabUrl: string | undefined,
  extension: FilenameExtension,
): string {
  const date = new Date();

  const datePart =
    date.getFullYear() +
    "-" +
    String(date.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(date.getDate()).padStart(2, "0");

  const rawTitle = stripChatSiteSuffix(tabTitle ?? "conversation");

  const safeTitle = rawTitle
    .toLowerCase()
    .replace(/[^a-z0-9\u0400-\u04FF]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

  const titlePart = safeTitle || "conversation";
  const site = getChatSite(tabUrl) ?? "chatgpt";

  return `${site}-export-${titlePart}-${datePart}.${extension}`;
}

/*
 * ---------------------------------------------------------
 * JSON / CSV BUILDERS
 * ---------------------------------------------------------
 */
export function buildJson(messages: Message[]): string {
  return JSON.stringify(
    messages.map((message) => ({
      role: message.role,
      content: message.content,
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

export function buildCsv(messages: Message[]): string {
  const header = "role,content";

  const rows = messages.map(
    (message) =>
      `${escapeCsvField(message.role)},${escapeCsvField(message.content)}`,
  );

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
    messages
      .map((message) => {
        const content =
          message.role === "assistant"
            ? normalizeMathMarkdown(message.content, site)
            : message.content;
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

export function buildContentForFormat(
  format: ExportFormat,
  markdown: string,
  messages: Message[],
): { content: string; mimeType: string } {
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
