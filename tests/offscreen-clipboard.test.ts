// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * offscreen.ts writes a copied chat to the clipboard in Chrome: its
 * Markdown as plain text and, alongside it, its formatted HTML (see
 * clipboard-export.ts).
 */

const runtimeId = "test-extension-id";

type Listener = (
  message: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: any) => void,
) => boolean | void;

const listeners: Listener[] = [];

function send(message: Record<string, unknown>): Promise<any> {
  return new Promise((resolve) => {
    for (const listener of listeners) {
      if (listener(message, { id: runtimeId } as chrome.runtime.MessageSender, resolve) === true) {
        return;
      }
    }
  });
}

/* A clipboard the copy event writes into, as the browser's does */
let copied: Record<string, string>;

function fireCopyEvent(): boolean {
  const event = new Event("copy", { cancelable: true });

  Object.defineProperty(event, "clipboardData", {
    value: {
      setData: (type: string, value: string) => {
        copied[type] = value;
      },
    },
  });
  document.dispatchEvent(event);

  if (!event.defaultPrevented) {
    copied["text/plain"] = (document.activeElement as HTMLTextAreaElement).value;
  }

  return true;
}

class FakeClipboardItem {
  items: Record<string, Blob>;

  constructor(items: Record<string, Blob>) {
    this.items = items;
  }
}

describe("offscreen.ts clipboard", () => {
  let clipboardWrite: ReturnType<typeof vi.fn>;
  let clipboardWriteText: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    listeners.length = 0;
    copied = {};
    document.body.innerHTML = '<textarea id="clipboard-helper"></textarea>';

    clipboardWrite = vi.fn().mockResolvedValue(undefined);
    clipboardWriteText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write: clipboardWrite, writeText: clipboardWriteText },
    });
    document.execCommand = vi.fn(fireCopyEvent);

    vi.stubGlobal("chrome", {
      runtime: {
        id: runtimeId,
        onMessage: {
          addListener: (listener: Listener) => {
            listeners.push(listener);
          },
        },
      },
    });

    await import("../src/offscreen");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("writes the text and the formatted chat as one clipboard item", async () => {
    const response = await send({
      type: "OFFSCREEN_COPY",
      data: "## User\n\nHi",
      html: "<h2>User</h2>\n<p>Hi</p>",
    });

    expect(response).toEqual({ success: true });

    const [[[item]]] = clipboardWrite.mock.calls as [[[FakeClipboardItem]]];

    expect(await item.items["text/plain"].text()).toBe("## User\n\nHi");
    expect(await item.items["text/html"].text()).toBe("<h2>User</h2>\n<p>Hi</p>");
    expect(clipboardWriteText).not.toHaveBeenCalled();
  });

  it("fills both in from a copy event when the document has no focus", async () => {
    clipboardWrite.mockRejectedValue(new DOMException("Document is not focused."));

    const response = await send({
      type: "OFFSCREEN_COPY",
      data: "## User\n\nHi",
      html: "<h2>User</h2>",
    });

    expect(response).toEqual({ success: true });
    expect(copied).toEqual({
      "text/plain": "## User\n\nHi",
      "text/html": "<h2>User</h2>",
    });
  });

  it("copies plain text alone when there's no HTML", async () => {
    const response = await send({ type: "OFFSCREEN_COPY", data: "# hello" });

    expect(response).toEqual({ success: true });
    expect(clipboardWriteText).toHaveBeenCalledWith("# hello");
    expect(clipboardWrite).not.toHaveBeenCalled();
  });
});
