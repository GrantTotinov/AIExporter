// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPdfBlob } from "../src/pdf-export";
import { DEFAULT_SETTINGS } from "../src/settings";
import type { Message } from "../src/export-builders";

/*
 * Chinese, Japanese, Korean and the Indic and South-East Asian
 * scripts get fonts of their own (see script-fonts.ts), read from
 * public/fonts like DejaVu.
 */
const fetched: string[] = [];

beforeEach(() => {
  fetched.length = 0;
  vi.stubGlobal("chrome", {
    runtime: { getURL: (path: string) => `ext:///${path}` },
  });
  vi.stubGlobal("fetch", async (url: string) => {
    const path = url.replace("ext:///", "");

    fetched.push(path);

    return new Response(readFileSync(`public/${path}`));
  });
});

function reply(content: string): Message[] {
  return [
    { id: "u", role: "user", order: 0, content: "Question" },
    { id: "a", role: "assistant", order: 1, content },
  ];
}

/* The PDF's text: its objects, with every compressed stream inflated */
async function pdfText(
  messages: Message[],
  title = "Chat",
  build = buildPdfBlob,
): Promise<string> {
  const blob = await build(messages, [], DEFAULT_SETTINGS, title, "https://chatgpt.com/c/1");
  const bytes = Buffer.from(await blob.arrayBuffer());
  const raw = bytes.toString("latin1");
  let text = raw;

  for (const match of raw.matchAll(/stream\r?\n/g)) {
    const start = match.index + match[0].length;
    const end = raw.indexOf("endstream", start);

    try {
      text += inflateSync(bytes.subarray(start, end)).toString("latin1");
    } catch {
      /* Not a compressed stream */
    }
  }

  return text;
}

describe("PDF in other writing systems", () => {
  it("loads no extra font for a chat in English", async () => {
    const text = await pdfText(reply("Plain **English** with `code`."));

    expect(fetched.filter((path) => !path.includes("DejaVu"))).toEqual([]);
    expect(text).not.toContain("/DroidSansFallback");
  });

  it("sets Chinese, Japanese and Korean in their fonts, as text", { timeout: 20_000 }, async () => {
    const text = await pdfText(
      reply("中文标题 **加粗** · 日本語のテキスト · 한국어 텍스트"),
      "测试对话 - ChatGPT",
    );

    expect(fetched).toContain("fonts/DroidSansFallbackFull.ttf");
    expect(fetched).toContain("fonts/NotoSansKR-Hangul.ttf");
    expect(text).toContain("/BaseFont /DroidSansFallback");
    expect(text).toContain("/BaseFont /NotoSansKR");
    // Bold has no font of its own: its letters are filled and outlined.
    expect(text).toMatch(/\b2 Tr\b/);
  });

  it("draws shaped scripts as outlines with invisible text over them", { timeout: 20_000 }, async () => {
    const text = await pdfText(reply("हिन्दी क्षत्रिय, ภาษาไทย and தமிழ்"));

    expect(fetched).toEqual(
      expect.arrayContaining([
        "fonts/NotoSansDevanagari-Regular.ttf",
        "fonts/NotoSansThai-Regular.ttf",
        "fonts/NotoSansTamil-Regular.ttf",
      ]),
    );
    expect(text).toContain("/BaseFont /NotoSansDevanagari");
    // Invisible, and its stretching undone with the graphics state.
    expect(text).toMatch(/q\s[\s\S]*?\b3 Tr\b[\s\S]*?\bTz\b[\s\S]*?ET\s+Q/);
    // Glyph outlines: curves filled as paths.
    expect(text).toMatch(/\bc\n[\s\S]*\bf\n/);
  });

  it("still exports when a font can't be loaded", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("Droid")) {
        throw new Error("offline");
      }

      return new Response(readFileSync(`public/${url.replace("ext:///", "")}`));
    });

    // A fresh module: the fonts loaded above are kept for the session.
    vi.resetModules();
    const fresh = await import("../src/pdf-export");
    const text = await pdfText(reply("中文 text"), "Chat", fresh.buildPdfBlob);

    expect(text).not.toContain("/DroidSansFallback");
    expect(text).toContain("/BaseFont /DejaVuSans");
  });
});
