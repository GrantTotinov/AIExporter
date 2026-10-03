// @vitest-environment jsdom
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import POPUP_HTML from "../public/popup.html?raw";
import en from "../src/locales/en.json";

const { buildPdfBlob } = vi.hoisted(() => ({
  buildPdfBlob: vi.fn(
    async () => new Blob(["%PDF-1.7"], { type: "application/pdf" }),
  ),
}));

vi.mock("../src/pdf-export.ts", () => ({ buildPdfBlob }));

const POPUP_BODY = POPUP_HTML.slice(
  POPUP_HTML.indexOf("<body>") + "<body>".length,
  POPUP_HTML.indexOf("</body>"),
);

const UUID = "0b2f7a52-1c3d-4e5f-8a9b-0c1d2e3f4a5b";
const CHATGPT_TAB = {
  id: 7,
  url: `https://chatgpt.com/c/${UUID}`,
  title: "Trip ideas - ChatGPT",
};

const MESSAGES = [
  {
    id: "1",
    role: "user",
    order: 0,
    content: "Where should I go in **April**?",
  },
  {
    id: "2",
    role: "assistant",
    order: 1,
    content: "## Japan\n\nSee the [cherry blossoms](https://example.com/sakura).",
  },
  { id: "3", role: "user", order: 2, content: "Thanks!" },
];

type Response = { success: boolean; data?: unknown; error?: string };

let syncStore: Record<string, unknown> = {};
let localStore: Record<string, unknown> = {};
let activeTab: typeof CHATGPT_TAB | { id: number; url: string; title: string };
let conversation: Response | Promise<Response>;
let githubStatus: Response;
let githubRepos: Response;
let messageListeners: ((message: unknown) => void)[] = [];

const tabsSendMessage = vi.fn(
  async (_tabId: number, message: { type: string }) => {
    if (message.type === "LOAD_CONVERSATION") {
      return conversation;
    }

    return { success: true };
  },
);

const runtimeSendMessage = vi.fn(
  async (message: { type: string; filename?: string }) => {
    switch (message.type) {
      case "UPDATE_CHECK":
        return {
          success: true,
          data: { state: { latestVersion: "2.3.0", checkedAt: Date.now() } },
        };
      case "GITHUB_GET_STATUS":
        return githubStatus;
      case "GITHUB_LIST_REPOS":
        return githubRepos;
      case "GITHUB_SAVE_FILE":
        return {
          success: true,
          data: {
            htmlUrl: `https://github.com/me/notes/blob/main/exports/${message.filename}`,
          },
        };
      case "DOWNLOAD_START":
        return { success: true, data: { downloadId: 1 } };
      default:
        return { success: true };
    }
  },
);

const tabsCreate = vi.fn(async () => ({}));
const openOptionsPage = vi.fn();

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function rows(): HTMLLabelElement[] {
  return Array.from(document.querySelectorAll<HTMLLabelElement>(".message"));
}

function rowCheckbox(index: number): HTMLInputElement {
  return rows()[index].querySelector("input") as HTMLInputElement;
}

function sentMessages(type: string): Record<string, unknown>[] {
  return runtimeSendMessage.mock.calls
    .map(([message]) => message as Record<string, unknown>)
    .filter((message) => message.type === type);
}

function decodeBase64(content: string): string {
  return new TextDecoder().decode(
    Uint8Array.from(atob(content), (char) => char.charCodeAt(0)),
  );
}

async function openPopup(): Promise<void> {
  vi.stubGlobal("chrome", {
    storage: {
      sync: {
        get: vi.fn(async (defaults: Record<string, unknown>) => ({
          ...defaults,
          ...structuredClone(syncStore),
        })),
      },
      local: {
        get: vi.fn(async (key: string) =>
          key in localStore ? { [key]: localStore[key] } : {},
        ),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(localStore, items);
        }),
        remove: vi.fn(async (key: string) => {
          delete localStore[key];
        }),
      },
      onChanged: { addListener: vi.fn() },
    },
    runtime: {
      getManifest: () => ({ version: "2.3.0" }),
      getURL: (path: string) => `chrome-extension://test-id/${path}`,
      requestUpdateCheck: vi.fn(),
      sendMessage: runtimeSendMessage,
      onMessage: {
        addListener: (listener: (message: unknown) => void) => {
          messageListeners.push(listener);
        },
      },
      openOptionsPage,
    },
    tabs: {
      query: vi.fn(async () => [activeTab]),
      sendMessage: tabsSendMessage,
      create: tabsCreate,
      reload: vi.fn(async () => undefined),
    },
    i18n: { getUILanguage: () => "en-US" },
  });

  document.body.innerHTML = POPUP_BODY;
  document.body.className = "";

  vi.resetModules();
  await import("../src/popup.ts");

  await vi.waitFor(() => {
    expect(byId("chat-card").dataset.state).not.toBe("loading");
    expect(byId("update-status-text").textContent).toBe(
      en["popup.update.upToDate"],
    );
  });
}

async function openExportScreen(): Promise<void> {
  byId<HTMLButtonElement>("export").click();

  await vi.waitFor(() => {
    expect(byId("export-view").hidden).toBe(false);
  });
}

async function openGithubScreen(): Promise<void> {
  await openExportScreen();
  byId<HTMLButtonElement>("selector-github-button").click();

  /* Loaded: either the repo picker or a message instead of it */
  await vi.waitFor(() => {
    expect(byId("github-view").hidden).toBe(false);
    expect(
      !byId("github-form").hidden || byId("github-state-spinner").hidden,
    ).toBe(true);
  });
}

beforeAll(() => {
  /* jsdom has no modal dialogs */
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);

  syncStore = {};
  localStore = {};
  activeTab = { ...CHATGPT_TAB };
  conversation = { success: true, data: { messages: MESSAGES, images: [] } };
  githubStatus = { success: true, data: { connected: true, login: "me" } };
  githubRepos = {
    success: true,
    data: [
      { full_name: "me/blog", private: false },
      { full_name: "me/notes", private: true },
    ],
  };
  messageListeners = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("popup: the current chat", () => {
  it("names the conversation the buttons will save", async () => {
    await openPopup();

    expect(byId("chat-card").dataset.state).toBe("ready");
    expect(byId("chat-site-label").textContent).toBe("ChatGPT chat");
    expect(byId("chat-title").textContent).toBe("Trip ideas");
    expect(byId<HTMLButtonElement>("export").disabled).toBe(false);
    expect(byId<HTMLButtonElement>("copy").disabled).toBe(false);
  });

  it("calls a chat without a title yet untitled", async () => {
    activeTab = {
      id: 7,
      url: "https://gemini.google.com/app/e87b6c6ac16404a5",
      title: "Google Gemini",
    };

    await openPopup();

    expect(byId("chat-site-label").textContent).toBe("Gemini chat");
    expect(byId("chat-title").textContent).toBe(en["popup.chat.untitled"]);
  });

  it("asks for a conversation on the chat sites' other pages", async () => {
    activeTab = { id: 7, url: "https://claude.ai/new", title: "Claude" };

    await openPopup();

    expect(byId("chat-card").dataset.state).toBe("open-chat");
    expect(byId("chat-open-hint").hidden).toBe(false);
    expect(byId("chat-open-text").textContent).toContain("Claude");
    expect(byId<HTMLButtonElement>("export").disabled).toBe(true);
    expect(byId<HTMLButtonElement>("copy").disabled).toBe(true);
  });

  it("explains what to do on other sites and links to the chat sites", async () => {
    activeTab = { id: 7, url: "https://example.com/", title: "Example" };

    await openPopup();

    expect(byId("chat-card").dataset.state).toBe("unsupported");
    expect(byId("chat-unsupported").hidden).toBe(false);
    expect(byId<HTMLButtonElement>("export").disabled).toBe(true);

    const gemini = document.querySelector<HTMLButtonElement>(
      '[data-site-name="Gemini"]',
    )!;

    expect(gemini.getAttribute("aria-label")).toBe("Open Gemini");

    gemini.click();

    expect(tabsCreate).toHaveBeenCalledWith({
      url: "https://gemini.google.com/",
    });
  });

  it("opens the settings", async () => {
    await openPopup();

    byId<HTMLButtonElement>("options-link").click();

    expect(openOptionsPage).toHaveBeenCalled();
  });
});

describe("popup: save as a file", () => {
  it("lists the messages as they read, all selected", async () => {
    await openPopup();
    await openExportScreen();

    expect(byId("main-view").hidden).toBe(true);
    expect(document.body.classList.contains("is-full")).toBe(true);
    expect(byId("export-subtitle").textContent).toBe("Trip ideas");
    expect(rows().map((row) => row.querySelector(".message-text")!.textContent))
      .toEqual([
        "YouWhere should I go in April?",
        "ChatGPTJapan\n\nSee the cherry blossoms.",
        "YouThanks!",
      ]);
    expect(rows().every((_, index) => rowCheckbox(index).checked)).toBe(true);
    expect(byId("selector-count").textContent).toBe("3 of 3 selected");
    expect(byId<HTMLInputElement>("selector-select-all").checked).toBe(true);
  });

  it("shows the loading progress on the pressed button", async () => {
    let finishLoading: (response: Response) => void = () => undefined;
    conversation = new Promise((resolve) => {
      finishLoading = resolve;
    });

    await openPopup();

    const exportButton = byId<HTMLButtonElement>("export");
    const description = exportButton.querySelector(".action-desc")!;

    exportButton.click();

    await vi.waitFor(() => {
      expect(exportButton.classList.contains("is-busy")).toBe(true);
    });
    expect(description.textContent).toBe(en["popup.loading.default"]);
    expect(byId<HTMLButtonElement>("copy").disabled).toBe(true);

    for (const listener of messageListeners) {
      listener({ type: "EXPORT_PROGRESS", collected: 42 });
    }

    expect(description.textContent).toBe(
      "Reading the chat… 42 messages so far",
    );

    finishLoading({ success: true, data: { messages: MESSAGES, images: [] } });

    await vi.waitFor(() => {
      expect(byId("export-view").hidden).toBe(false);
    });
    expect(exportButton.classList.contains("is-busy")).toBe(false);
    expect(description.textContent).toBe(en["popup.exportDesc"]);
  });

  it("shows a short error from the chat site as it is", async () => {
    conversation = {
      success: false,
      error: "Sign in to Gemini to export this conversation.",
    };

    await openPopup();
    byId<HTMLButtonElement>("export").click();

    await vi.waitFor(() => {
      expect(byId("toast").classList.contains("is-visible")).toBe(true);
    });
    expect(byId("toast").dataset.tone).toBe("error");
    expect(byId("toast-text").textContent).toBe(
      "Sign in to Gemini to export this conversation.",
    );
    expect(byId("export-view").hidden).toBe(true);
  });

  it("replaces a long technical error with what to do", async () => {
    conversation = {
      success: false,
      error:
        "ChatGPT returned a repeated pagination cursor. Pagination was stopped to prevent an infinite loop.",
    };

    await openPopup();
    byId<HTMLButtonElement>("export").click();

    await vi.waitFor(() => {
      expect(byId("toast-text").textContent).toBe(
        en["popup.error.loadConversationFailed"],
      );
    });
  });

  it("picks messages with the quick picks and Select all", async () => {
    await openPopup();
    await openExportScreen();

    const selectAll = byId<HTMLInputElement>("selector-select-all");

    byId<HTMLButtonElement>("selector-filter-answers").click();

    expect(rows().map((_, index) => rowCheckbox(index).checked)).toEqual([
      false,
      true,
      false,
    ]);
    expect(byId("selector-count").textContent).toBe("1 of 3 selected");
    expect(selectAll.indeterminate).toBe(true);

    byId<HTMLButtonElement>("selector-filter-invert").click();

    expect(rows().map((_, index) => rowCheckbox(index).checked)).toEqual([
      true,
      false,
      true,
    ]);

    selectAll.click();

    expect(rows().every((_, index) => rowCheckbox(index).checked)).toBe(true);

    selectAll.click();

    expect(rows().some((_, index) => rowCheckbox(index).checked)).toBe(false);
    expect(byId("selector-count").textContent).toBe(
      en["popup.selector.noneSelected"],
    );
    expect(byId<HTMLButtonElement>("selector-export").disabled).toBe(true);
    expect(byId<HTMLButtonElement>("selector-github-button").disabled).toBe(
      true,
    );
  });

  it("ticks a range with Shift+Click", async () => {
    await openPopup();
    await openExportScreen();

    byId<HTMLInputElement>("selector-select-all").click();
    rowCheckbox(0).click();
    rowCheckbox(2).dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        shiftKey: true,
      }),
    );

    expect(rows().map((_, index) => rowCheckbox(index).checked)).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("shows full messages on request", async () => {
    await openPopup();
    await openExportScreen();

    const toggle = byId<HTMLInputElement>("selector-expand-toggle");

    toggle.click();

    expect(byId("selector-list").classList.contains("is-expanded")).toBe(true);
  });

  it("starts with PDF and says what it's for", async () => {
    await openPopup();
    await openExportScreen();

    expect(
      document.querySelector<HTMLInputElement>('input[name="format"]:checked')
        ?.value,
    ).toBe("pdf");
    expect(byId("selector-export-label").textContent).toBe("Download PDF");
    expect(byId("format-hint-text").textContent).toBe(
      en["popup.formatHint.pdf"],
    );
  });

  it("downloads a PDF of the selected messages", async () => {
    await openPopup();
    await openExportScreen();

    rowCheckbox(2).click();
    byId<HTMLButtonElement>("selector-export").click();

    await vi.waitFor(() => {
      expect(sentMessages("DOWNLOAD_START")).toHaveLength(1);
    });

    const [chosen] = buildPdfBlob.mock.calls[0] as unknown as [
      { id: string }[],
    ];
    const download = sentMessages("DOWNLOAD_START")[0];

    expect(chosen.map((message) => message.id)).toEqual(["1", "2"]);
    expect(download.mimeType).toBe("application/pdf");
    expect(download.filename).toMatch(
      /^chatgpt-export-trip-ideas-\d{4}-\d{2}-\d{2}\.pdf$/,
    );
    expect(download.tabId).toBe(7);

    await vi.waitFor(() => {
      expect(byId("toast-text").textContent).toBe(
        en["popup.toast.downloadStarted"],
      );
    });
    expect(byId("selector-export").classList.contains("is-busy")).toBe(false);
    expect(byId("selector-export-label").textContent).toBe("Download PDF");
  });

  it("downloads the chosen file type and remembers it", async () => {
    await openPopup();
    await openExportScreen();

    document
      .querySelector<HTMLInputElement>('input[name="format"][value="md"]')!
      .click();

    expect(byId("selector-export-label").textContent).toBe(
      "Download Markdown",
    );
    expect(byId("format-hint-text").textContent).toBe(
      en["popup.formatHint.md"],
    );
    expect(localStore.popupExportFormat).toBe("md");

    byId<HTMLButtonElement>("selector-export").click();

    await vi.waitFor(() => {
      expect(sentMessages("DOWNLOAD_START")).toHaveLength(1);
    });

    const download = sentMessages("DOWNLOAD_START")[0];

    expect(download.mimeType).toBe("text/markdown");
    expect(download.filename).toMatch(/\.md$/);
    expect(decodeBase64(download.content as string)).toContain(
      "## User\n\nWhere should I go in **April**?",
    );
    expect(buildPdfBlob).not.toHaveBeenCalled();
  });

  async function downloadAs(format: string): Promise<string> {
    await openPopup();
    await openExportScreen();

    document
      .querySelector<HTMLInputElement>(`input[name="format"][value="${format}"]`)!
      .click();
    byId<HTMLButtonElement>("selector-export").click();

    await vi.waitFor(() => {
      expect(sentMessages("DOWNLOAD_START")).toHaveLength(1);
    });

    return decodeBase64(sentMessages("DOWNLOAD_START")[0].content as string);
  }

  it("starts Markdown files with note properties", async () => {
    const markdown = await downloadAs("md");

    expect(markdown.startsWith(
      [
        "---",
        'title: "Trip ideas"',
        `source: "https://chatgpt.com/c/${UUID}"`,
        "site: ChatGPT",
        "messages: 3",
        "tags:",
        "  - ai-chat",
        "  - chatgpt",
        "---",
        "",
        "## User",
      ].join("\n"),
    )).toBe(true);
  });

  it("moves the export time into the note properties", async () => {
    syncStore = { includeTimestamp: true };

    const markdown = await downloadAs("md");

    expect(markdown).toMatch(/\nexported: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}\n/);
    expect(markdown).not.toContain("_Exported");
  });

  it("leaves note properties out when they're turned off", async () => {
    syncStore = { markdownProperties: false, includeTimestamp: true };

    const markdown = await downloadAs("md");

    expect(markdown.startsWith("_Exported ")).toBe(true);
    expect(markdown).not.toContain("tags:");
  });

  it("leaves note properties out of text files", async () => {
    const text = await downloadAs("txt");

    expect(text).not.toContain("tags:");
    expect(text).not.toContain("---");
  });

  it("writes ChatGPT's math the way Markdown apps show it", async () => {
    conversation = {
      success: true,
      data: {
        messages: [
          { ...MESSAGES[0], content: "What is \\(x\\)?" },
          {
            ...MESSAGES[1],
            content: "It is \\(x = \\frac{1}{2}\\), so\n\\[\nx^2 = \\tfrac14\n\\]",
          },
        ],
        images: [],
      },
    };

    const markdown = await downloadAs("md");

    // Only replies are rewritten; the question stays as typed.
    expect(markdown).toContain("## User\n\nWhat is \\(x\\)?");
    expect(markdown).toContain(
      "It is $x = \\frac{1}{2}$, so\n$$\nx^2 = \\tfrac14\n$$",
    );
  });

  it("starts with the file type picked last time", async () => {
    localStore.popupExportFormat = "csv";

    await openPopup();
    await openExportScreen();

    expect(
      document.querySelector<HTMLInputElement>('input[name="format"]:checked')
        ?.value,
    ).toBe("csv");
    expect(byId("selector-export-label").textContent).toBe("Download CSV");
  });

  it("says when the images come in a ZIP file", async () => {
    conversation = {
      success: true,
      data: {
        messages: [
          { ...MESSAGES[0] },
          {
            ...MESSAGES[1],
            content: "Here:\n\n![Map](images/image-1.png)",
            imagePaths: ["images/image-1.png"],
          },
        ],
        images: [
          {
            path: "images/image-1.png",
            mimeType: "image/png",
            base64: "iVBORw0KGgo=",
            sizeBytes: 8,
          },
        ],
      },
    };
    localStore.popupExportFormat = "txt";

    await openPopup();
    await openExportScreen();

    expect(rows()[1].querySelector(".message-text")!.textContent).toBe(
      "ChatGPTHere:\n\n[Image]",
    );
    expect(byId("format-hint-text").textContent).toBe(
      `${en["popup.formatHint.txt"]} ${en["popup.formatHint.zip"]}`,
    );

    rowCheckbox(1).click();

    expect(byId("format-hint-text").textContent).toBe(
      en["popup.formatHint.txt"],
    );
  });

  it("goes back to the main screen", async () => {
    await openPopup();
    await openExportScreen();

    byId<HTMLButtonElement>("selector-cancel").click();

    expect(byId("main-view").hidden).toBe(false);
    expect(byId("export-view").hidden).toBe(true);
    expect(document.body.classList.contains("is-full")).toBe(false);

    await openExportScreen();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(byId("main-view").hidden).toBe(false);
  });
});

describe("popup: copy", () => {
  it("copies the whole conversation and says how to paste it", async () => {
    await openPopup();

    byId<HTMLButtonElement>("copy").click();

    await vi.waitFor(() => {
      expect(byId("toast-text").textContent).toBe(
        "Copied! Paste it anywhere with Ctrl+V.",
      );
    });

    const [copy] = sentMessages("COPY_TO_CLIPBOARD");

    expect(copy.data).toContain("## User\n\nWhere should I go in **April**?");
    expect(copy.data).toContain("## User\n\nThanks!");
    // Note properties are for files, not for pasting.
    expect(copy.data).not.toContain("tags:");
  });
});

describe("popup: save to GitHub", () => {
  it("asks to connect GitHub first", async () => {
    githubStatus = { success: true, data: { connected: false } };

    await openPopup();
    await openGithubScreen();

    expect(byId("github-state-title").textContent).toBe(
      en["popup.github.notConnectedTitle"],
    );
    expect(byId("github-form").hidden).toBe(true);
    expect(byId("github-footer").hidden).toBe(true);

    byId<HTMLButtonElement>("github-state-action").click();

    expect(tabsCreate).toHaveBeenCalledWith({
      url: "chrome-extension://test-id/options.html#github",
    });
  });

  it("offers to create a repository when there are none", async () => {
    githubRepos = { success: true, data: [] };

    await openPopup();
    await openGithubScreen();

    expect(byId("github-state-title").textContent).toBe(
      en["popup.github.noReposTitle"],
    );

    byId<HTMLButtonElement>("github-state-action").click();

    expect(tabsCreate).toHaveBeenCalledWith({ url: "https://github.com/new" });
  });

  it("tries again after the repos fail to load", async () => {
    githubRepos = { success: false, error: "Failed to list GitHub repos: 500" };

    await openPopup();
    await openGithubScreen();

    expect(byId("github-state").dataset.tone).toBe("error");
    expect(byId("github-state-text").textContent).toBe(
      "Failed to list GitHub repos: 500",
    );

    githubRepos = {
      success: true,
      data: [{ full_name: "me/notes", private: true }],
    };
    byId<HTMLButtonElement>("github-state-action").click();

    await vi.waitFor(() => {
      expect(byId("github-form").hidden).toBe(false);
    });
  });

  it("saves into a private repo right away and links to the file", async () => {
    localStore.popupGithubRepo = "me/notes";

    await openPopup();
    await openGithubScreen();

    expect(byId<HTMLSelectElement>("github-repo-select").value).toBe(
      "me/notes",
    );
    expect(byId("github-visibility").dataset.visibility).toBe("private");
    expect(byId("github-file-name").textContent).toMatch(
      /^exports\/chatgpt-export-trip-ideas-\d{4}-\d{2}-\d{2}\.md$/,
    );

    byId<HTMLButtonElement>("github-panel-save").click();

    await vi.waitFor(() => {
      expect(byId("github-state-title").textContent).toBe(
        en["popup.github.savedTitle"],
      );
    });

    const [save] = sentMessages("GITHUB_SAVE_FILE");

    expect(save.fullName).toBe("me/notes");
    expect(save.binary).toBe(false);
    expect(save.content).toMatch(/^---\ntitle: "Trip ideas"\n/);
    expect(byId<HTMLDialogElement>("github-confirm").open).toBe(false);
    expect(localStore.popupGithubRepo).toBe("me/notes");
    expect(tabsSendMessage).toHaveBeenCalledWith(7, {
      type: "SHOW_EXPORT_SUCCESS",
    });

    byId<HTMLButtonElement>("github-state-action").click();

    expect(tabsCreate).toHaveBeenCalledWith({
      url: `https://github.com/me/notes/blob/main/exports/${save.filename}`,
    });

    byId<HTMLButtonElement>("github-state-secondary").click();

    expect(byId("main-view").hidden).toBe(false);
  });

  it("asks before saving into a public repo", async () => {
    await openPopup();
    await openGithubScreen();

    expect(byId<HTMLSelectElement>("github-repo-select").value).toBe("me/blog");
    expect(byId("github-visibility").dataset.visibility).toBe("public");

    const confirm = byId<HTMLDialogElement>("github-confirm");

    byId<HTMLButtonElement>("github-panel-save").click();

    expect(confirm.open).toBe(true);

    byId<HTMLButtonElement>("github-confirm-cancel").click();

    expect(confirm.open).toBe(false);
    expect(sentMessages("GITHUB_SAVE_FILE")).toHaveLength(0);

    byId<HTMLButtonElement>("github-panel-save").click();
    byId<HTMLButtonElement>("github-confirm-export").click();

    await vi.waitFor(() => {
      expect(sentMessages("GITHUB_SAVE_FILE")).toHaveLength(1);
    });
    expect(sentMessages("GITHUB_SAVE_FILE")[0].fullName).toBe("me/blog");
  });

  it("goes back to picking messages", async () => {
    await openPopup();
    await openGithubScreen();

    byId<HTMLButtonElement>("github-panel-cancel").click();

    expect(byId("export-view").hidden).toBe(false);
    expect(byId("github-view").hidden).toBe(true);
  });
});
