import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  AgentLoop,
  buildAgentMessages,
  InboundMessage,
  MessageBus,
  RuntimeEventPublisher,
  SessionTurnStarted,
  ToolRegistry,
  TurnCompleted,
  TurnRunStatusChanged,
  UNIFIED_SESSION_KEY,
  type AgentToolRegistry,
  type ChatOptions,
  type GenerationSettings,
  type LLMProvider,
  type LLMResponse,
  type RuntimeEvent,
  llmResponse,
} from "../../src/index.js";

class MockProvider implements LLMProvider {
  readonly defaultModel = "mock";
  readonly supportsProgressDeltas = false;
  generation: GenerationSettings = { temperature: 0.1, maxTokens: 1024 };
  calls: ChatOptions[] = [];

  constructor(private readonly responses: LLMResponse[]) {}

  getDefaultModel(): string {
    return this.defaultModel;
  }

  async chat(options: ChatOptions): Promise<LLMResponse> {
    this.calls.push(options);
    return this.responses.shift() ?? llmResponse({ content: "fallback" });
  }
}

class DeferredProvider implements LLMProvider {
  readonly defaultModel = "mock";
  readonly supportsProgressDeltas = false;
  generation: GenerationSettings = { temperature: 0.1, maxTokens: 1024 };
  calls: ChatOptions[] = [];
  resolve!: (response: LLMResponse) => void;
  readonly response = new Promise<LLMResponse>((resolve) => {
    this.resolve = resolve;
  });

  getDefaultModel(): string {
    return this.defaultModel;
  }

  async chat(options: ChatOptions): Promise<LLMResponse> {
    this.calls.push(options);
    return this.response;
  }
}

class MultiDeferredProvider implements LLMProvider {
  readonly defaultModel = "mock";
  readonly supportsProgressDeltas = false;
  generation: GenerationSettings = { temperature: 0.1, maxTokens: 1024 };
  calls: ChatOptions[] = [];
  private readonly resolvers: Array<(response: LLMResponse) => void> = [];

  getDefaultModel(): string {
    return this.defaultModel;
  }

  async chat(options: ChatOptions): Promise<LLMResponse> {
    this.calls.push(options);
    return new Promise<LLMResponse>((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  resolve(index: number, response: LLMResponse): void {
    const resolve = this.resolvers[index];
    assert.ok(resolve, `missing deferred provider call ${index}`);
    resolve(response);
  }
}

class FailOnceProvider implements LLMProvider {
  readonly defaultModel = "mock";
  readonly supportsProgressDeltas = false;
  generation: GenerationSettings = { temperature: 0.1, maxTokens: 1024 };
  calls: ChatOptions[] = [];
  private failed = false;

  getDefaultModel(): string {
    return this.defaultModel;
  }

  async chat(options: ChatOptions): Promise<LLMResponse> {
    this.calls.push(options);
    if (!this.failed) {
      this.failed = true;
      throw new Error("provider exploded");
    }
    return llmResponse({ content: "recovered" });
  }
}

test("buildAgentMessages assembles context sections and preserves history before the user turn", () => {
  const messages = buildAgentMessages({
    workspace: "D:/work/project",
    botIdentity: "You are the project assistant.",
    runtimePolicy: "Prefer focused answers.",
    tools: [{ name: "read_file", description: "Read workspace files" }],
    memoryContent: "Durable project fact.",
    memoryHistory: "[2026-06-13T09:00:00.000Z] #1 Recent fact.",
    media: ["voice.ogg"],
    modelSettings: {
      model: "test-model",
      maxTokens: 1024,
      temperature: 0.2,
      reasoningEffort: "medium",
    },
    history: [{ role: "assistant", content: "previous answer" }],
    userContent: "current request",
  });

  assert.equal(messages.length, 3);
  assert.equal(messages[0]?.role, "system");
  assert.equal(messages[1]?.role, "assistant");
  assert.equal(messages[1]?.content, "previous answer");
  assert.equal(messages[2]?.role, "user");
  assert.equal(messages[2]?.content, "current request");

  const systemPrompt = String(messages[0]?.content);
  assert.match(systemPrompt, /You are the project assistant/);
  assert.match(systemPrompt, /Prefer focused answers/);
  assert.match(systemPrompt, /Workspace: D:\/work\/project/);
  assert.match(systemPrompt, /read_file: Read workspace files/);
  assert.match(systemPrompt, /Durable project fact/);
  assert.match(systemPrompt, /Recent fact/);
  assert.match(systemPrompt, /voice\.ogg/);
  assert.match(systemPrompt, /model: test-model/);
  assert.match(systemPrompt, /maxTokens: 1024/);
  assert.match(systemPrompt, /temperature: 0\.2/);
  assert.match(systemPrompt, /reasoningEffort: medium/);
});

test("agent loop assembles context, executes tool calls, publishes progress, and saves session", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-agent-"));
  const bus = new MessageBus();
  const tools = new ToolRegistry();
  tools.register({
    name: "echo",
    description: "Echo text",
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: { text: { type: "string" } },
    },
    policy: {},
    execute: async (input: Record<string, unknown>) => ({ content: `echo:${String(input.text)}` }),
  });
  const provider = new MockProvider([
    llmResponse({
      content: null,
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_1", name: "echo", arguments: { text: "hi" } }],
    }),
    llmResponse({ content: "final answer" }),
  ]);
  const loop = new AgentLoop({ bus, provider, workspace, tools, maxToolIterations: 3 });

  await loop.handleInbound(new InboundMessage({ channel: "telegram", senderId: "u1", chatId: "c1", content: "hello" }));

  const progress = await bus.consumeOutbound();
  const final = await bus.consumeOutbound();
  assert.equal(progress.metadata.progress, true);
  assert.match(progress.content, /Running tool echo/);
  assert.equal(final.content, "final answer");
  assert.equal(provider.calls.length, 2);
  const systemPrompt = String(provider.calls[0]?.messages[0]?.content);
  assert.match(systemPrompt, /Bot Identity/i);
  assert.match(systemPrompt, /Runtime Policy/i);
  assert.match(systemPrompt, /Available Tools/i);
  assert.match(systemPrompt, /echo: Echo text/);
  assert.match(systemPrompt, /Model Settings/i);
  assert.match(systemPrompt, /mock/);
  assert.equal(provider.calls[1]?.messages.at(-1)?.role, "tool");
  assert.equal(provider.calls[1]?.messages.at(-1)?.content, "echo:hi");

  const session = await loop.sessions.getOrCreate("telegram:c1");
  assert.equal(session.messages.at(-1)?.content, "final answer");
});

test("agent loop publishes runtime status events with latency and runtime metadata", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-runtime-events-"));
  const bus = new MessageBus();
  const runtimeEvents = new RuntimeEventPublisher();
  const events: RuntimeEvent[] = [];
  runtimeEvents.bus.subscribe((event) => {
    events.push(event);
  });
  const tools = new ToolRegistry();
  tools.register({
    name: "echo",
    description: "Echo text",
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: { text: { type: "string" } },
    },
    policy: {},
    execute: async (input: Record<string, unknown>) => ({ content: `echo:${String(input.text)}` }),
  });
  const provider = new MockProvider([
    llmResponse({
      content: null,
      finishReason: "tool_calls",
      usage: { prompt_tokens: 5 },
      toolCalls: [{ id: "call_1", name: "echo", arguments: { text: "hi" } }],
    }),
    llmResponse({ content: "final answer", usage: { completion_tokens: 3 } }),
  ]);
  const loop = new AgentLoop({ bus, provider, workspace, tools, runtimeEvents });

  await loop.handleInbound(new InboundMessage({ channel: "telegram", senderId: "u1", chatId: "c1", content: "hello" }));

  assert.equal((await bus.consumeOutbound()).metadata.progress, true);
  assert.equal((await bus.consumeOutbound()).content, "final answer");
  assert.deepEqual(events.map((event) => event.constructor.name), [
    "SessionTurnStarted",
    "TurnRunStatusChanged",
    "TurnRunStatusChanged",
    "TurnRunStatusChanged",
    "TurnRunStatusChanged",
    "TurnCompleted",
  ]);
  assert.ok(events[0] instanceof SessionTurnStarted);
  assert.deepEqual(
    events.filter((event) => event instanceof TurnRunStatusChanged).map((event) => event.status),
    ["running", "tool", "final", "complete"],
  );
  const completed = events.at(-1);
  assert.ok(completed instanceof TurnCompleted);
  assert.equal(completed.context.sessionKey, "telegram:c1");
  assert.equal(typeof completed.latencyMs, "number");
  assert.deepEqual(completed.runtime, {
    iterations: 2,
    toolCalls: 1,
    usage: { prompt_tokens: 5, completion_tokens: 3 },
  });
});

test("agent loop passes abort signal to provider and tool execution", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-signals-"));
  const bus = new MessageBus();
  const provider = new MockProvider([
    llmResponse({
      content: null,
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_1", name: "echo", arguments: { text: "hi" } }],
    }),
    llmResponse({ content: "done" }),
  ]);
  let toolSignal: AbortSignal | undefined;
  const tools = new ToolRegistry();
  tools.register({
    name: "echo",
    description: "Echo text",
    inputSchema: { type: "object", properties: {} },
    policy: {},
    execute: async (_input: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
      toolSignal = options?.signal;
      return { content: "ok" };
    },
  });
  const loop = new AgentLoop({ bus, provider, workspace, tools });

  await loop.handleInbound(new InboundMessage({ channel: "telegram", senderId: "u1", chatId: "c1", content: "hello" }));

  assert.ok(provider.calls[0]?.signal instanceof AbortSignal);
  assert.ok(provider.calls[1]?.signal instanceof AbortSignal);
  assert.equal(provider.calls[0]?.signal, provider.calls[1]?.signal);
  assert.equal(toolSignal, provider.calls[0]?.signal);
});

test("agent loop uses unified session key unless an explicit session override is provided", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-unified-"));
  const bus = new MessageBus();
  const provider = new MockProvider([
    llmResponse({ content: "first" }),
    llmResponse({ content: "second" }),
    llmResponse({ content: "override" }),
  ]);
  const loop = new AgentLoop({ bus, provider, workspace, unifiedSession: true });

  await loop.handleInbound(new InboundMessage({ channel: "telegram", senderId: "u1", chatId: "c1", content: "one" }));
  await bus.consumeOutbound();
  await loop.handleInbound(new InboundMessage({ channel: "telegram", senderId: "u2", chatId: "c2", content: "two" }));
  await bus.consumeOutbound();
  await loop.handleInbound(new InboundMessage({
    channel: "telegram",
    senderId: "u3",
    chatId: "c3",
    content: "three",
    sessionKeyOverride: "explicit:thread",
  }));
  await bus.consumeOutbound();

  assert.deepEqual(
    (await loop.sessions.getOrCreate(UNIFIED_SESSION_KEY)).messages.map((message) => message.content),
    ["one", "first", "two", "second"],
  );
  assert.deepEqual(
    (await loop.sessions.getOrCreate("explicit:thread")).messages.map((message) => message.content),
    ["three", "override"],
  );
});

test("agent loop requests bounded timestamped history from the session", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-history-options-"));
  const bus = new MessageBus();
  const provider = new MockProvider([llmResponse({ content: "new" })]);
  const loop = new AgentLoop({
    bus,
    provider,
    workspace,
    maxHistoryMessages: 1,
    maxHistoryTokens: 100,
    includeHistoryTimestamps: true,
  });
  const session = await loop.sessions.getOrCreate("telegram:c1");
  session.addMessage("user", "oldest");
  session.addMessage("assistant", "previous");
  await loop.sessions.save(session);

  await loop.handleInbound(new InboundMessage({ channel: "telegram", senderId: "u1", chatId: "c1", content: "current" }));

  const historyContent = provider.calls[0]?.messages.map((message) => String(message.content)).join("\n");
  assert.doesNotMatch(historyContent ?? "", /oldest/);
  assert.match(historyContent ?? "", /previous/);
});

test("agent loop handles control commands and iteration limits", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-agent-"));
  const bus = new MessageBus();
  const provider = new MockProvider([
    llmResponse({
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_1", name: "missing", arguments: {} }],
    }),
  ]);
  const loop = new AgentLoop({ bus, provider, workspace, maxToolIterations: 0 });
  const route = { channel: "telegram", senderId: "u1", chatId: "c1" };

  await loop.handleInbound(new InboundMessage({ ...route, content: "/help" }));
  assert.match((await bus.consumeOutbound()).content, /\/new/);

  await loop.handleInbound(new InboundMessage({ ...route, content: "needs tool" }));
  assert.match((await bus.consumeOutbound()).content, /iteration limit/i);

  await loop.handleInbound(new InboundMessage({ ...route, content: "/new" }));
  assert.match((await bus.consumeOutbound()).content, /New session/);
  assert.equal((await loop.sessions.getOrCreate("telegram:c1")).messages.length, 0);

  await loop.handleInbound(new InboundMessage({ ...route, content: "/stop" }));
  assert.match((await bus.consumeOutbound()).content, /Stopped/);
  assert.equal((await loop.sessions.getOrCreate("telegram:c1")).messages.length, 0);
});

test("memory store reads workspace memory, appends JSONL history, and skips empty consolidation", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-memory-"));
  const loop = new AgentLoop({
    bus: new MessageBus(),
    provider: new MockProvider([llmResponse({ content: "ok" })]),
    workspace,
  });

  await mkdir(join(workspace, "memory"), { recursive: true });
  await writeFile(join(workspace, "memory", "MEMORY.md"), "# Memory\n\nProject context lives here.\n", "utf8");
  await loop.memory.appendHistory("remember this");
  assert.match(await loop.memory.readMemory(), /Project context lives here/);
  assert.match(await loop.memory.readRecentHistory(), /remember this/);

  const rawHistory = await readFile(join(workspace, "memory", "history.jsonl"), "utf8");
  const historyEntry = JSON.parse(rawHistory.trim()) as { content: string };
  assert.equal(historyEntry.content, "remember this");
  await assert.rejects(access(join(workspace, ".nanobot", "memory", "history.md")));

  const result = await loop.memory.consolidate();
  assert.equal(result.status, "skipped");
  assert.equal(result.providerBacked, false);
  assert.match(result.message, /no messages/i);
});

test("agent loop includes memory, media breadcrumbs, and model settings in context", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-context-"));
  const bus = new MessageBus();
  const provider = new MockProvider([llmResponse({ content: "ok" })]);
  provider.generation.reasoningEffort = "medium";
  const loop = new AgentLoop({ bus, provider, workspace });

  await mkdir(join(workspace, "memory"), { recursive: true });
  await writeFile(join(workspace, "memory", "MEMORY.md"), "Durable project memory", "utf8");
  await loop.memory.appendHistory("recent memory entry");
  await loop.handleInbound(new InboundMessage({
    channel: "telegram",
    senderId: "u1",
    chatId: "c1",
    content: "hello",
    media: ["voice.ogg"],
  }));

  const systemPrompt = String(provider.calls[0]?.messages[0]?.content);
  assert.match(systemPrompt, /Durable project memory/);
  assert.match(systemPrompt, /recent memory entry/);
  assert.match(systemPrompt, /voice\.ogg/);
  assert.match(systemPrompt, /reasoningEffort: medium/);
});

test("agent loop cancels active run on stop and suppresses late persistence", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-cancel-"));
  const bus = new MessageBus();
  const runtimeEvents = new RuntimeEventPublisher();
  const statuses: string[] = [];
  runtimeEvents.bus.subscribe((event) => {
    if (event instanceof TurnRunStatusChanged) {
      statuses.push(event.status);
    }
  });
  const provider = new DeferredProvider();
  const loop = new AgentLoop({ bus, provider, workspace, runtimeEvents });
  const route = { channel: "telegram", senderId: "u1", chatId: "c1" };

  const activeRun = loop.handleInbound(new InboundMessage({ ...route, content: "long task" }));
  while (provider.calls.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  await loop.handleInbound(new InboundMessage({ ...route, content: "/stop" }));
  assert.match((await bus.consumeOutbound()).content, /Stopped/);
  assert.equal(provider.calls[0]?.signal?.aborted, true);
  provider.resolve(llmResponse({ content: "late answer" }));
  await activeRun;

  assert.equal(bus.outboundSize, 0);
  assert.equal((await loop.sessions.getOrCreate("telegram:c1")).messages.length, 0);
  assert.deepEqual(statuses, ["running", "cancelled"]);
});

test("agent loop cancels active and queued same-session runs on stop", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-cancel-overlap-"));
  const bus = new MessageBus();
  const provider = new MultiDeferredProvider();
  const loop = new AgentLoop({ bus, provider, workspace });
  const route = { channel: "telegram", senderId: "u1", chatId: "c1" };

  const firstRun = loop.handleInbound(new InboundMessage({ ...route, content: "first long task" }));
  const secondRun = loop.handleInbound(new InboundMessage({ ...route, content: "second long task" }));
  while (provider.calls.length < 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await new Promise((resolve) => setTimeout(resolve, 0));

  await loop.handleInbound(new InboundMessage({ ...route, content: "/stop" }));
  assert.match((await bus.consumeOutbound()).content, /Stopped/);
  assert.equal(provider.calls[0]?.signal?.aborted, true);
  assert.equal(provider.calls.length, 1);

  provider.resolve(0, llmResponse({ content: "late first answer" }));
  await Promise.all([firstRun, secondRun]);

  assert.equal(bus.outboundSize, 0);
  assert.equal((await loop.sessions.getOrCreate("telegram:c1")).messages.length, 0);
});

test("agent loop serializes overlapping same-session turns and preserves both in order", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-turn-chain-"));
  const bus = new MessageBus();
  const provider = new MultiDeferredProvider();
  const loop = new AgentLoop({ bus, provider, workspace });
  const route = { channel: "telegram", senderId: "u1", chatId: "c1" };

  const firstRun = loop.handleInbound(new InboundMessage({ ...route, content: "first" }));
  while (provider.calls.length < 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const secondRun = loop.handleInbound(new InboundMessage({ ...route, content: "second" }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(provider.calls.length, 1);
  provider.resolve(0, llmResponse({ content: "first answer" }));
  assert.equal((await bus.consumeOutbound()).content, "first answer");

  while (provider.calls.length < 2) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.match(
    provider.calls[1]?.messages.map((message) => String(message.content)).join("\n") ?? "",
    /first answer/,
  );
  provider.resolve(1, llmResponse({ content: "second answer" }));
  assert.equal((await bus.consumeOutbound()).content, "second answer");
  await Promise.all([firstRun, secondRun]);

  assert.deepEqual(
    (await loop.sessions.getOrCreate("telegram:c1")).messages.map((message) => message.content),
    ["first", "first answer", "second", "second answer"],
  );
});

test("agent loop persists provider failures and continues later same-session turns", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-provider-failure-"));
  const bus = new MessageBus();
  const runtimeEvents = new RuntimeEventPublisher();
  const statuses: string[] = [];
  runtimeEvents.bus.subscribe((event) => {
    if (event instanceof TurnRunStatusChanged) {
      statuses.push(event.status);
    }
  });
  const provider = new FailOnceProvider();
  const loop = new AgentLoop({ bus, provider, workspace, runtimeEvents });
  const route = { channel: "telegram", senderId: "u1", chatId: "c1" };

  await loop.handleInbound(new InboundMessage({ ...route, content: "fail once" }));
  const errorMessage = await bus.consumeOutbound();
  assert.match(errorMessage.content, /provider exploded/);

  await loop.handleInbound(new InboundMessage({ ...route, content: "try again" }));
  assert.equal((await bus.consumeOutbound()).content, "recovered");

  const session = await loop.sessions.getOrCreate("telegram:c1");
  assert.deepEqual(session.messages.map((message) => message.role), ["user", "assistant", "user", "assistant"]);
  assert.equal(session.messages[0]?.content, "fail once");
  assert.match(String(session.messages[1]?.content), /provider exploded/);
  assert.deepEqual(statuses, ["running", "failed", "running", "final", "complete"]);
});

test("agent loop persists tool execution failures from throwing registries", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-tool-failure-"));
  const bus = new MessageBus();
  const runtimeEvents = new RuntimeEventPublisher();
  const statuses: string[] = [];
  runtimeEvents.bus.subscribe((event) => {
    if (event instanceof TurnRunStatusChanged) {
      statuses.push(event.status);
    }
  });
  const tools: AgentToolRegistry = {
    list: () => [{
      name: "explode",
      description: "Throw an error",
      inputSchema: { type: "object", properties: {} },
    }],
    execute: async () => {
      throw new Error("tool exploded");
    },
  };
  const provider = new MockProvider([
    llmResponse({
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_1", name: "explode", arguments: {} }],
    }),
  ]);
  const loop = new AgentLoop({ bus, provider, workspace, tools, runtimeEvents });

  await loop.handleInbound(new InboundMessage({ channel: "telegram", senderId: "u1", chatId: "c1", content: "use tool" }));

  assert.match((await bus.consumeOutbound()).content, /Running tool explode/);
  const errorMessage = await bus.consumeOutbound();
  assert.match(errorMessage.content, /tool exploded/);
  const session = await loop.sessions.getOrCreate("telegram:c1");
  assert.deepEqual(session.messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal(session.messages[0]?.content, "use tool");
  assert.match(String(session.messages[1]?.content), /tool exploded/);
  assert.deepEqual(statuses, ["running", "tool", "failed"]);
});

test("agent loop suppresses empty assistant responses", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-empty-"));
  const bus = new MessageBus();
  const runtimeEvents = new RuntimeEventPublisher();
  const events: RuntimeEvent[] = [];
  runtimeEvents.bus.subscribe((event) => {
    events.push(event);
  });
  const provider = new MockProvider([llmResponse({ content: "" })]);
  const loop = new AgentLoop({ bus, provider, workspace, runtimeEvents });

  await loop.handleInbound(new InboundMessage({ channel: "telegram", senderId: "u1", chatId: "c1", content: "hello" }));

  assert.equal(bus.outboundSize, 0);
  const session = await loop.sessions.getOrCreate("telegram:c1");
  assert.deepEqual(session.messages.map((message) => message.role), ["user"]);
  assert.deepEqual(events.map((event) => event.constructor.name), [
    "SessionTurnStarted",
    "TurnRunStatusChanged",
    "TurnRunStatusChanged",
    "TurnRunStatusChanged",
    "TurnCompleted",
  ]);
  assert.deepEqual(
    events.filter((event) => event instanceof TurnRunStatusChanged).map((event) => event.status),
    ["running", "final", "complete"],
  );
  const completed = events.at(-1);
  assert.ok(completed instanceof TurnCompleted);
  assert.equal(completed.context.sessionKey, "telegram:c1");
  assert.equal(typeof completed.latencyMs, "number");
  assert.deepEqual(completed.runtime, {
    iterations: 1,
    toolCalls: 0,
    usage: {},
  });
});

test("agent loop persists tool calls, tool results, and assistant reasoning fields", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-response-persistence-"));
  const bus = new MessageBus();
  const tools = new ToolRegistry();
  tools.register({
    name: "echo",
    description: "Echo text",
    inputSchema: { type: "object", properties: {} },
    policy: {},
    execute: async () => ({ content: "tool output" }),
  });
  const provider = new MockProvider([
    llmResponse({
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_1", name: "echo", arguments: {} }],
    }),
    llmResponse({
      content: "visible answer",
      reasoningContent: "private reasoning",
      thinkingBlocks: [{ type: "thinking", text: "block" }],
    }),
  ]);
  const loop = new AgentLoop({ bus, provider, workspace, tools });

  await loop.handleInbound(new InboundMessage({ channel: "telegram", senderId: "u1", chatId: "c1", content: "hello" }));

  const session = await loop.sessions.getOrCreate("telegram:c1");
  assert.deepEqual(session.messages.map((message) => message.role), ["user", "assistant", "tool", "assistant"]);
  assert.equal(session.messages[1]?.tool_calls !== undefined, true);
  assert.equal(session.messages[2]?.tool_call_id, "call_1");
  assert.equal(session.messages[3]?.reasoningContent, "private reasoning");
  assert.deepEqual(session.messages[3]?.thinkingBlocks, [{ type: "thinking", text: "block" }]);
});
