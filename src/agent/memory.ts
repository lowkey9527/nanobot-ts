import { constants as fsConstants } from "node:fs";
import { access, appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type ChatMessage, type ChatOptions, type LLMProvider, type LLMResponse } from "../providers/base.js";

const DEFAULT_MAX_HISTORY_ENTRIES = 1_000;
const HISTORY_ENTRY_HARD_CAP = 64_000;
const RAW_ARCHIVE_MAX_CHARS = 16_000;
const ARCHIVE_SUMMARY_MAX_CHARS = 8_000;

export interface MemoryStoreOptions {
  maxHistoryEntries?: number;
}

export interface MemoryHistoryEntry {
  cursor: number;
  timestamp: string;
  content: string;
}

export interface DreamPrompt {
  prompt: string;
  lastCursor: number;
}

export type MemoryArchiveChat = (options: ChatOptions) => Promise<LLMResponse>;

export interface MemoryArchiveMessage extends Record<string, unknown> {
  role: string;
  content?: unknown;
  timestamp?: unknown;
  tools_used?: unknown;
}

export interface MemoryConsolidationOptions {
  messages?: MemoryArchiveMessage[] | ChatMessage[];
  provider?: Pick<LLMProvider, "chat" | "generation" | "getDefaultModel">;
  chat?: MemoryArchiveChat;
  model?: string;
  maxSummaryChars?: number;
  maxRawChars?: number;
}

export type ConsolidationStatus =
  | {
      status: "skipped";
      providerBacked: false;
      memoryPath: string;
      historyPath: string;
      message: string;
    }
  | {
      status: "archived";
      providerBacked: true;
      memoryPath: string;
      historyPath: string;
      cursor: number;
      message: string;
      summary: string;
    }
  | {
      status: "raw_archived";
      providerBacked: false;
      memoryPath: string;
      historyPath: string;
      cursor: number;
      message: string;
      error?: string;
    };

export type ConsolidationPlaceholder = ConsolidationStatus;

export class MemoryStore {
  private readonly memoryDir: string;
  private readonly memoryPath: string;
  private readonly historyPath: string;
  private readonly legacyHistoryPath: string;
  private readonly soulPath: string;
  private readonly userPath: string;
  private readonly cursorPath: string;
  private readonly dreamCursorPath: string;
  private readonly maxHistoryEntries: number;
  private initialized?: Promise<void>;
  private appendChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly workspace: string, options: MemoryStoreOptions = {}) {
    this.memoryDir = join(workspace, "memory");
    this.memoryPath = join(this.memoryDir, "MEMORY.md");
    this.historyPath = join(this.memoryDir, "history.jsonl");
    this.legacyHistoryPath = join(this.memoryDir, "HISTORY.md");
    this.soulPath = join(workspace, "SOUL.md");
    this.userPath = join(workspace, "USER.md");
    this.cursorPath = join(this.memoryDir, ".cursor");
    this.dreamCursorPath = join(this.memoryDir, ".dream_cursor");
    this.maxHistoryEntries = options.maxHistoryEntries ?? DEFAULT_MAX_HISTORY_ENTRIES;
  }

  async appendHistory(entry: string, options: { maxChars?: number } = {}): Promise<number> {
    const run = this.appendChain.then(() => this.appendHistoryUnlocked(entry, options));
    this.appendChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async readMemory(maxChars = 16_000): Promise<string> {
    await this.ensureReady();
    const content = await this.readFileIfExists(this.memoryPath)
      || await this.readFileIfExists(await this.resolveBundledTemplate("memory/MEMORY.md"));
    return tail(content, maxChars);
  }

  async writeMemory(content: string): Promise<void> {
    await this.ensureReady();
    await writeFile(this.memoryPath, content, "utf8");
  }

  async readSoul(maxChars = 16_000): Promise<string> {
    await this.ensureReady();
    return tail(await this.readFileIfExists(this.soulPath), maxChars);
  }

  async writeSoul(content: string): Promise<void> {
    await this.ensureReady();
    await writeFile(this.soulPath, content, "utf8");
  }

  async readUser(maxChars = 16_000): Promise<string> {
    await this.ensureReady();
    return tail(await this.readFileIfExists(this.userPath), maxChars);
  }

  async writeUser(content: string): Promise<void> {
    await this.ensureReady();
    await writeFile(this.userPath, content, "utf8");
  }

  async readRecentHistory(maxEntries = 20): Promise<string> {
    await this.ensureReady();
    const entries = await this.readValidEntries();
    return entries.slice(-maxEntries).map(formatHistoryEntry).join("\n");
  }

  async readDreamCursor(): Promise<number> {
    await this.ensureReady();
    return this.readCursorFile(this.dreamCursorPath);
  }

  async getLastDreamCursor(): Promise<number> {
    return this.readDreamCursor();
  }

  async setDreamCursor(cursor: number): Promise<void> {
    await this.ensureReady();
    await writeFile(this.dreamCursorPath, String(Math.max(0, Math.trunc(cursor))), "utf8");
  }

  async setLastDreamCursor(cursor: number): Promise<void> {
    await this.setDreamCursor(cursor);
  }

  async buildDreamPrompt(options: { maxEntries?: number } = {}): Promise<DreamPrompt | null> {
    await this.ensureReady();
    const sinceCursor = await this.readDreamCursor();
    const entries = (await this.readValidEntries())
      .filter((entry) => entry.cursor > sinceCursor)
      .slice(0, options.maxEntries ?? 20);
    if (entries.length === 0) {
      return null;
    }

    const historyText = entries
      .map((entry) => `[${entry.timestamp}] ${truncateText(entry.content, 500)}`)
      .join("\n");
    const template = await this.readFileIfExists(await this.resolveBundledTemplate("agent/dream.md"));
    const rendered = template.replaceAll("{{ skill_creator_path }}", "skills/skill-creator/SKILL.md").trim();
    return {
      prompt: `${rendered}\n\n## Conversation History\n${historyText}`,
      lastCursor: entries[entries.length - 1]?.cursor ?? sinceCursor,
    };
  }

  async compactHistory(maxEntries = this.maxHistoryEntries): Promise<void> {
    await this.ensureReady();
    if (maxEntries <= 0) {
      return;
    }
    const entries = await this.readValidEntries();
    if (entries.length <= maxEntries) {
      return;
    }
    await this.writeEntries(entries.slice(-maxEntries));
  }

  async rawArchive(messages: MemoryArchiveMessage[] | ChatMessage[], options: { maxChars?: number } = {}): Promise<number> {
    const formatted = truncateText(formatMessages(messages), options.maxChars ?? RAW_ARCHIVE_MAX_CHARS);
    return this.appendHistory(`[RAW] ${messages.length} messages\n${formatted}`);
  }

  async archive(messages: MemoryArchiveMessage[] | ChatMessage[], options: MemoryConsolidationOptions = {}): Promise<ConsolidationStatus> {
    await this.ensureReady();
    if (messages.length === 0) {
      return this.skipped("No messages supplied for memory consolidation.");
    }

    const chat = options.chat ?? (options.provider ? options.provider.chat.bind(options.provider) : undefined);
    if (!chat) {
      const cursor = await this.rawArchive(messages, { maxChars: options.maxRawChars });
      return this.rawArchived(cursor, "No provider supplied; raw-archived messages.");
    }

    try {
      const response = await chat({
        messages: [
          { role: "system", content: await this.readFileIfExists(await this.resolveBundledTemplate("agent/consolidator_archive.md")) },
          { role: "user", content: truncateText(formatMessages(messages), RAW_ARCHIVE_MAX_CHARS) },
        ],
        model: options.model ?? options.provider?.getDefaultModel(),
        maxTokens: options.provider?.generation.maxTokens,
        temperature: options.provider?.generation.temperature,
        reasoningEffort: options.provider?.generation.reasoningEffort,
      });
      if (response.finishReason === "error") {
        throw new Error(response.content ?? "provider returned error");
      }
      const summary = (response.content ?? "[no summary]").trim() || "[no summary]";
      const cursor = await this.appendHistory(summary, {
        maxChars: options.maxSummaryChars ?? ARCHIVE_SUMMARY_MAX_CHARS,
      });
      return {
        status: "archived",
        providerBacked: true,
        memoryPath: this.memoryPath,
        historyPath: this.historyPath,
        cursor,
        message: "Memory archived through provider.",
        summary,
      };
    } catch (error) {
      const cursor = await this.rawArchive(messages, { maxChars: options.maxRawChars });
      return this.rawArchived(cursor, "Provider memory archive failed; raw-archived messages.", errorMessage(error));
    }
  }

  async consolidate(options: MemoryConsolidationOptions = {}): Promise<ConsolidationStatus> {
    const messages = options.messages ?? [];
    if (messages.length === 0) {
      await this.ensureReady();
      return this.skipped("No messages supplied for memory consolidation.");
    }
    return this.archive(messages, options);
  }

  private async appendHistoryUnlocked(entry: string, options: { maxChars?: number }): Promise<number> {
    await this.ensureReady();
    const raw = truncateText(entry.trimEnd(), options.maxChars ?? HISTORY_ENTRY_HARD_CAP);
    const content = stripTemplateLeaks(raw);
    const cursor = await this.nextCursor();
    const record: MemoryHistoryEntry = {
      cursor,
      timestamp: new Date().toISOString(),
      content,
    };
    await appendFile(this.historyPath, `${JSON.stringify(record)}\n`, "utf8");
    await writeFile(this.cursorPath, String(cursor), "utf8");
    return cursor;
  }

  private async ensureReady(): Promise<void> {
    this.initialized ??= this.initialize();
    await this.initialized;
  }

  private async initialize(): Promise<void> {
    await mkdir(this.memoryDir, { recursive: true });
    await this.migrateLegacyHistory();
  }

  private async migrateLegacyHistory(): Promise<void> {
    if (!await exists(this.legacyHistoryPath)) {
      return;
    }
    if (await this.fileHasContent(this.historyPath)) {
      return;
    }

    const legacyText = await this.readFileIfExists(this.legacyHistoryPath);
    const entries = this.parseLegacyHistory(legacyText);
    if (entries.length > 0) {
      await this.writeEntries(entries);
      const lastCursor = entries[entries.length - 1]?.cursor ?? 0;
      await writeFile(this.cursorPath, String(lastCursor), "utf8");
      await writeFile(this.dreamCursorPath, String(lastCursor), "utf8");
    }
    await rename(this.legacyHistoryPath, await this.nextLegacyBackupPath());
  }

  private parseLegacyHistory(text: string): MemoryHistoryEntry[] {
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
    if (!normalized) {
      return [];
    }

    const chunks: string[] = [];
    let current: string[] = [];
    for (const line of normalized.split("\n")) {
      if (this.shouldStartLegacyChunk(line, current)) {
        chunks.push(current.join("\n").trim());
        current = [line];
      } else {
        current.push(line);
      }
    }
    if (current.length > 0) {
      chunks.push(current.join("\n").trim());
    }

    return chunks.filter(Boolean).map((chunk, index) => {
      const match = /^\[([^\]]+)\]\s*/.exec(chunk);
      return {
        cursor: index + 1,
        timestamp: match?.[1] ?? new Date().toISOString(),
        content: match ? chunk.slice(match[0].length).trimStart() : chunk,
      };
    });
  }

  private shouldStartLegacyChunk(line: string, current: string[]): boolean {
    if (current.length === 0) {
      return false;
    }
    if (!/^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*/.test(line)) {
      return false;
    }
    if (this.isLegacyRawChunk(current) && /^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s+[A-Z][A-Z0-9_]*(?:\s+\[tools:\s*[^\]]+\])?:/.test(line)) {
      return false;
    }
    return true;
  }

  private isLegacyRawChunk(lines: string[]): boolean {
    const first = lines.find((line) => line.trim().length > 0) ?? "";
    const match = /^\[[^\]]+\]\s*/.exec(first);
    return Boolean(match && first.slice(match[0].length).trimStart().startsWith("[RAW]"));
  }

  private async nextLegacyBackupPath(): Promise<string> {
    let candidate = `${this.legacyHistoryPath}.bak`;
    let suffix = 2;
    while (await exists(candidate)) {
      candidate = `${this.legacyHistoryPath}.bak.${suffix}`;
      suffix += 1;
    }
    return candidate;
  }

  private async fileHasContent(path: string): Promise<boolean> {
    try {
      return (await stat(path)).size > 0;
    } catch (error) {
      if (isNotFound(error)) {
        return false;
      }
      throw error;
    }
  }

  private async nextCursor(): Promise<number> {
    const fromCursorFile = await this.readCursorFile(this.cursorPath);
    if (fromCursorFile > 0) {
      return fromCursorFile + 1;
    }
    const entries = await this.readValidEntries();
    return Math.max(0, ...entries.map((entry) => entry.cursor)) + 1;
  }

  private async readCursorFile(path: string): Promise<number> {
    const content = (await this.readFileIfExists(path)).trim();
    if (!content) {
      return 0;
    }
    const parsed = Number(content);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
  }

  private async readValidEntries(): Promise<MemoryHistoryEntry[]> {
    const history = await this.readFileIfExists(this.historyPath);
    const entries: MemoryHistoryEntry[] = [];
    for (const line of history.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          continue;
        }
        const cursor = validCursor(parsed.cursor);
        if (cursor === null) {
          continue;
        }
        entries.push({
          cursor,
          timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : "?",
          content: typeof parsed.content === "string" ? parsed.content : stringifyContent(parsed.content),
        });
      } catch {
        // Malformed JSONL entries are ignored so one bad line does not poison memory.
      }
    }
    return entries;
  }

  private async writeEntries(entries: MemoryHistoryEntry[]): Promise<void> {
    const content = entries.map((entry) => JSON.stringify(entry)).join("\n");
    await writeFile(this.historyPath, content ? `${content}\n` : "", "utf8");
  }

  private skipped(message: string): ConsolidationStatus {
    return {
      status: "skipped",
      providerBacked: false,
      memoryPath: this.memoryPath,
      historyPath: this.historyPath,
      message,
    };
  }

  private rawArchived(cursor: number, message: string, error?: string): ConsolidationStatus {
    return {
      status: "raw_archived",
      providerBacked: false,
      memoryPath: this.memoryPath,
      historyPath: this.historyPath,
      cursor,
      message,
      error,
    };
  }

  private async readFileIfExists(path: string): Promise<string> {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (isNotFound(error)) {
        return "";
      }
      throw error;
    }
  }

  private async resolveBundledTemplate(relativePath: string): Promise<string> {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      resolve(moduleDir, "../../../templates", relativePath),
      resolve(moduleDir, "../../templates", relativePath),
    ];
    for (const candidate of candidates) {
      try {
        await access(candidate, fsConstants.F_OK);
        return candidate;
      } catch {
        // Try the next package layout.
      }
    }
    return join(this.workspace, relativePath);
  }
}

function formatHistoryEntry(entry: MemoryHistoryEntry): string {
  return `[${entry.timestamp}] #${entry.cursor} ${entry.content}`;
}

function formatMessages(messages: MemoryArchiveMessage[] | ChatMessage[]): string {
  return messages.flatMap((message) => {
    const content = stringifyContent(message.content);
    if (!content) {
      return [];
    }
    const timestamp = typeof message.timestamp === "string" ? message.timestamp.slice(0, 16) : "?";
    const role = typeof message.role === "string" ? message.role.toUpperCase() : "UNKNOWN";
    const tools = Array.isArray(message.tools_used) && message.tools_used.length > 0
      ? ` [tools: ${message.tools_used.map(String).join(", ")}]`
      : "";
    return [`[${timestamp}] ${role}${tools}: ${content}`];
  }).join("\n");
}

function stripTemplateLeaks(input: string): string {
  const withoutClosedThink = input.replace(/<think\b[\s\S]*?<\/think>/gi, "");
  const openThink = withoutClosedThink.search(/<think\b/i);
  const withoutOpenThink = openThink >= 0 ? withoutClosedThink.slice(0, openThink) : withoutClosedThink;
  return withoutOpenThink
    .replace(/<\|[^|]+\|>/g, "")
    .replace(/<[A-Za-z0-9_-]+\|>/g, "")
    .trimEnd();
}

function truncateText(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input;
  }
  if (maxChars <= 0) {
    return "";
  }
  const suffix = "\n... (truncated)";
  if (maxChars <= suffix.length) {
    return input.slice(0, maxChars);
  }
  return `${input.slice(0, maxChars - suffix.length)}${suffix}`;
}

function tail(input: string, maxChars: number): string {
  return input.length <= maxChars ? input : input.slice(input.length - maxChars);
}

function stringifyContent(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function validCursor(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
