/*
 * =========================================================
 * AI Exporter - xlsx-export.ts
 * =========================================================
 *
 * The chat as an Excel workbook (.xlsx), which Excel, Google
 * Sheets, Numbers and LibreOffice all open:
 *
 *   - "Chat": a row per message - who wrote it, when, with which
 *     model, what it says (as the CSV export has it), its thinking
 *     and sources - with the header row frozen and filterable;
 *   - "Table 1", "Table 2", ...: every table the chat holds, one
 *     sheet each, numbers as numbers - the tables are what people
 *     most often want out of a chat into a spreadsheet.
 *
 * An .xlsx file is a ZIP of XML parts (Office Open XML); this
 * writes the few a workbook needs, with its text as inline strings.
 * No DOM: it can be built anywhere.
 */
import type { Settings } from "./settings.ts";
import {
  applyContentSettings,
  type Message,
} from "./export-builders.ts";
import { parseBlocks } from "./markdown-parse.ts";
import { stripMarkdown } from "./markdown-strip.ts";
import { bracketNotes, sourceLabel, stripNotes } from "./source-notes.ts";
import { createZipBlob } from "./zip.ts";

export const XLSX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

type Cell = string | number | { date: number } | null;

interface Sheet {
  name: string;
  columns: number[];
  rows: Cell[][];
}

/* Excel holds at most 32,767 characters in a cell */
const MAX_CELL_LENGTH = 32767;

/* Characters XML 1.0 can't hold */
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDFFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function escapeXml(text: string): string {
  return text
    .replace(INVALID_XML, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function columnName(index: number): string {
  let name = "";
  let rest = index + 1;

  while (rest > 0) {
    const digit = (rest - 1) % 26;

    name = String.fromCharCode(65 + digit) + name;
    rest = Math.floor((rest - 1) / 26);
  }

  return name;
}

/* A time as Excel's serial date, in local time */
export function excelDate(time: number): number {
  const offset = new Date(time).getTimezoneOffset() * 60_000;

  return (time - offset) / 86_400_000 + 25569;
}

/* A table cell's number, if it's plainly one ("42", "-3.5", "1,200") */
export function cellNumber(text: string): number | null {
  const plain = text.trim();

  if (!/^-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(plain) || /^-?0\d/.test(plain)) {
    return null;
  }

  const number = Number(plain.replace(/,/g, ""));

  return Number.isFinite(number) && Math.abs(number) < 1e15 ? number : null;
}

const STYLE_HEADER = 1;
const STYLE_WRAP = 2;
const STYLE_DATE = 3;

function cellXml(cell: Cell, reference: string, header: boolean): string {
  if (cell === null || cell === "") {
    return "";
  }

  if (typeof cell === "number") {
    return `<c r="${reference}"><v>${cell}</v></c>`;
  }

  if (typeof cell === "object") {
    return `<c r="${reference}" s="${STYLE_DATE}"><v>${cell.date}</v></c>`;
  }

  const text = escapeXml(Array.from(cell).slice(0, MAX_CELL_LENGTH).join(""));

  return `<c r="${reference}" t="inlineStr" s="${header ? STYLE_HEADER : STYLE_WRAP}"><is><t xml:space="preserve">${text}</t></is></c>`;
}

function sheetXml(sheet: Sheet): string {
  const width = Math.max(1, ...sheet.rows.map((row) => row.length));
  const rows = sheet.rows
    .map(
      (row, rowIndex) =>
        `<row r="${rowIndex + 1}">${row
          .map((cell, column) => cellXml(cell, `${columnName(column)}${rowIndex + 1}`, rowIndex === 0))
          .join("")}</row>`,
    )
    .join("");
  const columns = sheet.columns
    .map((size, index) => `<col min="${index + 1}" max="${index + 1}" width="${size}" customWidth="1"/>`)
    .join("");
  const range = `A1:${columnName(width - 1)}${Math.max(1, sheet.rows.length)}`;

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    (columns ? `<cols>${columns}</cols>` : "") +
    `<sheetData>${rows}</sheetData>` +
    (sheet.rows.length > 1 ? `<autoFilter ref="${range}"/>` : "") +
    "</worksheet>"
  );
}

const STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm"/></numFmts>' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="4">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top"/></xf>' +
  "</cellXfs>" +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  "</styleSheet>";

/* A sheet name Excel accepts: no []:*?/\, at most 31 characters, unique */
function sheetName(wanted: string, taken: Set<string>): string {
  const base = Array.from(wanted.replace(/[[\]:*?/\\]/g, " ").trim() || "Sheet")
    .slice(0, 31)
    .join("");
  let name = base;

  for (let number = 2; taken.has(name.toLowerCase()); number++) {
    const suffix = ` (${number})`;

    name = Array.from(base).slice(0, 31 - suffix.length).join("") + suffix;
  }

  taken.add(name.toLowerCase());

  return name;
}

export function buildWorkbookSheets(messages: Message[]): Sheet[] {
  const withTime = messages.some((message) => message.time !== undefined);
  const withModel = messages.some((message) => message.model);
  const withThinking = messages.some((message) => message.thinking);
  const withSources = messages.some((message) => message.sources?.length);
  const chat: Sheet = {
    name: "Chat",
    columns: [
      12,
      ...(withTime ? [17] : []),
      ...(withModel ? [16] : []),
      90,
      ...(withThinking ? [50] : []),
      ...(withSources ? [50] : []),
    ],
    rows: [
      [
        "Role",
        ...(withTime ? ["Time"] : []),
        ...(withModel ? ["Model"] : []),
        "Message",
        ...(withThinking ? ["Thinking"] : []),
        ...(withSources ? ["Sources"] : []),
      ],
      ...messages.map((message): Cell[] => {
        const sources = message.sources ?? [];

        return [
          message.role === "user" ? "User" : "Assistant",
          ...(withTime ? [message.time !== undefined ? { date: excelDate(message.time) } : null] : []),
          ...(withModel ? [message.model ?? ""] : []),
          bracketNotes(message.content, sources),
          ...(withThinking ? [message.thinking ?? ""] : []),
          ...(withSources
            ? [
                sources
                  .map((source, index) =>
                    [`[${index + 1}] ${sourceLabel(source)}`, source.url].filter(Boolean).join(" - "),
                  )
                  .join("\n"),
              ]
            : []),
        ];
      }),
    ],
  };
  const tables: Sheet[] = [];

  for (const message of messages) {
    for (const block of parseBlocks(stripNotes(message.content))) {
      if (block.type !== "table") {
        continue;
      }

      const cells = [block.header, ...block.rows].map((row) =>
        row.map((cell): Cell => {
          const text = stripMarkdown(cell.replace(/<br\s*\/?>/gi, "\n"));

          return cellNumber(text) ?? text;
        }),
      );
      const width = Math.max(...cells.map((row) => row.length));

      tables.push({
        name: `Table ${tables.length + 1}`,
        columns: Array.from({ length: width }, (_, column) =>
          Math.min(
            60,
            Math.max(
              8,
              ...cells.map((row) => {
                const cell = row[column];

                return typeof cell === "string" ? Math.max(...cell.split("\n").map((line) => line.length)) + 2 : 10;
              }),
            ),
          ),
        ),
        rows: cells,
      });
    }
  }

  return [chat, ...tables];
}

export function buildXlsxBlob(allMessages: Message[], settings: Settings): Blob {
  const messages = applyContentSettings(allMessages, settings);
  const taken = new Set<string>();
  const sheets = buildWorkbookSheets(messages).map((sheet) => ({
    ...sheet,
    name: sheetName(sheet.name, taken),
  }));
  const encoder = new TextEncoder();
  const file = (path: string, xml: string) => ({ path, bytes: encoder.encode(xml) });
  const xmlHead = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

  return new Blob(
    [
      createZipBlob([
        file(
          "[Content_Types].xml",
          `${xmlHead}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
            '<Default Extension="xml" ContentType="application/xml"/>' +
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
            '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
            sheets
              .map(
                (_, index) =>
                  `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
              )
              .join("") +
            "</Types>",
        ),
        file(
          "_rels/.rels",
          `${xmlHead}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
            "</Relationships>",
        ),
        file(
          "xl/workbook.xml",
          `${xmlHead}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
            sheets
              .map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
              .join("") +
            "</sheets></workbook>",
        ),
        file(
          "xl/_rels/workbook.xml.rels",
          `${xmlHead}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
            sheets
              .map(
                (_, index) =>
                  `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
              )
              .join("") +
            `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
            "</Relationships>",
        ),
        file("xl/styles.xml", STYLES_XML),
        ...sheets.map((sheet, index) => file(`xl/worksheets/sheet${index + 1}.xml`, sheetXml(sheet))),
      ]),
    ],
    { type: XLSX_MIME_TYPE },
  );
}
