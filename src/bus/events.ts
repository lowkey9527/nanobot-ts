import { type JsonObject } from "../config/schema.js";

export const OUTBOUND_META_AGENT_UI = "_agent_ui";
export const INBOUND_META_RUNTIME_CONTROL = "_runtime_control";
export const RUNTIME_CONTROL_ACK = "_ack";
export const RUNTIME_CONTROL_MCP_RELOAD = "mcp_reload";

export interface InboundMessageInput {
  channel: string;
  senderId: string;
  chatId: string;
  content: string;
  timestamp?: Date;
  media?: string[];
  metadata?: JsonObject;
  sessionKeyOverride?: string;
}

export class InboundMessage {
  readonly channel: string;
  readonly senderId: string;
  readonly chatId: string;
  readonly content: string;
  readonly timestamp: Date;
  readonly media: string[];
  readonly metadata: JsonObject;
  readonly sessionKeyOverride?: string;

  constructor(input: InboundMessageInput) {
    this.channel = input.channel;
    this.senderId = input.senderId;
    this.chatId = input.chatId;
    this.content = input.content;
    this.timestamp = input.timestamp ?? new Date();
    this.media = input.media ?? [];
    this.metadata = input.metadata ?? {};
    this.sessionKeyOverride = input.sessionKeyOverride;
  }

  get sessionKey(): string {
    return this.sessionKeyOverride ?? `${this.channel}:${this.chatId}`;
  }
}

export interface OutboundMessageInput {
  channel: string;
  chatId: string;
  content: string;
  replyTo?: string;
  media?: string[];
  metadata?: JsonObject;
  buttons?: string[][];
}

export class OutboundMessage {
  readonly channel: string;
  readonly chatId: string;
  readonly content: string;
  readonly replyTo?: string;
  readonly media: string[];
  readonly metadata: JsonObject;
  readonly buttons: string[][];

  constructor(input: OutboundMessageInput) {
    this.channel = input.channel;
    this.chatId = input.chatId;
    this.content = input.content;
    this.replyTo = input.replyTo;
    this.media = input.media ?? [];
    this.metadata = input.metadata ?? {};
    this.buttons = input.buttons ?? [];
  }
}
