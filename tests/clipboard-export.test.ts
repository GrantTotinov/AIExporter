// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildClipboardContent } from "../src/clipboard-export";
import type { Message } from "../src/export-builders";
import type { Settings } from "../src/settings";
import { NOTE_CLOSE, NOTE_OPEN } from "../src/source-notes";

const MESSAGES: Message[] = [
  { id: "1", role: "user", order: 0, content: "Is <b>this</b> safe? [x](javascript:alert(1))" },
  {
    id: "2",
    role: "assistant",
    order: 1,
    content: [
      "## Answer",
      "",
      `Use **bold** and \`code\`${NOTE_OPEN}1${NOTE_CLOSE}.`,
      "",
      "```ts",
      "const x = 1; // one",
      "```",
      "",
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "Euler: \\(e^{i\\pi} + 1 = 0\\)",
      "",
      "![Image 1](images/image-001.png)",
    ].join("\n"),
    imagePaths: ["images/image-001.png"],
    thinking: "Think it over.",
    sources: [{ title: "Guide", url: "https://guide.example/" }],
  },
];

const SOURCE = { tabTitle: "Safety - ChatGPT", tabUrl: "https://chatgpt.com/c/1" };

let stored: Partial<Settings> = {};

function parse(html: string): Document {
  return new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
}

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

describe("the copied chat", () => {
  it("is Markdown as plain text, without note properties or footnotes", async () => {
    const { text } = await buildClipboardContent(MESSAGES, SOURCE);

    expect(text).toContain("## User\n\nIs <b>this</b> safe?");
    expect(text).toContain("Use **bold** and `code`[1].");
    expect(text).not.toContain("tags:");
    expect(text).not.toContain("[^1]");
  });

  it("is formatted HTML too, with the styles written onto the elements", async () => {
    const { html } = await buildClipboardContent(MESSAGES, SOURCE);
    const page = parse(html);

    expect([...page.querySelectorAll("h2")].map((heading) => heading.textContent)).toEqual([
      "User",
      "Assistant",
    ]);
    expect(page.querySelector("h4")?.textContent).toBe("Answer");
    expect(page.querySelector("strong")?.textContent).toBe("bold");
    expect(page.querySelector("pre")?.getAttribute("style")).toContain("white-space:pre-wrap");
    expect(page.querySelector("pre code span")?.getAttribute("style")).toBe("color:#cf222e");
    expect(page.querySelector("td")?.getAttribute("style")).toContain("border:1px solid");
    expect(html).not.toContain("class=");
  });

  it("keeps formulas as their LaTeX and leaves pictures out, like the Markdown", async () => {
    const { html } = await buildClipboardContent(MESSAGES, SOURCE);
    const page = parse(html);

    expect([...page.querySelectorAll("code")].map((code) => code.textContent)).toContain(
      "e^{i\\pi} + 1 = 0",
    );
    expect(page.querySelector("img, svg")).toBeNull();
  });

  it("links the notes and lists the sources, but never a script link", async () => {
    const { html } = await buildClipboardContent(MESSAGES, SOURCE);
    const page = parse(html);

    expect(page.querySelector("sup a")?.getAttribute("href")).toBe("https://guide.example/");
    expect(page.querySelector("ol li a")?.textContent).toBe("Guide");
    expect(page.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(page.body.textContent).toContain("Is <b>this</b> safe?");
  });

  it("follows the settings: names, thinking and message details", async () => {
    stored = {
      headingStyle: "bold",
      includeThinking: true,
      includeMessageDetails: true,
      messageSeparator: "rule",
    };

    const { html } = await buildClipboardContent(
      [
        { ...MESSAGES[0], time: new Date(2026, 9, 3, 14, 5).getTime() },
        { ...MESSAGES[1], model: "gpt-4o" },
      ],
      SOURCE,
    );
    const page = parse(html);

    expect(page.querySelector("h2")).toBeNull();
    expect(page.querySelector("p strong")?.textContent).toBe("User:");
    expect(page.querySelector("p em")?.textContent).toBe("2026-10-03 14:05");
    expect(page.querySelector("blockquote")?.textContent).toBe("ThinkingThink it over.");
    expect(page.querySelectorAll("hr")).toHaveLength(1);
  });
});
