import { constants as fsConstants } from "node:fs";
import { access, mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { type JsonObject, type JsonValue } from "../config/schema.js";

export const UNIFIED_SESSION_KEY = "unified:default";
const DEFAULT_MAX_MESSAGES = 120;
const DEFAULT_FILE_MAX_MESSAGES = 2_000;
const CHANNEL_DELIVERY_REPLAY = Symbol("channelDeliveryReplay");

export interface SessionMessage {
  role: string;
  content: JsonValue;
  timestamp?: string;
  toolCalls?: JsonValue;
  toolCallId?: string;
  name?: string;
  reasoningContent?: string;
  thinkingBlocks?: JsonObject[];
  [key: string]: JsonValue | undefined;
}

interface SessionHistoryInternalMessage extends SessionMessage {
  [CHANNEL_DELIVERY_REPLAY]?: true;
}

export interface SessionHistoryOptions {
  maxMessages?: number;
  maxTokens?: number;
  includeTimestamps?: boolean;
}

export interface SessionFilePayload {
  key: string;
  createdAt: string;
  created_at: string;
  updatedAt: string;
  updated_at: string;
  metadata: JsonObject;
  lastConsolidated: number;
  last_consolidated: number;
  messages: SessionMessage[];
}

export interface SessionListEntry {
  key: string;
  createdAt: string;
  created_at: string;
  updatedAt: string;
  updated_at: string;
  metadata: JsonObject;
  lastConsolidated: number;
  last_consolidated: number;
  title: string;
  preview: string;
  path: string;
}

export interface SessionManagerOptions {
  legacySessionsDir?: string;
}

export interface SessionFileCapOptions {
  limit?: number;
  onArchive?: (messages: SessionMessage[]) => void;
}

export interface SessionKeyInput {
  originalKey: string;
  unifiedSession?: boolean;
  overrideKey?: string | null;
}

export class Session {
  readonly key: string;
  messages: SessionMessage[];
  createdAt: Date;
  updatedAt: Date;
  metadata: JsonObject;
  lastConsolidated: number;

  constructor(input: {
    key: string;
    messages?: SessionMessage[];
    createdAt?: Date;
    updatedAt?: Date;
    metadata?: JsonObject;
    lastConsolidated?: number;
  }) {
    this.key = input.key;
    this.messages = input.messages ?? [];
    this.createdAt = input.createdAt ?? new Date();
    this.updatedAt = input.updatedAt ?? new Date();
    this.metadata = input.metadata ?? {};
    this.lastConsolidated = normalizeLastConsolidated(input.lastConsolidated, this.messages.length);
  }

  addMessage(role: string, content: JsonValue, extra: Partial<SessionMessage> = {}): void {
    this.messages.push({
      role,
      content,
      timestamp: new Date().toISOString(),
      ...extra,
    });
    this.updatedAt = new Date();
  }

  getHistory(maxMessages?: number): SessionMessage[];
  getHistory(options?: SessionHistoryOptions): SessionMessage[];
  getHistory(input: number | SessionHistoryOptions = DEFAULT_MAX_MESSAGES): SessionMessage[] {
    const options = typeof input === "number" ? { maxMessages: input } : input;
    const maxMessages = options.maxMessages !== undefined && options.maxMessages > 0
      ? options.maxMessages
      : DEFAULT_MAX_MESSAGES;
    const maxTokens = options.maxTokens !== undefined && options.maxTokens > 0 ? options.maxTokens : 0;
    const includeTimestamps = options.includeTimestamps === true;

    let sliced = this.messages.slice(this.lastConsolidated).filter((message) => message._command !== true).slice(-maxMessages);
    sliced = trimToReplayBoundary(sliced);

    let history = sliced.flatMap((message) => this.toHistoryMessage(message, includeTimestamps));
    if (maxTokens > 0 && history.length > 0) {
      history = trimByApproximateTokens(history, maxTokens);
    }
    return history;
  }

  clear(): void {
    this.messages = [];
    this.lastConsolidated = 0;
    this.updatedAt = new Date();
  }

  retainRecentLegalSuffix(maxMessages: number): [SessionMessage[], number] {
    if (maxMessages <= 0) {
      const dropped = [...this.messages];
      const alreadyConsolidated = Math.min(this.lastConsolidated, dropped.length);
      this.clear();
      return [dropped, alreadyConsolidated];
    }
    if (this.messages.length <= maxMessages) {
      return [[], 0];
    }

    const original = [...this.messages];
    const beforeLastConsolidated = this.lastConsolidated;
    const retained = trimToReplayBoundary(this.messages.slice(-maxMessages));

    const retainedSet = new Set(retained);
    const dropped = original.filter((message) => !retainedSet.has(message));
    const alreadyConsolidated = original.filter((message, index) => index < beforeLastConsolidated && !retainedSet.has(message)).length;
    const newLastConsolidated = original.filter((message, index) => index < beforeLastConsolidated && retainedSet.has(message)).length;

    this.messages = retained;
    this.lastConsolidated = newLastConsolidated;
    this.updatedAt = new Date();
    return [dropped, alreadyConsolidated];
  }

  enforceFileCap(options: SessionFileCapOptions = {}): SessionMessage[] {
    const limit = options.limit ?? DEFAULT_FILE_MAX_MESSAGES;
    if (limit <= 0 || this.messages.length <= limit) {
      return [];
    }

    const [dropped, alreadyConsolidated] = this.retainRecentLegalSuffix(limit);
    const archiveChunk = dropped.slice(alreadyConsolidated);
    if (archiveChunk.length > 0) {
      options.onArchive?.(archiveChunk);
    }
    return dropped;
  }

  private toHistoryMessage(message: SessionMessage, includeTimestamp: boolean): SessionMessage[] {
    if (message._command === true) {
      return [];
    }

    let content = message.content;
    if (message.role === "assistant" && typeof content === "string") {
      content = sanitizeAssistantReplayText(content);
    }
    if (message.role === "user") {
      content = addUserBreadcrumbs(content, message);
      if (includeTimestamp && typeof content === "string" && typeof message.timestamp === "string" && message.timestamp.length > 0) {
        content = `[Message Time: ${message.timestamp}]\n${content}`;
      }
    }

    if (message.role === "assistant" && isBlankString(content) && !hasAssistantPayload(message)) {
      return [];
    }

    const entry: SessionMessage = { role: message.role, content };
    if (isAssistantChannelDelivery(message)) {
      Object.defineProperty(entry, CHANNEL_DELIVERY_REPLAY, { value: true });
    }
    copyIfPresent(message, entry, "tool_calls");
    copyIfPresent(message, entry, "toolCalls");
    copyIfPresent(message, entry, "tool_call_id");
    copyIfPresent(message, entry, "toolCallId");
    copyIfPresent(message, entry, "name");
    copyIfPresent(message, entry, "reasoningContent");
    copyIfPresent(message, entry, "reasoning_content");
    copyIfPresent(message, entry, "thinkingBlocks");
    copyIfPresent(message, entry, "thinking_blocks");
    return [entry];
  }
}

export class SessionManager {
  readonly workspace: string;
  readonly sessionsDir: string;
  readonly legacySessionsDir?: string;
  private readonly cache = new Map<string, Session>();

  constructor(workspace: string, options: SessionManagerOptions = {}) {
    this.workspace = workspace;
    this.sessionsDir = join(workspace, "sessions");
    this.legacySessionsDir = options.legacySessionsDir;
  }

  static safeKey(key: string): string {
    return key.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "session";
  }

  async getOrCreate(key: string): Promise<Session> {
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }

    const loaded = await this.load(key);
    const session = loaded ?? new Session({ key });
    this.cache.set(key, session);
    return session;
  }

  async save(session: Session, options: { fsync?: boolean } = {}): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });

    const path = this.sessionPath(session.key);
    const tmpPath = `${path}.tmp`;
    try {
      const metadata = {
        _type: "metadata",
        key: session.key,
        createdAt: session.createdAt.toISOString(),
        created_at: session.createdAt.toISOString(),
        updatedAt: session.updatedAt.toISOString(),
        updated_at: session.updatedAt.toISOString(),
        metadata: session.metadata,
        lastConsolidated: session.lastConsolidated,
        last_consolidated: session.lastConsolidated,
      };
      const lines = [metadata, ...session.messages].map((entry) => JSON.stringify(entry));

      await writeFile(tmpPath, `${lines.join("\n")}\n`, "utf8");
      if (options.fsync === true) {
        await syncFile(tmpPath);
      }
      await rename(tmpPath, path);
      if (options.fsync === true) {
        await syncDirectory(this.sessionsDir);
      }
      this.cache.set(session.key, session);
    } catch (error) {
      await unlinkIfExists(tmpPath);
      throw error;
    }
  }

  async deleteSession(key: string): Promise<boolean> {
    this.cache.delete(key);

    const path = this.sessionPath(key);
    if (!(await exists(path))) {
      return false;
    }

    await unlink(path);
    return true;
  }

  invalidate(key: string): void {
    this.cache.delete(key);
  }

  async flushAll(): Promise<number> {
    let flushed = 0;
    for (const session of this.cache.values()) {
      try {
        await this.save(session, { fsync: true });
        flushed += 1;
      } catch {
        // Best-effort shutdown flush: one bad session must not block others.
      }
    }
    return flushed;
  }

  async readSessionFile(key: string): Promise<SessionFilePayload | undefined> {
    const loaded = await this.load(key, { migrateLegacy: false });
    if (!loaded) {
      return undefined;
    }
    return sessionPayload(loaded);
  }

  async listSessions(): Promise<SessionListEntry[]> {
    await mkdir(this.sessionsDir, { recursive: true });
    const entries = await readdir(this.sessionsDir);
    const sessions: SessionListEntry[] = [];
    for (const fileName of entries) {
      if (!fileName.endsWith(".jsonl")) {
        continue;
      }
      const fallbackKey = fileName.slice(0, -".jsonl".length);
      const loaded = await this.load(fallbackKey, { migrateLegacy: false, path: join(this.sessionsDir, fileName) });
      if (!loaded) {
        continue;
      }
      const payload = sessionPayload(loaded);
      sessions.push({
        ...payload,
        title: sessionListTitle(payload.metadata),
        preview: firstPreviewText(payload.messages),
        path: join(this.sessionsDir, fileName),
      });
    }
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private sessionPath(key: string): string {
    return join(this.sessionsDir, `${SessionManager.safeKey(key)}.jsonl`);
  }

  private legacySessionPath(key: string): string | undefined {
    return this.legacySessionsDir ? join(this.legacySessionsDir, `${SessionManager.safeKey(key)}.jsonl`) : undefined;
  }

  private async load(key: string, options: { migrateLegacy?: boolean; path?: string } = {}): Promise<Session | undefined> {
    const path = options.path ?? this.sessionPath(key);
    if (!(await exists(path))) {
      if (options.migrateLegacy !== false) {
        const legacyPath = this.legacySessionPath(key);
        if (legacyPath && await exists(legacyPath)) {
          await mkdir(this.sessionsDir, { recursive: true });
          await rename(legacyPath, path);
        }
      }
    }
    if (!(await exists(path))) {
      return undefined;
    }

    const text = await readFile(path, "utf8");
    const messages: SessionMessage[] = [];
    let createdAt: Date | undefined;
    let updatedAt: Date | undefined;
    let metadata: JsonObject = {};
    let lastConsolidated = 0;
    let storedKey: string | undefined;

    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      const record = asJsonObject(parsed);
      if (!record) {
        continue;
      }

      if (record._type === "metadata") {
        createdAt = parseDate(stringValue(record.createdAt) ?? stringValue(record.created_at)) ?? createdAt;
        updatedAt = parseDate(stringValue(record.updatedAt) ?? stringValue(record.updated_at)) ?? updatedAt;
        metadata = asJsonObject(record.metadata) ?? {};
        lastConsolidated = numberField(record, "lastConsolidated") ?? numberField(record, "last_consolidated") ?? 0;
        storedKey = typeof record.key === "string" ? record.key : storedKey;
      } else {
        const message = asSessionMessage(record);
        if (message) {
          messages.push(message);
        }
      }
    }

    return new Session({ key: storedKey ?? key, messages, createdAt, updatedAt, metadata, lastConsolidated });
  }
}

export function resolveSessionKey(input: SessionKeyInput): string {
  if (input.overrideKey && input.overrideKey.length > 0) {
    return input.overrideKey;
  }
  return input.unifiedSession === true ? UNIFIED_SESSION_KEY : input.originalKey;
}

export function effectiveSessionKey(input: SessionKeyInput): string {
  return resolveSessionKey(input);
}

function trimToReplayBoundary(messages: SessionMessage[]): SessionMessage[] {
  let sliced = messages.slice(findReplayStartIndex(messages));
  const legalStart = findLegalMessageStart(sliced);
  if (legalStart > 0) {
    sliced = sliced.slice(legalStart);
  }
  return sliced;
}

function findReplayStartIndex(messages: SessionMessage[]): number {
  const firstUserIndex = messages.findIndex((message) => message.role === "user");
  if (firstUserIndex < 0) {
    return 0;
  }
  const previous = messages[firstUserIndex - 1];
  return previous && isAssistantChannelDelivery(previous) ? firstUserIndex - 1 : firstUserIndex;
}

function isAssistantChannelDelivery(message: SessionMessage): boolean {
  return message.role === "assistant"
    && (message._channel_delivery === true || (message as SessionHistoryInternalMessage)[CHANNEL_DELIVERY_REPLAY] === true);
}

function findLegalMessageStart(messages: SessionMessage[]): number {
  for (let index = 0; index < messages.length; index += 1) {
    const suffix = messages.slice(index);
    if (suffix.length === 0) {
      return index;
    }
    if (suffix[0]?.role === "tool") {
      continue;
    }
    if (!hasOrphanToolResultPrefix(suffix)) {
      return index;
    }
  }
  return messages.length;
}

function hasOrphanToolResultPrefix(messages: SessionMessage[]): boolean {
  const declared = new Set<string>();
  for (const message of messages) {
    for (const id of toolCallIds(message)) {
      declared.add(id);
    }
    if (message.role === "tool") {
      const id = toolResultId(message);
      if (id && !declared.has(id)) {
        return true;
      }
    }
  }
  return false;
}

function toolCallIds(message: SessionMessage): string[] {
  const calls = valueAsArray(message.tool_calls) ?? valueAsArray(message.toolCalls);
  if (!calls) {
    return [];
  }
  return calls.flatMap((call) => {
    const record = valueAsObject(call);
    const id = record?.id;
    return typeof id === "string" ? [id] : [];
  });
}

function toolResultId(message: SessionMessage): string | undefined {
  const snake = message.tool_call_id;
  if (typeof snake === "string") {
    return snake;
  }
  return typeof message.toolCallId === "string" ? message.toolCallId : undefined;
}

function addUserBreadcrumbs(content: JsonValue, message: SessionMessage): JsonValue {
  if (typeof content !== "string") {
    return content;
  }

  const lines: string[] = [];
  const media = valueAsArray(message.media);
  if (media) {
    for (const item of media) {
      if (typeof item === "string" && item.length > 0) {
        lines.push(`[image: ${item}]`);
      }
    }
  }

  const cliApps = valueAsArray(message.cliApps) ?? valueAsArray(message.cli_apps);
  if (cliApps) {
    for (const item of cliApps.slice(0, 8)) {
      const app = valueAsObject(item);
      const name = normalizeAttachmentName(app?.name);
      if (!name) {
        continue;
      }
      const entryPoint = stringField(app, "entryPoint") ?? stringField(app, "entry_point") ?? "unknown";
      lines.push(`[CLI App Attachment: @${name}; tool=run_cli_app; entry_point=${entryPoint}; skill=skills/cli-app-${name}/SKILL.md]`);
    }
  }

  const mcpPresets = valueAsArray(message.mcpPresets) ?? valueAsArray(message.mcp_presets);
  if (mcpPresets) {
    for (const item of mcpPresets.slice(0, 8)) {
      const preset = valueAsObject(item);
      const name = normalizeAttachmentName(preset?.name);
      if (!name) {
        continue;
      }
      const transport = stringField(preset, "transport") ?? "mcp";
      lines.push(`[MCP Preset Attachment: @${name}; tool_prefix=mcp_${name}_; transport=${transport}]`);
    }
  }

  if (lines.length === 0) {
    return content;
  }
  return content.length > 0 ? `${content}\n${lines.join("\n")}` : lines.join("\n");
}

function sanitizeAssistantReplayText(content: string): string {
  return content
    .replace(/^\[Message Time: [^\]]+\]\n?/, "")
    .split(/\r?\n/)
    .filter((line) => !/^\[image: (?:\/|~)[^\]]+\]\s*$/.test(line))
    .filter((line) => !/^\s*(?:generate_image|message)\([^)]*\)\s*$/.test(line))
    .join("\n")
    .trim();
}

function hasAssistantPayload(message: SessionMessage): boolean {
  return message.tool_calls !== undefined
    || message.toolCalls !== undefined
    || message.reasoningContent !== undefined
    || message.reasoning_content !== undefined
    || message.thinkingBlocks !== undefined
    || message.thinking_blocks !== undefined;
}

function trimByApproximateTokens(messages: SessionMessage[], maxTokens: number): SessionMessage[] {
  const kept: SessionMessage[] = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    const tokens = estimateMessageTokens(message);
    if (kept.length > 0 && used + tokens > maxTokens) {
      break;
    }
    kept.unshift(message);
    used += tokens;
  }

  const firstUser = kept.findIndex((message) => message.role === "user");
  if (firstUser >= 0) {
    return trimToReplayBoundary(kept);
  }

  const recoveredUser = findLastIndex(messages, (message) => message.role === "user");
  if (recoveredUser < 0) {
    return trimToReplayBoundary(kept);
  }
  const recoveryStart = recoveredUser > 0 && isAssistantChannelDelivery(messages[recoveredUser - 1] as SessionMessage)
    ? recoveredUser - 1
    : recoveredUser;
  return trimToReplayBoundary(messages.slice(recoveryStart));
}

function estimateMessageTokens(message: SessionMessage): number {
  return Math.max(1, Math.ceil(JSON.stringify(message).length / 4));
}

function sessionPayload(session: Session): SessionFilePayload {
  const createdAt = session.createdAt.toISOString();
  const updatedAt = session.updatedAt.toISOString();
  return {
    key: session.key,
    createdAt,
    created_at: createdAt,
    updatedAt,
    updated_at: updatedAt,
    metadata: session.metadata,
    lastConsolidated: session.lastConsolidated,
    last_consolidated: session.lastConsolidated,
    messages: session.messages,
  };
}

function sessionListTitle(metadata: JsonObject): string {
  const title = metadata.title;
  if (typeof title !== "string") {
    return "";
  }
  return metadata.title_user_edited === true ? title : stripThinkBlocks(title);
}

function stripThinkBlocks(value: string): string {
  return value.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "").replace(/\s+/g, " ").trim();
}

function firstPreviewText(messages: SessionMessage[]): string {
  for (const message of messages) {
    const preview = previewText(message.content);
    if (message.role === "user" && preview) {
      return preview;
    }
  }
  for (const message of messages) {
    const preview = previewText(message.content);
    if (preview) {
      return preview;
    }
  }
  return "";
}

function previewText(content: JsonValue): string {
  if (typeof content === "string") {
    return content.replace(/\s+/g, " ").trim().slice(0, 120);
  }
  if (Array.isArray(content)) {
    return content.flatMap((item) => {
      const record = valueAsObject(item);
      const text = record?.text;
      return typeof text === "string" ? [text] : [];
    }).join(" ").replace(/\s+/g, " ").trim().slice(0, 120);
  }
  return "";
}

function copyIfPresent(source: SessionMessage, target: SessionMessage, key: string): void {
  const value = source[key];
  if (value !== undefined) {
    target[key] = value;
  }
}

function valueAsArray(value: JsonValue | undefined): JsonValue[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function valueAsObject(value: JsonValue | undefined): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function asJsonObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : undefined;
}

function asSessionMessage(record: JsonObject): SessionMessage | undefined {
  if (typeof record.role !== "string" || !hasOwn(record, "content")) {
    return undefined;
  }
  return record as SessionMessage;
}

function hasOwn(record: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberField(record: JsonObject, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function stringField(record: JsonObject | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeAttachmentName(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().toLowerCase() : undefined;
}

function isBlankString(value: JsonValue): boolean {
  return typeof value === "string" && value.trim().length === 0;
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index] as T)) {
      return index;
    }
  }
  return -1;
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

async function syncFile(path: string): Promise<void> {
  const file = await open(path, "r");
  try {
    try {
      await file.sync();
    } catch (error) {
      if (!isUnsupportedSyncError(error)) {
        throw error;
      }
    }
  } finally {
    await file.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  let directory;
  try {
    directory = await open(path, "r");
  } catch (error) {
    if (!isUnsupportedSyncError(error)) {
      throw error;
    }
    return;
  }
  try {
    try {
      await directory.sync();
    } catch (error) {
      if (!isUnsupportedSyncError(error)) {
        throw error;
      }
    }
  } finally {
    await directory.close();
  }
}

function isUnsupportedSyncError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error.code === "EPERM" || error.code === "EINVAL" || error.code === "ENOTSUP" || error.code === "EISDIR");
}

async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // Best-effort cleanup only.
  }
}

function normalizeLastConsolidated(value: number | undefined, messageCount: number): number {
  return Number.isInteger(value) && value !== undefined && value >= 0 && value <= messageCount ? value : 0;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}
