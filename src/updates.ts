/*
 * =========================================================
 * AI Exporter - updates.ts
 * =========================================================
 *
 * The shared half of keeping AI Exporter up to date: comparing
 * versions, asking the store for its newest version, and the
 * small record of update state that background.ts writes and
 * popup.ts shows (the version in the popup footer, the
 * "update ready" banner).
 *
 * WHY THE EXTENSION HAS TO HELP ITS OWN UPDATES ALONG:
 *
 * Browsers update store extensions on their own, but they only
 * install an update while the extension isn't running:
 *
 *   - Chrome looks for updates every few hours and downloads
 *     them, then holds a download back for as long as any page
 *     of the extension is open. The offscreen document
 *     background.ts opens for copying and downloading stays
 *     open until the browser quits, so after a single copy or
 *     export Chrome would sit on every update until the next
 *     browser restart - weeks away, for a lot of people.
 *   - Firefox looks once a day and installs right away, unless
 *     the update asks for new permissions: that one waits until
 *     the person approves it from the Firefox menu.
 *
 * Both browsers fire runtime.onUpdateAvailable for an update
 * they're holding back, and reloading the extension installs
 * it - background.ts does that as soon as nothing is in
 * progress. Asking the store directly (requestUpdateCheck in
 * Chrome, the addons.mozilla.org API in Firefox, which has no
 * requestUpdateCheck) is what lets the popup say whether a
 * newer version exists at all.
 */

export const UPDATE_STATE_KEY = "updateState";

/*
 * The version background.ts just updated to, left for the next
 * popup to mention once and then remove. Its own key rather than
 * a field of UpdateState, so the popup can clear it without
 * racing background.ts's writes to the state.
 */
export const UPDATE_NOTICE_KEY = "updateNotice";

/*
 * How long a store check counts as fresh before opening the
 * popup asks again. Chrome already looks every 5 hours on its
 * own, and answers "throttled" to a requestUpdateCheck() made
 * within about 5 hours of the previous one.
 */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/*
 * In Chrome, a check that finds an update also starts
 * downloading it, and onUpdateAvailable marks it ready seconds
 * later. One that still isn't ready after this long is waiting
 * for Chrome's next update round instead.
 */
const DOWNLOAD_WAIT_MS = 10 * 60 * 1000;

const AMO_ADDON_API_URL = "https://addons.mozilla.org/api/v5/addons/addon/";

/*
 * Stored in chrome.storage.local (it describes this browser's
 * install, so it shouldn't sync to the person's other ones).
 */
export interface UpdateState {
  /* Newest version the store reported. */
  latestVersion?: string;
  /* When the store last gave an answer, in ms since the epoch. */
  checkedAt?: number;
  /*
   * Version the browser has downloaded and is holding back
   * until AI Exporter reloads (from runtime.onUpdateAvailable).
   */
  readyVersion?: string;
  /*
   * The readyVersion a reload was already spent on - see
   * installPendingUpdate() in background.ts.
   */
  reloadedFor?: string;
}

export type StoreCheckStatus =
  | "update_available"
  | "no_update"
  | "throttled"
  /*
   * The store doesn't list this add-on ID: a temporary Firefox
   * add-on loaded from source, or a build under another ID.
   */
  | "unlisted"
  | "error";

export interface StoreCheckResult {
  status: StoreCheckStatus;
  /* The newer version, when status is "update_available". */
  version?: string;
}

/*
 * What the popup shows, worked out from UpdateState:
 *   ready       - downloaded, installs on the next reload
 *   downloading - Chrome found it and is fetching it
 *   available   - the store has it, the browser doesn't yet
 *   current     - the store's newest version is this one
 *   unknown     - the store hasn't answered yet
 */
export type UpdateView =
  | { kind: "ready"; version: string }
  | { kind: "downloading"; version: string }
  | { kind: "available"; version: string }
  | { kind: "current"; checkedAt: number }
  | { kind: "unknown" };

/*
 * ---------------------------------------------------------
 * VERSIONS
 * ---------------------------------------------------------
 *
 * Extension versions are one to four dot-separated integers
 * ("2.3.0", "2.10"), so they compare part by part as numbers -
 * as strings, "2.10.0" would sort before "2.9.0". A missing
 * part counts as 0, so "2.3" equals "2.3.0".
 */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);

  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);

    if (difference !== 0) {
      return Math.sign(difference);
    }
  }

  return 0;
}

export function isNewerVersion(
  candidate: string | undefined,
  current: string,
): candidate is string {
  return (
    typeof candidate === "string" && compareVersions(candidate, current) > 0
  );
}

export function getRunningVersion(): string {
  return chrome.runtime.getManifest().version;
}

/*
 * Chrome (and Edge) have runtime.requestUpdateCheck(), and an
 * update it finds starts downloading straight away. Firefox
 * doesn't implement it, so there the popup can only point at
 * Firefox's own "Check for Updates".
 */
export function storeInstallsUpdates(): boolean {
  return typeof chrome.runtime.requestUpdateCheck === "function";
}

/*
 * ---------------------------------------------------------
 * STORED STATE
 * ---------------------------------------------------------
 */
export async function loadUpdateState(): Promise<UpdateState> {
  const stored = await chrome.storage.local.get(UPDATE_STATE_KEY);
  const state = stored[UPDATE_STATE_KEY];

  return state !== null && typeof state === "object"
    ? (state as UpdateState)
    : {};
}

let pendingStateChange: Promise<unknown> = Promise.resolve();

/*
 * Read-modify-write of the stored state, queued so that two
 * events landing together (a store check finishing just as
 * onUpdateAvailable fires, say) can't overwrite each other's
 * changes. background.ts is the only writer, so a queue in this
 * one module instance is enough.
 */
export function changeUpdateState(
  change: (state: UpdateState) => UpdateState,
): Promise<UpdateState> {
  const changed = pendingStateChange.then(async () => {
    const next = change(await loadUpdateState());

    await chrome.storage.local.set({ [UPDATE_STATE_KEY]: next });

    return next;
  });

  pendingStateChange = changed.catch(() => undefined);

  return changed;
}

export function getUpdateView(
  state: UpdateState,
  runningVersion: string,
  installsUpdates: boolean,
  now = Date.now(),
): UpdateView {
  if (isNewerVersion(state.readyVersion, runningVersion)) {
    return { kind: "ready", version: state.readyVersion };
  }

  if (isNewerVersion(state.latestVersion, runningVersion)) {
    const downloading =
      installsUpdates &&
      state.checkedAt !== undefined &&
      now - state.checkedAt < DOWNLOAD_WAIT_MS;

    return {
      kind: downloading ? "downloading" : "available",
      version: state.latestVersion,
    };
  }

  if (state.checkedAt !== undefined) {
    return { kind: "current", checkedAt: state.checkedAt };
  }

  return { kind: "unknown" };
}

/*
 * ---------------------------------------------------------
 * ASKING THE STORE
 * ---------------------------------------------------------
 *
 * Never throws - a failed check is reported as "error", and
 * whatever was known before stays as it was.
 */
export async function checkStoreForUpdate(
  runningVersion: string,
): Promise<StoreCheckResult> {
  try {
    if (storeInstallsUpdates()) {
      const { status, version } = await chrome.runtime.requestUpdateCheck();

      if (status === "update_available") {
        return isNewerVersion(version, runningVersion)
          ? { status, version }
          : { status: "no_update" };
      }

      return { status };
    }

    return await checkAddonsMozillaOrg(runningVersion);
  } catch {
    return { status: "error" };
  }
}

/*
 * addons.mozilla.org's public API says which version of an
 * add-on is current, answers anyone and allows any origin, so
 * this needs no host permission. All it's sent is the add-on's
 * ID - the public one from manifest.firefox.json - and no
 * cookies.
 */
async function checkAddonsMozillaOrg(
  runningVersion: string,
): Promise<StoreCheckResult> {
  const response = await fetch(
    `${AMO_ADDON_API_URL}${encodeURIComponent(chrome.runtime.id)}/`,
    { cache: "no-cache", credentials: "omit" },
  );

  if (response.status === 404) {
    return { status: "unlisted" };
  }

  if (!response.ok) {
    return { status: "error" };
  }

  const data = (await response.json()) as {
    current_version?: { version?: unknown };
  };
  const version = data.current_version?.version;

  if (typeof version !== "string") {
    return { status: "error" };
  }

  return isNewerVersion(version, runningVersion)
    ? { status: "update_available", version }
    : { status: "no_update" };
}
