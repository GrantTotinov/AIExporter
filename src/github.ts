/*
 * =========================================================
 * AI Exporter - github.ts
 * =========================================================
 *
 * GitHub integration: OAuth Device Flow authentication,
 * token storage, and the small set of GitHub REST API calls
 * needed to list repos, save an export as a file, and star
 * the project repository.
 *
 * WHY DEVICE FLOW (not the redirect/web OAuth flow):
 *
 * The standard GitHub OAuth "web application flow" requires
 * exchanging an authorization code for an access token using
 * a client_secret. A client_secret cannot safely live in an
 * extension - the extension's code is fully inspectable (an
 * unpacked .crx is just files on disk), and AI Exporter is
 * open source, so anything committed here is public.
 * Embedding a secret would leak it immediately.
 *
 * GitHub's OAuth Device Flow (RFC 8628) is designed for
 * exactly this situation: public clients (CLIs, desktop apps,
 * browser extensions) that can't protect a secret. It needs
 * only a client_id, which is NOT sensitive - GitHub's own
 * docs and official client libraries (e.g. octokit's
 * auth-oauth-device) confirm the device flow requires no
 * client secret and no server-side component. This is why
 * AI Exporter uses it instead of chrome.identity.launchWebAuthFlow
 * (which would still need a secret-holding backend somewhere).
 *
 * Flow:
 *   1. POST https://github.com/login/device/code
 *        -> { device_code, user_code, verification_uri, interval }
 *   2. Show the user_code, open verification_uri in a new tab.
 *   3. Poll POST https://github.com/login/oauth/access_token
 *      every `interval` seconds until the user finishes
 *      authorizing (or it expires / is denied).
 *   4. Store the resulting access_token in chrome.storage.local.
 *
 * Token storage uses chrome.storage.local, not .sync:
 * chrome.storage.sync has an 8KB-per-item cap and syncs the
 * value across the user's other Chrome installs, which is
 * not desirable for a bearer credential - local keeps it on
 * this machine only.
 */

/*
 * ---------------------------------------------------------
 * CONFIG
 * ---------------------------------------------------------
 *
 * This is a GitHub OAuth App's Client ID - NOT a secret.
 * OAuth/Device Flow client IDs are public application
 * identifiers by design (this is explicitly confirmed by
 * GitHub's own device flow documentation and by every
 * official device-flow client library, e.g. octokit's
 * auth-oauth-device.js ships client IDs as plain constructor
 * arguments). Safe to commit.
 *
 * Replace this with the Client ID from your own OAuth App
 * (GitHub -> Settings -> Developer settings -> OAuth Apps),
 * with "Enable Device Flow" turned on in that app's settings.
 */
import { t } from "./i18n.ts";

const GITHUB_CLIENT_ID = "Ov23livM5zFifnOcvad6";

const GITHUB_SCOPE = "repo";

const STORAGE_KEY_TOKEN = "githubAccessToken";
export const PROJECT_REPOSITORY = "GrantTotinov/AIExporter";

/*
 * ---------------------------------------------------------
 * TYPES
 * ---------------------------------------------------------
 */

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface AccessTokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  owner: {
    login: string;
  };
  private: boolean;
  default_branch: string;
  permissions?: {
    push?: boolean;
  };
}

export interface GitHubUser {
  login: string;
  avatar_url: string;
}

/*
 * ---------------------------------------------------------
 * TOKEN STORAGE
 * ---------------------------------------------------------
 */

export async function getStoredToken(): Promise<string | null> {
  const stored = await chrome.storage.local.get(STORAGE_KEY_TOKEN);

  const token = stored[STORAGE_KEY_TOKEN];

  return typeof token === "string" && token.length > 0 ? token : null;
}

async function storeToken(token: string): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY_TOKEN]: token });
}

export async function disconnectGitHub(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY_TOKEN);
}

/*
 * ---------------------------------------------------------
 * DEVICE FLOW: START
 * ---------------------------------------------------------
 *
 * Requests a device_code/user_code pair from GitHub. The
 * caller is responsible for showing user_code to the person
 * and opening verification_uri, then calling
 * pollForAccessToken with the returned device_code.
 */
export async function startDeviceFlow(): Promise<DeviceCodeResponse> {
  const response = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      scope: GITHUB_SCOPE,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `GitHub device code request failed: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as DeviceCodeResponse;

  if (!data.device_code || !data.user_code || !data.verification_uri) {
    throw new Error(t("github.error.deviceFlowUnexpected"));
  }

  return data;
}

/*
 * ---------------------------------------------------------
 * DEVICE FLOW: POLL
 * ---------------------------------------------------------
 *
 * Polls GitHub's token endpoint on the interval GitHub told
 * us to use, until the user finishes authorizing (success),
 * explicitly denies access, or the device_code expires.
 *
 * "authorization_pending" is the expected response on every
 * poll until the user acts - it is not an error, just "not
 * yet". "slow_down" means we're polling too fast; GitHub
 * tells us to add 5 seconds to our interval when this
 * happens, per the OAuth Device Flow spec.
 */
export async function pollForAccessToken(
  deviceCode: string,
  intervalSeconds: number,
  expiresInSeconds: number,
  onTick?: () => void,
): Promise<string> {
  const deadline = Date.now() + expiresInSeconds * 1000;

  let interval = intervalSeconds;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));

    onTick?.();

    const response = await fetch(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      },
    );

    const data = (await response.json()) as AccessTokenResponse;

    if (data.access_token) {
      await storeToken(data.access_token);

      return data.access_token;
    }

    switch (data.error) {
      case "authorization_pending":
        continue;

      case "slow_down":
        /*
         * Per RFC 8628, add 5 seconds and keep polling.
         */
        interval += 5;
        continue;

      case "expired_token":
        throw new Error(t("github.error.codeExpired"));

      case "access_denied":
        throw new Error(t("github.error.signinCancelled"));

      default:
        throw new Error(
          data.error_description ??
            data.error ??
            t("github.error.unknownSignin"),
        );
    }
  }

  throw new Error(t("github.error.codeExpired"));
}

/*
 * ---------------------------------------------------------
 * AUTHENTICATED REQUEST HELPER
 * ---------------------------------------------------------
 */

async function githubApiRequest(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await getStoredToken();

  if (!token) {
    throw new Error(t("github.error.notConnected"));
  }

  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...init.headers,
    },
  });

  if (response.status === 401) {
    /*
     * Token is invalid/revoked - clear it so the UI can
     * prompt the person to reconnect instead of repeatedly
     * failing silently.
     */
    await disconnectGitHub();

    throw new Error(t("github.error.connectionExpired"));
  }

  return response;
}

/*
 * ---------------------------------------------------------
 * CURRENT USER
 * ---------------------------------------------------------
 *
 * Used to confirm the token works and to show "Connected as
 * <login>" in the UI.
 */
export async function getCurrentUser(): Promise<GitHubUser> {
  const response = await githubApiRequest("/user");

  if (!response.ok) {
    throw new Error(
      `Failed to fetch GitHub user: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as GitHubUser;

  return data;
}

/*
 * ---------------------------------------------------------
 * STAR PROJECT
 * ---------------------------------------------------------
 *
 * GitHub accepts an empty PUT to this endpoint to add a star
 * for the authenticated user. If the current token does not
 * have the required permission, the caller can fall back to
 * opening the repository page.
 */
export async function starProject(): Promise<void> {
  const response = await githubApiRequest(
    `/user/starred/${PROJECT_REPOSITORY}`,
    {
      method: "PUT",
    },
  );

  if (!response.ok && response.status !== 204) {
    throw new Error(
      `Failed to star repository: ${response.status} ${response.statusText}`,
    );
  }
}

/*
 * ---------------------------------------------------------
 * LIST REPOS
 * ---------------------------------------------------------
 *
 * Lists repos the authenticated user can push to, most
 * recently updated first. Only fetches the first page (100
 * repos) - plenty for a repo picker; someone with more than
 * 100 repos can still type/search within that list.
 */
export async function listRepos(): Promise<GitHubRepo[]> {
  const response = await githubApiRequest(
    "/user/repos?sort=updated&per_page=100&affiliation=owner,collaborator",
  );

  if (!response.ok) {
    throw new Error(
      `Failed to list GitHub repos: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as GitHubRepo[];

  /*
   * Only repos the user can actually push to are useful here.
   * `permissions` is present because we request it implicitly
   * as the authenticated repo owner/collaborator; filter
   * defensively in case GitHub omits it for some entries.
   */
  return data.filter((repo) => repo.permissions?.push !== false);
}

/*
 * ---------------------------------------------------------
 * SAVE FILE TO REPO
 * ---------------------------------------------------------
 *
 * Creates or updates a file at exports/<filename> in the
 * given repo's default branch, via the Contents API:
 *
 *   PUT /repos/{owner}/{repo}/contents/{path}
 *
 * The Contents API requires the file's current `sha` when
 * overwriting an existing file (otherwise GitHub returns 422
 * "sha wasn't supplied"). So this first does a GET to check
 * whether the file already exists and, if so, includes its
 * sha in the PUT body.
 */
export async function saveFileToRepo(
  fullName: string,
  filename: string,
  content: string,
  alreadyBase64 = false,
): Promise<{ htmlUrl: string }> {
  const path = `exports/${filename}`;

  const existing = await githubApiRequest(
    `/repos/${fullName}/contents/${encodeURIComponent(path)}`,
  );

  let existingSha: string | undefined;

  if (existing.ok) {
    const existingData = (await existing.json()) as { sha?: string };

    existingSha = existingData.sha;
  } else if (existing.status !== 404) {
    throw new Error(
      `Failed to check for existing file: ${existing.status} ${existing.statusText}`,
    );
  }

  /*
   * btoa only handles Latin1, but export content is often
   * Cyrillic/UTF-8 (Bulgarian, per Grant's usual conversations)
   * - encode to UTF-8 bytes first via TextEncoder, then to
   * base64, so non-ASCII content survives the round trip.
   *
   * Building the intermediate "binary" string one
   * String.fromCharCode(byte) call at a time is O(n) calls
   * for n bytes, which gets slow for long conversations.
   * String.fromCharCode accepts many arguments at once, so
   * decoding in fixed-size chunks cuts that down to
   * ceil(n / CHUNK_SIZE) calls instead - a few thousand
   * chunks instead of potentially millions of single-byte
   * calls for a very large export. The chunk size is kept
   * well under engines' function-argument limits (which vary,
   * but problems start well beyond 100k) to stay safe.
   */
  let base64Content = content;

  if (!alreadyBase64) {
    const utf8Bytes = new TextEncoder().encode(content);

    const CHUNK_SIZE = 8192;

    let binary = "";

    for (let offset = 0; offset < utf8Bytes.length; offset += CHUNK_SIZE) {
      const chunk = utf8Bytes.subarray(offset, offset + CHUNK_SIZE);

      binary += String.fromCharCode(...chunk);
    }

    base64Content = btoa(binary);
  }

  const response = await githubApiRequest(
    `/repos/${fullName}/contents/${encodeURIComponent(path)}`,
    {
      method: "PUT",
      body: JSON.stringify({
        message: existingSha
          ? `Update ${filename} via AI Exporter`
          : `Add ${filename} via AI Exporter`,
        content: base64Content,
        sha: existingSha,
      }),
    },
  );

  if (response.status === 409) {
    /*
     * 409 here means the file's sha changed between our GET
     * and this PUT - most likely because another save (e.g.
     * a second popup instance, or a double-click that raced
     * past the UI's own busy-state guard) wrote to the same
     * path in between. Retry once with a fresh sha: if the
     * conflicting write finished, this second attempt reads
     * the now-current sha and succeeds; if not, the ordinary
     * error path below still applies.
     */
    const retryExisting = await githubApiRequest(
      `/repos/${fullName}/contents/${encodeURIComponent(path)}`,
    );

    const retrySha = retryExisting.ok
      ? ((await retryExisting.json()) as { sha?: string }).sha
      : undefined;

    const retryResponse = await githubApiRequest(
      `/repos/${fullName}/contents/${encodeURIComponent(path)}`,
      {
        method: "PUT",
        body: JSON.stringify({
          message: `Update ${filename} via AI Exporter`,
          content: base64Content,
          sha: retrySha,
        }),
      },
    );

    if (!retryResponse.ok) {
      throw new Error(
        "Another save to this file happened at the same time and the retry also failed. Please try saving again.",
      );
    }

    const retryData = (await retryResponse.json()) as {
      content?: { html_url?: string };
    };

    return {
      htmlUrl: retryData.content?.html_url ?? `https://github.com/${fullName}`,
    };
  }

  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);

    throw new Error(
      (errorBody as { message?: string } | null)?.message ??
        `Failed to save file to GitHub: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as {
    content?: { html_url?: string };
  };

  return {
    htmlUrl: data.content?.html_url ?? `https://github.com/${fullName}`,
  };
}
