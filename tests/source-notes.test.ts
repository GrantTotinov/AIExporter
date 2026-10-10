import { describe, expect, it } from "vitest";
import {
  NOTE_CLOSE,
  NOTE_OPEN,
  bracketNotes,
  bracketSourceList,
  hasNotes,
  markdownFootnoteDefinitions,
  markdownFootnotes,
  markdownSourceLink,
  noteNumbers,
  normalizeNotes,
  replaceNotes,
  sourceHost,
  sourceLabel,
  stripNotes,
} from "../src/source-notes";
import { ReplySources, isWebAddress, replyExtras } from "../src/reply-sources";

const note = (...numbers: number[]) => `${NOTE_OPEN}${numbers.join(",")}${NOTE_CLOSE}`;

const SOURCES = [
  { title: "Wikipedia: Rome", url: "https://en.wikipedia.org/wiki/Rome" },
  { title: "", url: "https://www.example.com/page" },
  { title: "Uploaded notes.pdf", url: "" },
];

describe("the two sides agree", () => {
  it("reads the notes reply-sources.ts writes", () => {
    const sources = new ReplySources();
    const first = sources.add("https://a.example/", "A");
    const second = sources.add("https://b.example/", "B");
    const text = `One${sources.note([first])} and two${sources.note([first, second])}.`;

    expect(text).toBe(`One${note(1)} and two${note(1, 2)}.`);
    expect(bracketNotes(text, sources.list)).toBe("One[1] and two[1][2].");
  });
});

describe("ReplySources", () => {
  it("numbers each page once, in the order it's first cited", () => {
    const sources = new ReplySources();

    expect(sources.add("https://a.example/x", "A")).toBe(1);
    expect(sources.add("https://b.example/y")).toBe(2);
    expect(sources.add("https://a.example/x", "A again")).toBe(1);
    expect(sources.numberOf("https://b.example/y")).toBe(2);
    expect(sources.size).toBe(2);
  });

  it("fills in a title a later mention knows", () => {
    const sources = new ReplySources();

    sources.add("https://b.example/y");
    sources.add("https://b.example/y", "  Bee   page ");

    expect(sources.list).toEqual([{ title: "Bee page", url: "https://b.example/y" }]);
  });

  it("keeps only web links, and sources named without one", () => {
    const sources = new ReplySources();

    expect(sources.add("javascript:alert(1)", "Bad")).toBe(1);
    expect(sources.list[0]).toEqual({ title: "Bad", url: "" });
    expect(sources.add("https://user:pass@a.example/")).toBeNull();
    expect(sources.add(undefined, "")).toBeNull();
    expect(isWebAddress("http://a.example/")).toBe(true);
    expect(isWebAddress("data:text/html,x")).toBe(false);
  });

  it("writes no note for nothing", () => {
    const sources = new ReplySources();

    expect(sources.note([null, undefined, 4])).toBe("");
  });

  it("leaves out empty thinking and sources", () => {
    expect(replyExtras("  \n", new ReplySources())).toEqual({});

    const sources = new ReplySources();
    sources.add("https://a.example/", "A");

    expect(replyExtras("\nThought.\n", sources)).toEqual({
      thinking: "Thought.",
      sources: [{ title: "A", url: "https://a.example/" }],
    });
  });
});

describe("notes", () => {
  it("cite only numbers the reply has, each once", () => {
    expect(noteNumbers("2,1,2,9,x", 3)).toEqual([2, 1]);
    expect(normalizeNotes(`a${note(4)}b${note(2, 7)}`, 3)).toBe(`ab${note(2)}`);
  });

  it("can be replaced or stripped", () => {
    const text = `Rome${note(1)} is old${note(1, 2)}.`;

    expect(hasNotes(text)).toBe(true);
    expect(stripNotes(text)).toBe("Rome is old.");
    expect(hasNotes(stripNotes(text))).toBe(false);
    expect(replaceNotes(text, 3, (numbers) => `<${numbers.join("+")}>`)).toBe(
      "Rome<1> is old<1+2>.",
    );
    expect(stripNotes(`half ${NOTE_OPEN}open`)).toBe("half open");
  });
});

describe("Markdown footnotes", () => {
  it("are numbered on from the replies before", () => {
    const text = `Rome${note(1)} and more${note(2, 3)}.`;

    expect(markdownFootnotes(text, SOURCES, 4)).toBe("Rome[^5] and more[^6][^7].");
    expect(markdownFootnoteDefinitions(SOURCES, 4)).toBe(
      [
        "[^5]: [Wikipedia: Rome](https://en.wikipedia.org/wiki/Rome)",
        "[^6]: [example.com](https://www.example.com/page)",
        "[^7]: Uploaded notes.pdf",
      ].join("\n"),
    );
  });

  it("escape brackets in titles", () => {
    expect(
      markdownSourceLink({ title: "[Draft] *notes*", url: "https://a.example/a%20b" }),
    ).toBe("[\\[Draft\\] \\*notes\\*](https://a.example/a%20b)");
  });

  it("are numbered from links the browser's way", () => {
    const sources = new ReplySources();

    sources.add("https://a.example/a b", "A");

    expect(sources.list[0].url).toBe("https://a.example/a%20b");
    expect(sources.add("https://a.example/a%20b")).toBe(1);
  });
});

describe("plain text", () => {
  it("lists the sources under the reply", () => {
    expect(bracketSourceList(SOURCES)).toBe(
      [
        "Sources:",
        "[1] Wikipedia: Rome - https://en.wikipedia.org/wiki/Rome",
        "[2] example.com - https://www.example.com/page",
        "[3] Uploaded notes.pdf",
      ].join("\n"),
    );
  });

  it("names a source by its site when it has no title", () => {
    expect(sourceHost("https://www.example.com/page")).toBe("example.com");
    expect(sourceLabel({ title: "", url: "https://www.example.com/page" })).toBe(
      "example.com",
    );
    expect(sourceLabel({ title: "", url: "" })).toBe("Source");
  });
});

describe("bracketNotes and small print", () => {
  it("writes a ChatGPT note's text without its <small> tags, but not in code", () => {
    const content = [
      "<small>Planning note: depart from Osaka.</small>",
      "",
      "```html",
      "<small>Tax included</small>",
      "```",
    ].join("\n");

    expect(bracketNotes(content, [])).toBe(
      ["Planning note: depart from Osaka.", "", "```html", "<small>Tax included</small>", "```"].join("\n"),
    );
  });
});
