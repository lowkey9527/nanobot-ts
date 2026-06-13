import { type JsonObject } from "../config/schema.js";
import { InboundMessage } from "./events.js";

export interface RuntimeEventContextInput {
  channel: string;
  chatId: string;
  sessionKey: string;
  metadata?: JsonObject;
}

export class RuntimeEventContext {
  readonly channel: string;
  readonly chatId: string;
  readonly sessionKey: string;
  readonly metadata: JsonObject;

  constructor(input: RuntimeEventContextInput) {
    this.channel = input.channel;
    this.chatId = input.chatId;
    this.sessionKey = input.sessionKey;
    this.metadata = { ...(input.metadata ?? {}) };
  }
}

export interface SessionTurnStartedInput {
  context: RuntimeEventContext | RuntimeEventContextInput;
}

export class SessionTurnStarted {
  readonly context: RuntimeEventContext;

  constructor(input: SessionTurnStartedInput) {
    this.context = toRuntimeEventContext(input.context);
  }
}

export interface TurnRunStatusChangedInput {
  context: RuntimeEventContext | RuntimeEventContextInput;
  status: string;
  startedAt?: number;
}

export class TurnRunStatusChanged {
  readonly context: RuntimeEventContext;
  readonly status: string;
  readonly startedAt?: number;

  constructor(input: TurnRunStatusChangedInput) {
    this.context = toRuntimeEventContext(input.context);
    this.status = input.status;
    this.startedAt = input.startedAt;
  }
}

export interface TurnCompletedInput {
  context: RuntimeEventContext | RuntimeEventContextInput;
  latencyMs?: number;
  runtime?: unknown;
}

export class TurnCompleted {
  readonly context: RuntimeEventContext;
  readonly latencyMs?: number;
  readonly runtime?: unknown;

  constructor(input: TurnCompletedInput) {
    this.context = toRuntimeEventContext(input.context);
    this.latencyMs = input.latencyMs;
    this.runtime = input.runtime;
  }
}

export interface GoalStateChangedInput {
  context: RuntimeEventContext | RuntimeEventContextInput;
  sessionMetadata?: JsonObject;
}

export class GoalStateChanged {
  readonly context: RuntimeEventContext;
  readonly sessionMetadata: JsonObject;

  constructor(input: GoalStateChangedInput) {
    this.context = toRuntimeEventContext(input.context);
    this.sessionMetadata = { ...(input.sessionMetadata ?? {}) };
  }
}

export interface RuntimeModelChangedInput {
  model: string;
  modelPreset?: string;
}

export class RuntimeModelChanged {
  readonly model: string;
  readonly modelPreset?: string;

  constructor(input: RuntimeModelChangedInput) {
    this.model = input.model;
    this.modelPreset = input.modelPreset;
  }
}

export type RuntimeEvent =
  | SessionTurnStarted
  | TurnRunStatusChanged
  | TurnCompleted
  | GoalStateChanged
  | RuntimeModelChanged;

export type RuntimeEventType<T extends RuntimeEvent = RuntimeEvent> = new (...args: never[]) => T;
export type RuntimeEventHandler<T extends RuntimeEvent = RuntimeEvent> = (event: T) => void | Promise<void>;

interface HandlerEntry {
  eventType?: RuntimeEventType;
  handler: RuntimeEventHandler;
}

export class RuntimeEventBus {
  readonly #handlers: HandlerEntry[] = [];

  subscribe<T extends RuntimeEvent>(handler: RuntimeEventHandler<T>, eventType?: RuntimeEventType<T>): () => void {
    const entry: HandlerEntry = {
      eventType: eventType as RuntimeEventType | undefined,
      handler: handler as RuntimeEventHandler,
    };
    this.#handlers.push(entry);

    return () => {
      const index = this.#handlers.indexOf(entry);
      if (index !== -1) {
        this.#handlers.splice(index, 1);
      }
    };
  }

  async publish(event: RuntimeEvent): Promise<void> {
    for (const { eventType, handler } of [...this.#handlers]) {
      if (eventType !== undefined && !(event instanceof eventType)) {
        continue;
      }

      try {
        await handler(event);
      } catch {
        // Runtime observers must not prevent later observers from seeing the event.
      }
    }
  }

  publishNowait(event: RuntimeEvent): void {
    queueMicrotask(() => {
      void this.publish(event);
    });
  }
}

export class RuntimeEventPublisher {
  readonly bus: RuntimeEventBus;
  readonly #turnLatencyMs = new Map<string, number>();
  readonly #turnRuntime = new Map<string, unknown>();

  constructor(bus = new RuntimeEventBus()) {
    this.bus = bus;
  }

  recordTurnRuntime(sessionKey: string, runtime: unknown): void {
    this.#turnRuntime.set(sessionKey, runtime);
  }

  recordTurnLatency(sessionKey: string, latencyMs: number | undefined): void {
    if (latencyMs !== undefined) {
      this.#turnLatencyMs.set(sessionKey, Math.trunc(latencyMs));
    }
  }

  clearTurn(sessionKey: string): void {
    this.#turnLatencyMs.delete(sessionKey);
    this.#turnRuntime.delete(sessionKey);
  }

  async sessionTurnStarted(message: InboundMessage, sessionKey: string): Promise<void> {
    await this.bus.publish(new SessionTurnStarted({ context: contextFromMessage(message, sessionKey) }));
  }

  async runStatusChanged(
    message: InboundMessage,
    sessionKey: string,
    status: string,
    options: { startedAt?: number } = {},
  ): Promise<void> {
    await this.bus.publish(new TurnRunStatusChanged({
      context: contextFromMessage(message, sessionKey),
      status,
      startedAt: options.startedAt,
    }));
  }

  async goalStateChanged(
    message: InboundMessage,
    sessionKey: string,
    sessionMetadata: JsonObject = {},
  ): Promise<void> {
    await this.bus.publish(new GoalStateChanged({
      context: contextFromMessage(message, sessionKey),
      sessionMetadata,
    }));
  }

  async turnCompleted(input: {
    channel: string;
    chatId: string;
    sessionKey: string;
    metadata?: JsonObject;
  }): Promise<void> {
    const { channel, chatId, sessionKey, metadata } = input;
    await this.bus.publish(new TurnCompleted({
      context: new RuntimeEventContext({ channel, chatId, sessionKey, metadata }),
      latencyMs: this.#consumeLatency(sessionKey),
      runtime: this.#consumeRuntime(sessionKey),
    }));
  }

  runtimeModelChanged(model: string, modelPreset?: string): void {
    this.bus.publishNowait(new RuntimeModelChanged({ model, modelPreset }));
  }

  #consumeLatency(sessionKey: string): number | undefined {
    const latencyMs = this.#turnLatencyMs.get(sessionKey);
    this.#turnLatencyMs.delete(sessionKey);
    return latencyMs;
  }

  #consumeRuntime(sessionKey: string): unknown {
    const runtime = this.#turnRuntime.get(sessionKey);
    this.#turnRuntime.delete(sessionKey);
    return runtime;
  }
}

function toRuntimeEventContext(context: RuntimeEventContext | RuntimeEventContextInput): RuntimeEventContext {
  return context instanceof RuntimeEventContext ? context : new RuntimeEventContext(context);
}

function contextFromMessage(message: InboundMessage, sessionKey: string): RuntimeEventContext {
  return new RuntimeEventContext({
    channel: message.channel,
    chatId: message.chatId,
    sessionKey,
    metadata: message.metadata,
  });
}
