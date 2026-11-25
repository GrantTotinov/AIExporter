// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://chatgpt.com/"}
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadContentScript } from "./content-harness";

/*
 * "Save many chats" and the automatic backup list ChatGPT chats
 * through the page bridge. ChatGPT's sidebar list leaves out the
 * archived chats and the chats in projects, so the list goes on
 * to those once the sidebar's chats are listed.
 */

const item = (id: string) => ({ id, title: `Chat ${id}`, create_time: 1700000000 });

/* What each list request is answered with */
function answerList(request: Record<string, any>): unknown {
  switch (request.list) {
    case "chats":
      return { items: [item("c1"), item("c2")], total: 2 };
    case "archived":
      return { items: [], total: 0 };
    case "projects":
      return request.cursor === "p2"
        ? { items: [{ gizmo: { gizmo: { id: "g-p-c" } } }], cursor: null }
        : {
            items: [{ gizmo: { gizmo: { id: "g-p-a" } } }, { gizmo: { gizmo: { id: "g-p-b" } } }],
            cursor: "p2",
          };
    case "project":
      if (request.projectId === "g-p-a") {
        return request.cursor === "a2"
          ? { items: [item("a2")], cursor: null }
          : { items: [item("a1")], cursor: "a2" };
      }

      return request.projectId === "g-p-c"
        ? { items: [item("pc")], cursor: null }
        : { items: [], cursor: null };
  }
}

function fakeBridge(): { requests: Record<string, any>[]; ready: () => void } {
  const requests: Record<string, any>[] = [];
  const answer = (data: Record<string, unknown>): void => {
    const event = new Event("message");

    Object.defineProperties(event, {
      data: { value: { source: "AIExporter", ...data } },
      source: { value: window },
    });
    setTimeout(() => window.dispatchEvent(event), 0);
  };

  vi.spyOn(window, "postMessage").mockImplementation((message: any) => {
    if (message?.type === "AIExporter_LIST_REQUEST") {
      requests.push(message);
      answer({
        type: "AIExporter_API_RESPONSE",
        requestId: message.requestId,
        data: answerList(message),
      });
    }
  });

  return { requests, ready: () => answer({ type: "BRIDGE_READY" }) };
}

describe("ChatGPT's conversation list", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("lists the chats, then the archived ones, then every project's", async () => {
    const bridge = fakeBridge();
    const script = await loadContentScript();

    bridge.ready();

    const pages: { ids: string[]; urls: string[] }[] = [];
    let cursor: string | null = null;

    do {
      const response = await script.send({ type: "LIST_CONVERSATIONS_PAGE", cursor });

      expect(response.success).toBe(true);
      pages.push({
        ids: response.data.conversations.map((chat: { id: string }) => chat.id),
        urls: response.data.conversations.map((chat: { url: string }) => chat.url),
      });
      cursor = response.data.nextCursor;
    } while (cursor !== null);

    // No page comes back empty before the end: the bulk page stops at one.
    expect(pages.map((page) => page.ids)).toEqual([["c1", "c2"], ["a1"], ["a2"], ["pc"], []]);
    expect(pages[1].urls).toEqual(["https://chatgpt.com/c/a1"]);
    expect(
      bridge.requests.map(({ list, offset, cursor, projectId }) =>
        [list, offset, cursor, projectId].filter((part) => part != null).join(" "),
      ),
    ).toEqual([
      "chats 0",
      "archived 0",
      "projects 0",
      "projects 0 p2",
      "project 0 g-p-a",
      "project 0 a2 g-p-a",
      "project 0 g-p-b",
      "project 0 g-p-c",
    ]);
  });
});
