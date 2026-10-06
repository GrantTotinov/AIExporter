import { describe, expect, it } from "vitest";
import {
  buildGrokListPath,
  buildGrokLoadPath,
  buildGrokNodesPath,
  convertGrokResponses,
  getGrokActiveResponseId,
  getGrokConversationId,
  parseGrokConversationList,
  parseGrokResponseNodes,
  parseGrokResponses,
} from "../src/grok-conversation";
import { NOTE_CLOSE, NOTE_OPEN } from "../src/source-notes";

/*
 * The fixtures follow the shape grok.com's web app gets from
 * /rest/app-chat/conversations/{id}/load-responses, as captured
 * responses and open-source exporters show it; xAI doesn't
 * document this API.
 */

const UUID = "0b2f7a52-1c3d-4e5f-8a9b-0c1d2e3f4a5b";

const note = (numbers: string): string => `${NOTE_OPEN}${numbers}${NOTE_CLOSE}`;

const citation = (cardId: string): string =>
  `<grok:render card_id="${cardId}" card_type="citation_card" type="render_inline_citation">` +
  `<argument name="citation_id">0</argument></grok:render>`;

/* A question with two replies: the first one, and a regenerated one that searched the web */
function responses() {
  return [
    {
      responseId: "r1",
      sender: "human",
      createTime: "2026-10-01T10:00:00.000Z",
      message: "Where should I travel in April?",
      fileAttachmentsMetadata: [
        {
          fileName: "map.png",
          fileMimeType: "image/png",
          fileUri: "users/u1/map.png",
        },
        {
          fileName: "plan.pdf",
          fileMimeType: "application/pdf",
          fileUri: "users/u1/plan.pdf",
        },
      ],
    },
    {
      responseId: "r2",
      sender: "assistant",
      parentResponseId: "r1",
      createTime: "2026-10-01T10:00:05.000Z",
      message: "A first reply.",
    },
    {
      responseId: "r3",
      sender: "ASSISTANT",
      parentResponseId: "r1",
      createTime: "2026-10-01T10:01:00.000Z",
      message:
        `Try Lisbon ${citation("c1")}. It's sunny then ${citation("c2")}` +
        '<grok:render card_id="x1" type="render_searched_image"></grok:render>.' +
        "<xai:tool_usage_card><xai:tool_name>web_search</xai:tool_name></xai:tool_usage_card>",
      cardAttachmentsJson: [
        JSON.stringify({
          id: "c1",
          type: "render_inline_citation",
          url: "https://example.com/lisbon",
        }),
        JSON.stringify({
          id: "c2",
          type: "render_inline_citation",
          url: "https://weather.example/lisbon",
        }),
        "not JSON",
      ],
      webSearchResults: [
        { url: "https://example.com/lisbon", title: "Lisbon guide" },
        { url: "https://other.example/porto", title: "Porto guide" },
      ],
      steps: [
        {
          toolUsageResults: [
            {
              webSearchResults: {
                results: [
                  { url: "https://weather.example/lisbon", title: "Lisbon weather" },
                ],
              },
            },
          ],
        },
      ],
      thinkingTrace: "Thinking about spring in Europe.",
      generatedImageUrls: ["users/u1/generated/lisbon.jpg"],
    },
  ];
}

describe("getGrokConversationId", () => {
  it("reads the id from a conversation's address", () => {
    expect(getGrokConversationId(`/c/${UUID}`)).toBe(UUID);
    expect(getGrokConversationId(`/chat/${UUID}/`)).toBe(UUID);
    expect(getGrokConversationId(`/en/c/${UUID}`)).toBe(UUID);
  });

  it("returns null on the other pages", () => {
    expect(getGrokConversationId("/")).toBeNull();
    expect(getGrokConversationId("/c/not-a-uuid")).toBeNull();
    expect(getGrokConversationId(`/project/${UUID}`)).toBeNull();
  });
});

describe("getGrokActiveResponseId", () => {
  it("reads the reply the address names", () => {
    expect(getGrokActiveResponseId("?rid=r2-abc")).toBe("r2-abc");
    expect(getGrokActiveResponseId("")).toBeNull();
    expect(getGrokActiveResponseId("?rid=a%20b")).toBeNull();
  });
});

describe("Grok requests", () => {
  it("asks for the responses' tree, the responses and the chat list", () => {
    expect(buildGrokNodesPath(UUID)).toBe(
      `/rest/app-chat/conversations/${UUID}/response-node?includeThreads=true`,
    );
    expect(buildGrokLoadPath(UUID)).toBe(
      `/rest/app-chat/conversations/${UUID}/load-responses`,
    );
    expect(buildGrokListPath(60, null)).toBe(
      "/rest/app-chat/conversations?pageSize=60",
    );
    expect(buildGrokListPath(60, "next=")).toBe(
      "/rest/app-chat/conversations?pageSize=60&pageToken=next%3D",
    );
  });

  it("reads every response's id once", () => {
    expect(
      parseGrokResponseNodes({
        responseNodes: [
          { responseId: "r1", sender: "human" },
          { responseId: "r2", sender: "assistant", parentResponseId: "r1" },
          { responseId: "r1" },
          {},
        ],
      }),
    ).toEqual(["r1", "r2"]);
  });

  it("rejects answers it can't read", () => {
    expect(() => parseGrokResponseNodes({})).toThrow(
      "Grok returned an unexpected conversation format.",
    );
    expect(() => parseGrokResponses({ responses: null })).toThrow(
      "Grok returned an unexpected conversation format.",
    );
    expect(parseGrokResponses({ responses: [{ responseId: "r1" }] })).toEqual([
      { responseId: "r1" },
    ]);
  });
});

describe("parseGrokConversationList", () => {
  it("lists the chats and the next page's token", () => {
    expect(
      parseGrokConversationList({
        conversations: [
          {
            conversationId: UUID,
            title: " Trip ideas ",
            createTime: "2026-10-01T10:00:00.000Z",
            modifyTime: "2026-10-02T10:00:00.000Z",
          },
          { conversationId: "c2", title: "Rice", createTime: "2026-09-01T10:00:00.000Z" },
          { title: "No id" },
        ],
        nextPageToken: "next",
      }),
    ).toEqual({
      conversations: [
        {
          id: UUID,
          title: "Trip ideas",
          createdAt: Date.parse("2026-10-01T10:00:00.000Z"),
          updatedAt: Date.parse("2026-10-02T10:00:00.000Z"),
        },
        {
          id: "c2",
          title: "Rice",
          createdAt: Date.parse("2026-09-01T10:00:00.000Z"),
          updatedAt: Date.parse("2026-09-01T10:00:00.000Z"),
        },
      ],
      nextCursor: "next",
    });
  });

  it("stops after the last page, and rejects a list it can't read", () => {
    expect(
      parseGrokConversationList({ conversations: [], nextPageToken: "" }).nextCursor,
    ).toBeNull();
    expect(() => parseGrokConversationList({})).toThrow(
      "Grok returned an unexpected chat list format.",
    );
  });
});

describe("convertGrokResponses", () => {
  it("follows the newest reply, with its citations, thinking and pictures", () => {
    expect(convertGrokResponses(responses(), null)).toEqual([
      {
        id: "r1",
        role: "user",
        parts: [
          {
            kind: "image",
            image: { url: "https://assets.grok.com/users/u1/map.png", fileName: "map.png" },
          },
          { kind: "text", text: "[Attachment: plan.pdf]" },
          { kind: "text", text: "Where should I travel in April?" },
        ],
        time: Date.parse("2026-10-01T10:00:00.000Z"),
      },
      {
        id: "r3",
        role: "assistant",
        parts: [
          {
            kind: "text",
            text: `Try Lisbon${note("1")}. It's sunny then${note("2")}.`,
          },
          {
            kind: "image",
            image: {
              url: "https://assets.grok.com/users/u1/generated/lisbon.jpg",
              fileName: "image",
            },
          },
        ],
        thinking: "Thinking about spring in Europe.",
        // The pages it cited first, then the rest it found
        sources: [
          { title: "Lisbon guide", url: "https://example.com/lisbon" },
          { title: "Lisbon weather", url: "https://weather.example/lisbon" },
          { title: "Porto guide", url: "https://other.example/porto" },
        ],
        time: Date.parse("2026-10-01T10:01:00.000Z"),
      },
    ]);
  });

  it("follows the reply the address names", () => {
    expect(
      convertGrokResponses(responses(), "r2").map((message) => message.parts),
    ).toEqual([
      expect.any(Array),
      [{ kind: "text", text: "A first reply." }],
    ]);
  });

  it("ignores a named reply it doesn't have", () => {
    expect(
      convertGrokResponses(responses(), "gone").map((message) => message.id),
    ).toEqual(["r1", "r3"]);
  });

  it("reads the thinking from the reply's steps when there's no trace", () => {
    const [, reply] = convertGrokResponses(
      [
        { responseId: "r1", sender: "human", message: "Hi" },
        {
          responseId: "r2",
          sender: "assistant",
          parentResponseId: "r1",
          message: "Hello!",
          steps: [
            { text: ["Greeting back."], tags: [] },
            { text: "web_search(query)", tags: ["tool_usage_card"] },
            { text: "<xai:tool_name>x</xai:tool_name> Done." },
          ],
        },
      ],
      null,
    );

    expect(reply.thinking).toBe("Greeting back.\n\nDone.");
  });

  it("drops a citation whose card it can't find", () => {
    const [, reply] = convertGrokResponses(
      [
        { responseId: "r1", sender: "human", message: "Hi" },
        {
          responseId: "r2",
          sender: "assistant",
          parentResponseId: "r1",
          message: `Hello ${citation("missing")} there ${citation("bad")}.`,
          cardAttachmentsJson: [
            JSON.stringify({ id: "bad", url: "javascript:alert(1)" }),
          ],
        },
      ],
      null,
    );

    expect(reply).toEqual({
      id: "r2",
      role: "assistant",
      parts: [{ kind: "text", text: "Hello there." }],
    });
  });
});
