import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  SEPARATOR_TEXT,
  loadSettings,
  saveSettings,
  type Settings,
} from "../src/settings";

const storageGet = vi.fn();
const storageSet = vi.fn();

vi.stubGlobal("chrome", {
  storage: {
    sync: {
      get: storageGet,
      set: storageSet,
    },
  },
});

describe("settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("has the expected default settings", () => {
    expect(DEFAULT_SETTINGS).toEqual({
      includeTimestamp: false,
      headingStyle: "h2",
      messageSeparator: "double",
      askWhereToSave: true,
      downloadImagesLocally: false,
      theme: "system",
      language: "auto",
    });
  });

  it("defines all message separators", () => {
    expect(SEPARATOR_TEXT.single).toBe("\n");
    expect(SEPARATOR_TEXT.double).toBe("\n\n");
    expect(SEPARATOR_TEXT.rule).toBe("\n\n---\n\n");
  });

  it("loads settings with defaults", async () => {
    storageGet.mockResolvedValue({
      ...DEFAULT_SETTINGS,
    });

    const result = await loadSettings();

    expect(storageGet).toHaveBeenCalledWith({
      ...DEFAULT_SETTINGS,
    });

    expect(result).toEqual(DEFAULT_SETTINGS);
  });

  it("loads stored custom settings", async () => {
    const settings: Settings = {
      includeTimestamp: true,
      headingStyle: "bold",
      messageSeparator: "rule",
      askWhereToSave: true,
      downloadImagesLocally: true,
      theme: "dark",
      language: "en",
    };

    storageGet.mockResolvedValue(settings);

    const result = await loadSettings();

    expect(result).toEqual(settings);
  });

  it("saves settings to Chrome sync storage", async () => {
    const settings: Settings = {
      includeTimestamp: true,
      headingStyle: "none",
      messageSeparator: "single",
      askWhereToSave: true,
      downloadImagesLocally: false,
      theme: "light",
      language: "fr",
    };

    storageSet.mockResolvedValue(undefined);

    await saveSettings(settings);

    expect(storageSet).toHaveBeenCalledWith(settings);
  });
});
