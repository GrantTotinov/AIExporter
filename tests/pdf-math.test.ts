// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPdfBlob, parseInline } from "../src/pdf-export";
import { MATH_CLOSE, MATH_OPEN } from "../src/math";
import { DEFAULT_SETTINGS } from "../src/settings";

/*
 * jsdom's URL isn't Node's, so fonts are read by relative path
 * (vitest runs from the repo root).
 */
beforeEach(() => {
  vi.stubGlobal("chrome", {
    runtime: { getURL: (path: string) => `ext:///${path}` },
  });
  vi.stubGlobal("fetch", async (url: string) => {
    return new Response(readFileSync(`public/${url.replace("ext:///", "")}`));
  });
});

async function pdfSize(url: string, reply: string): Promise<number> {
  const blob = await buildPdfBlob(
    [
      { id: "u", role: "user", content: "Explain \\(x\\), $5", order: 0 },
      { id: "a", role: "assistant", content: reply, order: 1 },
    ],
    [],
    DEFAULT_SETTINGS,
    "Math",
    url,
  );

  return blob.size;
}

describe("PDF right-to-left text", () => {
  // The first test to typeset a formula loads MathJax, which takes a
  // few seconds while the other test files run alongside.
  it("lays out Hebrew and Arabic replies", { timeout: 20_000 }, async () => {
    const size = await pdfSize(
      "https://chatgpt.com/c/1",
      [
        "## כותרת",
        "",
        "שלום **עולם** עם [קישור](https://example.com) ו־3.14 \\(x^2\\).",
        "",
        "1. פריט",
        "> *اقتباس* بالكتاب الله",
        "",
        "| שם | גיל |",
        "| --- | --- |",
        "| דנה | 34 |",
        "",
        "```",
        "// הערה",
        "```",
      ].join("\n"),
    );

    expect(size).toBeGreaterThan(0);
  });
});

describe("PDF math", () => {
  it("parses a formula placeholder as a math run", () => {
    expect(
      parseInline(`**Area ${MATH_OPEN}3${MATH_CLOSE} here**`),
    ).toEqual([
      { bold: true, text: "Area " },
      { bold: true, text: "", math: 3 },
      { bold: true, text: " here" },
    ]);
  });

  it(
    "typesets each site's formulas, and survives ones that don't parse",
    async () => {
      const plain = await pdfSize(
        "https://chatgpt.com/c/1",
        "No math here, just $5.",
      );

      for (const [url, reply] of [
        [
          "https://chatgpt.com/c/1",
          "Inline \\(\\frac{a}{b}\\), display:\n\\[\n\\sum_{n=1}^\\infty \\frac{1}{n^2} = \\frac{\\pi^2}{6} \\tag{1}\n\\]\n\n| A | B |\n| --- | --- |\n| \\(\\sqrt{x}\\) | \\(\\text{Жаба}\\) |\n\nBroken: \\(\\frac{1}{\\)",
        ],
        ["https://claude.ai/chat/1", "Inline $$E = mc^2$$.\n\n$$\n\\nabla f\n$$"],
        ["https://gemini.google.com/app/1", "Inline $x^2$ and $5.\n\n$$y$$"],
      ]) {
        expect(await pdfSize(url, reply)).toBeGreaterThan(plain);
      }
    },
    60000,
  );
});
