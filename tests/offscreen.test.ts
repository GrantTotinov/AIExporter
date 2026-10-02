import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * offscreen.ts makes the blob: URLs Chrome's service worker
 * can't (see the "Chrome service worker" tests in
 * background.test.ts). These check the offscreen side: the file
 * arrives as base64 and must come out byte for byte.
 */

const runtimeId = "test-extension-id";

type Listener = (
  message: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: any) => void,
) => boolean | void;

const listeners: Listener[] = [];

function send(
  message: Record<string, unknown>,
  sender: Partial<chrome.runtime.MessageSender> = { id: runtimeId },
): { handled: boolean; response: unknown } {
  let response: unknown;
  let responded = false;

  for (const listener of listeners) {
    listener(message, sender as chrome.runtime.MessageSender, (value) => {
      responded = true;
      response = value;
    });

    if (responded) {
      break;
    }
  }

  return { handled: responded, response };
}

describe("offscreen.ts download blob URLs", () => {
  beforeEach(async () => {
    vi.resetModules();
    listeners.length = 0;

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

  it("turns base64 content into a blob: URL of the same bytes and type", async () => {
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:chrome-extension://test-extension-id/abc");
    const bytes = new Uint8Array([0, 1, 2, 127, 128, 254, 255]);

    const { handled, response } = send({
      type: "OFFSCREEN_CREATE_BLOB_URL",
      content: btoa(String.fromCharCode(...bytes)),
      mimeType: "application/pdf",
    });

    expect(handled).toBe(true);
    expect(response).toEqual({
      success: true,
      url: "blob:chrome-extension://test-extension-id/abc",
    });

    const blob = createObjectURL.mock.calls[0][0] as Blob;

    expect(blob.type).toBe("application/pdf");
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([...bytes]);
  });

  it("reports malformed base64 instead of throwing", () => {
    const { response } = send({
      type: "OFFSCREEN_CREATE_BLOB_URL",
      content: "not base64!!",
      mimeType: "text/plain",
    });

    expect(response).toMatchObject({ success: false });
  });

  it("revokes blob: URLs and nothing else", () => {
    const revokeObjectURL = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);

    expect(
      send({
        type: "OFFSCREEN_REVOKE_BLOB_URL",
        url: "blob:chrome-extension://test-extension-id/abc",
      }).response,
    ).toEqual({ success: true });
    send({ type: "OFFSCREEN_REVOKE_BLOB_URL", url: "https://example.com/" });

    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith(
      "blob:chrome-extension://test-extension-id/abc",
    );
  });

  it("ignores messages from outside the extension", () => {
    const createObjectURL = vi.spyOn(URL, "createObjectURL");

    const { handled } = send(
      {
        type: "OFFSCREEN_CREATE_BLOB_URL",
        content: btoa("x"),
        mimeType: "text/plain",
      },
      { id: "some-other-extension" },
    );

    expect(handled).toBe(false);
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});
