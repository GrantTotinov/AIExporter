/*
 * =========================================================
 * AI Exporter - clipboard-export.ts
 * =========================================================
 *
 * What "Copy the whole chat" (popup.ts) and the copy shortcut
 * (background.ts) put on the clipboard: the chat as Markdown for
 * plain text - editors, chat boxes, Obsidian - and as formatted
 * HTML for Word, Google Docs, Notion and mail (see
 * buildClipboardHtml in html-export.ts). Whatever it's pasted
 * into picks the one it reads. A pasted chat goes into a message
 * or a document, where note properties would just be clutter and
 * Markdown footnotes would show as "[^1]", so both have neither.
 */
import { loadSettings } from "./settings.ts";
import { buildMarkdownFromMessages, type Message } from "./export-builders.ts";
import { buildClipboardHtml } from "./html-export.ts";

export interface ClipboardContent {
  /* Markdown, as text/plain */
  text: string;
  /* The same chat formatted, as text/html */
  html: string;
}

export async function buildClipboardContent(
  messages: Message[],
  source: { tabTitle: string | undefined; tabUrl: string | undefined },
): Promise<ClipboardContent> {
  const settings = await loadSettings();
  const text = await buildMarkdownFromMessages(messages, {
    ...source,
    properties: false,
    notes: "brackets",
  });

  return { text, html: buildClipboardHtml(messages, settings, source.tabUrl) };
}
