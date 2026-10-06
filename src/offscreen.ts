const devLog = (...args: unknown[]): void => {
  if (import.meta.env.DEV) {
    console.log(...args);
  }
};

const devError = (...args: unknown[]): void => {
  if (import.meta.env.DEV) {
    console.error(...args);
  }
};

/*
 * ---------------------------------------------------------
 * MODERN CLIPBOARD API
 * ---------------------------------------------------------
 *
 * navigator.clipboard.writeText() is the current standard
 * clipboard API: async, no visible/focused element required,
 * and not deprecated. It works from the offscreen document
 * (it has its own DOM, so focus/visibility quirks that block
 * clipboard writes from a hidden background page don't apply
 * here) as long as clipboardWrite is in the manifest, which
 * it already is.
 */
async function copyUsingClipboardApi(text: string): Promise<boolean> {
  if (!navigator.clipboard?.writeText) {
    return false;
  }

  try {
    await navigator.clipboard.writeText(text);

    return true;
  } catch (error) {
    devError("AI Exporter: navigator.clipboard.writeText failed", error);

    return false;
  }
}

/*
 * ---------------------------------------------------------
 * LEGACY FALLBACK
 * ---------------------------------------------------------
 *
 * document.execCommand("copy") is deprecated but still
 * works in current Chrome. Kept as a fallback in case
 * navigator.clipboard is ever unavailable in the offscreen
 * document context on some Chrome version, so a single
 * clipboard failure mode doesn't turn into a hard break.
 */
function copyUsingExecCommand(text: string): boolean {
  const textarea = document.getElementById(
    "clipboard-helper",
  ) as HTMLTextAreaElement | null;

  if (!textarea) {
    devError("AI Exporter: clipboard-helper textarea missing");

    return false;
  }

  textarea.value = text;
  textarea.focus();
  textarea.select();

  const success = document.execCommand("copy");

  textarea.value = "";

  return success;
}

/*
 * ---------------------------------------------------------
 * FORMATTED TEXT
 * ---------------------------------------------------------
 *
 * A copied chat comes with an HTML version too (see
 * clipboard-export.ts), put on the clipboard next to the plain
 * text so Word, Google Docs and mail paste it formatted.
 * ClipboardItem writes both at once. Where that fails - this
 * document never has focus, which navigator.clipboard can insist
 * on - a "copy" event fills both in, the way a page's own copy
 * handler does.
 */
async function copyRichUsingClipboardApi(
  text: string,
  html: string,
): Promise<boolean> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    return false;
  }

  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": new Blob([text], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" }),
      }),
    ]);

    return true;
  } catch (error) {
    devError("AI Exporter: navigator.clipboard.write failed", error);

    return false;
  }
}

function copyRichUsingExecCommand(text: string, html: string): boolean {
  const fill = (event: ClipboardEvent): void => {
    event.preventDefault();
    event.clipboardData?.setData("text/plain", text);
    event.clipboardData?.setData("text/html", html);
  };

  document.addEventListener("copy", fill);

  try {
    return copyUsingExecCommand(text);
  } finally {
    document.removeEventListener("copy", fill);
  }
}

async function copyToClipboard(text: string, html = ""): Promise<boolean> {
  if (html) {
    if (
      (await copyRichUsingClipboardApi(text, html)) ||
      copyRichUsingExecCommand(text, html)
    ) {
      return true;
    }

    devLog("AI Exporter: formatted copy failed, copying the text alone");
  }

  const modernResult = await copyUsingClipboardApi(text);

  if (modernResult) {
    return true;
  }

  devLog(
    "AI Exporter: navigator.clipboard unavailable, falling back to execCommand",
  );

  return copyUsingExecCommand(text);
}

/*
 * ---------------------------------------------------------
 * DOWNLOAD BLOB URLS
 * ---------------------------------------------------------
 *
 * Chrome's MV3 service worker has no URL.createObjectURL(), so
 * background.ts has this document turn an export file (sent as
 * base64) into a blob: URL for chrome.downloads, and revoke it
 * once the download is over. A blob: URL lives as long as the
 * document that made it, and this one outlives the popup.
 *
 * Decodes inline rather than importing zip.ts's decodeBase64():
 * offscreen.html loads this file as a classic script, which
 * can't `import` the chunk Rollup would split it into.
 */
function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (
    message.type !== "OFFSCREEN_CREATE_BLOB_URL" &&
    message.type !== "OFFSCREEN_REVOKE_BLOB_URL"
  ) {
    return false;
  }

  if (sender.id !== chrome.runtime.id) {
    return false;
  }

  try {
    if (message.type === "OFFSCREEN_REVOKE_BLOB_URL") {
      if (typeof message.url === "string" && message.url.startsWith("blob:")) {
        URL.revokeObjectURL(message.url);
      }

      sendResponse({ success: true });

      return false;
    }

    const blob = new Blob([decodeBase64(String(message.content ?? ""))], {
      type: String(message.mimeType ?? ""),
    });

    sendResponse({ success: true, url: URL.createObjectURL(blob) });
  } catch (error) {
    devError("AI Exporter: offscreen blob URL failed", error);

    sendResponse({
      success: false,
      error: String(error),
    });
  }

  return false;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "OFFSCREEN_COPY") {
    return false;
  }

  if (sender.id !== chrome.runtime.id) {
    return false;
  }

  (async () => {
    try {
      const text = String(message.data ?? "");
      const html = typeof message.html === "string" ? message.html : "";

      const success = await copyToClipboard(text, html);

      if (!success) {
        throw new Error("Clipboard write failed");
      }

      devLog("AI Exporter: offscreen clipboard write successful");

      sendResponse({
        success: true,
      });
    } catch (error) {
      devError("AI Exporter: offscreen clipboard failed", error);

      sendResponse({
        success: false,
        error: String(error),
      });
    }
  })();

  return true;
});
