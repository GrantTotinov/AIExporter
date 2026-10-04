import { describe, expect, it } from "vitest";
import {
  FILE_NAME_PRESETS,
  asciiFileName,
  fileNamePreset,
  isSafeFileName,
  renderFileName,
  sanitizeFileName,
  standardFileName,
  titleSlug,
} from "../src/file-names";
import { buildFilename } from "../src/export-builders";

const date = new Date(2026, 9, 4, 14, 5);

describe("sanitizeFileName", () => {
  it("keeps titles readable while removing what Windows forbids", () => {
    expect(sanitizeFileName("Python: list comprehension")).toBe(
      "Python - list comprehension",
    );
    expect(sanitizeFileName("Meeting at 10:30")).toBe("Meeting at 10-30");
    expect(sanitizeFileName("What is 2/3?")).toBe("What is 2-3");
    expect(sanitizeFileName("C:\\Users\\me")).toBe("C - Users-me");
    expect(sanitizeFileName('Say "hi" <now> *please* ~5 min')).toBe(
      "Say 'hi' now please 5 min",
    );
  });

  it("drops invisible characters and spaces or dots at the ends", () => {
    expect(
      sanitizeFileName(
        `${String.fromCodePoint(0x200e)}Hello${String.fromCodePoint(0x202e)} world\u{7}`,
      ),
    ).toBe("Hello world");
    expect(sanitizeFileName("  ..Trip ideas...  ")).toBe("Trip ideas");
    expect(sanitizeFileName("Wait.. what")).toBe("Wait. what");
    expect(sanitizeFileName(`a\u{a0}b\u{3000}c\u{2028}d`)).toBe("a b cd");
  });

  it("keeps letters of every script", () => {
    expect(sanitizeFileName("Рецепта за баница")).toBe("Рецепта за баница");
    expect(sanitizeFileName("如何学习编程")).toBe("如何学习编程");
    expect(sanitizeFileName("שלום עולם")).toBe("שלום עולם");
    expect(sanitizeFileName("नमस्ते दुनिया")).toBe("नमस्ते दुनिया");
  });

  it("renames names Windows reserves", () => {
    expect(sanitizeFileName("con")).toBe("con_");
    expect(sanitizeFileName("LPT1")).toBe("LPT1_");
    expect(sanitizeFileName("console")).toBe("console");
  });

  it("caps long names without cutting a character in half", () => {
    const name = sanitizeFileName("编".repeat(200));

    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(180);
    expect(name).toBe("编".repeat(60));
  });

  it("returns nothing for text with nothing usable", () => {
    expect(sanitizeFileName(" ?*: ")).toBe("");
  });
});

describe("standard names", () => {
  it("are what AI Exporter always made", () => {
    expect(
      standardFileName({ title: "Trip ideas", site: "chatgpt", date }),
    ).toBe("chatgpt-export-trip-ideas-2026-10-04");
    expect(standardFileName({ title: "", site: "claude", date })).toBe(
      "claude-export-conversation-2026-10-04",
    );
  });

  it("keep titles in any script", () => {
    expect(titleSlug("Рецепта за баница!")).toBe("рецепта-за-баница");
    expect(titleSlug("如何学习编程")).toBe("如何学习编程");
    expect(titleSlug("नमस्ते दुनिया")).toBe("नमस्ते-दुनिया");
    expect(titleSlug("a".repeat(100))).toHaveLength(60);
  });
});

describe("renderFileName", () => {
  it("fills in the tokens, in any case", () => {
    expect(
      renderFileName("{date} {title}", { title: "Trip ideas", site: "gemini", date }),
    ).toBe("2026-10-04 Trip ideas");
    expect(
      renderFileName("{SITE} - {Title} - {date} {time}", {
        title: "Trip: Rome",
        site: "chatgpt",
        date,
      }),
    ).toBe("ChatGPT - Trip - Rome - 2026-10-04 14-05");
  });

  it("leaves other braces as they are", () => {
    expect(
      renderFileName("{title} {draft}", { title: "Notes", site: null, date }),
    ).toBe("Notes {draft}");
  });

  it("closes the gap a missing title leaves", () => {
    expect(
      renderFileName(FILE_NAME_PRESETS.siteTitleDate, {
        title: "",
        site: "chatgpt",
        date,
      }),
    ).toBe("ChatGPT - 2026-10-04");
  });

  it("falls back to the standard name when nothing is left", () => {
    expect(renderFileName("{title}", { title: "", site: "claude", date })).toBe(
      "claude-export-conversation-2026-10-04",
    );
    expect(renderFileName("   ", { title: "Hi", site: "claude", date })).toBe(
      "claude-export-hi-2026-10-04",
    );
  });
});

describe("fileNamePreset", () => {
  it("recognizes the ready-made patterns", () => {
    expect(fileNamePreset("")).toBe("standard");
    expect(fileNamePreset("{title}")).toBe("title");
    expect(fileNamePreset(" {date} {title} ")).toBe("dateTitle");
    expect(fileNamePreset("{site} - {title} - {date}")).toBe("siteTitleDate");
    expect(fileNamePreset("{title} ({date})")).toBeNull();
  });
});

describe("isSafeFileName", () => {
  it("accepts what file-names.ts makes", () => {
    for (const name of [
      "chatgpt-export-trip-ideas-2026-10-04.pdf",
      "2026-10-04 Trip ideas.md",
      "如何学习编程.docx",
      "con_.pdf",
    ]) {
      expect(isSafeFileName(name)).toBe(true);
    }
  });

  it("rejects paths, traversal and names a browser refuses", () => {
    for (const name of [
      "",
      "../x.pdf",
      "a/b.pdf",
      "a..b.pdf",
      " x.pdf",
      "x .pdf",
      "con.pdf",
      "x:y.pdf",
      "noextension",
      `x${"a".repeat(260)}.pdf`,
      42,
      null,
    ]) {
      expect(isSafeFileName(name)).toBe(false);
    }
  });

  it("accepts every name the patterns can produce", () => {
    const titles = [
      "Trip: Rome / Paris?",
      "  ..weird   name..  ",
      "如何学习编程",
      "con",
      `${String.fromCodePoint(0x200e)}Gemini title`,
      "",
    ];

    for (const template of [...Object.values(FILE_NAME_PRESETS), "{title} ({time})"]) {
      for (const title of titles) {
        const name = `${renderFileName(template, { title, site: "chatgpt", date })}.pdf`;

        expect(isSafeFileName(name), name).toBe(true);
      }
    }
  });
});

describe("asciiFileName", () => {
  it("keeps only plain ASCII letters, digits and dashes", () => {
    expect(asciiFileName("Café ideas.pdf")).toBe("Cafe-ideas.pdf");
    expect(asciiFileName("如何学习编程.docx")).toBe("chat-export.docx");
  });
});

describe("buildFilename", () => {
  it("names the file after the tab, without the site's name", () => {
    expect(
      buildFilename("Trip ideas - ChatGPT", "https://chatgpt.com/c/1", "pdf", "", date),
    ).toBe("chatgpt-export-trip-ideas-2026-10-04.pdf");
    expect(
      buildFilename(
        "Trip ideas - Claude",
        "https://claude.ai/chat/1",
        "md",
        "{date} {title}",
        date,
      ),
    ).toBe("2026-10-04 Trip ideas.md");
  });

  it("treats a tab that only shows the site's name as untitled", () => {
    expect(
      buildFilename("ChatGPT", "https://chatgpt.com/", "zip", "", date),
    ).toBe("chatgpt-export-conversation-2026-10-04.zip");
    expect(
      buildFilename(
        "DeepSeek - Into the Unknown",
        "https://chat.deepseek.com/a/chat/s/1",
        "md",
        "",
        date,
      ),
    ).toBe("deepseek-export-conversation-2026-10-04.md");
    expect(
      buildFilename("Perplexity", "https://www.perplexity.ai/search/1", "pdf", "", date),
    ).toBe("perplexity-export-conversation-2026-10-04.pdf");
  });

  it("names DeepSeek, Grok and Perplexity files after their site", () => {
    expect(
      buildFilename(
        "Trip ideas - DeepSeek",
        "https://chat.deepseek.com/a/chat/s/1",
        "pdf",
        "",
        date,
      ),
    ).toBe("deepseek-export-trip-ideas-2026-10-04.pdf");
    expect(
      buildFilename(
        "Trip ideas - Grok",
        "https://grok.com/c/1",
        "docx",
        "{site} - {title} - {date}",
        date,
      ),
    ).toBe("Grok - Trip ideas - 2026-10-04.docx");
    expect(
      buildFilename(
        "Trip ideas | Perplexity",
        "https://perplexity.ai/search/1",
        "html",
        "{title}",
        date,
      ),
    ).toBe("Trip ideas.html");
  });
});
