/*
 * =========================================================
 * AI Exporter - claude-conversation.ts
 * =========================================================
 *
 * Turns a claude.ai conversation, as returned by claude.ai's
 * own API, into the messages content.ts hands to popup.ts.
 *
 * claude.ai keeps every branch of a conversation (edited
 * prompts, retried replies) in one flat chat_messages list in
 * which each message points at its parent. The conversation's
 * current_leaf_message_uuid is the last message of the branch
 * on screen, so walking parent pointers up from it yields
 * exactly that branch, in order.
 *
 * Imported only by content.ts. Rollup inlines a module that a
 * single entry imports, so content.js stays free of `import`
 * statements (content scripts aren't ES modules - see the top
 * of content.ts). Importing this from the popup, options or
 * background bundles as well would move it into a shared
 * chunk that content.js would have to import.
 */

/*
 * ---------------------------------------------------------
 * CLAUDE API TYPES
 * ---------------------------------------------------------
 *
 * Only the fields the export reads. Everything is optional:
 * this is claude.ai's internal API, not a documented one.
 */

export interface ClaudeContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
}

export interface ClaudeFileAsset {
  url?: string | null;
}

export interface ClaudeFile {
  file_kind?: string;
  file_uuid?: string;
  file_name?: string;
  preview_url?: string | null;
  thumbnail_url?: string | null;
  preview_asset?: ClaudeFileAsset | null;
  thumbnail_asset?: ClaudeFileAsset | null;
}

export interface ClaudeAttachment {
  file_name?: string;
}

export interface ClaudeChatMessage {
  uuid?: string;
  sender?: string;
  index?: number;
  created_at?: string;
  parent_message_uuid?: string | null;
  text?: string;
  content?: ClaudeContentBlock[];
  attachments?: ClaudeAttachment[];
  files?: ClaudeFile[];
  files_v2?: ClaudeFile[];
}

export interface ClaudeConversation {
  uuid?: string;
  name?: string;
  current_leaf_message_uuid?: string | null;
  chat_messages?: ClaudeChatMessage[];
}

/*
 * ---------------------------------------------------------
 * EXPORT TYPES
 * ---------------------------------------------------------
 *
 * A message is a list of parts so content.ts can swap each
 * image for a downloaded file (or drop it) without having to
 * know anything about Claude's message format.
 */

export interface ClaudeImage {
  /* claude.ai API path of the image; null if none was given. */
  url: string | null;
  fileName: string;
}

export type ClaudeMessagePart =
  | { kind: "text"; text: string }
  | { kind: "image"; image: ClaudeImage };

export interface ClaudeExportMessage {
  id: string;
  role: "user" | "assistant";
  parts: ClaudeMessagePart[];
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/*
 * ---------------------------------------------------------
 * IDS AND URLS
 * ---------------------------------------------------------
 */

export function getClaudeConversationId(pathname: string): string | null {
  const id = pathname.match(/\/chat\/([0-9a-f-]{36})(?:\/|$)/i)?.[1];

  return id && UUID_PATTERN.test(id) ? id : null;
}

/*
 * claude.ai keeps the organization the person last worked in
 * in a lastActiveOrg cookie. A person can belong to several (a
 * personal plan and a Team plan, say), and a conversation only
 * exists in one of them.
 */
export function getClaudeOrganizationIdFromCookie(
  cookie: string,
): string | null {
  for (const entry of cookie.split(";")) {
    const separator = entry.indexOf("=");

    if (
      separator === -1 ||
      entry.slice(0, separator).trim() !== "lastActiveOrg"
    ) {
      continue;
    }

    const value = entry.slice(separator + 1).trim();

    return UUID_PATTERN.test(value) ? value : null;
  }

  return null;
}

/*
 * /api/organizations lists every organization the account
 * belongs to. Only those with the "chat" capability have
 * claude.ai conversations (an API-only Console organization
 * doesn't).
 */
export function getClaudeChatOrganizationIds(organizations: unknown): string[] {
  if (!Array.isArray(organizations)) {
    return [];
  }

  return organizations.flatMap((organization): string[] => {
    if (
      !isRecord(organization) ||
      typeof organization.uuid !== "string" ||
      !UUID_PATTERN.test(organization.uuid)
    ) {
      return [];
    }

    const capabilities = organization.capabilities;

    return Array.isArray(capabilities) && !capabilities.includes("chat")
      ? []
      : [organization.uuid];
  });
}

/*
 * The request claude.ai itself makes to show a conversation:
 * tree=True includes every branch (resolveClaudeActiveBranch
 * picks the visible one), rendering_mode=messages returns each
 * reply as typed content blocks instead of one flattened text
 * string, and render_all_tools=true includes artifact edits.
 */
export function buildClaudeConversationPath(
  organizationId: string,
  conversationId: string,
): string {
  const params = new URLSearchParams({
    tree: "True",
    rendering_mode: "messages",
    render_all_tools: "true",
  });

  return `/api/organizations/${encodeURIComponent(organizationId)}/chat_conversations/${encodeURIComponent(conversationId)}?${params.toString()}`;
}

/*
 * ---------------------------------------------------------
 * ACTIVE BRANCH
 * ---------------------------------------------------------
 */

type IdentifiedClaudeMessage = ClaudeChatMessage & { uuid: string };

function getClaudeMessageTime(message: ClaudeChatMessage): number {
  const time = Date.parse(message.created_at ?? "");

  return Number.isNaN(time) ? 0 : time;
}

export function resolveClaudeActiveBranch(
  conversation: ClaudeConversation,
): ClaudeChatMessage[] {
  const messages = (conversation.chat_messages ?? []).filter(
    (message): message is IdentifiedClaudeMessage =>
      isRecord(message) && typeof message.uuid === "string",
  );

  /*
   * A response without parent pointers holds a single branch
   * already - just put it in order.
   */
  if (
    !messages.some(
      (message) => typeof message.parent_message_uuid === "string",
    )
  ) {
    return [...messages].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  }

  const byId = new Map(messages.map((message) => [message.uuid, message]));

  /*
   * Without a (known) current leaf, the newest message is the
   * best guess for the end of the branch the person last used.
   */
  const leaf =
    byId.get(conversation.current_leaf_message_uuid ?? "") ??
    messages.reduce<IdentifiedClaudeMessage | undefined>(
      (latest, message) =>
        !latest || getClaudeMessageTime(message) >= getClaudeMessageTime(latest)
          ? message
          : latest,
      undefined,
    );

  const branch: ClaudeChatMessage[] = [];
  const visited = new Set<string>();
  let message = leaf;

  while (message && !visited.has(message.uuid)) {
    visited.add(message.uuid);
    branch.push(message);
    message = byId.get(message.parent_message_uuid ?? "");
  }

  return branch.reverse();
}

/*
 * ---------------------------------------------------------
 * ARTIFACTS
 * ---------------------------------------------------------
 *
 * Artifacts are the code and documents Claude writes in the
 * side panel - in this format, the "legacy" artifacts made
 * before claude.ai's September 2026 artifacts update. Each one
 * is created once and then edited in later replies, either
 * rewritten whole or patched with an old_str -> new_str
 * replacement, so the version a reply shows only exists after
 * replaying every edit before it. Each reply that touches an
 * artifact exports the artifact as it stood at the end of that
 * reply.
 */

interface ClaudeArtifact {
  id: string;
  title: string;
  type: string;
  language: string;
  content: string;
}

const ARTIFACT_COMMANDS = new Set(["create", "update", "rewrite"]);

const ARTIFACT_LANGUAGES: Record<string, string> = {
  "text/html": "html",
  "image/svg+xml": "svg",
  "application/vnd.ant.mermaid": "mermaid",
  "application/vnd.ant.react": "jsx",
};

function getArtifactInput(
  block: ClaudeContentBlock,
): (Record<string, unknown> & { id: string }) | null {
  const input = block.input;

  return block.type === "tool_use" &&
    isRecord(input) &&
    typeof input.id === "string" &&
    typeof input.command === "string" &&
    ARTIFACT_COMMANDS.has(input.command)
    ? (input as Record<string, unknown> & { id: string })
    : null;
}

/*
 * Returns the artifact after the edit, or undefined for an
 * update to an artifact this branch never created. An update
 * whose old_str isn't found leaves the content unchanged -
 * which is also what claude.ai showed for it.
 */
function applyArtifactCommand(
  artifacts: Map<string, ClaudeArtifact>,
  input: Record<string, unknown> & { id: string },
): ClaudeArtifact | undefined {
  const previous = artifacts.get(input.id);

  if (input.command === "update" && !previous) {
    return undefined;
  }

  const artifact: ClaudeArtifact = {
    id: input.id,
    title: stringValue(input.title) ?? previous?.title ?? "",
    type: stringValue(input.type) ?? previous?.type ?? "",
    language: stringValue(input.language) ?? previous?.language ?? "",
    content: previous?.content ?? "",
  };

  if (input.command === "update") {
    const oldText = stringValue(input.old_str) ?? "";
    const start = oldText ? artifact.content.indexOf(oldText) : -1;

    if (start !== -1) {
      artifact.content =
        artifact.content.slice(0, start) +
        (stringValue(input.new_str) ?? "") +
        artifact.content.slice(start + oldText.length);
    }
  } else {
    artifact.content = stringValue(input.content) ?? "";
  }

  artifacts.set(input.id, artifact);

  return artifact;
}

/*
 * A document artifact is Markdown already and is kept as such;
 * everything else becomes a code block. The fence is made
 * longer than any fence inside the content, so a README with
 * its own code blocks doesn't close it early.
 */
function renderArtifact(artifact: ClaudeArtifact): string {
  const content = artifact.content.replace(/^\n+|\s+$/g, "");

  if (!content) {
    return "";
  }

  const heading = `**Artifact: ${artifact.title.trim() || artifact.id}**`;

  if (artifact.type === "text/markdown") {
    return `${heading}\n\n${content}`;
  }

  const language = (
    artifact.language ||
    ARTIFACT_LANGUAGES[artifact.type] ||
    ""
  ).replace(/[^\w+#.-]/g, "");
  const longestInnerFence = Math.max(
    0,
    ...Array.from(
      content.matchAll(/^[ \t]*(`{3,})/gm),
      (match) => match[1].length,
    ),
  );
  const fence = "`".repeat(Math.max(3, longestInnerFence + 1));

  return `${heading}\n\n${fence}${language}\n${content}\n${fence}`;
}

/*
 * ---------------------------------------------------------
 * MESSAGE CONTENT
 * ---------------------------------------------------------
 *
 * Text and voice-note blocks are the reply itself (Markdown).
 * Thinking, tool calls and tool results are left out, the
 * same way the ChatGPT export leaves out reasoning and tool
 * traffic - except artifacts, which are usually the substance
 * of the reply.
 */

type PendingPart = ClaudeMessagePart | { kind: "artifact"; id: string };

/*
 * Older replies can come back as a single text string with
 * artifacts and thinking inlined as <antArtifact> and
 * <antThinking> tags instead of content blocks.
 */
function convertLegacyText(text: string): string {
  return text
    .replace(/<antThinking>[\s\S]*?<\/antThinking>\n*/g, "")
    .replace(
      /\n*<antArtifact\b([^>]*)>([\s\S]*?)<\/antArtifact>\n*/g,
      (_match, attributes: string, body: string) => {
        const attribute = (name: string): string =>
          attributes.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? "";

        return `\n\n${renderArtifact({
          id: attribute("identifier"),
          title: attribute("title"),
          type: attribute("type"),
          language: attribute("language"),
          content: body,
        })}\n\n`;
      },
    )
    .trim();
}

function getContentParts(
  message: ClaudeChatMessage,
  artifacts: Map<string, ClaudeArtifact>,
): ClaudeMessagePart[] {
  const blocks = Array.isArray(message.content)
    ? message.content.filter(isRecord)
    : [];

  /*
   * Only without any content blocks: when blocks exist, `text`
   * can hold placeholders for them ("This block is not
   * supported on your current device yet.").
   */
  if (blocks.length === 0) {
    const text = convertLegacyText(stringValue(message.text) ?? "");

    return text ? [{ kind: "text", text }] : [];
  }

  const parts: PendingPart[] = [];
  let textRun = "";

  const flushText = (): void => {
    const text = textRun.replace(/^(?:[ \t]*\n)+/, "").trimEnd();

    if (text) {
      parts.push({ kind: "text", text });
    }

    textRun = "";
  };

  for (const block of blocks) {
    /*
     * Consecutive text blocks are one passage cut up around
     * citations, so they're joined as-is; anything in between
     * (a tool call, say) starts a new paragraph.
     */
    if (block.type === "text") {
      textRun += stringValue(block.text) ?? "";
      continue;
    }

    flushText();

    if (block.type === "voice_note") {
      textRun = stringValue(block.text) ?? "";
      flushText();
      continue;
    }

    const input = getArtifactInput(block);

    if (
      input &&
      applyArtifactCommand(artifacts, input) &&
      !parts.some((part) => part.kind === "artifact" && part.id === input.id)
    ) {
      parts.push({ kind: "artifact", id: input.id });
    }
  }

  flushText();

  return parts.flatMap((part): ClaudeMessagePart[] => {
    if (part.kind !== "artifact") {
      return [part];
    }

    const artifact = artifacts.get(part.id);
    const text = artifact ? renderArtifact(artifact) : "";

    return text ? [{ kind: "text", text }] : [];
  });
}

/*
 * Uploaded images become image parts, which content.ts
 * downloads when image bundling is on, like ChatGPT uploads.
 * Other files and pasted documents are listed by name: their
 * extracted text can run to whole books, so it isn't inlined.
 */
function getFileParts(message: ClaudeChatMessage): ClaudeMessagePart[] {
  const files =
    Array.isArray(message.files_v2) && message.files_v2.length > 0
      ? message.files_v2
      : Array.isArray(message.files)
        ? message.files
        : [];
  const parts: ClaudeMessagePart[] = [];

  for (const file of files) {
    if (!isRecord(file)) {
      continue;
    }

    const fileName = stringValue(file.file_name)?.trim() || "file";

    if (file.file_kind !== "image") {
      parts.push({ kind: "text", text: `[Attachment: ${fileName}]` });
      continue;
    }

    const url = [
      file.preview_url,
      isRecord(file.preview_asset) ? file.preview_asset.url : undefined,
      file.thumbnail_url,
      isRecord(file.thumbnail_asset) ? file.thumbnail_asset.url : undefined,
    ].find((candidate): candidate is string => Boolean(stringValue(candidate)));

    parts.push({ kind: "image", image: { url: url ?? null, fileName } });
  }

  for (const attachment of Array.isArray(message.attachments)
    ? message.attachments
    : []) {
    if (isRecord(attachment)) {
      const fileName =
        stringValue(attachment.file_name)?.trim() || "pasted text";

      parts.push({ kind: "text", text: `[Attachment: ${fileName}]` });
    }
  }

  return parts;
}

/*
 * Messages must be in conversation order (as returned by
 * resolveClaudeActiveBranch): artifact edits are replayed in
 * that order.
 */
export function convertClaudeMessages(
  messages: ClaudeChatMessage[],
): ClaudeExportMessage[] {
  const artifacts = new Map<string, ClaudeArtifact>();

  return messages.flatMap((message): ClaudeExportMessage[] => {
    const role =
      message.sender === "human"
        ? "user"
        : message.sender === "assistant"
          ? "assistant"
          : null;

    if (!role || typeof message.uuid !== "string") {
      return [];
    }

    const parts = [
      ...getFileParts(message),
      ...getContentParts(message, artifacts),
    ];

    return parts.length > 0 ? [{ id: message.uuid, role, parts }] : [];
  });
}
