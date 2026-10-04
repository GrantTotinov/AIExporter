import { describe, expect, it } from "vitest";
import {
  chatGptThinking,
  convertChatGptCitations,
  type ChatGptMessageLike,
} from "../src/chatgpt-reply";
import { ReplySources } from "../src/reply-sources";
import { NOTE_CLOSE, NOTE_OPEN, bracketNotes } from "../src/source-notes";

const OPEN = String.fromCharCode(0xe200);
const CLOSE = String.fromCharCode(0xe201);
const SEP = String.fromCharCode(0xe202);

const cite = (...refs: string[]) => `${OPEN}cite${refs.map((ref) => `${SEP}${ref}`).join("")}${CLOSE}`;
const note = (...numbers: number[]) => `${NOTE_OPEN}${numbers.join(",")}${NOTE_CLOSE}`;

describe("convertChatGptCitations", () => {
  it("turns ChatGPT's citation markers into notes, in the order they're cited", () => {
    const sources = new ReplySources();
    const text = `Rome was founded in 753 BC. ${cite("turn0search3")} It has 2.8 million people. ${cite("turn0search1", "turn0search3")}`;
    const metadata = {
      content_references: [
        {
          type: "grouped_webpages",
          matched_text: cite("turn0search3"),
          items: [{ title: "History of Rome", url: "https://history.example/rome" }],
        },
        {
          type: "grouped_webpages",
          matched_text: cite("turn0search1", "turn0search3"),
          items: [
            {
              title: "Rome census",
              url: "https://stats.example/rome",
              supporting_websites: [
                { title: "History of Rome", url: "https://history.example/rome" },
              ],
            },
          ],
        },
      ],
    };

    const content = convertChatGptCitations(text, metadata, sources);

    expect(content).toBe(
      `Rome was founded in 753 BC.${note(1)} It has 2.8 million people.${note(2, 1)}`,
    );
    expect(sources.list).toEqual([
      { title: "History of Rome", url: "https://history.example/rome" },
      { title: "Rome census", url: "https://stats.example/rome" },
    ]);
  });

  it("adds ChatGPT's own source list after the cited pages", () => {
    const sources = new ReplySources();

    convertChatGptCitations(
      `Fact ${cite("turn0search0")}`,
      {
        content_references: [
          {
            type: "grouped_webpages",
            matched_text: cite("turn0search0"),
            items: [{ title: "A", url: "https://a.example/" }],
          },
          {
            type: "sources_footnote",
            matched_text: " ",
            sources: [
              { title: "A", url: "https://a.example/" },
              { attribution: "B site", url: "https://b.example/" },
            ],
          },
        ],
      },
      sources,
    );

    expect(sources.list).toEqual([
      { title: "A", url: "https://a.example/" },
      { title: "B site", url: "https://b.example/" },
    ]);
  });

  it("keeps the text of references without sources and drops image carousels", () => {
    const sources = new ReplySources();
    const content = convertChatGptCitations(
      `Try ${OPEN}product${SEP}x${CLOSE} or this. ${OPEN}i${SEP}turn0image0${CLOSE}`,
      {
        content_references: [
          {
            type: "product_entity",
            matched_text: `${OPEN}product${SEP}x${CLOSE}`,
            alt: "[Acme Kettle]()",
          },
          { type: "image_group", matched_text: `${OPEN}i${SEP}turn0image0${CLOSE}` },
        ],
      },
      sources,
    );

    expect(content).toBe("Try Acme Kettle or this.");
    expect(sources.size).toBe(0);
  });

  it("removes markers nothing explains, and makes url tokens links", () => {
    const content = convertChatGptCitations(
      `See ${OPEN}url${SEP}the docs${SEP}https://docs.example/${CLOSE}. Done ${cite("turn9search9")}`,
      {},
      new ReplySources(),
    );

    expect(content).toBe("See [the docs](https://docs.example/). Done");
  });

  it("reads the older 【n†source】 citations by position or number", () => {
    const sources = new ReplySources();
    const text = "Paris is big【11†source】. Lyon too【12†(Wiki)】.";
    const content = convertChatGptCitations(
      text,
      {
        citations: [
          {
            start_ix: text.indexOf("【11"),
            end_ix: text.indexOf("】") + 1,
            metadata: { title: "Paris", url: "https://paris.example/" },
          },
          {
            start_ix: 0,
            end_ix: 3,
            metadata: {
              title: "Lyon",
              url: "https://lyon.example/",
              extra: { cited_message_idx: 12 },
            },
          },
        ],
      },
      sources,
    );

    expect(bracketNotes(content, sources.list)).toBe("Paris is big[1]. Lyon too[2].");
  });
});

describe("chatGptThinking", () => {
  const message = (
    id: string,
    parent: string | null,
    rest: Omit<ChatGptMessageLike, "id"> & { parent?: never },
  ): ChatGptMessageLike & { parent: string | null } => ({ id, parent, ...rest });

  const conversation = [
    message("u1", null, { author: { role: "user" }, content: { content_type: "text", parts: ["Question"] } }),
    message("t1", "u1", {
      author: { role: "assistant" },
      content: {
        content_type: "thoughts",
        thoughts: [
          { summary: "Reading the question", content: "They want a summary." },
          { summary: "", content: "Check the dates." },
        ],
      },
    }),
    message("s1", "t1", {
      author: { role: "assistant" },
      content: { content_type: "code", parts: [] },
      metadata: { reasoning_title: "Searching the web" },
    }),
    message("p1", "s1", {
      author: { role: "assistant" },
      content: { content_type: "text", parts: ["Found two sources."] },
      metadata: { is_thinking_preamble_message: true },
    }),
    message("r1", "p1", {
      author: { role: "assistant" },
      content: { content_type: "reasoning_recap", parts: [] },
    }),
    message("a1", "r1", { author: { role: "assistant" }, content: { content_type: "text", parts: ["Answer"] } }),
  ];

  const byId = new Map<string, ChatGptMessageLike>(
    conversation.map((item) => [item.id as string, item]),
  );
  const parentOf = (item: ChatGptMessageLike) =>
    (item as { parent: string | null }).parent;

  it("gathers the reasoning between the question and the answer, oldest first", () => {
    expect(chatGptThinking(byId.get("a1")!, byId, parentOf)).toBe(
      [
        "**Reading the question**\n\nThey want a summary.",
        "Check the dates.",
        "*Searching the web*",
        "Found two sources.",
      ].join("\n\n"),
    );
  });

  it("finds nothing for a reply without reasoning", () => {
    const plain = new Map([
      ["u", message("u", null, { author: { role: "user" } })],
      ["a", message("a", "u", { author: { role: "assistant" } })],
    ]);

    expect(chatGptThinking(plain.get("a")!, plain, parentOf)).toBe("");
  });

  it("falls back to the reply's turn when there are no parent links", () => {
    const turn = { turn_exchange_id: "turn-1" };
    const loose = new Map<string, ChatGptMessageLike>([
      [
        "t",
        {
          id: "t",
          author: { role: "assistant" },
          create_time: 1,
          metadata: turn,
          content: { content_type: "thoughts", thoughts: [{ summary: "", content: "Hmm." }] },
        },
      ],
      ["a", { id: "a", author: { role: "assistant" }, create_time: 2, metadata: turn }],
    ]);

    expect(chatGptThinking(loose.get("a")!, loose, () => null)).toBe("Hmm.");
  });
});
