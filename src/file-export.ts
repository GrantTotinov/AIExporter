/*
 * =========================================================
 * AI Exporter - file-export.ts
 * =========================================================
 *
 * The "document" formats - PDF, Word, HTML, a picture (PNG) and
 * an Excel workbook - are built straight from the messages, with
 * the chat's images embedded in the file itself, so they're never
 * zipped with an images/ folder the way Markdown and the other
 * text formats are. Shared by the popup and the bulk export page.
 *
 * A chat too long for one picture comes as a ZIP of pictures (see
 * png-export.ts): fileExtension() names the file for what it holds.
 */
import type { Settings } from "./settings.ts";
import { buildPdfBlob } from "./pdf-export.ts";
import { buildHtmlDocument } from "./html-export.ts";
import { DOCX_MIME_TYPE, buildDocxBlob } from "./docx-export.ts";
import { buildPngBlob } from "./png-export.ts";
import { buildXlsxBlob } from "./xlsx-export.ts";
import type {
  ExportFormat,
  ExportImageFile,
  Message,
} from "./export-builders.ts";

export type DocumentFormat = Extract<
  ExportFormat,
  "pdf" | "docx" | "html" | "png" | "xlsx"
>;

const DOCUMENT_FORMATS: readonly ExportFormat[] = ["pdf", "docx", "html", "png", "xlsx"];

export function isDocumentFormat(format: ExportFormat): format is DocumentFormat {
  return DOCUMENT_FORMATS.includes(format);
}

/* The extension a built file gets: "zip" for pictures in a ZIP */
export function fileExtension(format: DocumentFormat, blob: Blob): DocumentFormat | "zip" {
  return format === "png" && blob.type === "application/zip" ? "zip" : format;
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
    case "png":
      return buildPngBlob(messages, images, settings, { tabTitle, tabUrl });
    case "xlsx":
      return buildXlsxBlob(messages, settings, tabUrl);
  }
}
