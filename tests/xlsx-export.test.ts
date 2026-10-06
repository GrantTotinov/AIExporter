// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  buildXlsxBlob,
  cellNumber,
  columnName,
  excelDate,
} from "../src/xlsx-export";
import { pictureParts } from "../src/png-export";
import { DEFAULT_SETTINGS } from "../src/settings";
import type { Message } from "../src/export-builders";
import { NOTE_CLOSE, NOTE_OPEN } from "../src/source-notes";

async function unzip(blob: Blob): Promise<Map<string, string>> {
  // Entries are stored uncompressed (see zip.ts).
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const files = new Map<string, string>();
  const decoder = new TextDecoder();
  let offset = 0;

  while (view.getUint32(offset, true) === 0x04034b50) {
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;

    files.set(
      decoder.decode(bytes.subarray(nameStart, nameStart + nameLength)),
      decoder.decode(bytes.subarray(dataStart, dataStart + size)),
    );
    offset = dataStart + size;
  }

  return files;
}

function xml(text: string | undefined): Document {
  const parsed = new DOMParser().parseFromString(text ?? "", "application/xml");

  expect(parsed.querySelector("parsererror")).toBeNull();

  return parsed;
}

/* The cells of a sheet, row by row, as text */
function cells(sheet: Document): string[][] {
  return Array.from(sheet.getElementsByTagName("row")).map((row) =>
    Array.from(row.getElementsByTagName("c")).map(
      (cell) => cell.getElementsByTagName("t")[0]?.textContent ?? cell.getElementsByTagName("v")[0]?.textContent ?? "",
    ),
  );
}

const MESSAGES: Message[] = [
  { id: "1", role: "user", order: 0, content: "Compare <prices> & sizes", time: Date.UTC(2026, 9, 3, 12) },
  {
    id: "2",
    role: "assistant",
    order: 1,
    model: "gpt-4o",
    content: [
      `Here you go${NOTE_OPEN}1${NOTE_CLOSE}:`,
      "",
      "| Item | Price | Note |",
      "| --- | --- | --- |",
      "| **Tea** | 1,200 | 2nd |",
      "| Coffee | 3.5 | 007 |",
    ].join("\n"),
    sources: [{ title: "Shop", url: "https://shop.example/" }],
  },
];

describe("the Excel export", () => {
  it("is a workbook with a sheet for the chat and one per table", async () => {
    const files = await unzip(
      buildXlsxBlob(MESSAGES, { ...DEFAULT_SETTINGS, includeMessageDetails: true }),
    );

    expect([...files.keys()]).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/worksheets/sheet1.xml",
      "xl/worksheets/sheet2.xml",
    ]);

    for (const text of files.values()) {
      xml(text);
    }

    expect(
      Array.from(xml(files.get("xl/workbook.xml")).getElementsByTagName("sheet")).map((sheet) =>
        sheet.getAttribute("name"),
      ),
    ).toEqual(["Chat", "Table 1"]);

    const chat = cells(xml(files.get("xl/worksheets/sheet1.xml")));

    expect(chat[0]).toEqual(["Role", "Time", "Model", "Message", "Sources"]);
    expect(chat[1][0]).toBe("User");
    expect(Number(chat[1][1])).toBeCloseTo(excelDate(Date.UTC(2026, 9, 3, 12)), 6);
    expect(chat[1][2]).toBe("Compare <prices> & sizes");
    expect(chat[2]).toEqual([
      "Assistant",
      "gpt-4o",
      expect.stringContaining("Here you go[1]:"),
      "[1] Shop - https://shop.example/",
    ]);

    // Numbers as numbers, anything else - "007", "2nd" - as text
    expect(cells(xml(files.get("xl/worksheets/sheet2.xml")))).toEqual([
      ["Item", "Price", "Note"],
      ["Tea", "1200", "2nd"],
      ["Coffee", "3.5", "007"],
    ]);
    expect(files.get("xl/worksheets/sheet2.xml")).toContain('<c r="B2"><v>1200</v></c>');
  });

  it("reads numbers and names columns the way Excel does", () => {
    expect(cellNumber("42")).toBe(42);
    expect(cellNumber("-3.25")).toBe(-3.25);
    expect(cellNumber("1,234,567")).toBe(1234567);
    expect(cellNumber("12,34")).toBeNull();
    expect(cellNumber("0012")).toBeNull();
    expect(cellNumber("5%")).toBeNull();
    expect(columnName(0)).toBe("A");
    expect(columnName(25)).toBe("Z");
    expect(columnName(26)).toBe("AA");
    expect(columnName(701)).toBe("ZZ");
  });
});

describe("pictureParts", () => {
  it("keeps a short chat in one picture", () => {
    expect(pictureParts(5000, [0, 1200, 3000])).toEqual([[0, 5000]]);
  });

  it("cuts a long chat between messages", () => {
    expect(pictureParts(40000, [0, 9000, 15000, 17000, 30000, 39000], 16000)).toEqual([
      [0, 15000],
      [15000, 30000],
      [30000, 40000],
    ]);
  });

  it("cuts through a message taller than a picture", () => {
    expect(pictureParts(35000, [0, 100], 16000)).toEqual([
      [0, 16000],
      [16000, 32000],
      [32000, 35000],
    ]);
  });
});
