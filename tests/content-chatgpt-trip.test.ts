// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://chatgpt.com/c/6ac98449-b5bc-83eb-ae8a-4d106de5aaa0"}
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadContentScript, PNG_BASE64, PNG_BYTES } from "./content-harness";
import { convertChatGptReplies } from "../src/chatgpt-components";
import {
  buildContentForFormat,
  buildMarkdownFromMessages,
  type Message,
} from "../src/export-builders";
import { buildHtmlDocument } from "../src/html-export";
import { buildDocxBlob } from "../src/docx-export";
import { buildXlsxBlob } from "../src/xlsx-export";
import { buildNotionPage } from "../src/notion-blocks";
import { buildHandoffPrompt } from "../src/handoff";
import { buildClipboardContent } from "../src/clipboard-export";
import { buildPdfBlob } from "../src/pdf-export";
import { DEFAULT_SETTINGS } from "../src/settings";

/*
 * The ChatGPT loader in content.ts, fed a real conversation the way
 * the page bridge hands it over (tests/fixtures/chatgpt-japan-trip.json):
 * seven turns, the last a picture ChatGPT generated, its replies
 * written with UI components - <Cite refs={[...]}/>, <CodeBlock>,
 * <box>/<row> cards and the rest - and their search results in the
 * metadata. `page` is what AI Exporter reads; `conversation` is the
 * whole tree, with other versions of two replies.
 */
const fixture = JSON.parse(readFileSync("tests/fixtures/chatgpt-japan-trip.json", "utf8"));

const NOTE = (numbers: number[]) =>
  `${String.fromCharCode(0xe310)}${numbers.join(",")}${String.fromCharCode(0xe311)}`;

/* The page with every time written as ISO 8601 */
function withIsoTimes(): unknown {
  const page = structuredClone(fixture.page);

  for (const message of page.messages) {
    message.create_time = new Date(message.create_time * 1000).toISOString().replace("Z", "123+00:00");
  }

  return page;
}

let answerWith: () => unknown = () => structuredClone(fixture.page);

/* Answers content.ts' bridge requests the way pageBridge.js does */
function fakeBridge(): { downloads: string[]; ready: () => void } {
  const downloads: string[] = [];
  const answer = (data: Record<string, unknown>): void => {
    const event = new Event("message");

    Object.defineProperties(event, {
      data: { value: { source: "AIExporter", ...data } },
      source: { value: window },
    });
    setTimeout(() => window.dispatchEvent(event), 0);
  };

  vi.spyOn(window, "postMessage").mockImplementation((message: any) => {
    if (message?.type === "AIExporter_API_REQUEST") {
      answer({
        type: "AIExporter_API_RESPONSE",
        requestId: message.requestId,
        data: answerWith(),
      });
    } else if (message?.type === "AIExporter_FILE_DOWNLOAD_REQUEST") {
      downloads.push(`${message.scheme}:${message.fileId}`);
      answer({
        type: "AIExporter_FILE_DOWNLOAD_RESPONSE",
        requestId: message.requestId,
        imageFile: {
          base64: PNG_BASE64,
          fileName: "poster.png",
          mimeType: "image/png",
          sizeBytes: PNG_BYTES.length,
        },
      });
    }
  });

  return { downloads, ready: () => answer({ type: "BRIDGE_READY" }) };
}

async function load(downloadImagesLocally: boolean) {
  const bridge = fakeBridge();
  const script = await loadContentScript();

  bridge.ready();

  const response = await script.send({ type: "LOAD_CONVERSATION", downloadImagesLocally });

  expect(response.success).toBe(true);

  return { ...response.data, downloads: bridge.downloads, script };
}

/* An .xlsx or .docx file's parts: stored, not compressed (see zip.ts) */
async function unzip(blob: Blob): Promise<Map<string, string>> {
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

/* The tags the chat's components were written with */
const COMPONENT_TAGS = [
  "<Cite",
  "<CodeBlock",
  "<box",
  "<row",
  "<text ",
  "<Entity",
  "<AsyncImageGroup",
  "<WritingBlock",
];

const EXPECTED_OUTPUT =
  "## Expected output\n\n```text\nTotal: ¥255,000 ($1,700.00)\nDaily average: ¥18,214.29 ($121.43)\n```";

describe("ChatGPT conversation with UI components", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    answerWith = () => structuredClone(fixture.page);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("exports all seven turns, the generated picture last, downloaded", async () => {
    const { messages, images, downloads } = await load(true);

    expect(messages.map((message: any) => message.role)).toEqual(
      Array.from({ length: 7 }, () => ["user", "assistant"]).flat(),
    );
    expect(messages[12].content).toMatch(/^Generate an image: a minimalist poster of Mount Fuji/);
    expect(messages[13].content).toBe("![Image 1](images/image-001.png)");
    expect(messages[13].imagePaths).toEqual(["images/image-001.png"]);
    expect(downloads).toEqual(["sediment:file_00000000a5308210b7d9131682351394"]);
    expect(images).toEqual([
      expect.objectContaining({ path: "images/image-001.png", mimeType: "image/png" }),
    ]);
  });

  it("keeps the picture's prompt when pictures aren't included", async () => {
    const { messages, images } = await load(false);

    expect(messages).toHaveLength(13);
    expect(messages[12]).toMatchObject({ role: "user" });
    expect(messages[12].content).toMatch(/^Generate an image/);
    expect(images).toEqual([]);
  });

  it("keeps the replies on screen when it reads the whole tree", async () => {
    answerWith = () => structuredClone(fixture.conversation);

    const { messages } = await load(true);

    expect(messages).toHaveLength(14);
    // Not the other versions of these two replies
    expect(messages[3].content).toMatch(/^## 1\. Japan Rail Pass: 14-day price right now/);
    expect(messages[5].content).toMatch(/^# Japan 14-day budget estimate/);
    expect(messages[13].content).toBe("![Image 1](images/image-001.png)");
  });

  it("turns each <Cite> into a note for the search results it names", async () => {
    const { messages } = await load(false);
    const itinerary = messages[1];

    expect(itinerary.content).not.toContain("<Cite");
    expect(itinerary.content).toContain(`for a two-week trip.${NOTE([1, 2])}`);
    expect([...itinerary.content.matchAll(/\u{e310}([0-9,]*)\u{e311}/gu)].map((match) => match[1])).toEqual([
      "1,2",
      "3,4",
      "5,6",
      "7,8",
      "9,10",
      "5,6",
    ]);
    expect(itinerary.sources.slice(0, 2)).toEqual([
      {
        title: "Golden Route | Itineraries | Welcome to Japan. Unforgettable. | JNTO",
        url: "https://www.japan.travel/en/gc/itineraries/long-plan/",
      },
      {
        title:
          "The Sakura Trail—Mt. Yoshino, Nara and Kyoto | Itineraries | Travel Japan - Japan National Tourism Organization (Official Site)",
        url: "https://faq.japan-travel.jnto.go.jp/en/itineraries/the-sakura-trail-mt-yoshino-nara-and-kyoto/",
      },
    ]);
    expect(itinerary.sources).toHaveLength(10);
    expect(messages[3].sources).toHaveLength(4);
    expect(messages[3].content).toContain(`announcement.${NOTE([2, 1])}`);
  });

  it("keeps the Expected output block, which ChatGPT also lists as a code widget", async () => {
    const { messages } = await load(false);

    expect(messages[9].content).toContain(EXPECTED_OUTPUT);
  });

  it("gives every message its time and every reply its model", async () => {
    const { messages } = await load(true);

    expect(messages[0].time).toBe(1791591498607);

    for (const message of messages) {
      expect(message.time).toBeGreaterThan(Date.UTC(2026, 9, 10));
    }

    expect(
      messages.filter((message: any) => message.role === "assistant").map((message: any) => message.model),
    ).toEqual(Array.from({ length: 7 }, () => "gpt-6"));
  });

  it("also reads times written as ISO 8601, as ChatGPT's chat list sends them", async () => {
    answerWith = withIsoTimes;

    const { messages } = await load(true);

    expect(messages).toHaveLength(14);
    expect(messages[0].time).toBe(1791591498607);
    expect(messages.every((message: any) => typeof message.time === "number")).toBe(true);
  });

  it("writes no component tag into any format", { timeout: 60_000 }, async () => {
    const { messages, images, script } = await load(true);
    const chat: Message[] = convertChatGptReplies(messages, "chatgpt");
    const settings = { ...DEFAULT_SETTINGS, includeMessageDetails: true };
    const source = {
      tabTitle: "Japan Itinerary Planning - ChatGPT",
      tabUrl: "https://chatgpt.com/c/6ac98449-b5bc-83eb-ae8a-4d106de5aaa0",
    };

    vi.mocked(chrome.storage.sync.get).mockImplementation(((defaults: object) =>
      Promise.resolve({ ...defaults, includeMessageDetails: true })) as never);
    // The PDF's fonts, from public/ as the extension has them
    script.fetchMock.mockImplementation(
      async (url: string) => new Response(readFileSync(`public/${url.replace(/^chrome-extension:\/\/test-id\//, "")}`)),
    );

    const markdown = await buildMarkdownFromMessages(chat, { ...source, properties: true, notes: "footnotes" });
    const bracketed = await buildMarkdownFromMessages(chat, { ...source, properties: false, notes: "brackets" });
    const txt = buildContentForFormat("txt", bracketed, chat, settings).content;
    const json = buildContentForFormat("json", bracketed, chat, settings).content;
    const csv = buildContentForFormat("csv", bracketed, chat, settings).content;
    const html = await buildHtmlDocument(chat, images, settings, source);
    const docx = (await unzip(await buildDocxBlob(chat, images, settings, source))).get("word/document.xml") ?? "";
    const xlsx = [...(await unzip(buildXlsxBlob(chat, settings, source.tabUrl))).values()].join("\n");
    const notionPage = buildNotionPage(chat, settings, source);
    const notion = JSON.stringify(notionPage);
    const handoff = buildHandoffPrompt(chat, {
      intro: "Continue this chat.",
      start: "--- start ---",
      end: "--- end ---",
      omitted: "{{count}} left out",
      user: "User",
      assistant: "ChatGPT",
    });
    const copied = await buildClipboardContent(chat, source);
    // Without its picture: the PDF measures one with an <img>, which
    // jsdom never loads.
    const pdf = Buffer.from(
      await (await buildPdfBlob(chat, [], settings, source.tabTitle, source.tabUrl)).arrayBuffer(),
    ).toString("latin1");
    // What each shows: Word's and Excel's text without their own XML
    const xmlText = (xml: string) =>
      xml.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    const htmlText = (markup: string) =>
      new DOMParser().parseFromString(markup, "text/html").body.textContent ?? "";
    const outputs: Record<string, string> = {
      markdown,
      txt,
      json,
      csv,
      html,
      htmlText: htmlText(html),
      docx: xmlText(docx),
      xlsx: xmlText(xlsx),
      notion,
      handoff,
      copiedText: copied.text,
      copiedHtml: copied.html,
      copiedHtmlText: htmlText(copied.html),
    };

    for (const [name, text] of Object.entries(outputs)) {
      for (const tag of COMPONENT_TAGS) {
        expect(text.includes(tag), `${name} has ${tag}`).toBe(false);
      }

      expect(text, name).not.toMatch(/AsyncImageGroup|Shibuya crossing cherry blossoms/);
    }

    // Code: its own block, line breaks and template literals kept
    expect(markdown).toContain("```python\ndays = 14\nhotel_nights = 13\n");
    expect(markdown).toContain("```javascript\nconst days = 14;\n");
    expect(markdown).toContain(
      "console.log(`Total: ¥${totalYen.toLocaleString()} ($${(totalYen / yenPerUsd).toFixed(2)})`);",
    );
    expect(txt).toContain(
      "console.log(`Total: ¥${totalYen.toLocaleString()} ($${(totalYen / yenPerUsd).toFixed(2)})`);",
    );
    expect(txt).toContain("days = 14\nhotel_nights = 13\nhotel_per_night = 15_000");
    expect(markdown).toContain(EXPECTED_OUTPUT);
    expect(txt).toContain("Expected output\n\nTotal: ¥255,000 ($1,700.00)\nDaily average: ¥18,214.29 ($121.43)");

    // Citations: footnotes in Markdown, [n] in text, JSON and CSV
    expect(markdown).toContain("for a two-week trip.[^1][^2]");
    expect(markdown).toContain(
      "[^1]: [Golden Route | Itineraries | Welcome to Japan. Unforgettable. | JNTO](https://www.japan.travel/en/gc/itineraries/long-plan/)",
    );
    expect(txt).toContain("for a two-week trip.[1][2]");
    expect(txt).toContain(
      "[1] Golden Route | Itineraries | Welcome to Japan. Unforgettable. | JNTO - https://www.japan.travel/en/gc/itineraries/long-plan/",
    );
    expect(csv).toContain("for a two-week trip.[1][2]");
    expect(JSON.parse(json)[1].sources[0]).toEqual({
      title: "Golden Route | Itineraries | Welcome to Japan. Unforgettable. | JNTO",
      url: "https://www.japan.travel/en/gc/itineraries/long-plan/",
    });

    // Entity, small print, the draft, the summary card
    expect(markdown).toContain("Sources: the official Japan Rail Pass price table");
    expect(markdown).toContain("<small>Planning note: This version assumes you depart from Osaka.");
    expect(txt).toContain("\nPlanning note: This version assumes you depart from Osaka.");
    expect(json).not.toContain("<small>");
    expect(csv).not.toContain("<small>");
    expect(xlsx).not.toContain("&lt;small&gt;");
    expect(handoff).not.toContain("<small>");
    expect(markdown).toContain(
      "أريد شراء JR Pass مقابل 50,000 ين ياباني.\n\nهل يمكنني استخدام JR Pass للسفر بالقطارات السريعة بين طوكيو وأوساكا؟",
    );
    expect(markdown).toContain("| | |\n|---|---|\n| Total for 14 days | **¥255,000** |\n| Average per day | **¥18,214** |");
    expect(txt).toContain("Total for 14 days: ¥255,000\nAverage per day: ¥18,214\nTotal in USD: $1,700");

    // When each message was sent, and by which model
    expect(markdown).toMatch(/\n\*2026-10-1\d \d\d:\d\d · gpt-6\*\n/);
    expect(JSON.parse(json)[1]).toMatchObject({ model: "gpt-6", time: expect.stringMatching(/^2026-10-10T/) });

    // HTML: small gray note, raised notes linked to their pages, the
    // card without a header row, a nested list
    const page = new DOMParser().parseFromString(html, "text/html");
    const card = [...page.querySelectorAll("table")].find((table) =>
      table.textContent?.includes("Total for 14 days"),
    );

    expect(page.querySelector("p.small")?.textContent).toMatch(/^Planning note/);
    expect(
      page.querySelector('sup.note a[href="https://www.japan.travel/en/gc/itineraries/long-plan/"]'),
    ).not.toBeNull();
    expect(card?.querySelector("thead")).toBeNull();
    expect(card?.querySelectorAll("tr")).toHaveLength(4);
    expect(page.querySelector("ul ul li")?.textContent).toMatch(/^Get a rechargeable Suica/);
    expect(page.querySelector(".code pre code")?.textContent).toContain("days = 14\nhotel_nights = 13");

    // Word: small print small and gray, a nested item a level down
    expect(docx).toMatch(/<w:color w:val="656D76"\/><w:sz w:val="19"\/>[^]*?Planning note/);
    expect(docx).toMatch(/<w:ilvl w:val="1"\/><w:numId w:val="1"\/>(?:(?!<\/w:p>)[^])*Get a rechargeable/);

    // A table's cells read in its direction: Arabic with its
    // transliteration stays in that order in an English table.
    const arabicCell = docx.match(/<w:p>(?:(?!<\/w:p>)[^])*Bikam(?:(?!<\/w:p>)[^])*<\/w:p>/)?.[0] ?? "";

    expect(arabicCell).toContain("بكم هذا؟");
    expect(arabicCell).not.toContain("<w:bidi/>");
    expect(page.querySelectorAll('table[dir="ltr"]').length).toBe(page.querySelectorAll("table").length);
    expect(page.querySelector("td[dir], th[dir]")).toBeNull();

    // Notion: a nested item inside the item above it
    const within = notionPage.blocks.find(
      (block: any) => block.type === "bulleted_list_item" && JSON.stringify(block).includes("Within cities"),
    ) as any;

    expect(within.bulleted_list_item.children.map((child: any) => child.type)).toEqual([
      "bulleted_list_item",
      "bulleted_list_item",
    ]);
    expect(JSON.stringify(within.bulleted_list_item.children[0])).toContain("Get a rechargeable");

    // PDF: notes link to their sources
    expect(pdf).toContain("/URI (https://www.japan.travel/en/gc/itineraries/long-plan/)");
  });
});
