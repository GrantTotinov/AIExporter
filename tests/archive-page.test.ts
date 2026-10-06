// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/*
 * The "Open a data export" page (archive.ts) with a Claude export
 * picked: its chats listed, searched, read and saved. Reading the
 * export itself is covered by chat-archive.test.ts.
 */
const PAGE = readFileSync("public/archive.html", "utf8");
const BODY = PAGE.slice(PAGE.indexOf("<body>") + 6, PAGE.indexOf("</body>"));

const EXPORT = JSON.stringify([
  {
    uuid: "11111111-2222-3333-4444-555555555555",
    name: "Bread",
    updated_at: "2026-09-02T10:00:00Z",
    chat_messages: [
      { uuid: "m1", sender: "human", text: "How do I bake bread?" },
      { uuid: "m2", sender: "assistant", text: "Knead the dough." },
    ],
  },
  {
    uuid: "66666666-7777-8888-9999-000000000000",
    name: "Rice",
    updated_at: "2026-09-01T10:00:00Z",
    chat_messages: [
      { uuid: "m3", sender: "human", text: "Rice?" },
      { uuid: "m4", sender: "assistant", text: "Rinse it." },
    ],
  },
]);

const download = vi.fn(async () => 7);

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});

async function openPage(): Promise<void> {
  document.body.innerHTML = BODY;
  vi.stubGlobal("chrome", {
    storage: {
      sync: { get: vi.fn(async (defaults: Record<string, unknown>) => defaults) },
      local: { get: vi.fn(async () => ({})) },
    },
    i18n: { getUILanguage: () => "en-US" },
    downloads: { download },
  });
  URL.createObjectURL = vi.fn(() => "blob:zip");
  URL.revokeObjectURL = vi.fn();
  vi.resetModules();
  await import("../src/archive");
}

function pick(text: string): void {
  const input = document.getElementById("archive-file") as HTMLInputElement;

  Object.defineProperty(input, "files", {
    value: [new File([text], "conversations.json", { type: "application/json" })],
    configurable: true,
  });
  input.dispatchEvent(new Event("change"));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the data export page", () => {
  it("lists the export's chats, newest first", async () => {
    await openPage();
    pick(EXPORT);

    await vi.waitFor(() => {
      expect(document.getElementById("archive-status")?.textContent).toBe("Chats from Claude: 2.");
    });
    expect(
      Array.from(document.querySelectorAll(".chat-row-title")).map((title) => title.textContent),
    ).toEqual(["Bread", "Rice"]);
    expect(document.getElementById("chats-card")?.hidden).toBe(false);
  });

  it("searches the messages and marks the words found", async () => {
    await openPage();
    pick(EXPORT);
    await vi.waitFor(() => expect(document.querySelectorAll(".chat-row")).toHaveLength(2));

    const search = document.getElementById("search") as HTMLInputElement;

    search.value = "rinse";
    search.dispatchEvent(new Event("input"));

    await vi.waitFor(() => {
      expect(
        Array.from(document.querySelectorAll(".chat-row-title")).map((title) => title.textContent),
      ).toEqual(["Rice"]);
    });

    document.querySelector<HTMLButtonElement>(".chat-row-open")?.click();

    expect((document.getElementById("preview") as HTMLDialogElement).open).toBe(true);
    expect(document.querySelector("#preview-body mark")?.textContent).toBe("Rinse");
  });

  it("says when the file isn't an export", async () => {
    await openPage();
    pick("{}");

    await vi.waitFor(() => {
      const status = document.getElementById("archive-status");

      expect(status?.textContent).toBe("This isn't a ChatGPT or Claude data export.");
      expect(status?.classList.contains("is-error")).toBe(true);
    });
  });

  it("saves the ticked chats in one ZIP", async () => {
    await openPage();
    pick(EXPORT);
    await vi.waitFor(() => expect(document.querySelectorAll(".chat-row")).toHaveLength(2));

    document.querySelector<HTMLInputElement>('input[value="md"]')!.click();
    document.querySelector<HTMLInputElement>(".chat-row input")!.click();
    expect(document.getElementById("summary-text")?.textContent).toBe(
      "Each one is saved as a Markdown file, all in one ZIP.",
    );
    document.getElementById("export")!.click();

    await vi.waitFor(() => {
      expect(document.getElementById("archive-status")?.textContent).toBe("Chats saved in one ZIP: 1.");
    });
    expect(download).toHaveBeenCalledWith({
      url: "blob:zip",
      filename: expect.stringMatching(/^claude-export-\d{4}-\d{2}-\d{2}\.zip$/),
      saveAs: true,
    });
  });
});
