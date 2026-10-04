/*
 * =========================================================
 * AI Exporter - file-export.ts
 * =========================================================
 *
 * The "document" formats - PDF, Word and HTML - are built
 * straight from the messages, with the chat's images embedded in
 * the file itself, so they're never zipped with an images/ folder
 * the way Markdown and the other text formats are. Shared by the
 * popup and the bulk export page.
 */
import type { Settings } from "./settings.ts";
import { buildPdfBlob } from "./pdf-export.ts";
import { buildHtmlDocument } from "./html-export.ts";
import { DOCX_MIME_TYPE, buildDocxBlob } from "./docx-export.ts";
import type {
  ExportFormat,
  ExportImageFile,
  Message,
} from "./export-builders.ts";

export type DocumentFormat = Extract<ExportFormat, "pdf" | "docx" | "html">;

export function isDocumentFormat(format: ExportFormat): format is DocumentFormat {
  return format === "pdf" || format === "docx" || format === "html";
}

export async function buildDocumentBlob(
  format: DocumentFormat,
  messages: Message[],
  images: ExportImageFile[],
  settings: Settings,
  tabTitle: string | undefined,
  tabUrl: string | undefined,
): Promise<Blob> {
  switch (format) {
    case "pdf":
      return buildPdfBlob(messages, images, settings, tabTitle, tabUrl);
    case "docx": {
      const blob = await buildDocxBlob(messages, images, settings, {
        tabTitle,
        tabUrl,
      });

      return blob.type ? blob : new Blob([blob], { type: DOCX_MIME_TYPE });
    }
    case "html":
      return new Blob(
        [await buildHtmlDocument(messages, images, settings, { tabTitle, tabUrl })],
        { type: "text/html" },
      );
  }
}
