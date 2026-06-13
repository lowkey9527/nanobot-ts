import assert from "node:assert/strict";
import test from "node:test";

import {
  INBOUND_META_RUNTIME_CONTROL,
  GoalStateChanged,
  InboundMessage,
  MessageBus,
  OUTBOUND_META_AGENT_UI,
  OutboundMessage,
  RuntimeEventBus,
  RuntimeEventContext,
  RuntimeEventPublisher,
  RuntimeModelChanged,
  SessionTurnStarted,
  TurnCompleted,
  TurnRunStatusChanged,
  RUNTIME_CONTROL_ACK,
  RUNTIME_CONTROL_MCP_RELOAD,
} from "../../src/index.js";
import { InboundMessage as BusInboundMessage, OutboundMessage as BusOutboundMessage } from "../../src/bus/events.js";
import { MessageBus as QueueMessageBus } from "../../src/bus/queue.js";
import { RuntimeEventBus as BusRuntimeEventBus } from "../../src/bus/runtime-events.js";

test("public message exports use the canonical bus subsystem", () => {
  assert.equal(InboundMessage, BusInboundMessage);
  assert.equal(OutboundMessage, BusOutboundMessage);
  assert.equal(MessageBus, QueueMessageBus);
  assert.equal(RuntimeEventBus, BusRuntimeEventBus);
});

test("bus metadata constants match runtime control protocol keys", () => {
  assert.equal(OUTBOUND_META_AGENT_UI, "_agent_ui");
  assert.equal(INBOUND_META_RUNTIME_CONTROL, "_runtime_control");
  assert.equal(RUNTIME_CONTROL_ACK, "_ack");
  assert.equal(RUNTIME_CONTROL_MCP_RELOAD, "mcp_reload");
});

test("message bus preserves inbound and outbound ordering", async () => {
  const bus = new MessageBus();
  const first = new InboundMessage({ channel: "telegram", senderId: "u1", chatId: "c1", content: "first" });
  const second = new InboundMessage({ channel: "telegram", senderId: "u1", chatId: "c1", content: "second" });

  assert.equal(first.sessionKey, "telegram:c1");
  assert.equal(bus.inboundSize, 0);

  await bus.publishInbound(first);
  await bus.publishInbound(second);
  assert.equal(bus.inboundSize, 2);

  assert.equal((await bus.consumeInbound()).content, "first");
  assert.equal((await bus.consumeInbound()).content, "second");
  assert.equal(bus.inboundSize, 0);

  await bus.publishOutbound(new OutboundMessage({ channel: "telegram", chatId: "c1", content: "reply" }));

  assert.equal(bus.outboundSize, 1);
  assert.equal((await bus.consumeOutbound()).content, "reply");
  assert.equal(bus.outboundSize, 0);
});

test("inbound message session override and metadata are preserved", () => {
  const msg = new InboundMessage({
    channel: "discord",
    senderId: "u2",
    chatId: "room",
    content: "hello",
    media: ["voice.ogg"],
    metadata: { messageId: "m1" },
    sessionKeyOverride: "thread:42",
  });

  assert.equal(msg.sessionKey, "thread:42");
  assert.deepEqual(msg.media, ["voice.ogg"]);
  assert.deepEqual(msg.metadata, { messageId: "m1" });
});

test("runtime event bus filters by event type and keeps catch-all subscriptions", async () => {
  const bus = new RuntimeEventBus();
  const statusEvents: string[] = [];
  const allEvents: string[] = [];

  bus.subscribe((event) => {
    allEvents.push(event.constructor.name);
  });
  bus.subscribe(async (event) => {
    statusEvents.push(event.status);
  }, TurnRunStatusChanged);

  await bus.publish(new RuntimeModelChanged({ model: "mock", modelPreset: undefined }));
  await bus.publish(new TurnRunStatusChanged({
    context: new RuntimeEventContext({ channel: "cli", chatId: "direct", sessionKey: "cli:direct" }),
    status: "running",
  }));

  assert.deepEqual(allEvents, ["RuntimeModelChanged", "TurnRunStatusChanged"]);
  assert.deepEqual(statusEvents, ["running"]);
});

test("runtime event bus continues after handler failures in registration order", async () => {
  const bus = new RuntimeEventBus();
  const seen: string[] = [];

  bus.subscribe(() => {
    seen.push("first");
    throw new Error("handler failed");
  });
  bus.subscribe(async () => {
    await Promise.resolve();
    seen.push("second");
  });
  bus.subscribe(() => {
    seen.push("third");
  });

  await bus.publish(new RuntimeModelChanged({ model: "mock" }));

  assert.deepEqual(seen, ["first", "second", "third"]);
});

test("runtime event bus unsubscribe removes subscriptions", async () => {
  const bus = new RuntimeEventBus();
  const seen: string[] = [];

  const unsubscribe = bus.subscribe((event) => {
    seen.push(event.constructor.name);
  });

  await bus.publish(new RuntimeModelChanged({ model: "first" }));
  unsubscribe();
  await bus.publish(new RuntimeModelChanged({ model: "second" }));

  assert.deepEqual(seen, ["RuntimeModelChanged"]);
});

test("runtime event publisher builds context from inbound message", async () => {
  const bus = new RuntimeEventBus();
  const seen: object[] = [];
  const publisher = new RuntimeEventPublisher(bus);
  const msg = new InboundMessage({
    channel: "websocket",
    senderId: "user",
    chatId: "chat-a",
    content: "hello",
    metadata: { traceId: "turn-1" },
  });

  bus.subscribe((event) => {
    seen.push(event);
  });

  await publisher.sessionTurnStarted(msg, "websocket:chat-a");
  await publisher.runStatusChanged(msg, "websocket:chat-a", "running", { startedAt: 12.5 });

  const started = seen[0];
  const running = seen[1];
  assert.equal(started instanceof SessionTurnStarted, true);
  assert.equal((started as SessionTurnStarted).context.channel, "websocket");
  assert.equal((started as SessionTurnStarted).context.chatId, "chat-a");
  assert.equal((started as SessionTurnStarted).context.sessionKey, "websocket:chat-a");
  assert.deepEqual((started as SessionTurnStarted).context.metadata, { traceId: "turn-1" });
  assert.notEqual((started as SessionTurnStarted).context.metadata, msg.metadata);
  assert.equal(running instanceof TurnRunStatusChanged, true);
  assert.equal((running as TurnRunStatusChanged).status, "running");
  assert.equal((running as TurnRunStatusChanged).startedAt, 12.5);
});

test("runtime event publisher emits goal state and model changes", async () => {
  const bus = new RuntimeEventBus();
  const seen: object[] = [];
  const publisher = new RuntimeEventPublisher(bus);
  const msg = new InboundMessage({
    channel: "websocket",
    senderId: "user",
    chatId: "chat-a",
    content: "hello",
    metadata: { traceId: "turn-1" },
  });

  bus.subscribe((event) => {
    seen.push(event);
  });

  await publisher.goalStateChanged(msg, "websocket:chat-a", { goal: "active" });
  publisher.runtimeModelChanged("gpt-test", "fast");
  await new Promise((resolve) => {
    setImmediate(resolve);
  });

  const goal = seen[0];
  const model = seen[1];
  assert.equal(goal instanceof GoalStateChanged, true);
  assert.deepEqual((goal as GoalStateChanged).sessionMetadata, { goal: "active" });
  assert.deepEqual((goal as GoalStateChanged).context.metadata, { traceId: "turn-1" });
  assert.equal(model instanceof RuntimeModelChanged, true);
  assert.equal((model as RuntimeModelChanged).model, "gpt-test");
  assert.equal((model as RuntimeModelChanged).modelPreset, "fast");
});

test("runtime event publisher consumes turn metadata on completion", async () => {
  const bus = new RuntimeEventBus();
  const seen: object[] = [];
  const publisher = new RuntimeEventPublisher(bus);

  bus.subscribe((event) => {
    seen.push(event);
  });
  publisher.recordTurnRuntime("cli:direct", "runtime");
  publisher.recordTurnLatency("cli:direct", 123);

  await publisher.turnCompleted({
    channel: "cli",
    chatId: "direct",
    sessionKey: "cli:direct",
    metadata: { source: "test" },
  });
  await publisher.turnCompleted({
    channel: "cli",
    chatId: "direct",
    sessionKey: "cli:direct",
  });

  const first = seen[0];
  const second = seen[1];
  assert.equal(first instanceof TurnCompleted, true);
  assert.deepEqual((first as TurnCompleted).context.metadata, { source: "test" });
  assert.equal((first as TurnCompleted).latencyMs, 123);
  assert.equal((first as TurnCompleted).runtime, "runtime");
  assert.equal(second instanceof TurnCompleted, true);
  assert.equal((second as TurnCompleted).latencyMs, undefined);
  assert.equal((second as TurnCompleted).runtime, undefined);
});
