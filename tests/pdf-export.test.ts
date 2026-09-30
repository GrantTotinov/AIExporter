import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  fenceUserContent,
  fitToFont,
  parseBlocks,
  parseInline,
  preprocessRawContent,
  readCmapCoverage,
} from "../src/pdf-export";

const cp = (...codes: number[]) => String.fromCodePoint(...codes);

function fontCoverage(file: string): Set<number> {
  const url = new URL(`../public/fonts/${file}`, import.meta.url);
  return readCmapCoverage(new Uint8Array(readFileSync(url)));
}

const sans = fontCoverage("DejaVuSans.ttf");
const mono = fontCoverage("DejaVuSansMono.ttf");

describe("readCmapCoverage", () => {
  it("reports exactly the characters the font has glyphs for", () => {
    expect(sans.has("✓".codePointAt(0) ?? 0)).toBe(true);
    expect(sans.has("Ж".codePointAt(0) ?? 0)).toBe(true);
    expect(sans.has("✅".codePointAt(0) ?? 0)).toBe(false);
    expect(sans.has(0x09)).toBe(false);
  });
});

describe("fitToFont", () => {
  it("keeps characters the font can draw", () => {
    const text = "Copyright © 2024 ↔ ★ ✔ ♥ Жаба";
    expect(fitToFont(text, sans)).toBe(text);
  });

  it("falls back to the closest drawable glyph for common emoji", () => {
    expect(fitToFont("✅ ok ❌ no 😄", sans)).toBe("✓ ok ✗ no ☺");
  });

  it("drops other emoji together with their modifiers and joiners", () => {
    const text = `a🚀b👍${cp(0x1f3fd)}c${cp(0x1f468, 0x200d, 0x1f469)}d`;
    expect(fitToFont(text, sans)).toBe("abcd");
  });

  it("drops variation selectors and keycap combiners", () => {
    const text = `⚠${cp(0xfe0f)} 1${cp(0xfe0f, 0x20e3)}`;
    expect(fitToFont(text, sans)).toBe("⚠ 1");
  });

  it("uses a missing character's compatibility form when the font has it", () => {
    expect(fitToFont(cp(0x1d401, 0x1d428), sans)).toBe("Bo");
  });

  it("marks other missing characters instead of silently dropping them", () => {
    expect(fitToFont("中文 tail", sans)).toBe(`${cp(0xfffd, 0xfffd)} tail`);
  });

  it("turns whitespace the font lacks into spaces", () => {
    expect(fitToFont("a\tb", sans)).toBe("a b");
  });

  it("checks coverage against the font actually used", () => {
    expect(fitToFont("א", sans)).toBe("א");
    expect(fitToFont("א", mono)).toBe(cp(0xfffd));
  });
});

describe("preprocessRawContent", () => {
  const [open, sep, close] = [cp(0xe200), cp(0xe202), cp(0xe201)];

  it("folds a multi-line link onto one line and drops its title", () => {
    const markdown =
      '[throw for P256K crv\n…](https://x.io/commit/3159fb8 "throw for P256K crv\nand tests")';
    expect(preprocessRawContent(markdown)).toBe(
      "[throw for P256K crv …](https://x.io/commit/3159fb8)",
    );
  });

  it("keeps parentheses inside link URLs", () => {
    const markdown =
      "[Curve](https://en.wikipedia.org/wiki/Curve_(disambiguation))";
    expect(preprocessRawContent(markdown)).toBe(markdown);
  });

  it("leaves fenced code untouched", () => {
    const markdown = '```\n[a\nb](c "d")\n```';
    expect(preprocessRawContent(markdown)).toBe(markdown);
  });

  it("turns url tokens into links and removes citation tokens", () => {
    const markdown = `See ${open}url${sep}Issue #1${sep}https://x.io/1${close} now ${open}cite${sep}turn0search0${close}.`;
    expect(preprocessRawContent(markdown)).toBe(
      "See [Issue #1](https://x.io/1) now.",
    );
  });

  it("converts :::writing blocks into quoted lines with hard breaks", () => {
    const markdown =
      ':::writing{variant="chat_message" id="1"}\nHi team,\nplease review.\n:::';
    expect(preprocessRawContent(markdown)).toBe(
      "> Hi team,  \n> please review.  ",
    );
  });
});

describe("fenceUserContent", () => {
  it("fences a whole git graph, keeping the intro and question outside", () => {
    const graph = [
      "*   3159fb8 (HEAD -> main) Merge branch 'main'",
      "|\\  ",
      "| * a1b2c3d Add tests",
      "|/|",
      "|\\ \\",
      "* | bddabbc372 Fix typo",
      "|/ ",
      "* 195b605 Add docs",
    ];
    const markdown = ["Here's the log:", ...graph, "What do you think?"].join(
      "\n",
    );

    expect(fenceUserContent(markdown)).toBe(
      ["Here's the log:", "```", ...graph, "```", "What do you think?"].join(
        "\n",
      ),
    );
  });

  it("keeps a terminal session with blank lines in one block", () => {
    const session = [
      "PS C:\\Repos\\app> git status",
      "On branch main",
      "",
      "Changes not staged for commit:",
      "        modified:   src/app.ts",
      "",
      "PS C:\\Repos\\app> npm test",
      "  All tests passed.",
    ].join("\n");

    expect(fenceUserContent(session)).toBe(`\`\`\`\n${session}\n\`\`\``);
  });

  it("fences unfenced source code, including blank lines between members", () => {
    const code = [
      "public class Validator",
      "{",
      "    private readonly ILogger _logger;",
      "",
      "    public Validator(ILogger logger)",
      "    {",
      "        _logger = logger;",
      "    }",
      "}",
    ];
    const markdown = [
      "Here is my code:",
      "",
      ...code,
      "",
      "Why does this fail?",
    ].join("\n");

    expect(fenceUserContent(markdown)).toBe(
      [
        "Here is my code:",
        "",
        "```",
        ...code,
        "```",
        "",
        "Why does this fail?",
      ].join("\n"),
    );
  });

  it("leaves prose, lists, quotes and pasted markdown alone", () => {
    const markdown = [
      "I have a few questions:",
      "- Should we validate `crv`?",
      "- What about 3 * 4 * 5?",
      "",
      "> Note: quoted",
      "> text",
      "",
      "[dotnet](https://github.com/dotnet)",
      "/",
      "[aspnetcore](https://github.com/dotnet/aspnetcore)",
      "",
      "## Description",
      "",
      "https://a.io/x/y",
      "https://b.io/z/w",
    ].join("\n");

    expect(fenceUserContent(markdown)).toBe(markdown);
  });

  it("leaves existing fences as they are", () => {
    const markdown = "```\n* abc1234 message\n* def5678 message\n```";
    expect(fenceUserContent(markdown)).toBe(markdown);
  });
});

describe("parseBlocks", () => {
  it("treats every line break in user text as a hard break", () => {
    expect(parseBlocks("first\nsecond", true)).toEqual([
      { type: "paragraph", text: "first\nsecond" },
    ]);
  });

  it("soft-wraps assistant text except for explicit hard breaks", () => {
    expect(parseBlocks("one\ntwo  \nthree")).toEqual([
      { type: "paragraph", text: "one two\nthree" },
    ]);
  });

  it("keeps hard breaks inside blockquotes", () => {
    expect(parseBlocks("> Hi team,  \n> please review.")).toEqual([
      { type: "blockquote", text: "Hi team,\nplease review." },
    ]);
  });
});

describe("parseInline", () => {
  beforeAll(() => {
    const textarea = {
      value: "",
      set innerHTML(html: string) {
        this.value = html;
      },
    };

    Object.defineProperty(globalThis, "document", {
      value: { createElement: () => textarea },
      configurable: true,
    });
  });

  it("parses markdown inside link labels", () => {
    expect(parseInline("[`3159fb8`](https://x.io/c)")).toEqual([
      { text: "3159fb8", code: true, link: "https://x.io/c" },
    ]);
  });

  it("parses links inside bold text", () => {
    expect(parseInline("**[Copilot](https://x.io)** said")).toEqual([
      { text: "Copilot", bold: true, link: "https://x.io" },
      { text: " said" },
    ]);
  });

  it("keeps parentheses inside URLs", () => {
    expect(parseInline("[W](https://e.org/A_(b))")).toEqual([
      { text: "W", link: "https://e.org/A_(b)" },
    ]);
  });

  it("leaves asterisks surrounded by spaces literal", () => {
    expect(parseInline("3 * 4 * 5")).toEqual([{ text: "3 * 4 * 5" }]);
  });

  it("parses bold italic", () => {
    expect(parseInline("***both***")).toEqual([
      { text: "both", bold: true, italic: true },
    ]);
  });
});
