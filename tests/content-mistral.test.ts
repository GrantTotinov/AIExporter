// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://chat.mistral.ai/chat/0b2f7a52-1c3d-4e5f-8a9b-0c1d2e3f4a5b"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadContentScript, type ContentScript } from "./content-harness";

/*
 * Le Chat has no API AI Exporter reads: the content script reads
 * the open conversation from the page (dom-conversation.ts).
 */
let page: ContentScript;

describe("content.ts on chat.mistral.ai", () => {
  beforeEach(async () => {
    document.body.innerHTML = `
      <div data-message-author-role="user" data-message-id="u1"><div class="select-text">Rice?</div></div>
      <div data-message-author-role="assistant" data-message-id="a1">
        <div data-message-part-type="answer"><p>Rinse it, then <em>simmer</em>.</p></div>
      </div>`;
    page = await loadContentScript();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reads the conversation from the page, without any request", async () => {
    const response = await page.send({ type: "LOAD_CONVERSATION", downloadImagesLocally: false });

    expect(page.fetchMock).not.toHaveBeenCalled();
    expect(page.getURL).not.toHaveBeenCalled();
    expect(response).toEqual({
      success: true,
      data: {
        messages: [
          { id: "u1", role: "user", content: "Rice?", imagePaths: [], order: 0 },
          { id: "a1", role: "assistant", content: "Rinse it, then *simmer*.", imagePaths: [], order: 1 },
        ],
        images: [],
      },
    });
  });

  it("says when the page shows no conversation", async () => {
    document.body.innerHTML = "<main>Welcome</main>";

    expect(await page.send({ type: "LOAD_CONVERSATION", downloadImagesLocally: false })).toEqual({
      success: false,
      error: "No messages found on this Le Chat page. Open a chat and wait for it to load, then try again.",
    });
  });

  it("can't export another conversation than the open one", async () => {
    expect(
      await page.send({ type: "LOAD_CONVERSATION", downloadImagesLocally: false, conversationId: "other123" }),
    ).toEqual({
      success: false,
      error: "Le Chat chats can only be exported one at a time, from the open chat.",
    });
  });
});
