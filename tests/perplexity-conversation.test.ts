import { describe, expect, it } from "vitest";
import {
  PERPLEXITY_HEADERS,
  buildPerplexityListRequest,
  buildPerplexityThreadPath,
  convertPerplexityEntries,
  getPerplexityThreadSlug,
  parsePerplexityThread,
  parsePerplexityThreadList,
} from "../src/perplexity-conversation";
import { NOTE_CLOSE, NOTE_OPEN } from "../src/source-notes";

/*
 * The fixtures follow the shape www.perplexity.ai's web app gets
 * from /rest/thread/{slug}, as open-source clients read it;
 * Perplexity doesn't document this API.
 */

const note = (numbers: string): string => `${NOTE_OPEN}${numbers}${NOTE_CLOSE}`;

const RICE_GUIDE = { title: "Rice guide", url: "https://example.com/rice" };
const WATER_RATIO = { title: "Water ratio", url: "https://example.org/water" };
const UNCITED = { title: "More rice", url: "https://more.example/rice" };

/* A Pro Search answer, as today's threads have it */
function entry() {
  return {
    backend_uuid: "e1",
    query_str: "How do I cook rice?",
    attachments: [
      "https://pplx-res.cloudinary.com/image/upload/v1/user_uploads/rice%20pot.jpg",
      { url: "https://files.example/recipe.pdf", name: "recipe.pdf" },
    ],
    blocks: [
      {
        intended_usage: "pro_search_steps",
        plan_block: {
          goals: [{ description: "Find a simple rice recipe" }, { description: " " }],
          steps: [],
        },
      },
      {
        intended_usage: "web_results",
        web_result_block: {
          web_results: [
            { name: RICE_GUIDE.title, url: RICE_GUIDE.url },
            { name: WATER_RATIO.title, url: WATER_RATIO.url },
            { name: UNCITED.title, url: UNCITED.url },
          ],
        },
      },
      {
        intended_usage: "ask_text",
        markdown_block: { answer: "An older copy.", chunks: ["An older copy."] },
      },
      {
        intended_usage: "ask_text_0_markdown",
        markdown_block: {
          answer:
            "Rinse the rice [1]. Use two cups of water [2][1].\n\n" +
            "```js\nconst cups = [1];\n```\n\n" +
            "See `pot[2]`, [the guide][1] and [4].",
        },
      },
    ],
  };
}

describe("getPerplexityThreadSlug", () => {
  it("reads the thread from its address", () => {
    expect(
      getPerplexityThreadSlug("/search/how-to-cook-rice-4kT3x7mRQ2yC1x0Pz6Hn8Q"),
    ).toBe("how-to-cook-rice-4kT3x7mRQ2yC1x0Pz6Hn8Q");
    expect(getPerplexityThreadSlug("/search/%E4%BD%A0%E5%A5%BD-abc/")).toBe(
      "你好-abc",
    );
    expect(getPerplexityThreadSlug("/search/50%25-off")).toBe("50%-off");
    expect(getPerplexityThreadSlug("/search/bad%E0%A4%A")).toBe("bad%E0%A4%A");
  });

  it("returns null on the other pages", () => {
    expect(getPerplexityThreadSlug("/")).toBeNull();
    expect(getPerplexityThreadSlug("/discover")).toBeNull();
    expect(getPerplexityThreadSlug("/search/")).toBeNull();
    expect(getPerplexityThreadSlug("/search/a/b")).toBeNull();
  });
});

describe("Perplexity requests", () => {
  it("asks for a thread a page at a time, oldest first", () => {
    expect(buildPerplexityThreadPath("rice-abc", 50, 50)).toBe(
      "/rest/thread/rice-abc?with_parent_info=true&with_schematized_response=true" +
        "&version=2.18&source=default&limit=50&offset=50&from_first=true",
    );
    expect(buildPerplexityThreadPath("50%-off", 0, 50)).toMatch(
      /^\/rest\/thread\/50%25-off\?/,
    );
  });

  it("asks for the library, newest first", () => {
    const request = buildPerplexityListRequest(20, 40);

    expect(request.path).toBe(
      "/rest/thread/list_ask_threads?version=2.18&source=default",
    );
    expect(JSON.parse(request.body)).toEqual({
      limit: 20,
      offset: 40,
      ascending: false,
      search_term: "",
    });
  });

  it("names the API version it reads", () => {
    expect(PERPLEXITY_HEADERS).toMatchObject({
      "x-app-apiclient": "default",
      "x-app-apiversion": "2.18",
    });
  });
});

describe("parsePerplexityThread", () => {
  it("reads the entries and whether more follow", () => {
    expect(
      parsePerplexityThread({ status: "success", entries: [1, 2], has_next_page: true }),
    ).toEqual({ entries: [1, 2], hasNextPage: true });
    expect(parsePerplexityThread({ steps: [] })).toEqual({
      entries: [],
      hasNextPage: false,
    });
  });

  it("rejects a thread it can't read", () => {
    expect(() => parsePerplexityThread({ status: "failed" })).toThrow(
      "Perplexity returned an unexpected thread format.",
    );
    expect(() => parsePerplexityThread(null)).toThrow(
      "Perplexity returned an unexpected thread format.",
    );
  });
});

describe("parsePerplexityThreadList", () => {
  it("lists the threads by their uuid", () => {
    expect(
      parsePerplexityThreadList([
        {
          uuid: "2b9e4c1a-7d3f-4e8b-9a6c-5d1e0f2a3b4c",
          slug: "rice-abc",
          title: " Rice ",
          last_query_datetime: "2026-10-02T08:00:00.000Z",
        },
        { uuid: "not a uuid!", slug: "x" },
        { uuid: "u2", slug: "", title: "No slug" },
        { uuid: "u3", slug: "q-xyz", query_str: "Only a question" },
      ]),
    ).toEqual([
      {
        id: "2b9e4c1a-7d3f-4e8b-9a6c-5d1e0f2a3b4c",
        slug: "rice-abc",
        title: "Rice",
        updatedAt: Date.parse("2026-10-02T08:00:00.000Z"),
      },
      { id: "u3", slug: "q-xyz", title: "Only a question", updatedAt: null },
    ]);
  });

  it("reads a list wrapped in an object, and rejects one it can't read", () => {
    expect(parsePerplexityThreadList({ threads: [] })).toEqual([]);
    expect(() => parsePerplexityThreadList({})).toThrow(
      "Perplexity returned an unexpected thread list format.",
    );
  });
});

describe("convertPerplexityEntries", () => {
  it("turns an answer's citations into notes, outside code and links", () => {
    expect(convertPerplexityEntries([entry()])).toEqual([
      {
        id: "e1-question",
        role: "user",
        parts: [
          {
            kind: "image",
            image: {
              url: "https://pplx-res.cloudinary.com/image/upload/v1/user_uploads/rice%20pot.jpg",
              fileName: "rice pot.jpg",
            },
          },
          { kind: "text", text: "[Attachment: recipe.pdf]" },
          { kind: "text", text: "How do I cook rice?" },
        ],
      },
      {
        id: "e1",
        role: "assistant",
        parts: [
          {
            kind: "text",
            text:
              `Rinse the rice${note("1")}. Use two cups of water${note("2,1")}.\n\n` +
              "```js\nconst cups = [1];\n```\n\n" +
              "See `pot[2]`, [the guide][1] and [4].",
          },
        ],
        thinking: "- Find a simple rice recipe",
        // The pages it cited first, then the rest it was given
        sources: [RICE_GUIDE, WATER_RATIO, UNCITED],
      },
    ]);
  });

  it("gives a question and its answer the time it was asked", () => {
    const [question, answer] = convertPerplexityEntries([
      { ...entry(), updated_datetime: "2026-10-02T08:05:00.5", created_datetime: "2026-10-02T08:00:00" },
    ]);

    // Without a time zone, as Perplexity writes it: UTC
    expect(question.time).toBe(Date.UTC(2026, 9, 2, 8, 0, 0));
    expect(answer.time).toBe(Date.UTC(2026, 9, 2, 8, 0, 0));
    expect(
      convertPerplexityEntries([{ ...entry(), updated_datetime: "2026-10-02T08:05:00Z" }])[0].time,
    ).toBe(Date.UTC(2026, 9, 2, 8, 5, 0));
    expect(convertPerplexityEntries([entry()])[0]).not.toHaveProperty("time");
  });

  it("reads older entries, whose answer is JSON inside the final step", () => {
    const messages = convertPerplexityEntries([
      {
        uuid: "e2",
        query_str: "And brown rice?",
        text: JSON.stringify([
          { step_type: "INITIAL_QUERY", content: { query: "And brown rice?" } },
          {
            step_type: "FINAL",
            content: {
              answer: JSON.stringify({
                answer:
                  "<think>Brown rice takes longer.</think>\nCook it for 45 minutes [1].",
                web_results: [{ name: "Brown rice", url: "https://brown.example/" }],
              }),
            },
          },
        ]),
      },
    ]);

    expect(messages).toEqual([
      {
        id: "e2-question",
        role: "user",
        parts: [{ kind: "text", text: "And brown rice?" }],
      },
      {
        id: "e2",
        role: "assistant",
        parts: [{ kind: "text", text: `Cook it for 45 minutes${note("1")}.` }],
        thinking: "Brown rice takes longer.",
        sources: [{ title: "Brown rice", url: "https://brown.example/" }],
      },
    ]);
  });

  it("finds the web results in the search steps when there's no results block", () => {
    const [, answer] = convertPerplexityEntries([
      {
        backend_uuid: "e3",
        query_str: "Rice?",
        blocks: [
          {
            intended_usage: "pro_search_steps",
            plan_block: {
              steps: [
                {
                  step_type: "SEARCH_RESULTS",
                  web_results_content: {
                    web_results: [{ name: RICE_GUIDE.title, url: RICE_GUIDE.url }],
                  },
                },
              ],
            },
          },
          {
            intended_usage: "ask_text",
            markdown_block: { answer: "Boil it [1]." },
          },
        ],
      },
    ]);

    expect(answer.parts).toEqual([
      { kind: "text", text: `Boil it${note("1")}.` },
    ]);
    expect(answer.sources).toEqual([RICE_GUIDE]);
  });

  it("keeps a question that has no answer yet", () => {
    expect(
      convertPerplexityEntries([
        { backend_uuid: "e4", query_str: "Still thinking?", blocks: [] },
      ]),
    ).toEqual([
      {
        id: "e4-question",
        role: "user",
        parts: [{ kind: "text", text: "Still thinking?" }],
      },
    ]);
  });

  it("names an attachment whose address it can't decode as it is", () => {
    const [question] = convertPerplexityEntries([
      {
        backend_uuid: "e5",
        query_str: "This?",
        attachments: ["https://files.example/report%E0.pdf"],
      },
    ]);

    expect(question.parts[0]).toEqual({
      kind: "text",
      text: "[Attachment: report%E0.pdf]",
    });
  });
});
