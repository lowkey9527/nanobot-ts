import { type JsonObject } from "../config/schema.js";
import { InboundMessage } from "../bus/events.js";
import { type RuntimeEventPublisher } from "../bus/runtime-events.js";
import { type ChatMessage, type LLMProvider, type LLMResponse } from "../providers/base.js";
import { effectiveSessionKey, type Session, type SessionMessage, SessionManager } from "../session/manager.js";
import { buildAgentMessages, toolCallMessage, toolResultMessage } from "./context.js";
import { MemoryStore } from "./memory.js";

export interface AgentInboundMessage {
  channel: string;
  chatId: string;
  senderId?: string;
  content: string;
  media?: string[];
  metadata?: JsonObject;
  sessionKey?: string;
  sessionKeyOverride?: string;
}

export interface AgentOutboundMessage {
  channel: string;
  chatId: string;
  content: string;
  metadata?: JsonObject;
}

export interface AgentMessageBus {
  publishOutbound(message: AgentOutboundMessage): Promise<void>;
}

export interface AgentToolResult {
  content: string;
  error?: true;
}

export interface AgentToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface AgentToolRegistry {
  execute(name: string, input: JsonObject, options?: { signal?: AbortSignal }): Promise<AgentToolResult>;
  list?(): AgentToolDefinition[];
  toProviderTools?(): JsonObject[];
  getToolDefinitions?(): JsonObject[];
}

export interface AgentLoopOptions {
  bus: AgentMessageBus;
  provider: LLMProvider;
  workspace: string;
  tools?: AgentToolRegistry;
  maxToolIterations?: number;
  runtimeEvents?: RuntimeEventPublisher;
  unifiedSession?: boolean;
  maxHistoryMessages?: number;
  maxHistoryTokens?: number;
  includeHistoryTimestamps?: boolean;
  botIdentity?: string;
  runtimePolicy?: string;
}

interface ActiveRun {
  controller: AbortController;
  cancelled: boolean;
}

export class AgentLoop {
  readonly sessions: SessionManager;
  readonly memory: MemoryStore;

  private readonly maxToolIterations: number;
  private readonly activeRuns = new Map<string, Set<ActiveRun>>();
  private readonly turnChains = new Map<string, Promise<void>>();

  constructor(private readonly options: AgentLoopOptions) {
    this.maxToolIterations = options.maxToolIterations ?? 5;
    this.sessions = new SessionManager(options.workspace);
    this.memory = new MemoryStore(options.workspace);
  }

  async handleInbound(message: AgentInboundMessage): Promise<void> {
    const command = message.content.trim();
    const key = this.sessionKey(message);
    if (command === "/help") {
      await this.publish(message, "Commands: /help, /new, /stop");
      return;
    }
    if (command === "/new") {
      if (this.cancelActiveRun(key)) {
        await this.options.runtimeEvents?.runStatusChanged(this.runtimeMessage(message), key, "cancelled");
      }
      await this.sessions.deleteSession(key);
      await this.publish(message, "New session started.");
      return;
    }
    if (command === "/stop") {
      if (this.cancelActiveRun(key)) {
        await this.options.runtimeEvents?.runStatusChanged(this.runtimeMessage(message), key, "cancelled");
      }
      await this.publish(message, "Stopped current session.");
      return;
    }

    const run = this.startRun(key);
    const previousTurn = this.turnChains.get(key) ?? Promise.resolve();
    const turn = previousTurn.catch(() => undefined).then(() => this.handleNormalTurn(message, key, run));
    let chainedTurn: Promise<void>;
    chainedTurn = turn.finally(() => {
      if (this.turnChains.get(key) === chainedTurn) {
        this.turnChains.delete(key);
      }
    });
    this.turnChains.set(key, chainedTurn);
    await chainedTurn;
  }

  private async handleNormalTurn(message: AgentInboundMessage, key: string, run: ActiveRun): Promise<void> {
    const startedAt = Date.now();
    const runtimeMessage = this.runtimeMessage(message);
    let session: Session | undefined;
    let originalMessageCount = 0;
    let userMessageAdded = false;
    try {
      if (run.cancelled) {
        return;
      }
      await this.options.runtimeEvents?.sessionTurnStarted(runtimeMessage, key);
      await this.options.runtimeEvents?.runStatusChanged(runtimeMessage, key, "running", { startedAt });
      session = await this.sessions.getOrCreate(key);
      const modelSettings = this.modelSettings();
      const messages = buildAgentMessages({
        workspace: this.options.workspace,
        history: session.getHistory({
          maxMessages: this.options.maxHistoryMessages,
          maxTokens: this.options.maxHistoryTokens,
          includeTimestamps: this.options.includeHistoryTimestamps,
        }),
        botIdentity: this.options.botIdentity,
        runtimePolicy: this.options.runtimePolicy,
        tools: this.contextTools(),
        memoryContent: await this.memory.readMemory(),
        memoryHistory: await this.memory.readRecentHistory(),
        media: message.media,
        modelSettings,
        userContent: message.content,
      });
      if (run.cancelled) {
        return;
      }
      originalMessageCount = session.messages.length;
      session.addMessage("user", message.content, this.userMessageExtra(message));
      userMessageAdded = true;

      const final = await this.runProviderLoop(message, messages, run, key, runtimeMessage);
      if (final.cancelled || run.cancelled) {
        session.messages.splice(originalMessageCount);
        return;
      }
      for (const messageToSave of final.messagesToSave) {
        this.appendSessionMessage(session, messageToSave);
      }
      await this.sessions.save(session);
      if (final.content.trim().length > 0) {
        await this.publish(message, final.content);
      }
      const latencyMs = Date.now() - startedAt;
      this.options.runtimeEvents?.recordTurnLatency(key, latencyMs);
      this.options.runtimeEvents?.recordTurnRuntime(key, final.runtime);
      await this.options.runtimeEvents?.runStatusChanged(runtimeMessage, key, "complete", { startedAt });
      await this.options.runtimeEvents?.turnCompleted({
        channel: message.channel,
        chatId: message.chatId,
        sessionKey: key,
        metadata: message.metadata,
      });
    } catch (error) {
      if (run.cancelled || run.controller.signal.aborted) {
        await this.options.runtimeEvents?.runStatusChanged(runtimeMessage, key, "cancelled", { startedAt });
        return;
      }

      session ??= await this.sessions.getOrCreate(key);
      if (!userMessageAdded) {
        originalMessageCount = session.messages.length;
        session.addMessage("user", message.content, this.userMessageExtra(message));
        userMessageAdded = true;
      }
      const content = this.errorMessage(error);
      session.addMessage("assistant", content, { error: true });
      await this.sessions.save(session);
      this.options.runtimeEvents?.clearTurn(key);
      await this.options.runtimeEvents?.runStatusChanged(runtimeMessage, key, "failed", { startedAt });
      await this.publish(message, content, { error: true });
    } finally {
      this.removeRun(key, run);
    }
  }

  private async runProviderLoop(
    inbound: AgentInboundMessage,
    messages: ChatMessage[],
    run: ActiveRun,
    sessionKey: string,
    runtimeMessage: InboundMessage,
  ): Promise<{
    content: string;
    messagesToSave: ChatMessage[];
    cancelled?: true;
    runtime?: { iterations: number; toolCalls: number; usage: Record<string, number> };
  }> {
    const messagesToSave: ChatMessage[] = [];
    const usage: Record<string, number> = {};
    let toolCalls = 0;

    for (let iteration = 0; ; iteration += 1) {
      if (run.cancelled) {
        return { content: "", messagesToSave, cancelled: true };
      }
      const response = await this.chatProvider(messages, run);
      if (run.cancelled) {
        return { content: "", messagesToSave, cancelled: true };
      }
      addUsage(usage, response.usage);

      if (response.toolCalls.length === 0) {
        const content = response.content ?? "";
        await this.options.runtimeEvents?.runStatusChanged(runtimeMessage, sessionKey, "final");
        if (content.trim().length > 0) {
          messagesToSave.push(this.assistantMessage(response, content));
        }
        return {
          content,
          messagesToSave,
          runtime: { iterations: iteration + 1, toolCalls, usage },
        };
      }

      if (iteration >= this.maxToolIterations) {
        const content = `Stopped after reaching tool iteration limit (${this.maxToolIterations}).`;
        messagesToSave.push({ role: "assistant", content });
        await this.options.runtimeEvents?.runStatusChanged(runtimeMessage, sessionKey, "final");
        return {
          content,
          messagesToSave,
          runtime: { iterations: iteration + 1, toolCalls, usage },
        };
      }

      await this.options.runtimeEvents?.runStatusChanged(runtimeMessage, sessionKey, "tool");
      for (const toolCall of response.toolCalls) {
        if (run.cancelled) {
          return { content: "", messagesToSave, cancelled: true };
        }
        await this.publish(inbound, `Running tool ${toolCall.name}...`, { progress: true });
        const result = await this.executeTool(toolCall.name, toolCall.arguments, run);
        if (run.cancelled) {
          return { content: "", messagesToSave, cancelled: true };
        }
        toolCalls += 1;
        const assistantToolCall = toolCallMessage(toolCall);
        const toolResult = toolResultMessage(toolCall, result.content);
        messages.push(assistantToolCall, toolResult);
        messagesToSave.push(assistantToolCall, toolResult);
      }
    }
  }

  private assistantMessage(response: LLMResponse, content: string): ChatMessage {
    const message: ChatMessage = { role: "assistant", content };
    if (response.reasoningContent !== undefined) {
      message.reasoningContent = response.reasoningContent;
    }
    if (response.thinkingBlocks !== undefined) {
      message.thinkingBlocks = response.thinkingBlocks;
    }
    return message;
  }

  private async chatProvider(messages: ChatMessage[], run: ActiveRun): Promise<LLMResponse> {
    try {
      return await this.options.provider.chat({
        messages,
        tools: this.providerTools(),
        ...this.modelSettings(),
        signal: run.controller.signal,
      });
    } catch (error) {
      if (run.cancelled || run.controller.signal.aborted) {
        return llmCancelledResponse();
      }
      throw error;
    }
  }

  private async executeTool(name: string, input: JsonObject, run: ActiveRun): Promise<AgentToolResult> {
    if (!this.options.tools) {
      return { content: `Unknown tool '${name}'`, error: true };
    }
    try {
      return await this.options.tools.execute(name, input, { signal: run.controller.signal });
    } catch (error) {
      if (run.cancelled || run.controller.signal.aborted) {
        return { content: "", error: true };
      }
      throw error;
    }
  }

  private providerTools(): JsonObject[] | undefined {
    const tools = this.options.tools;
    if (!tools) {
      return undefined;
    }
    return tools.toProviderTools?.() ?? tools.getToolDefinitions?.() ?? tools.list?.().map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema as JsonObject,
      },
    } as JsonObject));
  }

  private contextTools(): Array<{ name: string; description?: string }> {
    const tools = this.options.tools;
    if (!tools) {
      return [];
    }
    const listed = tools.list?.();
    if (listed) {
      return listed.map((tool) => ({ name: tool.name, description: tool.description }));
    }
    const providerTools = tools.toProviderTools?.() ?? tools.getToolDefinitions?.() ?? [];
    return providerTools.flatMap((tool) => {
      const fn = tool.function;
      if (!fn || typeof fn !== "object" || Array.isArray(fn)) {
        return [];
      }
      const name = typeof fn.name === "string" ? fn.name : undefined;
      if (!name) {
        return [];
      }
      return [{ name, description: typeof fn.description === "string" ? fn.description : undefined }];
    });
  }

  private modelSettings(): {
    model: string;
    maxTokens: number;
    temperature: number;
    reasoningEffort?: string;
  } {
    return {
      model: this.options.provider.getDefaultModel(),
      maxTokens: this.options.provider.generation.maxTokens,
      temperature: this.options.provider.generation.temperature,
      reasoningEffort: this.options.provider.generation.reasoningEffort,
    };
  }

  private startRun(key: string): ActiveRun {
    const run = { controller: new AbortController(), cancelled: false };
    const runs = this.activeRuns.get(key) ?? new Set<ActiveRun>();
    runs.add(run);
    this.activeRuns.set(key, runs);
    return run;
  }

  private cancelActiveRun(key: string): boolean {
    const runs = this.activeRuns.get(key);
    if (!runs || runs.size === 0) {
      return false;
    }
    this.activeRuns.delete(key);
    for (const run of runs) {
      run.cancelled = true;
      run.controller.abort();
    }
    return true;
  }

  private removeRun(key: string, run: ActiveRun): void {
    const runs = this.activeRuns.get(key);
    if (!runs) {
      return;
    }
    runs.delete(run);
    if (runs.size === 0) {
      this.activeRuns.delete(key);
    }
  }

  private async publish(message: AgentInboundMessage, content: string, metadata?: JsonObject): Promise<void> {
    await this.options.bus.publishOutbound({
      channel: message.channel,
      chatId: message.chatId,
      content,
      metadata,
    });
  }

  private sessionKey(message: AgentInboundMessage): string {
    const originalKey = `${message.channel}:${message.chatId}`;
    const overrideKey = message.sessionKeyOverride ?? (hasOwn(message, "sessionKey") ? message.sessionKey : undefined);
    return effectiveSessionKey({
      originalKey,
      overrideKey,
      unifiedSession: this.options.unifiedSession,
    });
  }

  private appendSessionMessage(session: Session, message: ChatMessage): void {
    const { role, content = null, ...extra } = message;
    session.addMessage(role, content, extra as Partial<SessionMessage>);
  }

  private errorMessage(error: unknown): string {
    const detail = error instanceof Error && error.message.trim().length > 0 ? error.message : String(error);
    return `I hit an error while handling that turn: ${detail}`;
  }

  private runtimeMessage(message: AgentInboundMessage): InboundMessage {
    return new InboundMessage({
      channel: message.channel,
      senderId: message.senderId ?? "",
      chatId: message.chatId,
      content: message.content,
      media: message.media,
      metadata: message.metadata,
      sessionKeyOverride: this.sessionKey(message),
    });
  }

  private userMessageExtra(message: AgentInboundMessage): Partial<SessionMessage> {
    const extra: Partial<SessionMessage> = {};
    if (message.media && message.media.length > 0) {
      extra.media = message.media;
    }
    if (message.metadata !== undefined) {
      extra.metadata = message.metadata;
    }
    return extra;
  }
}

function addUsage(target: Record<string, number>, usage: Record<string, number>): void {
  for (const [key, value] of Object.entries(usage)) {
    target[key] = (target[key] ?? 0) + value;
  }
}

function llmCancelledResponse(): LLMResponse {
  return {
    content: null,
    toolCalls: [],
    finishReason: "cancelled",
    usage: {},
  };
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}
