/* Types for scripts/check-store-rules.mjs, used by the tests. */

export interface ManifestToCheck {
  /* Where the manifest comes from, shown in front of its problems. */
  label: string;
  manifest: Record<string, unknown>;
}

export function findCodeProblems(code: string): string[];

export function findHtmlProblems(html: string): string[];

/* { locale: messages.json }, null for one that isn't valid JSON. */
export type Locales = Record<
  string,
  Record<string, { message: string; description?: string }> | null
>;

export function readLocales(directory: string): Locales;

export function findManifestProblems(
  manifest: Record<string, unknown>,
  hasFile: (path: string) => boolean,
  locales?: Locales,
): string[];

export function checkDist(
  distDirectory: string,
  manifests: ManifestToCheck[],
): string[];

export function formatProblems(problems: string[]): string;
