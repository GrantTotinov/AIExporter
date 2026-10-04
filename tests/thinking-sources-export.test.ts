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
import { NOTE_CLOSE, NOTE_OPEN } from "../src/source-notes";

const note = (...numbers: number[]) => `${NOTE_OPEN}${numbers.join(",")}${NOTE_CLOSE}`;

const MESSAGES: Message[] = [
  { id: "1", role: "user", order: 0, content: "When was Rome founded?" },
  {
    id: "2",
    role: "assistant",
    order: 1,
    content: `In 753 BC${note(1)}, by legend${note(1, 2)}.`,
    thinking: "The user asks about **Rome**.\n\nCheck the sources.",
    sources: [
      { title: "History of Rome", url: "https://history.example/rome" },
      { title: "", url: "https://www.legends.example/romulus" },
    ],
  },
  { id: "3", role: "user", order: 2, content: "And Paris?" },
  {
    id: "4",
    role: "assistant",
    order: 3,
    content: `Around 250 BC${note(1)}.`,
    sources: [{ title: "Paris", url: "https://paris.example/" }],
  },
];

const SOURCE = { tabTitle: "Old cities - ChatGPT", tabUrl: "https://chatgpt.com/c/1" };

const WITH_THINKING: Settings = { ...DEFAULT_SETTINGS, includeThinking: true };
const WITHOUT_SOURCES: Settings = { ...DEFAULT_SETTINGS, includeSources: false };

let stored: Partial<Settings> = {};

beforeEach(() => {
  stored = {};
  vi.stubGlobal("chrome", {
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

describe("the settings", () => {
  it("keep sources and leave thinking out by default", () => {
    const [, reply] = applyContentSettings(MESSAGES, DEFAULT_SETTINGS);

    expect(reply.sources).toHaveLength(2);
    expect(reply.thinking).toBeUndefined();
    expect(reply.content).toBe(MESSAGES[1].content);
  });

  it("drop notes and sources when sources are off", () => {
    const [, reply] = applyContentSettings(MESSAGES, WITHOUT_SOURCES);

    expect(reply.content).toBe("In 753 BC, by legend.");
    expect(reply.sources).toBeUndefined();
  });

  it("keep thinking when it's on", () => {
    expect(applyContentSettings(MESSAGES, WITH_THINKING)[1].thinking).toBe(
      MESSAGES[1].thinking,
    );
  });
});

describe("Markdown", () => {
  it("writes footnotes numbered through the whole file, and folds the thinking away", async () => {
    stored = { includeThinking: true, markdownProperties: false };

    const markdown = await buildMarkdownFromMessages(MESSAGES, {
      ...SOURCE,
      properties: true,
    });

    expect(markdown).toContain(
      "<details>\n<summary>Thinking</summary>\n\nThe user asks about **Rome**.\n\nCheck the sources.\n\n</details>\n\nIn 753 BC[^1], by legend[^1][^2].",
    );
    expect(markdown).toContain(
      "[^1]: [History of Rome](https://history.example/rome)\n[^2]: [legends.example](https://www.legends.example/romulus)",
    );
    expect(markdown).toContain("Around 250 BC[^3].\n\n[^3]: [Paris](https://paris.example/)");
  });

  it("writes plain numbers and a list for text that's read as it is", async () => {
    const markdown = await buildMarkdownFromMessages(MESSAGES, {
      ...SOURCE,
      properties: false,
      notes: "brackets",
    });

    expect(markdown).toContain(
      "In 753 BC[1], by legend[1][2].\n\nSources:\n[1] History of Rome - https://history.example/rome\n[2] legends.example - https://www.legends.example/romulus",
    );
    expect(markdown).toContain("Around 250 BC[1].\n\nSources:\n[1] Paris - https://paris.example/");
    expect(markdown).not.toContain("Thinking");
  });

  it("leaves notes and sources out when they're off", async () => {
    stored = { includeSources: false };

    const markdown = await buildMarkdownFromMessages(MESSAGES, {
      ...SOURCE,
      properties: false,
    });

    expect(markdown).toContain("In 753 BC, by legend.");
    expect(markdown).not.toMatch(/\[\^|Sources/);
  });
});

describe("text, JSON and CSV", () => {
  it("give a text file numbers, a source list and plain thinking", async () => {
    stored = { includeThinking: true };

    const markdown = await buildMarkdownFromMessages(MESSAGES, {
      ...SOURCE,
      properties: false,
      notes: "brackets",
    });
    const { content } = buildContentForFormat("txt", markdown, MESSAGES, WITH_THINKING);

    expect(content).toContain("Thinking\n\nThe user asks about Rome.\n\nCheck the sources.");
    expect(content).toContain("In 753 BC[1], by legend[1][2].");
    expect(content).toContain("[1] History of Rome - https://history.example/rome");
  });

  it("give JSON the sources and thinking fields of their own", () => {
    const parsed = JSON.parse(
      buildContentForFormat("json", "", MESSAGES, WITH_THINKING).content,
    );

    expect(parsed[0]).toEqual({ role: "user", content: "When was Rome founded?" });
    expect(parsed[1]).toEqual({
      role: "assistant",
      content: "In 753 BC[1], by legend[1][2].",
      thinking: MESSAGES[1].thinking,
      sources: MESSAGES[1].sources,
    });
  });

  it("add CSV columns only for what the chat has", () => {
    const withThinking = buildContentForFormat("csv", "", MESSAGES, WITH_THINKING).content;
    const plain = buildContentForFormat("csv", "", MESSAGES, WITHOUT_SOURCES).content;

    expect(withThinking.split("\r\n")[0]).toBe("role,content,thinking,sources");
    expect(withThinking).toContain('"[1] History of Rome - https://history.example/rome\n[2] legends.example - https://www.legends.example/romulus"');
    expect(plain.split("\r\n")[0]).toBe("role,content");
    expect(plain).toContain('assistant,"In 753 BC, by legend."');
  });
});

describe("web page", () => {
  it("raises the notes, links them, and lists the sources under the reply", async () => {
    const html = await buildHtmlDocument(MESSAGES, [], WITH_THINKING, SOURCE);
    const page = new DOMParser().parseFromString(html, "text/html");
    const [first] = page.querySelectorAll("section.message--assistant");

    expect(
      [...first.querySelectorAll("sup.note a")].map((link) => link.getAttribute("href")),
    ).toEqual([
      "https://history.example/rome",
      "https://history.example/rome",
      "https://www.legends.example/romulus",
    ]);
    expect([...first.querySelectorAll(".sources li")].map((item) => item.textContent)).toEqual([
      "History of Rome · history.example",
      "legends.example",
    ]);
    expect(first.querySelector("details.thinking[open] strong")?.textContent).toBe("Rome");
  });

  it("has no thinking when it's off", async () => {
    const html = await buildHtmlDocument(MESSAGES, [], DEFAULT_SETTINGS, SOURCE);

    expect(html).not.toContain('class="thinking"');
  });
});

async function documentXml(blob: Blob): Promise<Map<string, string>> {
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
  it("raises the notes, links them, and adds the thinking and sources", async () => {
    const files = await documentXml(
      await buildDocxBlob(MESSAGES, [], WITH_THINKING, SOURCE),
    );
    const document = files.get("word/document.xml") ?? "";
    const parsed = new DOMParser().parseFromString(document, "application/xml");

    expect(parsed.querySelector("parsererror")).toBeNull();
    expect(document).toContain('<w:vertAlign w:val="superscript"/>');
    expect(document).toContain('w:val="ThinkingLabel"');
    expect(document).toContain('w:val="SourceItem"');
    expect(document).toContain("History of Rome");
    expect(files.get("word/_rels/document.xml.rels")).toContain(
      'Target="https://www.legends.example/romulus" TargetMode="External"',
    );
    expect(files.get("word/styles.xml")).toContain('w:styleId="Thinking"');
  });
});

describe("Notion", () => {
  function texts(block: NotionBlock): string {
    const content = block[block.type] as { rich_text?: { text?: { content: string } }[] };

    return (content.rich_text ?? []).map((piece) => piece.text?.content ?? "").join("");
  }

  it("folds the thinking into a toggle and lists the sources", () => {
    const { blocks } = buildNotionPage(MESSAGES, WITH_THINKING, SOURCE);
    const toggle = blocks.find((block) => block.type === "toggle");
    const children = (toggle?.toggle as { children: NotionBlock[] }).children;

    expect(texts(toggle!)).toBe("Thinking");
    expect(children.map(texts)).toEqual(["The user asks about Rome.", "Check the sources."]);
    expect(
      blocks.filter((block) => block.type === "numbered_list_item").map(texts),
    ).toEqual(["History of Rome · history.example", "legends.example", "Paris · paris.example"]);

    const answer = blocks.find((block) => texts(block).startsWith("In 753 BC"));
    const pieces = (answer?.paragraph as { rich_text: { text: { content: string; link?: { url: string } } }[] }).rich_text;

    expect(texts(answer!)).toBe("In 753 BC[1], by legend[1][2].");
    expect(pieces.find((piece) => piece.text.content === "[2]")?.text.link).toEqual({
      url: "https://www.legends.example/romulus",
    });
  });
});

describe("PDF", () => {
  beforeEach(() => {
    vi.stubGlobal("chrome", {
      runtime: { getURL: (path: string) => `ext:///${path}` },
    });
    vi.stubGlobal("fetch", async (url: string) => {
      return new Response(readFileSync(`public/${url.replace("ext:///", "")}`));
    });
  });

  it("links every note and source to its page, with thinking drawn too", async () => {
    const blob = await buildPdfBlob(MESSAGES, [], WITH_THINKING, SOURCE.tabTitle, SOURCE.tabUrl);
    const pdf = new TextDecoder("latin1").decode(new Uint8Array(await blob.arrayBuffer()));
    const links = [...pdf.matchAll(/\/URI \(([^)]*)\)/g)].map((match) => match[1]);

    // The chat's own link, three notes and two sources in the first
    // reply, one note and one source in the second.
    expect(links.filter((link) => link === "https://history.example/rome")).toHaveLength(3);
    expect(links.filter((link) => link === "https://www.legends.example/romulus")).toHaveLength(2);
    expect(links.filter((link) => link === "https://paris.example/")).toHaveLength(2);
  });

  it("leaves notes and sources out when they're off", async () => {
    const blob = await buildPdfBlob(MESSAGES, [], WITHOUT_SOURCES, SOURCE.tabTitle, SOURCE.tabUrl);
    const pdf = new TextDecoder("latin1").decode(new Uint8Array(await blob.arrayBuffer()));

    expect(pdf).not.toContain("history.example");
  });
});
