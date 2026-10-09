import { describe, expect, it, vi } from "vitest";
import {
  BACKUP_FORMATS,
  BACKUP_INTERVALS_MS,
  DEFAULT_BACKUP_CONFIG,
  backupConfig,
  backupFileBase,
  backupTarget,
  buildBackupFiles,
  isBackupDue,
} from "../src/auto-backup";
import { DEFAULT_SETTINGS } from "../src/settings";
import type { Message } from "../src/export-builders";

/*
 * No jsdom here: Chrome builds backups in its background service
 * worker, which has no DOM (see auto-backup.ts).
 */
vi.stubGlobal("chrome", {
  storage: {
    sync: { get: vi.fn(async (defaults: Record<string, unknown>) => defaults) },
  },
  i18n: { getUILanguage: () => "en-US" },
});

const CHAT = {
  id: "0b2f7a52-1c3d-4e5f-8a9b-0c1d2e3f4a5b",
  title: "Trip ideas",
  url: "https://chatgpt.com/c/0b2f7a52-1c3d-4e5f-8a9b-0c1d2e3f4a5b",
  createdAt: new Date(2026, 9, 1, 12).getTime(),
  updatedAt: new Date(2026, 9, 8, 12).getTime(),
};

const MESSAGES: Message[] = [
  { id: "1", role: "user", content: "Where should I go?", order: 0 },
  { id: "2", role: "assistant", content: "Lisbon.", order: 1 },
];

const FOLDER = "AI Exporter backup/ChatGPT";

describe("when a site is due", () => {
  const now = new Date(2026, 9, 8, 12).getTime();

  it("is due when it was never backed up", () => {
    expect(isBackupDue(undefined, "day", now)).toBe(true);
  });

  it("waits the chosen time after a backup", () => {
    const at = now - BACKUP_INTERVALS_MS.day + 60_000;

    expect(isBackupDue({ at }, "day", now)).toBe(false);
    expect(isBackupDue({ at }, "hour", now)).toBe(true);
    expect(isBackupDue({ at: now - BACKUP_INTERVALS_MS.day }, "day", now)).toBe(true);
  });

  it("tries again within the hour after one that stopped early", () => {
    const at = now - BACKUP_INTERVALS_MS.hour;

    expect(isBackupDue({ at, error: "The tab was closed." }, "week", now)).toBe(true);
    expect(isBackupDue({ at }, "week", now)).toBe(false);
  });

  it("isn't held up by a clock set back", () => {
    expect(isBackupDue({ at: now + BACKUP_INTERVALS_MS.day }, "week", now)).toBe(true);
  });
});

describe("the backup's settings", () => {
  it("start off, daily, into Downloads, as web pages", () => {
    expect(backupConfig(undefined)).toEqual(DEFAULT_BACKUP_CONFIG);
    expect(DEFAULT_BACKUP_CONFIG).toEqual({
      enabled: false,
      every: "day",
      target: "downloads",
      repo: "",
      format: "html",
    });
  });

  it("put anything unknown back to its default", () => {
    expect(
      backupConfig({ enabled: "yes", every: "minute", target: "ftp", repo: 5, format: "pdf" }),
    ).toEqual(DEFAULT_BACKUP_CONFIG);
    expect(
      backupConfig({ enabled: true, every: "week", target: "github", repo: "me/chats", format: "md" }),
    ).toEqual({ enabled: true, every: "week", target: "github", repo: "me/chats", format: "md" });
  });

  it("start over for a new place or file type", () => {
    const targets = new Set([
      backupTarget(DEFAULT_BACKUP_CONFIG),
      backupTarget({ ...DEFAULT_BACKUP_CONFIG, format: "md" }),
      backupTarget({ ...DEFAULT_BACKUP_CONFIG, target: "github", repo: "me/chats" }),
      backupTarget({ ...DEFAULT_BACKUP_CONFIG, target: "github", repo: "me/other" }),
    ]);

    expect(targets.size).toBe(4);
    // The repository chosen while backing up into Downloads doesn't matter
    expect(backupTarget({ ...DEFAULT_BACKUP_CONFIG, repo: "me/chats" })).toBe(
      backupTarget(DEFAULT_BACKUP_CONFIG),
    );
  });
});

describe("a chat's name in the backup", () => {
  it("is dated by when the chat began, and ends with its id", () => {
    expect(backupFileBase(CHAT, "", "chatgpt")).toBe("2026-10-01-trip-ideas-2e3f4a5b");
  });

  it("follows the person's own pattern", () => {
    expect(backupFileBase(CHAT, "{date} {title}", "chatgpt")).toBe(
      "2026-10-01 Trip ideas (2e3f4a5b)",
    );
  });

  it("keeps two chats of the same title and day apart", () => {
    expect(backupFileBase(CHAT, "", "chatgpt")).not.toBe(
      backupFileBase({ ...CHAT, id: "c_1234abcd5678" }, "", "chatgpt"),
    );
  });
});

describe("a chat's backup files", () => {
  it.each(BACKUP_FORMATS)("are built as %s without a DOM", async (format) => {
    expect(typeof document).toBe("undefined");

    const files = await buildBackupFiles("chatgpt", CHAT, MESSAGES, [], format, DEFAULT_SETTINGS);

    expect(files.map((file) => file.path)).toEqual([
      `${FOLDER}/2026-10-01-trip-ideas-2e3f4a5b.${format}`,
    ]);
    expect(files[0].blob.size).toBeGreaterThan(0);

    if (format !== "xlsx") {
      expect(await files[0].blob.text()).toContain("Lisbon.");
    }
  });

  it("put a text format's images in a folder next to it", async () => {
    const image = {
      path: "images/image-001.png",
      mimeType: "image/png",
      base64: btoa("PNG"),
      sizeBytes: 3,
    };

    const files = await buildBackupFiles(
      "chatgpt",
      CHAT,
      [...MESSAGES, { id: "3", role: "assistant", content: "![](images/image-001.png)", order: 2 }],
      [image],
      "md",
      DEFAULT_SETTINGS,
    );

    expect(files.map((file) => file.path)).toEqual([
      `${FOLDER}/2026-10-01-trip-ideas-2e3f4a5b/2026-10-01-trip-ideas-2e3f4a5b.md`,
      `${FOLDER}/2026-10-01-trip-ideas-2e3f4a5b/images/image-001.png`,
    ]);
    expect(await files[1].blob.text()).toBe("PNG");
  });
});
