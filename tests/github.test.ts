import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storageLocalGet = vi.fn();
const storageLocalSet = vi.fn();
const storageLocalRemove = vi.fn();

vi.stubGlobal("chrome", {
  storage: {
    local: {
      get: storageLocalGet,
      set: storageLocalSet,
      remove: storageLocalRemove,
    },
  },
  i18n: {
    getUILanguage: vi.fn(() => "en-US"),
  },
});

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    json: async () => body,
  } as unknown as Response;
}

describe("github", () => {
  let github: typeof import("../src/github");

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    github = await import("../src/github");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("token storage", () => {
    it("returns null when no token is stored", async () => {
      storageLocalGet.mockResolvedValue({});

      expect(await github.getStoredToken()).toBeNull();
    });

    it("returns the stored token when present", async () => {
      storageLocalGet.mockResolvedValue({ githubAccessToken: "abc123" });

      expect(await github.getStoredToken()).toBe("abc123");
    });

    it("treats an empty string token as absent", async () => {
      storageLocalGet.mockResolvedValue({ githubAccessToken: "" });

      expect(await github.getStoredToken()).toBeNull();
    });

    it("removes the stored token on disconnect", async () => {
      storageLocalRemove.mockResolvedValue(undefined);

      await github.disconnectGitHub();

      expect(storageLocalRemove).toHaveBeenCalledWith("githubAccessToken");
    });
  });

  describe("startDeviceFlow", () => {
    it("returns the device code payload on success", async () => {
      const payload = {
        device_code: "device123",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5,
      };

      fetchMock.mockResolvedValue(jsonResponse(200, payload));

      const result = await github.startDeviceFlow();

      expect(result).toEqual(payload);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://github.com/login/device/code",
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("throws when the HTTP request fails", async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Server Error",
      });

      await expect(github.startDeviceFlow()).rejects.toThrow(
        "GitHub device code request failed",
      );
    });

    it("throws when the response is missing required fields", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { device_code: "only" }));

      await expect(github.startDeviceFlow()).rejects.toThrow();
    });
  });

  describe("pollForAccessToken", () => {
    it("stores and returns the access token once granted", async () => {
      vi.useFakeTimers();

      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, { error: "authorization_pending" }),
      );
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, { access_token: "granted-token" }),
      );
      storageLocalSet.mockResolvedValue(undefined);

      const promise = github.pollForAccessToken("device123", 1, 60);

      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);

      const token = await promise;

      expect(token).toBe("granted-token");
      expect(storageLocalSet).toHaveBeenCalledWith({
        githubAccessToken: "granted-token",
      });
    });

    it("rejects when the user denies access", async () => {
      vi.useFakeTimers();

      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, { error: "access_denied" }),
      );

      const promise = github.pollForAccessToken("device123", 1, 60);
      const assertion = expect(promise).rejects.toThrow();

      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
    });

    it("rejects once the deadline passes", async () => {
      vi.useFakeTimers();

      fetchMock.mockResolvedValue(
        jsonResponse(200, { error: "authorization_pending" }),
      );

      const promise = github.pollForAccessToken("device123", 5, 5);
      const assertion = expect(promise).rejects.toThrow("expired");

      await vi.advanceTimersByTimeAsync(10000);
      await assertion;
    });
  });

  describe("authenticated requests", () => {
    it("throws when there is no stored token", async () => {
      storageLocalGet.mockResolvedValue({});

      await expect(github.getCurrentUser()).rejects.toThrow();
    });

    it("fetches the current user with the stored token", async () => {
      storageLocalGet.mockResolvedValue({ githubAccessToken: "tok" });
      fetchMock.mockResolvedValue(
        jsonResponse(200, { login: "grant", avatar_url: "https://x/y.png" }),
      );

      const user = await github.getCurrentUser();

      expect(user.login).toBe("grant");
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.github.com/user",
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer tok" }),
        }),
      );
    });

    it("clears the stored token and throws on a 401 response", async () => {
      storageLocalGet.mockResolvedValue({ githubAccessToken: "expired" });
      fetchMock.mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        json: async () => ({}),
      });
      storageLocalRemove.mockResolvedValue(undefined);

      await expect(github.getCurrentUser()).rejects.toThrow();
      expect(storageLocalRemove).toHaveBeenCalledWith("githubAccessToken");
    });
  });

  describe("listRepos", () => {
    it("filters out repos the user cannot push to", async () => {
      storageLocalGet.mockResolvedValue({ githubAccessToken: "tok" });
      fetchMock.mockResolvedValue(
        jsonResponse(200, [
          { id: 1, name: "a", full_name: "u/a", owner: { login: "u" }, private: false, default_branch: "main", permissions: { push: true } },
          { id: 2, name: "b", full_name: "u/b", owner: { login: "u" }, private: false, default_branch: "main", permissions: { push: false } },
          { id: 3, name: "c", full_name: "u/c", owner: { login: "u" }, private: false, default_branch: "main" },
        ]),
      );

      const repos = await github.listRepos();

      expect(repos.map((r) => r.id)).toEqual([1, 3]);
    });
  });

  describe("starProject", () => {
    it("succeeds on a 204 response", async () => {
      storageLocalGet.mockResolvedValue({ githubAccessToken: "tok" });
      fetchMock.mockResolvedValue({ ok: false, status: 204, statusText: "" });

      await expect(github.starProject()).resolves.toBeUndefined();
    });

    it("throws on failure", async () => {
      storageLocalGet.mockResolvedValue({ githubAccessToken: "tok" });
      fetchMock.mockResolvedValue({ ok: false, status: 403, statusText: "Forbidden" });

      await expect(github.starProject()).rejects.toThrow();
    });
  });

  describe("saveFileToRepo", () => {
    it("creates a new file when none exists yet", async () => {
      storageLocalGet.mockResolvedValue({ githubAccessToken: "tok" });

      fetchMock
        .mockResolvedValueOnce({ ok: false, status: 404, statusText: "Not Found" })
        .mockResolvedValueOnce(
          jsonResponse(201, { content: { html_url: "https://github.com/u/r/blob/main/exports/f.md" } }),
        );

      const result = await github.saveFileToRepo("u/r", "f.md", "hello world");

      expect(result.htmlUrl).toContain("exports/f.md");

      const putCall = fetchMock.mock.calls[1];
      const body = JSON.parse((putCall[1] as RequestInit).body as string);
      expect(body.message).toBe("Add f.md via AI Exporter");
      expect(body.sha).toBeUndefined();
    });

    it("updates an existing file using its current sha", async () => {
      storageLocalGet.mockResolvedValue({ githubAccessToken: "tok" });

      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, { sha: "abc" }))
        .mockResolvedValueOnce(
          jsonResponse(200, { content: { html_url: "https://github.com/u/r/blob/main/exports/f.md" } }),
        );

      await github.saveFileToRepo("u/r", "f.md", "updated content");

      const putCall = fetchMock.mock.calls[1];
      const body = JSON.parse((putCall[1] as RequestInit).body as string);
      expect(body.message).toBe("Update f.md via AI Exporter");
      expect(body.sha).toBe("abc");
    });

    it("retries once on a 409 conflict and succeeds with a fresh sha", async () => {
      storageLocalGet.mockResolvedValue({ githubAccessToken: "tok" });

      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, { sha: "stale" }))
        .mockResolvedValueOnce({ ok: false, status: 409, statusText: "Conflict" })
        .mockResolvedValueOnce(jsonResponse(200, { sha: "fresh" }))
        .mockResolvedValueOnce(
          jsonResponse(200, { content: { html_url: "https://github.com/u/r/blob/main/exports/f.md" } }),
        );

      const result = await github.saveFileToRepo("u/r", "f.md", "content");

      expect(result.htmlUrl).toContain("exports/f.md");
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it("throws when both the initial save and the 409 retry fail", async () => {
      storageLocalGet.mockResolvedValue({ githubAccessToken: "tok" });

      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, { sha: "stale" }))
        .mockResolvedValueOnce({ ok: false, status: 409, statusText: "Conflict" })
        .mockResolvedValueOnce({ ok: false, status: 404, statusText: "Not Found" })
        .mockResolvedValueOnce({ ok: false, status: 409, statusText: "Conflict" });

      await expect(
        github.saveFileToRepo("u/r", "f.md", "content"),
      ).rejects.toThrow("retry also failed");
    });

    it("passes through base64 content unchanged when alreadyBase64 is true", async () => {
      storageLocalGet.mockResolvedValue({ githubAccessToken: "tok" });

      fetchMock
        .mockResolvedValueOnce({ ok: false, status: 404, statusText: "Not Found" })
        .mockResolvedValueOnce(
          jsonResponse(200, { content: { html_url: "https://github.com/u/r/blob/main/exports/f.zip" } }),
        );

      await github.saveFileToRepo("u/r", "f.zip", "QUJD", true);

      const putCall = fetchMock.mock.calls[1];
      const body = JSON.parse((putCall[1] as RequestInit).body as string);
      expect(body.content).toBe("QUJD");
    });
  });
});
