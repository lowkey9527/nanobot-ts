import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { OutboundMessage, type OutboundMessageInput } from "../bus/events.js";

export interface HeartbeatTarget {
  channel: string;
  chatId: string;
}

export interface HeartbeatSessionEntry {
  key?: string;
}

export interface HeartbeatAgentInput {
  prompt: string;
  sessionKey: "heartbeat";
  heartbeatContent: string;
  target: HeartbeatTarget;
  keepRecentMessages: number;
}

export interface HeartbeatAgentResponse {
  content?: string;
}

export type HeartbeatAgentCallback = (
  input: HeartbeatAgentInput,
) => HeartbeatAgentResponse | string | undefined | Promise<HeartbeatAgentResponse | string | undefined>;

export interface HeartbeatPublisher {
  publishOutbound(message: OutboundMessage | OutboundMessageInput): Promise<void> | void;
}

export interface HeartbeatServiceOptions {
  workspace: string;
  agent: HeartbeatAgentCallback;
  publisher?: HeartbeatPublisher;
  listSessions?: () => HeartbeatSessionEntry[] | Promise<HeartbeatSessionEntry[]>;
  enabledChannels?: Iterable<string>;
  selectTarget?: (sessions: HeartbeatSessionEntry[], enabledChannels: Iterable<string>) => HeartbeatTarget;
  heartbeatPath?: string;
  keepRecentMessages?: number;
}

export interface HeartbeatRunResult {
  active: boolean;
  target: HeartbeatTarget;
  delivered: boolean;
  response?: string;
}

const ACTIVE_TASKS_HEADING = /^##\s+Active Tasks\s*$/i;
const NEXT_H2_HEADING = /^##\s+\S/;
const ANY_HEADING = /^#+\s+\S/;
const CLI_TARGET: HeartbeatTarget = { channel: "cli", chatId: "direct" };
const HEARTBEAT_SESSION_KEY = "heartbeat";
const DEFAULT_KEEP_RECENT_MESSAGES = 8;

export function heartbeatHasActiveTasks(content: string): boolean {
  let inActiveTasks = false;
  let inHtmlComment = false;

  for (const rawLine of content.split(/\r?\n/)) {
    const stripped = stripHtmlCommentLine(rawLine.trim(), inHtmlComment);
    inHtmlComment = stripped.inComment;
    const line = stripped.text;

    if (!inActiveTasks) {
      if (ACTIVE_TASKS_HEADING.test(line)) {
        inActiveTasks = true;
      }
      continue;
    }

    if (NEXT_H2_HEADING.test(line) && !ACTIVE_TASKS_HEADING.test(line)) {
      return false;
    }

    if (line.length === 0 || ANY_HEADING.test(line)) {
      continue;
    }
    return true;
  }

  return false;
}

export function pickHeartbeatTarget(sessions: HeartbeatSessionEntry[], enabledChannels: Iterable<string>): HeartbeatTarget {
  const enabled = normalizeEnabledChannels(enabledChannels);
  for (const session of sessions) {
    const key = session.key;
    if (typeof key !== "string") {
      continue;
    }

    const separatorIndex = key.indexOf(":");
    if (separatorIndex <= 0 || separatorIndex === key.length - 1) {
      continue;
    }

    const channel = key.slice(0, separatorIndex);
    const chatId = key.slice(separatorIndex + 1);
    if (channel === "cli" || channel === "system" || !enabled.has(channel)) {
      continue;
    }

    return { channel, chatId };
  }

  return { ...CLI_TARGET };
}

export class HeartbeatService {
  private readonly workspace: string;
  private readonly agent: HeartbeatAgentCallback;
  private readonly publisher: HeartbeatPublisher | undefined;
  private readonly listSessions: () => HeartbeatSessionEntry[] | Promise<HeartbeatSessionEntry[]>;
  private readonly enabledChannels: ReadonlySet<string>;
  private readonly selectTarget: (sessions: HeartbeatSessionEntry[], enabledChannels: Iterable<string>) => HeartbeatTarget;
  private readonly heartbeatPath: string | undefined;
  private readonly keepRecentMessages: number;

  constructor(options: HeartbeatServiceOptions) {
    this.workspace = options.workspace;
    this.agent = options.agent;
    this.publisher = options.publisher;
    this.listSessions = options.listSessions ?? (() => []);
    this.enabledChannels = normalizeEnabledChannels(options.enabledChannels ?? []);
    this.selectTarget = options.selectTarget ?? pickHeartbeatTarget;
    this.heartbeatPath = options.heartbeatPath;
    this.keepRecentMessages = options.keepRecentMessages ?? DEFAULT_KEEP_RECENT_MESSAGES;
  }

  async runOnce(): Promise<HeartbeatRunResult> {
    const content = await this.readHeartbeat();
    if (content === undefined || !heartbeatHasActiveTasks(content)) {
      return { active: false, target: { ...CLI_TARGET }, delivered: false };
    }

    const sessions = await this.listSessions();
    const target = this.selectTarget(sessions, this.enabledChannels);
    const response = await this.agent({
      prompt: buildHeartbeatPrompt(content),
      sessionKey: HEARTBEAT_SESSION_KEY,
      heartbeatContent: content,
      target,
      keepRecentMessages: this.keepRecentMessages,
    });
    const responseText = normalizeResponseContent(response);
    const delivered = await this.deliver(target, responseText);

    return {
      active: true,
      target,
      delivered,
      response: responseText,
    };
  }

  private async readHeartbeat(): Promise<string | undefined> {
    const path = this.heartbeatPath ?? join(this.workspace, "HEARTBEAT.md");
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  private async deliver(target: HeartbeatTarget, response: string | undefined): Promise<boolean> {
    if (!response || isCliFallbackTarget(target) || !this.publisher) {
      return false;
    }

    await this.publisher.publishOutbound(new OutboundMessage({
      channel: target.channel,
      chatId: target.chatId,
      content: response,
    }));
    return true;
  }
}

function isCliFallbackTarget(target: HeartbeatTarget): boolean {
  return target.channel === CLI_TARGET.channel && target.chatId === CLI_TARGET.chatId;
}

function normalizeEnabledChannels(enabledChannels: Iterable<string>): ReadonlySet<string> {
  if (typeof enabledChannels === "string") {
    return new Set([enabledChannels]);
  }
  return new Set(enabledChannels);
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function buildHeartbeatPrompt(content: string): string {
  return [
    "Review HEARTBEAT.md and complete any currently active heartbeat tasks.",
    "",
    "HEARTBEAT.md:",
    content,
  ].join("\n");
}

function normalizeResponseContent(response: HeartbeatAgentResponse | string | undefined): string | undefined {
  if (typeof response === "string") {
    return response;
  }
  return response?.content;
}

function stripHtmlCommentLine(line: string, inComment: boolean): { text: string; inComment: boolean } {
  let text = "";
  let cursor = 0;
  let commentOpen = inComment;

  while (cursor < line.length) {
    if (commentOpen) {
      const end = line.indexOf("-->", cursor);
      if (end < 0) {
        return { text: text.trim(), inComment: true };
      }
      cursor = end + 3;
      commentOpen = false;
      continue;
    }

    const start = line.indexOf("<!--", cursor);
    if (start < 0) {
      text += line.slice(cursor);
      break;
    }

    text += line.slice(cursor, start);
    cursor = start + 4;
    commentOpen = true;
  }

  return { text: text.trim(), inComment: commentOpen };
}
