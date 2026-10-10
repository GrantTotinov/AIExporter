import { describe, expect, it } from "vitest";
import { stripMarkdown } from "../src/markdown-strip";

describe("stripMarkdown", () => {
  it("returns plain text unchanged", () => {
    expect(stripMarkdown("Hello world")).toBe("Hello world");
  });

  it("removes Markdown headings", () => {
    expect(stripMarkdown("# Heading\n## Subheading")).toBe(
      "Heading\nSubheading",
    );
  });

  it("removes bold formatting", () => {
    expect(stripMarkdown("This is **bold** text.")).toBe("This is bold text.");
  });

  it("removes italic formatting", () => {
    expect(stripMarkdown("This is *italic* text.")).toBe(
      "This is italic text.",
    );
  });

  it("removes inline code formatting", () => {
    expect(stripMarkdown("Use `console.log()` here.")).toBe(
      "Use console.log() here.",
    );
  });

  it("preserves fenced code block content", () => {
    const markdown = "```ts\nconst x = 42;\nconsole.log(x);\n```";

    expect(stripMarkdown(markdown)).toBe("const x = 42;\nconsole.log(x);");
  });

  it("removes code block language identifiers", () => {
    expect(stripMarkdown("```javascript\nconst x = 1;\n```")).toBe(
      "const x = 1;",
    );
  });

  it("converts Markdown links to readable text and URL", () => {
    expect(stripMarkdown("[GitHub](https://github.com)")).toBe(
      "GitHub (https://github.com)",
    );
  });

  it("removes blockquote markers", () => {
    expect(stripMarkdown("> Hello\n> World")).toBe("Hello\nWorld");
  });

  it("converts unordered list markers to bullets", () => {
    expect(stripMarkdown("- First\n- Second")).toBe("• First\n• Second");
  });

  it("removes ordered list numbers", () => {
    expect(stripMarkdown("1. First\n2. Second")).toBe("First\nSecond");
  });

  it("converts horizontal rules", () => {
    expect(stripMarkdown("---")).toBe("----------");
  });

  it("collapses excessive blank lines", () => {
    expect(stripMarkdown("One\n\n\n\nTwo")).toBe("One\n\nTwo");
  });

  it("trims leading and trailing whitespace", () => {
    expect(stripMarkdown("  Hello world  ")).toBe("Hello world");
  });

  it("handles an empty string", () => {
    expect(stripMarkdown("")).toBe("");
  });

  it("handles mixed Markdown", () => {
    const markdown = `
# Title

**Hello** *world*

- Item one
- Item two

[GitHub](https://github.com)

> A quote

\`\`\`ts
const value = 42;
\`\`\`
`;

    const result = stripMarkdown(markdown);

    expect(result).toContain("Title");
    expect(result).toContain("Hello world");
    expect(result).toContain("• Item one");
    expect(result).toContain("• Item two");
    expect(result).toContain("GitHub (https://github.com)");
    expect(result).toContain("A quote");
    expect(result).toContain("const value = 42;");
    expect(result).not.toContain("**");
    expect(result).not.toContain("```");
  });
});

describe("stripMarkdown and ChatGPT's components", () => {
  it("leaves code alone: template literals, asterisks, list-like lines", () => {
    const markdown = [
      "```javascript",
      "console.log(`Total: ¥${total} ($${(total / 150).toFixed(2)})`);",
      "const area = w * h * d; // **not bold**",
      "- not a list",
      "```",
    ].join("\n");

    expect(stripMarkdown(markdown)).toBe(
      [
        "console.log(`Total: ¥${total} ($${(total / 150).toFixed(2)})`);",
        "const area = w * h * d; // **not bold**",
        "- not a list",
      ].join("\n"),
    );
  });

  it("writes a table without a header as label: value lines", () => {
    expect(
      stripMarkdown("| | |\n|---|---|\n| Total for 14 days | **¥255,000** |\n| Rate \\| note: | 150 |\n\nAfter."),
    ).toBe("Total for 14 days: ¥255,000\nRate | note: 150\n\nAfter.");
  });

  it("drops <small> tags and hard-break spaces", () => {
    expect(stripMarkdown("<small>Planning note.</small>\n\nLine one  \nLine two")).toBe(
      "Planning note.\n\nLine one\nLine two",
    );
  });
});
