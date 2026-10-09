/*
 * =========================================================
 * AI Exporter - auto-backup.ts
 * =========================================================
 *
 * "Automatic backup" (the settings page): now and then, the chats
 * that are new or have changed since the last backup are saved on
 * their own - into a folder in Downloads, or into a private GitHub
 * repository. background.ts runs it (AUTOMATIC BACKUP there); this
 * module holds what the settings page shares with it, and the parts
 * that don't need the browser: when a site is due, what each chat's
 * files are called, and building them.
 *
 * The chats come from the chat sites' own tabs, the way "Save many
 * chats" gets them: the content script of an open ChatGPT, Claude...
 * tab lists and loads them. No tab is opened for a backup - a site
 * that isn't open has nothing new from this computer, and is backed
 * up the next time it is.
 *
 * Chrome runs background.ts as a service worker, which has no DOM,
 * so a backup is made only in the formats built from text: not PDF,
 * Word or a picture, which need a canvas. MathJax loads with
 * import(), which service workers don't allow either, so there an
 * HTML backup shows a formula as its TeX source (see renderFormulas()
 * in export-document.ts). Firefox's background page has both.
 */
import { CHAT_SITE_NAMES, type ChatSite } from "./chat-sites.ts";
import type { ConversationSummary } from "./conversation-list.ts";
import { conversationFileBase } from "./bulk-export.ts";
import { buildHtmlDocument } from "./html-export.ts";
import { buildXlsxBlob } from "./xlsx-export.ts";
import {
  buildContentForFormat,
  buildMarkdownFromMessages,
  type ExportImageFile,
  type Message,
} from "./export-builders.ts";
import { copyToArrayBuffer, decodeBase64 } from "./zip.ts";
import { sanitizeFileName } from "./file-names.ts";
import { t } from "./i18n.ts";
import type { Settings } from "./settings.ts";

/*
 * In chrome.storage.local, not .sync: a backup runs on this computer,
 * into its own Downloads folder, with its own GitHub sign-in.
 */
export const BACKUP_CONFIG_KEY = "autoBackup";
export const BACKUP_STATUS_KEY = "autoBackupStatus";
export const BACKUP_SAVED_KEY = "autoBackupSaved";

/* The folder the chats go into, with a folder per site in it */
export const BACKUP_FOLDER = "AI Exporter backup";

export const BACKUP_FORMATS = ["html", "md", "txt", "json", "csv", "xlsx"] as const;

export type BackupFormat = (typeof BACKUP_FORMATS)[number];

const HOUR_MS = 60 * 60 * 1000;

export const BACKUP_INTERVALS_MS = {
  hour: HOUR_MS,
  day: 24 * HOUR_MS,
  week: 7 * 24 * HOUR_MS,
} as const;

export type BackupInterval = keyof typeof BACKUP_INTERVALS_MS;

export interface BackupConfig {
  enabled: boolean;
  every: BackupInterval;
  target: "downloads" | "github";
  /* The GitHub repository, "owner/name" */
  repo: string;
  format: BackupFormat;
}

export const DEFAULT_BACKUP_CONFIG: BackupConfig = {
  enabled: false,
  every: "day",
  target: "downloads",
  repo: "",
  format: "html",
};

export interface BackupSiteStatus {
  /* When its last backup started */
  at: number;
  /* Why that one stopped early; the site is tried again within the hour */
  error?: string;
}

export interface BackupStatus {
  /* When the last backup ended, the chats it saved and those it couldn't */
  at?: number;
  saved?: number;
  failed?: number;
  /* What stopped it: GitHub or the browser refusing to save a file */
  error?: string;
  /* backupTarget() the sites were backed up for: another one starts over */
  target?: string;
  sites: Partial<Record<ChatSite, BackupSiteStatus>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* The stored settings, with anything missing or unknown at its default */
export function backupConfig(stored: unknown): BackupConfig {
  const value = isRecord(stored) ? stored : {};

  return {
    enabled: value.enabled === true,
    every: Object.hasOwn(BACKUP_INTERVALS_MS, String(value.every))
      ? (value.every as BackupInterval)
      : DEFAULT_BACKUP_CONFIG.every,
    target: value.target === "github" ? "github" : "downloads",
    repo: typeof value.repo === "string" ? value.repo : "",
    format: BACKUP_FORMATS.includes(value.format as BackupFormat)
      ? (value.format as BackupFormat)
      : DEFAULT_BACKUP_CONFIG.format,
  };
}

export async function loadBackupConfig(): Promise<BackupConfig> {
  const stored = await chrome.storage.local.get(BACKUP_CONFIG_KEY);

  return backupConfig(stored[BACKUP_CONFIG_KEY]);
}

export function backupStatus(stored: unknown): BackupStatus {
  return isRecord(stored) && isRecord(stored.sites)
    ? (stored as unknown as BackupStatus)
    : { sites: {} };
}

/*
 * Whether a site is due: `every` has passed since its last backup
 * started - or an hour, after one that stopped early. A clock set
 * back since doesn't hold the next one up.
 */
export function isBackupDue(
  last: BackupSiteStatus | undefined,
  every: BackupInterval,
  now: number,
): boolean {
  if (!last) {
    return true;
  }

  const wait = last.error
    ? Math.min(HOUR_MS, BACKUP_INTERVALS_MS[every])
    : BACKUP_INTERVALS_MS[every];

  return now - last.at >= wait || last.at > now;
}

/*
 * What the chats saved so far (BACKUP_SAVED_KEY) were saved for: a
 * new place or file type has none of them yet, so changing either
 * starts the backup over.
 */
export function backupTarget(config: BackupConfig): string {
  const place = config.target === "github" ? `github:${config.repo}` : "downloads";

  return `${place}:${config.format}`;
}

/*
 * A chat's name in the backup: the standard name or the person's
 * pattern (see conversationFileBase), dated by when the chat began -
 * which never changes, so a chat used again keeps its name and its
 * copy is overwritten - and the end of its id, so two chats with the
 * same title on the same day don't overwrite each other.
 */
export function backupFileBase(
  conversation: ConversationSummary,
  template: string,
  site: ChatSite,
): string {
  const base = conversationFileBase(
    { ...conversation, updatedAt: conversation.createdAt ?? conversation.updatedAt },
    template,
    site,
  );
  const id = conversation.id.replace(/[^A-Za-z0-9]/g, "").slice(-8);

  return base.includes(" ") ? `${base} (${id})` : `${base}-${id}`;
}

export interface BackupFile {
  /* Under BACKUP_FOLDER: "AI Exporter backup/ChatGPT/<name>.html" */
  path: string;
  blob: Blob;
}

/*
 * One chat's files: the document on its own - or, for a text format
 * with downloaded images, a folder holding the document and its
 * images/ folder, as "Save many chats" puts it in the ZIP. HTML has
 * its images inside, and a workbook none.
 */
export async function buildBackupFiles(
  site: ChatSite,
  conversation: ConversationSummary,
  messages: Message[],
  images: ExportImageFile[],
  format: BackupFormat,
  settings: Settings,
): Promise<BackupFile[]> {
  const folder = `${BACKUP_FOLDER}/${CHAT_SITE_NAMES[site]}`;
  const name = backupFileBase(conversation, settings.fileNameTemplate, site);
  const source = {
    tabTitle: conversation.title || t("popup.chat.untitled"),
    tabUrl: conversation.url,
  };

  if (format === "html") {
    const html = await buildHtmlDocument(messages, images, settings, source);

    return [
      { path: `${folder}/${name}.html`, blob: new Blob([html], { type: "text/html" }) },
    ];
  }

  if (format === "xlsx") {
    return [{ path: `${folder}/${name}.xlsx`, blob: buildXlsxBlob(messages, settings) }];
  }

  const markdown = await buildMarkdownFromMessages(messages, {
    ...source,
    properties: format === "md",
    notes: format === "md" ? "footnotes" : "brackets",
  });
  const { content, mimeType } = buildContentForFormat(
    format,
    markdown,
    messages,
    settings,
  );
  const document = new Blob([content], { type: mimeType });

  if (images.length === 0) {
    return [{ path: `${folder}/${name}.${format}`, blob: document }];
  }

  return [
    { path: `${folder}/${name}/${name}.${format}`, blob: document },
    ...images.map((image) => ({
      path: `${folder}/${name}/images/${sanitizeFileName(image.path.split("/").pop() ?? "") || "image"}`,
      blob: new Blob([copyToArrayBuffer(decodeBase64(image.base64))], {
        type: image.mimeType,
      }),
    })),
  ];
}
