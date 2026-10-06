/*
 * ---------------------------------------------------------
 * SHARED SETTINGS TYPES
 * ---------------------------------------------------------
 *
 * Used by both popup.ts (reads settings when building the
 * export) and options.ts (reads/writes settings from the
 * options page). Keeping this in one file means the two
 * can't drift out of sync with different defaults or
 * option values.
 */
export interface Settings {
  includeTimestamp: boolean;
  /*
   * When true, Markdown files (downloads and GitHub saves, not
   * copied chats) start with a YAML front matter block - the
   * chat's title, link, site and message count - which Obsidian,
   * Logseq and similar note apps show as the note's properties and
   * GitHub shows as a small table.
   */
  markdownProperties: boolean;
  headingStyle: "h2" | "bold" | "none";
  messageSeparator: "single" | "double" | "rule";
  /*
   * When true, chrome.downloads.download() is called with
   * saveAs: true, which opens the browser's native "Save As"
   * dialog on every export instead of silently dropping the
   * file into the default Downloads folder. This lets people
   * choose a different folder each time (e.g. a Dropbox/
   * OneDrive sync folder) - identical behavior in Chrome and
   * Firefox, since chrome.downloads.download's saveAs option
   * is part of the shared WebExtensions API surface both
   * browsers implement the same way.
   */
  askWhereToSave: boolean;
  /*
   * How exported files are named (see file-names.ts): "" for AI
   * Exporter's standard name ("chatgpt-export-trip-ideas-
   * 2026-10-04"), or a pattern with {title}, {site}, {date} and
   * {time} in it, such as "{date} {title}".
   */
  fileNameTemplate: string;
  /**
   * When enabled, image-bearing exports download image assets and bundle them
   * with the conversation file. The default preserves the original text-only
   * behavior and omits image attachments from the Markdown.
   */
  downloadImagesLocally: boolean;
  /*
   * When true, the places in an answer that came from the web are
   * numbered and the pages listed under it, the way the chat site
   * shows them (see source-notes.ts). Off, the answer reads as
   * plain text.
   */
  includeSources: boolean;
  /*
   * When true, the reasoning some AI models do before they answer
   * ("thinking") is exported too, ahead of the answer itself.
   */
  includeThinking: boolean;
  /*
   * When true, every message is exported with the date and time it
   * was sent, and a reply with the AI model that wrote it when the
   * site names one (see message-details.ts) - next to its name in
   * documents, as fields of their own in JSON and CSV.
   */
  includeMessageDetails: boolean;
  theme: "system" | "light" | "dark";
  /*
   * "auto" detects a supported language from the browser's
   * UI language (via chrome.i18n.getUILanguage()/navigator.language)
   * and falls back to English if none match. Any other value
   * pins the UI to that language regardless of the browser's
   * own locale. See src/i18n.ts for the detection logic and
   * the list of supported languages.
   */
  language:
    | "auto"
    | "en"
    | "es"
    | "fr"
    | "de"
    | "ru"
    | "zh"
    | "ja"
    | "ko"
    | "hi"
    | "pt"
    | "id"
    | "tr"
    | "it";
  /*
   * Settings specific to the PDF export format (see
   * src/pdf-export.ts). Kept as a nested object rather than
   * flattened top-level keys so the PDF-only fields stay
   * visually and structurally separate from the settings that
   * apply to every format.
   */
  pdf: PdfSettings;
}

export interface PdfSettings {
  pageFormat: "a4" | "letter" | "legal";
  orientation: "portrait" | "landscape";
  /* All four margins are in millimeters. */
  marginTop: number;
  marginRight: number;
  marginBottom: number;
  marginLeft: number;
  /* Body text size in points. */
  fontSize: number;
  includeTableOfContents: boolean;
  includePageNumbers: boolean;
  /*
   * When true, userInfoText is printed in the footer of every
   * page (e.g. the exporter's name, or "Prepared for <team>").
   */
  includeUserInfo: boolean;
  userInfoText: string;
}

export const DEFAULT_PDF_SETTINGS: PdfSettings = {
  pageFormat: "a4",
  orientation: "portrait",
  marginTop: 20,
  marginRight: 18,
  marginBottom: 20,
  marginLeft: 18,
  fontSize: 11,
  includeTableOfContents: false,
  includePageNumbers: true,
  includeUserInfo: false,
  userInfoText: "",
};

export const DEFAULT_SETTINGS: Settings = {
  includeTimestamp: false,
  markdownProperties: true,
  headingStyle: "h2",
  messageSeparator: "double",
  askWhereToSave: true,
  fileNameTemplate: "",
  downloadImagesLocally: false,
  includeSources: true,
  includeThinking: false,
  includeMessageDetails: false,
  theme: "system",
  language: "auto",
  pdf: DEFAULT_PDF_SETTINGS,
};

export const SEPARATOR_TEXT: Record<Settings["messageSeparator"], string> = {
  single: "\n",
  double: "\n\n",
  rule: "\n\n---\n\n",
};

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.sync.get({
    ...DEFAULT_SETTINGS,
  } as Record<string, unknown>);

  return stored as unknown as Settings;
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.sync.set(settings);
}
