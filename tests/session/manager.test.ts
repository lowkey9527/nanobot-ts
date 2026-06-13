import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { effectiveSessionKey, resolveSessionKey, Session, SessionManager, UNIFIED_SESSION_KEY } from "../../src/index.js";

test("session manager persists JSONL sessions under safe filenames", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-session-"));
  const manager = new SessionManager(workspace);
  const session = await manager.getOrCreate("telegram:chat/unsafe");

  session.addMessage("user", "older");
  session.addMessage("assistant", "answer", {
    reasoningContent: "why",
    thinkingBlocks: [{ type: "thinking", text: "private" }],
  });
  await manager.save(session);

  const fresh = new SessionManager(workspace);
  const loaded = await fresh.getOrCreate("telegram:chat/unsafe");

  assert.equal(SessionManager.safeKey("telegram:chat/unsafe"), "telegram_chat_unsafe");
  assert.equal(loaded.messages.length, 2);
  assert.equal(loaded.messages[1]?.reasoningContent, "why");
  assert.deepEqual(loaded.messages[1]?.thinkingBlocks, [{ type: "thinking", text: "private" }]);
});

test("session history returns recent legal user-started window", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-session-"));
  const manager = new SessionManager(workspace);
  const session = await manager.getOrCreate("telegram:c1");

  session.addMessage("assistant", "orphan");
  session.addMessage("user", "one");
  session.addMessage("assistant", "two");
  session.addMessage("user", "three");

  assert.deepEqual(
    session.getHistory(3).map((message: { role: string; content: unknown }) => [message.role, message.content]),
    [["user", "one"], ["assistant", "two"], ["user", "three"]],
  );
  assert.deepEqual(
    session.getHistory(2).map((message: { role: string; content: unknown }) => [message.role, message.content]),
    [["user", "three"]],
  );
});

test("session manager repairs corrupt JSONL by skipping invalid lines", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-session-"));
  const sessionsDir = join(workspace, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(
    join(sessionsDir, `${SessionManager.safeKey("telegram:corrupt")}.jsonl`),
    [
      JSON.stringify({
        _type: "metadata",
        key: "telegram:corrupt",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:01:00.000Z",
        metadata: { title: "Recovered" },
        lastConsolidated: 9,
      }),
      "{broken json",
      JSON.stringify({ role: "user", content: "survived" }),
      "{\"role\":\"assistant\",\"content\":\"partial",
    ].join("\n"),
    "utf8",
  );

  const manager = new SessionManager(workspace);
  const session = await manager.getOrCreate("telegram:corrupt");

  assert.deepEqual(session.metadata, { title: "Recovered" });
  assert.equal(session.lastConsolidated, 0);
  assert.deepEqual(session.messages.map((message) => message.content), ["survived"]);
});

test("session manager skips malformed JSONL records with valid JSON syntax", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-session-"));
  const sessionsDir = join(workspace, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(
    join(sessionsDir, `${SessionManager.safeKey("telegram:malformed")}.jsonl`),
    [
      JSON.stringify({
        _type: "metadata",
        key: "telegram:malformed",
        metadata: { title: "Valid metadata" },
      }),
      JSON.stringify("not a record"),
      JSON.stringify(["not", "a", "record"]),
      JSON.stringify(null),
      JSON.stringify({ role: 123, content: "bad role" }),
      JSON.stringify({ role: "user" }),
      JSON.stringify({ role: "assistant" }),
      JSON.stringify({ role: "tool", tool_call_id: "missing-content" }),
      JSON.stringify({ role: "user", content: "kept user" }),
      JSON.stringify({
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }],
      }),
    ].join("\n"),
    "utf8",
  );

  const manager = new SessionManager(workspace);
  const session = await manager.getOrCreate("telegram:malformed");

  assert.deepEqual(session.metadata, { title: "Valid metadata" });
  assert.deepEqual(session.messages.map((message) => message.role), ["user", "assistant"]);
  assert.deepEqual(session.messages.map((message) => message.content), ["kept user", null]);
});

test("session manager migrates legacy session file on first load", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-session-"));
  const legacySessionsDir = await mkdtemp(join(tmpdir(), "nanobot-legacy-sessions-"));
  const legacyPath = join(legacySessionsDir, `${SessionManager.safeKey("telegram:legacy")}.jsonl`);
  await writeFile(
    legacyPath,
    [
      JSON.stringify({ _type: "metadata", key: "telegram:legacy", metadata: { from: "legacy" } }),
      JSON.stringify({ role: "user", content: "old home" }),
    ].join("\n"),
    "utf8",
  );

  const manager = new SessionManager(workspace, { legacySessionsDir });
  const session = await manager.getOrCreate("telegram:legacy");

  assert.deepEqual(session.metadata, { from: "legacy" });
  assert.equal(session.messages[0]?.content, "old home");
  await assert.rejects(access(legacyPath));
  await access(join(workspace, "sessions", `${SessionManager.safeKey("telegram:legacy")}.jsonl`));
});

test("readSessionFile, listSessions, invalidate, and flushAll expose persisted sessions", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-session-"));
  const manager = new SessionManager(workspace);
  const session = await manager.getOrCreate("telegram:list");
  session.metadata.title = "Listed";
  session.addMessage("user", "preview me");
  await manager.save(session);

  const data = await manager.readSessionFile("telegram:list");
  assert.equal(data?.key, "telegram:list");
  assert.deepEqual(data?.messages.map((message) => message.content), ["preview me"]);
  assert.equal((await manager.listSessions())[0]?.preview, "preview me");

  manager.invalidate("telegram:list");
  assert.equal(await manager.flushAll(), 0);
  await manager.getOrCreate("telegram:list");
  assert.equal(await manager.flushAll(), 1);
});

test("session metadata is persisted and exposed with snake case parity fields", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-session-"));
  const manager = new SessionManager(workspace);
  const session = await manager.getOrCreate("telegram:snake");
  session.createdAt = new Date("2026-01-02T03:04:05.000Z");
  session.metadata.title = "Snake";
  session.addMessage("user", "first");
  session.addMessage("assistant", "second");
  session.lastConsolidated = 1;
  await manager.save(session);

  const raw = await readFile(join(workspace, "sessions", `${SessionManager.safeKey("telegram:snake")}.jsonl`), "utf8");
  const metadata = JSON.parse(raw.split(/\r?\n/)[0] ?? "{}") as Record<string, unknown>;
  assert.equal(metadata.created_at, "2026-01-02T03:04:05.000Z");
  assert.equal(metadata.updated_at, session.updatedAt.toISOString());
  assert.equal(metadata.last_consolidated, 1);

  const data = await manager.readSessionFile("telegram:snake");
  const payload = data as unknown as Record<string, unknown>;
  assert.equal(payload.created_at, "2026-01-02T03:04:05.000Z");
  assert.equal(payload.updated_at, session.updatedAt.toISOString());
  assert.equal(payload.last_consolidated, 1);

  const listed = (await manager.listSessions()).find((entry) => entry.key === "telegram:snake") as unknown as Record<string, unknown>;
  assert.equal(listed.created_at, "2026-01-02T03:04:05.000Z");
  assert.equal(listed.updated_at, session.updatedAt.toISOString());
  assert.equal(listed.last_consolidated, 1);
});

test("listSessions strips generated title think blocks but preserves user-edited titles", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-session-"));
  const manager = new SessionManager(workspace);
  const generated = await manager.getOrCreate("telegram:generated-title");
  generated.metadata.title = "<think>draft rationale</think>Generated Title";
  generated.addMessage("user", "generated preview");
  await manager.save(generated);

  const userEdited = await manager.getOrCreate("telegram:user-title");
  userEdited.metadata.title = "<think>keep this</think>User Title";
  userEdited.metadata.title_user_edited = true;
  userEdited.addMessage("user", "user preview");
  await manager.save(userEdited);

  const sessions = await manager.listSessions();
  assert.equal(sessions.find((entry) => entry.key === "telegram:generated-title")?.title, "Generated Title");
  assert.equal(sessions.find((entry) => entry.key === "telegram:user-title")?.title, "<think>keep this</think>User Title");
});

test("flushAll continues after one cached session fails to save", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-session-"));
  const manager = new SessionManager(workspace);
  const good = await manager.getOrCreate("telegram:good");
  const bad = await manager.getOrCreate("telegram:bad");
  good.addMessage("user", "ok");
  bad.addMessage("user", "not ok");

  const originalSave = manager.save.bind(manager);
  let attempts = 0;
  manager.save = async (session, options) => {
    attempts += 1;
    if (session.key === "telegram:bad") {
      throw new Error("simulated save failure");
    }
    await originalSave(session, options);
  };

  assert.equal(await manager.flushAll(), 1);
  assert.equal(attempts, 2);
});

test("session history filters commands and annotates only user timestamps", () => {
  const session = new Session({ key: "telegram:timestamps" });
  session.messages.push(
    { role: "user", content: "/status", _command: true, timestamp: "2026-04-26T21:00:00.000Z" },
    { role: "user", content: "10 pm was yesterday", timestamp: "2026-04-26T22:00:00.000Z" },
    { role: "assistant", content: "noted", timestamp: "2026-04-26T22:00:05.000Z" },
  );

  assert.deepEqual(session.getHistory({ maxMessages: 10, includeTimestamps: true }), [
    { role: "user", content: "[Message Time: 2026-04-26T22:00:00.000Z]\n10 pm was yesterday" },
    { role: "assistant", content: "noted" },
  ]);
  assert.deepEqual(session.getHistory(10), [
    { role: "user", content: "10 pm was yesterday" },
    { role: "assistant", content: "noted" },
  ]);
});

test("session history keeps adjacent assistant channel delivery before user reply without timestamp annotation", () => {
  const session = new Session({ key: "telegram:delivery" });
  session.messages.push(
    { role: "assistant", content: "Proactive delivery", _channel_delivery: true, timestamp: "2026-04-26T21:59:59.000Z" },
    { role: "user", content: "reply", timestamp: "2026-04-26T22:00:00.000Z" },
    { role: "assistant", content: "response", timestamp: "2026-04-26T22:00:05.000Z" },
  );

  assert.deepEqual(session.getHistory({ maxMessages: 10, includeTimestamps: true }), [
    { role: "assistant", content: "Proactive delivery" },
    { role: "user", content: "[Message Time: 2026-04-26T22:00:00.000Z]\nreply" },
    { role: "assistant", content: "response" },
  ]);
});

test("session history adds user media CLI and MCP breadcrumbs only to user turns", () => {
  const session = new Session({ key: "telegram:breadcrumbs" });
  session.messages.push(
    {
      role: "user",
      content: "inspect",
      media: ["/tmp/a.png", ""],
      cliApps: [{ name: "DrawIO", entryPoint: "cli-anything-drawio" }],
      mcpPresets: [{ name: "Linear", transport: "stdio" }],
    },
    { role: "assistant", content: "done", media: ["/tmp/generated.png"] },
  );

  assert.deepEqual(session.getHistory(10), [
    {
      role: "user",
      content: [
        "inspect",
        "[image: /tmp/a.png]",
        "[CLI App Attachment: @drawio; tool=run_cli_app; entry_point=cli-anything-drawio; skill=skills/cli-app-drawio/SKILL.md]",
        "[MCP Preset Attachment: @linear; tool_prefix=mcp_linear_; transport=stdio]",
      ].join("\n"),
    },
    { role: "assistant", content: "done" },
  ]);
});

test("session history avoids orphan tool results and keeps valid replay fields", () => {
  const session = new Session({ key: "telegram:tools" });
  session.messages.push(
    { role: "tool", tool_call_id: "orphan", name: "lost", content: "old" },
    { role: "user", content: "run it" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }],
      toolCalls: [{ id: "camel_1", name: "lookup", arguments: {} }],
      reasoningContent: "visible reasoning",
      thinkingBlocks: [{ type: "thinking", text: "private" }],
    },
    { role: "tool", tool_call_id: "call_1", name: "lookup", content: "ok" },
    { role: "assistant", content: "" },
    { role: "assistant", content: "final" },
  );

  assert.deepEqual(session.getHistory(10), [
    { role: "user", content: "run it" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }],
      toolCalls: [{ id: "camel_1", name: "lookup", arguments: {} }],
      reasoningContent: "visible reasoning",
      thinkingBlocks: [{ type: "thinking", text: "private" }],
    },
    { role: "tool", tool_call_id: "call_1", name: "lookup", content: "ok" },
    { role: "assistant", content: "final" },
  ]);
});

test("session history token trimming recovers nearest user turn", () => {
  const session = new Session({ key: "telegram:tokens" });
  session.messages.push(
    { role: "user", content: "first question" },
    { role: "assistant", content: "first answer with enough words" },
    { role: "user", content: "second question" },
    { role: "assistant", content: "second answer with enough words" },
  );

  assert.deepEqual(
    session.getHistory({ maxMessages: 10, maxTokens: 4 }).map((message) => message.content),
    ["second question", "second answer with enough words"],
  );
});

test("session history token recovery keeps adjacent assistant channel delivery before recovered user", () => {
  const session = new Session({ key: "telegram:delivery-tokens" });
  session.messages.push(
    { role: "user", content: "first question" },
    { role: "assistant", content: "first answer with enough words" },
    { role: "assistant", content: "Proactive delivery", _channel_delivery: true, timestamp: "2026-04-26T21:59:59.000Z" },
    { role: "user", content: "second question", timestamp: "2026-04-26T22:00:00.000Z" },
    { role: "assistant", content: "second answer with enough words" },
  );

  assert.deepEqual(session.getHistory({ maxMessages: 10, maxTokens: 4, includeTimestamps: true }), [
    { role: "assistant", content: "Proactive delivery" },
    { role: "user", content: "[Message Time: 2026-04-26T22:00:00.000Z]\nsecond question" },
    { role: "assistant", content: "second answer with enough words" },
  ]);
});

test("session file cap keeps a legal suffix and archives only unconsolidated dropped messages", () => {
  const session = new Session({ key: "telegram:cap" });
  const archived: unknown[] = [];
  for (let index = 0; index < 10; index += 1) {
    session.messages.push({ role: "user", content: `u${index}` });
  }
  for (let index = 0; index < 10; index += 1) {
    session.messages.push({ role: "assistant", content: `a${index}` });
  }
  session.lastConsolidated = 12;

  const dropped = session.enforceFileCap({ limit: 4, onArchive: (messages) => archived.push(...messages) });

  assert.equal(session.messages.length <= 4, true);
  assert.deepEqual(session.messages.map((message) => message.content), ["a6", "a7", "a8", "a9"]);
  assert.equal(session.messages.at(-1)?.content, "a9");
  assert.equal(session.lastConsolidated, 0);
  assert.equal(dropped.length, 16);
  assert.equal(archived.some((message) => typeof message === "object" && message !== null && "content" in message && message.content === "u0"), false);

  const legal = new Session({ key: "telegram:cap-legal" });
  legal.messages.push(
    { role: "user", content: "u0" },
    { role: "assistant", content: "a0" },
    { role: "user", content: "u1" },
    { role: "assistant", content: "a1" },
    { role: "assistant", content: "a2" },
  );

  legal.enforceFileCap({ limit: 4 });

  assert.deepEqual(legal.messages.map((message) => message.content), ["u1", "a1", "a2"]);
});

test("session manager atomic save removes stale temp file on serialization failure", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-session-"));
  const manager = new SessionManager(workspace);
  const session = new Session({ key: "telegram:atomic" });
  const circular: Record<string, unknown> = { role: "assistant" };
  circular.self = circular;
  session.messages.push({ role: "user", content: "ok" }, circular as never);

  await assert.rejects(manager.save(session), /circular/i);

  const sessionsDir = join(workspace, "sessions");
  const files = await readdir(sessionsDir);
  assert.deepEqual(files.filter((file) => file.endsWith(".tmp")), []);
});

test("unified session helpers resolve default and override keys", () => {
  assert.equal(UNIFIED_SESSION_KEY, "unified:default");
  assert.equal(resolveSessionKey({ originalKey: "telegram:1", unifiedSession: true }), "unified:default");
  assert.equal(resolveSessionKey({ originalKey: "telegram:1", unifiedSession: true, overrideKey: "thread:2" }), "thread:2");
  assert.equal(effectiveSessionKey({ originalKey: "telegram:1", unifiedSession: false }), "telegram:1");
});
