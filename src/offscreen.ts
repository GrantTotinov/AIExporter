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

async function copyToClipboard(text: string): Promise<boolean> {
  const modernResult = await copyUsingClipboardApi(text);

  if (modernResult) {
    return true;
  }

  devLog(
    "AI Exporter: navigator.clipboard unavailable, falling back to execCommand",
  );

  return copyUsingExecCommand(text);
}

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

      const success = await copyToClipboard(text);

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
