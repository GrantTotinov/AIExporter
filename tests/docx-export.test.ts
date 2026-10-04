// @vitest-environment jsdom
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildDocxBlob, imagePixelSize } from "../src/docx-export";
import { DEFAULT_SETTINGS } from "../src/settings";

/* A 2x3 red PNG */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAEklEQVR4nGP4z8DwHwyBDAYGAEbqBf2Q2yHTAAAAAElFTkSuQmCC";

const MESSAGES = [
  {
    id: "1",
    role: "user" as const,
    order: 0,
    content: "Show me a **Python** loop & a table <please>",
    imagePaths: ["images/photo.png"],
  },
  {
    id: "2",
    role: "assistant" as const,
    order: 1,
    content: [
      "## Loop",
      "",
      "Here is `code` and a [link](https://example.com/a?b=1&c=2).",
      "",
      "```python",
      "for i in range(3):",
      '    print("hi")  # say hi',
      "```",
      "",
      "1. First",
      "2. Second",
      "",
      "- Bullet",
      "",
      "| Name | Age |",
      "| --- | --- |",
      "| Ana | 34 |",
      "",
      "> A quote",
      "",
      "---",
      "",
      "Inline math \\(x^2\\) and display:",
      "",
      "$$\\frac{a}{b}$$",
      "",
      "שלום עולם",
    ].join("\n"),
  },
];

const IMAGES = [
  {
    path: "images/photo.png",
    mimeType: "image/png",
    base64: PNG_BASE64,
    sizeBytes: 70,
  },
];

async function unzip(blob: Blob): Promise<Map<string, string>> {
  // Entries are stored uncompressed (see zip.ts): walk the local
  // file headers.
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
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));

    files.set(name, decoder.decode(bytes.subarray(dataStart, dataStart + size)));
    offset = dataStart + size;
  }

  return files;
}

function parseXml(xml: string): Document {
  const parsed = new DOMParser().parseFromString(xml, "application/xml");

  expect(parsed.querySelector("parsererror")).toBeNull();
  return parsed;
}

describe("Word export", () => {
  // The first test to typeset a formula loads MathJax, which takes a
  // few seconds while the other test files run alongside.
  it("builds a well-formed document with every part Word needs", { timeout: 20_000 }, async () => {
    const blob = await buildDocxBlob(MESSAGES, IMAGES, DEFAULT_SETTINGS, {
      tabTitle: "Loops & tables - ChatGPT",
      tabUrl: "https://chatgpt.com/c/1",
    });

    if (process.env.DOCX_OUT) {
      writeFileSync(process.env.DOCX_OUT, new Uint8Array(await blob.arrayBuffer()));
    }

    const files = await unzip(blob);

    expect([...files.keys()]).toEqual(
      expect.arrayContaining([
        "[Content_Types].xml",
        "_rels/.rels",
        "word/document.xml",
        "word/styles.xml",
        "word/numbering.xml",
        "word/_rels/document.xml.rels",
        "word/media/image1.png",
      ]),
    );

    for (const [name, content] of files) {
      if (name.endsWith(".xml") || name.endsWith(".rels")) {
        parseXml(content);
      }
    }

    const document = files.get("word/document.xml") ?? "";

    expect(document).toContain("Loops &amp; tables");
    expect(document).toContain("Show me a ");
    expect(document).toContain("&lt;please&gt;");
    expect(document).toContain('<w:pStyle w:val="Code"/>');
    expect(document).toContain('w:color w:val="CF222E"'); // "for" keyword
    expect(document).toContain("<w:tbl>");
    expect(document).toContain("<w:numId");
    expect(document).toContain("<w:bidi/>");
    expect(document).toContain("<w:drawing>");
    // No canvas in jsdom: formulas fall back to their source.
    expect(document).toContain("\\frac{a}{b}");
    expect(files.get("word/_rels/document.xml.rels")).toContain(
      'Target="https://example.com/a?b=1&amp;c=2" TargetMode="External"',
    );
  });

  it("leaves out characters XML doesn't allow", async () => {
    const blob = await buildDocxBlob(
      [{ id: "1", role: "user", order: 0, content: "bell\u0007 here" }],
      [],
      DEFAULT_SETTINGS,
      { tabTitle: "x", tabUrl: undefined },
    );
    const document = (await unzip(blob)).get("word/document.xml") ?? "";

    parseXml(document);
    expect(document).toContain("bell here");
  });

  it("reads image sizes from PNG, GIF and JPEG headers", () => {
    const png = Uint8Array.from(atob(PNG_BASE64), (char) => char.charCodeAt(0));

    expect(imagePixelSize(png)).toEqual({ width: 2, height: 3, extension: "png" });
    expect(
      imagePixelSize(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 5, 0, 7, 0, 0])),
    ).toEqual({ width: 5, height: 7, extension: "gif" });
    expect(
      imagePixelSize(
        Uint8Array.from([
          0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 9, 0, 12, 3, 0, 0,
        ]),
      ),
    ).toEqual({ width: 12, height: 9, extension: "jpeg" });
    expect(imagePixelSize(Uint8Array.from([1, 2, 3]))).toBeNull();
  });
});
