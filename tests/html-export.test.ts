// @vitest-environment jsdom
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildHtmlDocument } from "../src/html-export";
import { DEFAULT_SETTINGS } from "../src/settings";

const MESSAGES = [
  {
    id: "1",
    role: "user" as const,
    order: 0,
    content: "Is <script>alert(1)</script> safe? [x](javascript:alert(1))",
    imagePaths: ["images/a.png"],
  },
  {
    id: "2",
    role: "assistant" as const,
    order: 1,
    content: [
      "# Answer",
      "",
      "Use **bold**, *italic* and `code`.",
      "",
      "```ts",
      "const x: number = 1; // one",
      "```",
      "",
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "Euler: \\(e^{i\\pi} + 1 = 0\\)",
      "",
      "\\[\\int_0^1 x\\,dx\\]",
    ].join("\n"),
  },
];

const IMAGES = [
  { path: "images/a.png", mimeType: "image/png", base64: "AAAA", sizeBytes: 3 },
];

describe("HTML export", () => {
  // The first test to typeset a formula loads MathJax, which takes a
  // few seconds while the other test files run alongside.
  it("builds one self-contained page", { timeout: 20_000 }, async () => {
    const html = await buildHtmlDocument(MESSAGES, IMAGES, DEFAULT_SETTINGS, {
      tabTitle: "Safety question - ChatGPT",
      tabUrl: "https://chatgpt.com/c/1",
    });

    if (process.env.HTML_OUT) {
      writeFileSync(process.env.HTML_OUT, html);
    }

    const page = new DOMParser().parseFromString(html, "text/html");

    expect(page.title).toBe("Safety question");
    expect(page.querySelector("script")).toBeNull();
    expect(page.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(page.body.textContent).toContain("<script>alert(1)</script>");
    expect(page.querySelector("h3")?.textContent).toBe("Answer");
    expect(page.querySelector(".tok-keyword")?.textContent).toBe("const");
    expect(page.querySelector(".tok-comment")?.textContent).toBe("// one");
    expect(page.querySelectorAll("table td")).toHaveLength(2);
    expect(page.querySelector("img")?.getAttribute("src")).toBe(
      "data:image/png;base64,AAAA",
    );
    expect(page.querySelectorAll(".role")).toHaveLength(2);
    // MathJax typesets both formulas as inline SVG.
    expect(page.querySelectorAll(".math svg")).toHaveLength(1);
    expect(page.querySelectorAll(".math-display svg")).toHaveLength(1);
    expect(page.querySelector('link[rel="stylesheet"], img[src^="http"]')).toBeNull();
  });

  it("leaves the role labels out when headings are off", async () => {
    const html = await buildHtmlDocument(
      MESSAGES,
      [],
      { ...DEFAULT_SETTINGS, headingStyle: "none" },
      { tabTitle: "ChatGPT", tabUrl: "https://chatgpt.com/c/1" },
    );
    const page = new DOMParser().parseFromString(html, "text/html");

    expect(page.querySelector(".role")).toBeNull();
    expect(page.title).toBe("ChatGPT");
  });
});

describe("HTML export: table of contents", () => {
  const chat = (questions: string[]) =>
    questions.flatMap((question, index) => [
      { id: `q${index}`, role: "user" as const, order: index * 2, content: question },
      { id: `a${index}`, role: "assistant" as const, order: index * 2 + 1, content: "An answer." },
    ]);

  it("lists the questions of a longer chat, each a link to where it's asked", async () => {
    const html = await buildHtmlDocument(
      chat([
        "How do I cook **rice**?",
        "![Image 1](images/image-001.png)\nWhat's \\(this\\) photo?",
        `And ${"very ".repeat(30)}long?`,
      ]),
      [],
      DEFAULT_SETTINGS,
      { tabTitle: "Cooking - ChatGPT", tabUrl: "https://chatgpt.com/c/1" },
    );
    const page = new DOMParser().parseFromString(html, "text/html");
    const links = [...page.querySelectorAll<HTMLAnchorElement>("nav.toc a")];

    expect(page.querySelector("nav.toc summary")?.textContent).toBe("Contents · 3 questions");
    expect(page.querySelector("nav.toc details")?.hasAttribute("open")).toBe(false);
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "#message-1",
      "#message-3",
      "#message-5",
    ]);
    expect(links[0].textContent).toBe("How do I cook rice?");
    expect(links[1].textContent).toBe("What's (this) photo?");
    expect(Array.from(links[2].textContent ?? "").length).toBeLessThanOrEqual(90);
    expect(links[2].textContent?.endsWith("…")).toBe(true);

    for (const link of links) {
      expect(page.getElementById(link.getAttribute("href")!.slice(1))?.className).toBe(
        "message message--user",
      );
    }
  });

  it("leaves it out of a short chat", async () => {
    const html = await buildHtmlDocument(chat(["Hi?", "Bye?"]), [], DEFAULT_SETTINGS, {
      tabTitle: "Short - ChatGPT",
      tabUrl: "https://chatgpt.com/c/1",
    });

    expect(new DOMParser().parseFromString(html, "text/html").querySelector(".toc")).toBeNull();
  });
});
