import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  DEFAULT_PDF_SETTINGS,
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
      markdownProperties: true,
      headingStyle: "h2",
      messageSeparator: "double",
      askWhereToSave: true,
      fileNameTemplate: "",
      downloadImagesLocally: false,
      includeSources: true,
      includeThinking: false,
      includeMessageDetails: false,
      theme: "system",
      language: "auto",
      pdf: DEFAULT_PDF_SETTINGS,
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
      markdownProperties: false,
      headingStyle: "bold",
      messageSeparator: "rule",
      askWhereToSave: true,
      fileNameTemplate: "{date} {title}",
      downloadImagesLocally: true,
      includeSources: true,
      includeThinking: false,
      includeMessageDetails: true,
      theme: "dark",
      language: "en",
      pdf: DEFAULT_PDF_SETTINGS,
    };

    storageGet.mockResolvedValue(settings);

    const result = await loadSettings();

    expect(result).toEqual(settings);
  });

  it("saves settings to Chrome sync storage", async () => {
    const settings: Settings = {
      includeTimestamp: true,
      markdownProperties: false,
      headingStyle: "none",
      messageSeparator: "single",
      askWhereToSave: true,
      fileNameTemplate: "",
      downloadImagesLocally: false,
      includeSources: true,
      includeThinking: false,
      includeMessageDetails: false,
      theme: "light",
      language: "fr",
      pdf: DEFAULT_PDF_SETTINGS,
    };

    storageSet.mockResolvedValue(undefined);

    await saveSettings(settings);

    expect(storageSet).toHaveBeenCalledWith(settings);
  });
});
