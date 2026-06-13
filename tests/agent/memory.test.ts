import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MemoryStore,
  type ChatOptions,
  type GenerationSettings,
  type LLMProvider,
  type LLMResponse,
  llmResponse,
} from "../../src/index.js";

class MemoryProvider implements LLMProvider {
  readonly defaultModel = "memory-model";
  readonly supportsProgressDeltas = false;
  generation: GenerationSettings = { temperature: 0, maxTokens: 256 };
  calls: ChatOptions[] = [];

  constructor(private readonly response: LLMResponse | Error) {}

  getDefaultModel(): string {
    return this.defaultModel;
  }

  async chat(options: ChatOptions): Promise<LLMResponse> {
    this.calls.push(options);
    if (this.response instanceof Error) {
      throw this.response;
    }
    return this.response;
  }
}

async function readHistory(workspace: string): Promise<Array<Record<string, unknown>>> {
  const content = await readFile(join(workspace, "memory", "history.jsonl"), "utf8");
  return content.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("appendHistory writes cursored JSONL, strips template leaks, and ignores malformed reads", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-memory-jsonl-"));
  const store = new MemoryStore(workspace);

  const first = await store.appendHistory("first entry");
  const second = await store.appendHistory("<think>hidden</think>\nvisible <|assistant|> <channel|>");
  await writeFile(
    join(workspace, "memory", "history.jsonl"),
    [
      "{\"cursor\":true,\"timestamp\":\"bad\",\"content\":\"bool cursor\"}",
      "not json",
      ...(await readFile(join(workspace, "memory", "history.jsonl"), "utf8")).trim().split(/\r?\n/),
    ].join("\n") + "\n",
    "utf8",
  );

  assert.equal(first, 1);
  assert.equal(second, 2);
  const recent = await store.readRecentHistory(10);
  assert.match(recent, /first entry/);
  assert.match(recent, /visible/);
  assert.doesNotMatch(recent, /hidden|bool cursor|not json|<\|assistant\|>|<channel\|>/);
});

test("MemoryStore migrates legacy HISTORY.md once and backs it up", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-memory-legacy-"));
  await mkdir(join(workspace, "memory"), { recursive: true });
  await writeFile(
    join(workspace, "memory", "HISTORY.md"),
    "[2026-06-13 09:00] legacy one\n\n[2026-06-13 09:01] legacy two",
    "utf8",
  );

  const store = new MemoryStore(workspace);
  assert.match(await store.readRecentHistory(10), /legacy one/);
  assert.match(await store.readRecentHistory(10), /legacy two/);
  await access(join(workspace, "memory", "HISTORY.md.bak"));

  const entries = await readHistory(workspace);
  assert.deepEqual(entries.map((entry) => entry.cursor), [1, 2]);
  assert.equal(await store.readDreamCursor(), 2);
});

test("MemoryStore migrates legacy raw archive as one history entry", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-memory-legacy-raw-"));
  await mkdir(join(workspace, "memory"), { recursive: true });
  await writeFile(
    join(workspace, "memory", "HISTORY.md"),
    [
      "[2026-06-13 09:00] [RAW] 2 messages",
      "[2026-06-13 09:00] USER: hello",
      "[2026-06-13 09:01] ASSISTANT [tools: search]: result",
      "",
      "[2026-06-13 09:02] separate entry",
    ].join("\n"),
    "utf8",
  );

  const store = new MemoryStore(workspace);
  await store.readRecentHistory(10);

  const entries = await readHistory(workspace);
  assert.equal(entries.length, 2);
  assert.match(String(entries[0]?.content), /\[RAW\] 2 messages/);
  assert.match(String(entries[0]?.content), /USER: hello/);
  assert.match(String(entries[0]?.content), /ASSISTANT \[tools: search\]: result/);
  assert.equal(entries[1]?.content, "separate entry");
});

test("appendHistory does not compact entries before Dream can process them", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-memory-compact-"));
  const store = new MemoryStore(workspace, { maxHistoryEntries: 2 });

  await store.appendHistory("one");
  await store.appendHistory("two");
  await store.appendHistory("three");

  let entries = await readHistory(workspace);
  assert.deepEqual(entries.map((entry) => entry.content), ["one", "two", "three"]);

  await store.compactHistory();

  entries = await readHistory(workspace);
  assert.deepEqual(entries.map((entry) => entry.content), ["two", "three"]);
  assert.deepEqual(entries.map((entry) => entry.cursor), [2, 3]);
});

test("buildDreamPrompt uses unprocessed history and dream cursor helpers", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-memory-dream-"));
  const store = new MemoryStore(workspace);
  await store.appendHistory("already processed");
  await store.setDreamCursor(1);
  await store.appendHistory("new durable fact");

  const built = await store.buildDreamPrompt({ maxEntries: 10 });
  assert.ok(built);
  assert.equal(built.lastCursor, 2);
  assert.match(built.prompt, /memory consolidation engine/);
  assert.match(built.prompt, /new durable fact/);
  assert.doesNotMatch(built.prompt, /already processed/);

  await store.setDreamCursor(built.lastCursor);
  assert.equal(await store.buildDreamPrompt(), null);
});

test("consolidate archives through a provider when supplied", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-memory-provider-"));
  const provider = new MemoryProvider(llmResponse({ content: "- [durable] remembered summary" }));
  const store = new MemoryStore(workspace);

  const result = await store.consolidate({
    provider,
    messages: [{ role: "user", content: "remember this", timestamp: "2026-06-13T09:00:00.000Z" }],
  });

  assert.equal(result.status, "archived");
  assert.equal(result.providerBacked, true);
  assert.equal(provider.calls.length, 1);
  assert.match(String(provider.calls[0]?.messages[0]?.content), /Extract key facts/);
  assert.match(await store.readRecentHistory(), /remembered summary/);
});

test("consolidate raw-archives when provider fails", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-memory-raw-"));
  const provider = new MemoryProvider(new Error("provider unavailable"));
  const store = new MemoryStore(workspace);

  const result = await store.consolidate({
    provider,
    messages: [{
      role: "assistant",
      content: "tool result was important",
      timestamp: "2026-06-13T09:05:00.000Z",
      tools_used: ["search"],
    }],
  });

  assert.equal(result.status, "raw_archived");
  assert.equal(result.providerBacked, false);
  const recent = await store.readRecentHistory();
  assert.match(recent, /\[RAW\] 1 messages/);
  assert.match(recent, /ASSISTANT \[tools: search\]: tool result was important/);
});

test("consolidate raw-archives non-empty messages when no provider is supplied", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-memory-no-provider-"));
  const store = new MemoryStore(workspace);

  const result = await store.consolidate({
    messages: [{
      role: "user",
      content: "remember providerless work",
      timestamp: "2026-06-13T09:10:00.000Z",
    }],
  });

  assert.equal(result.status, "raw_archived");
  assert.equal(result.providerBacked, false);
  assert.match(result.message, /No provider supplied/);
  const recent = await store.readRecentHistory();
  assert.match(recent, /\[RAW\] 1 messages/);
  assert.match(recent, /USER: remember providerless work/);
});
