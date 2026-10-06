// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyContentSettings,
  buildContentForFormat,
  buildMarkdownFromMessages,
  type Message,
} from "../src/export-builders";
import { buildHtmlDocument } from "../src/html-export";
import { buildDocxBlob } from "../src/docx-export";
import { buildPdfBlob } from "../src/pdf-export";
import { buildNotionPage, type NotionBlock } from "../src/notion-blocks";
import { DEFAULT_SETTINGS, type Settings } from "../src/settings";

/*
 * Every string the PDF export draws, so the test can read the page
 * without unpacking the PDF's compressed, glyph-encoded text.
 */
const drawn = vi.hoisted(() => [] as string[]);

vi.mock("jspdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jspdf")>();
  const RealPdf = actual.default as unknown as new (...args: unknown[]) => {
    text: (...args: unknown[]) => unknown;
  };

  function RecordingPdf(...args: unknown[]) {
    const doc = new RealPdf(...args);
    const text = doc.text.bind(doc);

    doc.text = (...textArgs: unknown[]) => {
      drawn.push([textArgs[0]].flat().join(""));
      return text(...textArgs);
    };

    return doc;
  }

  return { ...actual, default: RecordingPdf, jsPDF: RecordingPdf };
});

/* In whatever time zone the tests run in */
const ASKED = new Date(2026, 9, 3, 14, 5, 9).getTime();
const ANSWERED = new Date(2026, 9, 3, 14, 6, 30).getTime();
const FOLLOW_UP = new Date(2026, 9, 4, 9, 0, 0).getTime();

const MESSAGES: Message[] = [
  { id: "1", role: "user", order: 0, content: "When was Rome founded?", time: ASKED },
  {
    id: "2",
    role: "assistant",
    order: 1,
    content: "In 753 BC, by legend.",
    time: ANSWERED,
    model: "gpt-4o",
  },
  { id: "3", role: "user", order: 2, content: "And Paris?", time: FOLLOW_UP },
  // A reply the site gave no details for
  { id: "4", role: "assistant", order: 3, content: "Around 250 BC." },
];

const SOURCE = { tabTitle: "Old cities - ChatGPT", tabUrl: "https://chatgpt.com/c/1" };

const WITH_DETAILS: Settings = { ...DEFAULT_SETTINGS, includeMessageDetails: true };

let stored: Partial<Settings> = {};

beforeEach(() => {
  stored = {};
  drawn.length = 0;
  vi.stubGlobal("chrome", {
    runtime: { getURL: (path: string) => `ext:///${path}` },
    storage: {
      sync: {
        get: vi.fn(async (defaults: Record<string, unknown>) => ({
          ...defaults,
          ...stored,
        })),
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the setting", () => {
  it("leaves times and models out by default", () => {
    const exported = applyContentSettings(MESSAGES, DEFAULT_SETTINGS);

    expect(exported.some((message) => "time" in message || "model" in message)).toBe(
      false,
    );
  });

  it("keeps them when it's on", () => {
    const [question, reply, , unknown] = applyContentSettings(MESSAGES, WITH_DETAILS);

    expect(question).toMatchObject({ time: ASKED });
    expect(reply).toMatchObject({ time: ANSWERED, model: "gpt-4o" });
    expect(unknown).not.toHaveProperty("time");
  });
});

describe("Markdown", () => {
  it("writes the details in italics under each name", async () => {
    stored = { includeMessageDetails: true };

    const markdown = await buildMarkdownFromMessages(MESSAGES, {
      ...SOURCE,
      properties: false,
    });

    expect(markdown).toContain(
      "## User\n\n*2026-10-03 14:05*\n\nWhen was Rome founded?",
    );
    expect(markdown).toContain(
      "## Assistant\n\n*2026-10-03 14:06 · gpt-4o*\n\nIn 753 BC, by legend.",
    );
    expect(markdown).toContain("## Assistant\n\nAround 250 BC.");
  });

  it("writes them on their own when names are off", async () => {
    stored = { includeMessageDetails: true, headingStyle: "none" };

    const markdown = await buildMarkdownFromMessages(MESSAGES, {
      ...SOURCE,
      properties: false,
    });

    expect(markdown.startsWith("*2026-10-03 14:05*\n\nWhen was Rome founded?")).toBe(true);
  });

  it("gives note apps the chat's first and last day and its models", async () => {
    stored = { includeMessageDetails: true };

    const markdown = await buildMarkdownFromMessages(MESSAGES, {
      ...SOURCE,
      properties: true,
    });

    expect(markdown).toContain(
      'messages: 4\ncreated: 2026-10-03T14:05\nupdated: 2026-10-04T09:00\nmodels:\n  - "gpt-4o"\ntags:',
    );
  });

  it("has none of it while the setting is off", async () => {
    const markdown = await buildMarkdownFromMessages(MESSAGES, {
      ...SOURCE,
      properties: true,
    });

    expect(markdown).not.toMatch(/2026-10-0|gpt-4o|created:|models:/);
  });
});

describe("text, JSON and CSV", () => {
  it("give a text file the details without the asterisks", async () => {
    stored = { includeMessageDetails: true };

    const markdown = await buildMarkdownFromMessages(MESSAGES, {
      ...SOURCE,
      properties: false,
      notes: "brackets",
    });
    const { content } = buildContentForFormat("txt", markdown, MESSAGES, WITH_DETAILS);

    expect(content).toContain("Assistant\n\n2026-10-03 14:06 · gpt-4o\n\nIn 753 BC");
  });

  it("give JSON a time in UTC and the model as fields of their own", () => {
    const parsed = JSON.parse(
      buildContentForFormat("json", "", MESSAGES, WITH_DETAILS).content,
    );

    expect(parsed[1]).toEqual({
      role: "assistant",
      time: new Date(ANSWERED).toISOString(),
      model: "gpt-4o",
      content: "In 753 BC, by legend.",
    });
    expect(parsed[3]).toEqual({ role: "assistant", content: "Around 250 BC." });
    expect(
      JSON.parse(buildContentForFormat("json", "", MESSAGES, DEFAULT_SETTINGS).content)[1],
    ).toEqual({ role: "assistant", content: "In 753 BC, by legend." });
  });

  it("give CSV time and model columns a spreadsheet reads", () => {
    const rows = buildContentForFormat("csv", "", MESSAGES, WITH_DETAILS).content.split(
      "\r\n",
    );

    expect(rows[0]).toBe("role,time,model,content");
    expect(rows[2]).toBe("assistant,2026-10-03 14:06:30,gpt-4o,\"In 753 BC, by legend.\"");
    expect(rows[4]).toBe("assistant,,,Around 250 BC.");
    expect(
      buildContentForFormat("csv", "", MESSAGES, DEFAULT_SETTINGS).content.split("\r\n")[0],
    ).toBe("role,content");
  });
});

describe("web page", () => {
  it("writes the details in gray after the name, with a machine-readable time", async () => {
    const html = await buildHtmlDocument(MESSAGES, [], WITH_DETAILS, SOURCE);
    const page = new DOMParser().parseFromString(html, "text/html");
    const [, reply] = page.querySelectorAll(".role");

    expect(reply.textContent).toBe("Assistant · 2026-10-03 14:06 · gpt-4o");
    expect(reply.querySelector(".role-details time")?.getAttribute("datetime")).toBe(
      new Date(ANSWERED).toISOString(),
    );
    expect(page.querySelectorAll(".role-details")).toHaveLength(3);
  });

  it("keeps the details when names are off", async () => {
    const html = await buildHtmlDocument(
      MESSAGES,
      [],
      { ...WITH_DETAILS, headingStyle: "none" },
      SOURCE,
    );
    const page = new DOMParser().parseFromString(html, "text/html");

    expect(page.querySelector(".role")?.textContent).toBe("2026-10-03 14:05");
  });

  it("has no details while the setting is off", async () => {
    const html = await buildHtmlDocument(MESSAGES, [], DEFAULT_SETTINGS, SOURCE);
    const page = new DOMParser().parseFromString(html, "text/html");

    expect(page.querySelector(".role-details")).toBeNull();
    expect(page.querySelector("time")).toBeNull();
  });
});

async function zipFiles(blob: Blob): Promise<Map<string, string>> {
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

describe("Word", () => {
  it("puts the details in a small gray paragraph under the name", async () => {
    const files = await zipFiles(await buildDocxBlob(MESSAGES, [], WITH_DETAILS, SOURCE));
    const document = files.get("word/document.xml") ?? "";

    expect(new DOMParser().parseFromString(document, "application/xml").querySelector("parsererror")).toBeNull();
    expect(document).toContain(
      '<w:pStyle w:val="MessageDetails"/></w:pPr><w:r><w:t xml:space="preserve">2026-10-03 14:06 · gpt-4o</w:t></w:r>',
    );
    expect(files.get("word/styles.xml")).toContain('w:styleId="MessageDetails"');
  });
});

describe("Notion", () => {
  function texts(block: NotionBlock): string {
    const content = block[block.type] as { rich_text?: { text?: { content: string } }[] };

    return (content.rich_text ?? []).map((piece) => piece.text?.content ?? "").join("");
  }

  it("adds a gray line with the details under the name", () => {
    const { blocks } = buildNotionPage(MESSAGES, WITH_DETAILS, SOURCE);
    const index = blocks.findIndex((block) => texts(block) === "2026-10-03 14:06 · gpt-4o");
    const details = blocks[index];

    expect(blocks[index - 1].type).toBe("heading_2");
    expect(details.type).toBe("paragraph");
    expect(
      (details.paragraph as { rich_text: { annotations?: unknown }[] }).rich_text[0].annotations,
    ).toEqual({ italic: true, color: "gray" });
  });
});

describe("PDF", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", async (url: string) => {
      return new Response(readFileSync(`public/${url.replace("ext:///", "")}`));
    });
  });

  it("draws the details under each name", async () => {
    await buildPdfBlob(MESSAGES, [], WITH_DETAILS, SOURCE.tabTitle, SOURCE.tabUrl);

    const reply = drawn.indexOf("2026-10-03 14:06 · gpt-4o");

    expect(drawn).toContain("2026-10-03 14:05");
    expect(reply).toBeGreaterThan(0);
    expect(drawn[reply - 1]).toBe("Assistant");
  });

  it("draws none while the setting is off", async () => {
    await buildPdfBlob(MESSAGES, [], DEFAULT_SETTINGS, SOURCE.tabTitle, SOURCE.tabUrl);

    expect(drawn.some((text) => text.includes("gpt-4o"))).toBe(false);
  });
});
