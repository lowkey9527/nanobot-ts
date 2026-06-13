import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { MessageBus, OutboundMessage, ToolRegistry, createCoreTools } from "../../src/index.js";
import type { CoreToolOptions } from "../../src/index.js";
import { OutboundMessage as BusOutboundMessage } from "../../src/bus/events.js";

test("tool registry validates input and keeps errors inside tool results", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "echo",
    description: "Echo text",
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: { text: { type: "string" } },
    },
    policy: {},
    execute: async (input: Record<string, unknown>) => ({ content: String(input.text) }),
  });

  assert.deepEqual(await registry.execute("echo", { text: "ok" }), { content: "ok" });

  const invalid = await registry.execute("echo", {});
  assert.equal(invalid.error, true);
  assert.match(invalid.content, /Missing required field 'text'/);

  const missing = await registry.execute("missing", {});
  assert.equal(missing.error, true);
  assert.match(missing.content, /Unknown tool 'missing'/);
});

test("send_message publishes canonical outbound bus events", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-tools-message-"));
  const bus = new MessageBus();
  const registry = new ToolRegistry();

  for (const tool of createCoreTools({
    workspace,
    restrictToWorkspace: true,
    bus,
    route: { channel: "telegram", chatId: "c1" },
  })) {
    registry.register(tool);
  }

  const sent = await registry.execute("send_message", { content: "side reply" });
  assert.equal(sent.error, undefined);

  const outbound = await bus.consumeOutbound();
  assert.equal(outbound instanceof BusOutboundMessage, true);
  assert.deepEqual(outbound, new OutboundMessage({ channel: "telegram", chatId: "c1", content: "side reply" }));
});

test("core filesystem, shell, message, and boundary tools expose policy boundaries", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-tools-"));
  const bus = new MessageBus();
  const registry = new ToolRegistry();

  const coreToolOptions: CoreToolOptions = {
    workspace,
    restrictToWorkspace: true,
    bus,
    route: { channel: "telegram", chatId: "c1" },
    mcpServers: {
      docs: {
        type: "stdio",
        command: "npx",
        args: ["docs-mcp"],
        env: {},
        cwd: workspace,
        url: "",
        headers: {},
        toolTimeout: 30,
        enabledTools: ["search"],
      },
    },
    mcpHandler: async (call) => ({
      content: `ran ${call.server}.${call.tool}`,
      status: "executed",
      echo: call.arguments,
      metadata: call.metadata,
    }),
    spawnHandler: async (request) => ({
      content: `spawned ${request.agent}`,
      status: "spawned",
      task: request.task,
      model: request.model,
      reasoning: request.reasoning,
      policy: request.policy,
    }),
  };

  for (const tool of createCoreTools(coreToolOptions)) {
    registry.register(tool);
  }

  await registry.execute("write_file", { path: "notes.txt", content: "hello" });
  assert.equal(await readFile(join(workspace, "notes.txt"), "utf8"), "hello");

  const outside = await registry.execute("read_file", { path: "../outside.txt" });
  assert.equal(outside.error, true);
  assert.match(outside.content, /outside workspace/);

  const shell = await registry.execute("shell", { command: "node", args: ["-e", "console.log('ok')"] });
  assert.equal(shell.error, undefined);
  assert.match(shell.content, /ok/);
  assert.equal(registry.get("shell")?.policy.execute, "execFile");
  assert.equal(registry.get("shell")?.policy.workspaceRestricted, true);

  const outsideShell = await registry.execute("shell", { command: "node", cwd: "../outside", args: ["-e", "console.log('bad')"] });
  assert.equal(outsideShell.error, true);
  assert.match(outsideShell.content, /outside workspace/);

  const sent = await registry.execute("send_message", { content: "side reply" });
  assert.equal(sent.error, undefined);
  const outbound = await bus.consumeOutbound();
  assert.equal(outbound instanceof BusOutboundMessage, true);
  assert.deepEqual(outbound, new OutboundMessage({ channel: "telegram", chatId: "c1", content: "side reply" }));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("remote text", { status: 200 })) as typeof fetch;
  try {
    const fetched = await registry.execute("web_fetch", { url: "https://example.com/docs" });
    assert.equal(fetched.error, undefined);
    assert.equal(fetched.content, "remote text");
    assert.equal(fetched.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const localFetch = await registry.execute("web_fetch", { url: "http://localhost:8080/private" });
  assert.equal(localFetch.error, true);
  assert.match(localFetch.content, /local or private/i);

  const cron = await registry.execute("cron", {
    action: "create",
    schedule: "*/5 * * * *",
    timezone: "Asia/Shanghai",
    protected: true,
    task: { tool: "send_message", input: { content: "ping" } },
  });
  assert.equal(cron.error, undefined);
  assert.equal(cron.action, "create");
  assert.equal(cron.status, "scheduled");
  assert.equal(cron.store, "memory");
  assert.match(cron.jobId as string, /^cron_/);
  assert.equal(cron.timezone, "Asia/Shanghai");
  assert.equal(cron.protected, true);

  const atJob = await registry.execute("cron", { action: "create", at: "2030-01-01T00:00:00.000Z", task: { tool: "send_message" } });
  assert.equal(atJob.error, undefined);
  assert.equal(atJob.kind, "at");

  const everyJob = await registry.execute("cron", { action: "create", every: "15m", task: { tool: "send_message" } });
  assert.equal(everyJob.error, undefined);
  assert.equal(everyJob.kind, "every");

  const listed = await registry.execute("cron", { action: "list" });
  assert.equal(listed.error, undefined);
  assert.equal(listed.count, 3);
  assert.equal(Array.isArray(listed.jobs), true);

  const badCron = await registry.execute("cron", { schedule: "bad cron", task: { tool: "send_message" } });
  assert.equal(badCron.error, true);
  assert.match(badCron.content, /Invalid cron schedule/);

  const protectedRemove = await registry.execute("cron", { action: "remove", id: cron.jobId });
  assert.equal(protectedRemove.error, true);
  assert.match(protectedRemove.content, /protected/);

  const removed = await registry.execute("cron", { action: "remove", id: cron.jobId, force: true });
  assert.equal(removed.error, undefined);
  assert.equal(removed.status, "removed");
  assert.equal(removed.jobId, cron.jobId);

  const mcp = await registry.execute("mcp", { server: "docs", tool: "search", arguments: { query: "api" } });
  assert.equal(mcp.error, undefined);
  assert.equal(mcp.status, "executed");
  assert.equal(mcp.server, "docs");
  assert.equal(mcp.tool, "search");
  assert.deepEqual(mcp.echo, { query: "api" });
  assert.equal((mcp.metadata as Record<string, unknown>).transport, "stdio");

  const mcpMetadata = await registry.execute("mcp", { action: "metadata", server: "docs", tool: "search" });
  assert.equal(mcpMetadata.error, undefined);
  assert.equal(mcpMetadata.status, "configured");
  assert.equal(mcpMetadata.transport, "stdio");

  const unavailableMcpRegistry = new ToolRegistry();
  for (const tool of createCoreTools({ ...coreToolOptions, mcpHandler: undefined })) {
    unavailableMcpRegistry.register(tool);
  }
  const unconfiguredMcp = await unavailableMcpRegistry.execute("mcp", { server: "docs", tool: "search" });
  assert.equal(unconfiguredMcp.error, true);
  assert.match(unconfiguredMcp.content, /handler is not configured/);

  const spawn = await registry.execute("spawn", { task: "Inspect docs", agent: "explore", model: "gpt-5.4-mini", reasoning: "low" });
  assert.equal(spawn.error, undefined);
  assert.equal(spawn.status, "spawned");
  assert.equal(spawn.task, "Inspect docs");
  assert.equal(spawn.model, "gpt-5.4-mini");
  assert.equal(spawn.reasoning, "low");

  const badSpawn = await registry.execute("spawn", { task: "Inspect docs", reasoning: "extreme" });
  assert.equal(badSpawn.error, true);
  assert.match(badSpawn.content, /reasoning/);

  const unavailableSpawnRegistry = new ToolRegistry();
  for (const tool of createCoreTools({ ...coreToolOptions, spawnHandler: undefined })) {
    unavailableSpawnRegistry.register(tool);
  }
  const unconfiguredSpawn = await unavailableSpawnRegistry.execute("spawn", { task: "Inspect docs", agent: "explore" });
  assert.equal(unconfiguredSpawn.error, true);
  assert.match(unconfiguredSpawn.content, /handler is not configured/);
});
