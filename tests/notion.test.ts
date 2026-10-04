// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildNotionPage,
  notionLanguage,
  type NotionBlock,
} from "../src/notion-blocks";
import { DEFAULT_SETTINGS } from "../src/settings";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

let localStore: Record<string, unknown> = {};
let permitted = true;
const fetchMock = vi.fn<Fetch>();

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  localStore = {};
  permitted = true;

  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: localStore[key] })),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(localStore, items);
        }),
        remove: vi.fn(async (key: string) => {
          delete localStore[key];
        }),
      },
      sync: { get: vi.fn(async (defaults: unknown) => defaults) },
    },
    permissions: { contains: vi.fn(async () => permitted) },
    i18n: { getUILanguage: () => "en" },
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function content(block: NotionBlock): Record<string, unknown> {
  return block[block.type] as Record<string, unknown>;
}

function plain(block: NotionBlock): string {
  return (
    (content(block).rich_text as { text?: { content: string } }[]) ?? []
  )
    .map((part) => part.text?.content ?? "")
    .join("");
}

describe("Notion blocks", () => {
  const page = () =>
    buildNotionPage(
      [
        {
          id: "1",
          role: "user",
          order: 0,
          content: "How do I loop? See [docs](javascript:alert(1))",
        },
        {
          id: "2",
          role: "assistant",
          order: 1,
          content: [
            "# Loops",
            "",
            "Use **for** and see [the docs](https://example.com/for).",
            "",
            "```py",
            "for i in range(3):",
            "    print(i)",
            "```",
            "",
            "- one",
            "- two",
            "",
            "1. first",
            "",
            "| A | B |",
            "| --- | --- |",
            "| 1 | 2 |",
            "",
            "> quoted",
            "",
            "Inline \\(x^2\\) here:",
            "",
            "$$\\sum_{i=1}^n i$$",
          ].join("\n"),
        },
      ],
      DEFAULT_SETTINGS,
      { tabTitle: "Loop help - ChatGPT", tabUrl: "https://chatgpt.com/c/1" },
    );

  it("names the page after the chat", () => {
    expect(page().title).toBe("Loop help");
  });

  it("uses Notion's own block types", () => {
    const { blocks } = page();
    const types = blocks.map((block) => block.type);

    expect(types).toEqual([
      "paragraph", // where it came from
      "heading_2", // User
      "paragraph",
      "heading_2", // Assistant
      "heading_3",
      "paragraph",
      "code",
      "bulleted_list_item",
      "bulleted_list_item",
      "numbered_list_item",
      "table",
      "quote",
      "paragraph",
      "equation",
    ]);

    const code = blocks.find((block) => block.type === "code") as NotionBlock;

    expect(content(code).language).toBe("python");
    expect(plain(code)).toBe("for i in range(3):\n    print(i)");

    const table = blocks.find((block) => block.type === "table") as NotionBlock;

    expect(content(table).table_width).toBe(2);
    expect((content(table).children as unknown[]).length).toBe(2);

    expect(content(blocks[blocks.length - 1]).expression).toBe(
      "\\sum_{i=1}^n i",
    );

    const inline = blocks[blocks.length - 2];
    const parts = content(inline).rich_text as { type: string }[];

    expect(parts.some((part) => part.type === "equation")).toBe(true);
  });

  it("keeps only web links", () => {
    const { blocks } = page();
    const links = blocks.flatMap((block) =>
      ((content(block).rich_text ?? []) as { text?: { link?: { url: string } } }[])
        .map((part) => part.text?.link?.url)
        .filter(Boolean),
    );

    expect(links).toEqual([
      "https://chatgpt.com/c/1",
      "https://example.com/for",
    ]);
  });

  it("splits text longer than Notion allows", () => {
    const long = "a".repeat(4500);
    const { blocks } = buildNotionPage(
      [{ id: "1", role: "assistant", order: 0, content: long }],
      { ...DEFAULT_SETTINGS, headingStyle: "none" },
      { tabTitle: "x", tabUrl: undefined },
    );
    const parts = content(blocks[1]).rich_text as {
      text: { content: string };
    }[];

    expect(parts.map((part) => part.text.content.length)).toEqual([
      2000, 2000, 500,
    ]);
  });

  it("maps fence languages to Notion's names", () => {
    expect(notionLanguage("ts")).toBe("typescript");
    expect(notionLanguage("C++")).toBe("c++");
    expect(notionLanguage("csharp")).toBe("c#");
    expect(notionLanguage("sh")).toBe("shell");
    expect(notionLanguage("brainfuck")).toBe("plain text");
    expect(notionLanguage(undefined)).toBe("plain text");
  });
});

describe("Notion API", () => {
  it("splits a long page into requests Notion accepts", async () => {
    const { chunkBlocks } = await import("../src/notion");
    const paragraph: NotionBlock = {
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: [] },
    };
    const table: NotionBlock = {
      object: "block",
      type: "table",
      table: { children: Array.from({ length: 99 }, () => paragraph) },
    };

    expect(
      chunkBlocks(Array.from({ length: 250 }, () => paragraph)).map(
        (chunk) => chunk.length,
      ),
    ).toEqual([100, 100, 50]);
    expect(
      chunkBlocks(Array.from({ length: 12 }, () => table)).map(
        (chunk) => chunk.length,
      ),
    ).toEqual([9, 3]);
  });

  it("checks an integration key with Notion before keeping it", async () => {
    const notion = await import("../src/notion");

    await expect(notion.connectNotionWithToken("hello")).rejects.toThrow(
      /ntn_/,
    );

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ object: "user", bot: { workspace_name: "Home" } }),
    );

    const connection = await notion.connectNotionWithToken(
      "  ntn_abcdefghijklmnopqrstuvwxyz123  ",
    );

    expect(connection).toEqual({
      accessToken: "ntn_abcdefghijklmnopqrstuvwxyz123",
      workspaceName: "Home",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.notion.com/v1/users/me",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer ntn_abcdefghijklmnopqrstuvwxyz123",
          "Notion-Version": "2022-06-28",
        }),
      }),
    );
    expect(await notion.getNotionConnection()).toEqual(connection);
  });

  it("doesn't keep a key Notion rejects", async () => {
    const notion = await import("../src/notion");

    fetchMock.mockResolvedValueOnce(jsonResponse({ code: "unauthorized" }, 401));

    await expect(
      notion.connectNotionWithToken("ntn_abcdefghijklmnopqrstuvwxyz123"),
    ).rejects.toThrow(/didn't accept/);
    expect(await notion.getNotionConnection()).toBeNull();
  });

  it("asks for access to Notion first", async () => {
    const notion = await import("../src/notion");

    permitted = false;

    await expect(
      notion.connectNotionWithToken("ntn_abcdefghijklmnopqrstuvwxyz123"),
    ).rejects.toThrow(/allowed to reach Notion/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lists the shared pages by title", async () => {
    const notion = await import("../src/notion");

    localStore.notionConnection = { accessToken: "ntn_x", method: "token" };
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        results: [
          {
            object: "page",
            id: "p1",
            icon: { type: "emoji", emoji: "A" },
            properties: {
              Name: { type: "title", title: [{ plain_text: "Chats" }] },
            },
          },
          { object: "page", id: "p2", in_trash: true, properties: {} },
          { object: "page", id: "p3", properties: {} },
        ],
        has_more: false,
        next_cursor: null,
      }),
    );

    expect(await notion.listNotionPages()).toEqual([
      { id: "p1", title: "Chats", icon: "A" },
      { id: "p3", title: "Untitled" },
    ]);
  });

  it("creates the page, then adds the rest of its blocks", async () => {
    const notion = await import("../src/notion");
    const blocks = Array.from(
      { length: 150 },
      (): NotionBlock => ({
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: [] },
      }),
    );

    localStore.notionConnection = { accessToken: "ntn_x", method: "token" };
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ id: "new-page", url: "https://www.notion.so/new-page" }),
      )
      .mockResolvedValueOnce(jsonResponse({ results: [] }));

    const parentId = "0b2f7a52-1c3d-4e5f-8a9b-0c1d2e3f4a5b";

    await expect(
      notion.createNotionPage(parentId, "My chat", blocks),
    ).resolves.toEqual({ url: "https://www.notion.so/new-page" });

    const [createUrl, createInit] = fetchMock.mock.calls[0];
    const created = JSON.parse(String(createInit?.body));

    expect(createUrl).toBe("https://api.notion.com/v1/pages");
    expect(created.parent).toEqual({ type: "page_id", page_id: parentId });
    expect(created.properties.title.title[0].text.content).toBe("My chat");
    expect(created.children).toHaveLength(100);

    const [appendUrl, appendInit] = fetchMock.mock.calls[1];

    expect(appendUrl).toBe("https://api.notion.com/v1/blocks/new-page/children");
    expect(appendInit?.method).toBe("PATCH");
    expect(JSON.parse(String(appendInit?.body)).children).toHaveLength(50);
  });

  it("says when the chosen page is no longer shared", async () => {
    const notion = await import("../src/notion");

    localStore.notionConnection = { accessToken: "ntn_x", method: "token" };
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ code: "object_not_found", message: "nope" }, 404),
    );

    await expect(
      notion.createNotionPage("0b2f7a521c3d4e5f8a9b0c1d2e3f4a5b", "x", []),
    ).rejects.toThrow(/isn't shared with AI Exporter/);
  });

  it("forgets a token Notion no longer accepts", async () => {
    const notion = await import("../src/notion");

    localStore.notionConnection = { accessToken: "ntn_x", method: "token" };
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 401));

    await expect(notion.listNotionPages()).rejects.toThrow(/expired/);
    expect(localStore.notionConnection).toBeUndefined();
  });
});
