import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  changeUpdateState,
  checkStoreForUpdate,
  compareVersions,
  getUpdateView,
  isNewerVersion,
  loadUpdateState,
} from "../src/updates";

const FIREFOX_ADDON_ID = "gptchatdownloader@granttotinov.com";

const requestUpdateCheck = vi.fn();
const fetchMock = vi.fn();

let localStorageItems: Record<string, unknown> = {};

function stubBrowser({ chrome: isChrome }: { chrome: boolean }): void {
  vi.stubGlobal("chrome", {
    runtime: {
      id: isChrome ? "objkcakdcilfaphifjfcgfamlnnbinjc" : FIREFOX_ADDON_ID,
      getManifest: () => ({ version: "2.3.0" }),
      /* Firefox doesn't implement requestUpdateCheck at all. */
      ...(isChrome ? { requestUpdateCheck } : {}),
    },
    storage: {
      local: {
        get: vi.fn(async (key: string) =>
          key in localStorageItems ? { [key]: localStorageItems[key] } : {},
        ),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(localStorageItems, JSON.parse(JSON.stringify(items)));
        }),
      },
    },
  });
  vi.stubGlobal("fetch", fetchMock);
}

function amoResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requestUpdateCheck.mockReset();
  fetchMock.mockReset();
  localStorageItems = {};
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("compareVersions", () => {
  it("compares each part as a number, not as text", () => {
    expect(compareVersions("2.10.0", "2.9.0")).toBe(1);
    expect(compareVersions("2.9.0", "2.10.0")).toBe(-1);
  });

  it("treats a missing part as 0", () => {
    expect(compareVersions("2.3", "2.3.0")).toBe(0);
    expect(compareVersions("2.3.0.1", "2.3")).toBe(1);
  });

  it("orders patch, minor and major versions", () => {
    expect(compareVersions("2.3.1", "2.3.0")).toBe(1);
    expect(compareVersions("2.4.0", "2.3.9")).toBe(1);
    expect(compareVersions("3.0.0", "2.99.99")).toBe(1);
    expect(compareVersions("2.3.0", "2.3.0")).toBe(0);
  });
});

describe("isNewerVersion", () => {
  it("is true only for a strictly newer version", () => {
    expect(isNewerVersion("2.4.0", "2.3.0")).toBe(true);
    expect(isNewerVersion("2.3.0", "2.3.0")).toBe(false);
    expect(isNewerVersion("1.1.0", "2.3.0")).toBe(false);
  });

  it("is false when there's no version", () => {
    expect(isNewerVersion(undefined, "2.3.0")).toBe(false);
  });
});

describe("checkStoreForUpdate in Chrome", () => {
  beforeEach(() => {
    stubBrowser({ chrome: true });
  });

  it("passes on a newer version from requestUpdateCheck()", async () => {
    requestUpdateCheck.mockResolvedValue({
      status: "update_available",
      version: "2.4.0",
    });

    expect(await checkStoreForUpdate("2.3.0")).toEqual({
      status: "update_available",
      version: "2.4.0",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes on no_update and throttled", async () => {
    requestUpdateCheck.mockResolvedValueOnce({ status: "no_update" });
    requestUpdateCheck.mockResolvedValueOnce({ status: "throttled" });

    expect(await checkStoreForUpdate("2.3.0")).toEqual({ status: "no_update" });
    expect(await checkStoreForUpdate("2.3.0")).toEqual({ status: "throttled" });
  });

  it("reports an error instead of throwing when the updater fails", async () => {
    requestUpdateCheck.mockRejectedValue(new Error("Updater disabled"));

    expect(await checkStoreForUpdate("2.3.0")).toEqual({ status: "error" });
  });
});

describe("checkStoreForUpdate in Firefox (addons.mozilla.org)", () => {
  beforeEach(() => {
    stubBrowser({ chrome: false });
  });

  it("asks addons.mozilla.org about this add-on's ID, without cookies", async () => {
    fetchMock.mockResolvedValue(
      amoResponse({ current_version: { version: "2.4.0" } }),
    );

    expect(await checkStoreForUpdate("2.3.0")).toEqual({
      status: "update_available",
      version: "2.4.0",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://addons.mozilla.org/api/v5/addons/addon/gptchatdownloader%40granttotinov.com/",
      { cache: "no-cache", credentials: "omit" },
    );
  });

  it("says no_update when the store has this version or an older one", async () => {
    fetchMock.mockResolvedValueOnce(
      amoResponse({ current_version: { version: "2.3.0" } }),
    );
    fetchMock.mockResolvedValueOnce(
      amoResponse({ current_version: { version: "1.1.0" } }),
    );

    expect(await checkStoreForUpdate("2.3.0")).toEqual({ status: "no_update" });
    expect(await checkStoreForUpdate("2.3.0")).toEqual({ status: "no_update" });
  });

  it("says unlisted when the store doesn't know this ID", async () => {
    fetchMock.mockResolvedValue(amoResponse({ detail: "Not found." }, 404));

    expect(await checkStoreForUpdate("2.3.0")).toEqual({ status: "unlisted" });
  });

  it("reports an error for a failed request or an unexpected answer", async () => {
    fetchMock.mockResolvedValueOnce(amoResponse({}, 503));
    fetchMock.mockRejectedValueOnce(new TypeError("NetworkError"));
    fetchMock.mockResolvedValueOnce(amoResponse({ current_version: null }));

    expect(await checkStoreForUpdate("2.3.0")).toEqual({ status: "error" });
    expect(await checkStoreForUpdate("2.3.0")).toEqual({ status: "error" });
    expect(await checkStoreForUpdate("2.3.0")).toEqual({ status: "error" });
  });
});

describe("getUpdateView", () => {
  const now = 1_800_000_000_000;

  it("shows a downloaded update as ready, ahead of anything else", () => {
    expect(
      getUpdateView(
        { readyVersion: "2.4.0", latestVersion: "2.5.0", checkedAt: now },
        "2.3.0",
        true,
        now,
      ),
    ).toEqual({ kind: "ready", version: "2.4.0" });
  });

  it("ignores a ready version that is already running", () => {
    expect(
      getUpdateView({ readyVersion: "2.3.0", checkedAt: now }, "2.3.0", true, now),
    ).toEqual({ kind: "current", checkedAt: now });
  });

  it("shows Chrome downloading an update it just found", () => {
    expect(
      getUpdateView({ latestVersion: "2.4.0", checkedAt: now }, "2.3.0", true, now),
    ).toEqual({ kind: "downloading", version: "2.4.0" });
  });

  it("shows the update as available once that download is overdue", () => {
    expect(
      getUpdateView(
        { latestVersion: "2.4.0", checkedAt: now - 11 * 60 * 1000 },
        "2.3.0",
        true,
        now,
      ),
    ).toEqual({ kind: "available", version: "2.4.0" });
  });

  it("shows a newer store version as available in Firefox", () => {
    expect(
      getUpdateView({ latestVersion: "2.4.0", checkedAt: now }, "2.3.0", false, now),
    ).toEqual({ kind: "available", version: "2.4.0" });
  });

  it("is current once the store has answered with nothing newer", () => {
    expect(
      getUpdateView({ latestVersion: "2.3.0", checkedAt: now }, "2.3.0", true, now),
    ).toEqual({ kind: "current", checkedAt: now });
  });

  it("is unknown before the store has answered", () => {
    expect(getUpdateView({}, "2.3.0", true, now)).toEqual({ kind: "unknown" });
  });
});

describe("changeUpdateState", () => {
  beforeEach(() => {
    stubBrowser({ chrome: true });
  });

  it("keeps both of two changes made at the same time", async () => {
    await Promise.all([
      changeUpdateState((state) => ({ ...state, latestVersion: "2.4.0" })),
      changeUpdateState((state) => ({ ...state, readyVersion: "2.4.0" })),
    ]);

    expect(await loadUpdateState()).toEqual({
      latestVersion: "2.4.0",
      readyVersion: "2.4.0",
    });
  });

  it("starts from an empty state when nothing is stored", async () => {
    expect(await loadUpdateState()).toEqual({});
  });
});
