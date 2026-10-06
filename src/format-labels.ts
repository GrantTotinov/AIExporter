/*
 * =========================================================
 * AI Exporter - format-labels.ts
 * =========================================================
 *
 * The name a file type goes by in a sentence ("each chat is saved
 * as a Word file"), shared by the pages that save many chats into
 * one ZIP: bulk.ts and archive.ts.
 */
import { t } from "./i18n.ts";
import type { ExportFormat } from "./export-builders.ts";

export function formatLabel(format: ExportFormat): string {
  return format === "txt"
    ? t("popup.format.txt")
    : {
        pdf: "PDF",
        docx: "Word",
        html: "HTML",
        md: "Markdown",
        json: "JSON",
        csv: "CSV",
        png: t("popup.format.png"),
        xlsx: "Excel",
      }[format];
}
