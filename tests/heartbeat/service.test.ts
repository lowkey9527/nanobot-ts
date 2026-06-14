import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MessageBus } from "../../src/bus/queue.js";
import {
  HeartbeatService,
  heartbeatHasActiveTasks,
  pickHeartbeatTarget,
} from "../../src/heartbeat/service.js";
import { HeartbeatService as PublicHeartbeatService } from "../../src/index.js";

const bundledTemplate = await readFile(join(process.cwd(), "templates", "HEARTBEAT.md"), "utf8");

test("heartbeat active task detection matches Python parity cases", () => {
  const cases: Array<{ name: string; content: string; active: boolean }> = [
    {
      name: "missing active tasks section",
      content: "# Heartbeat\n\n- task outside the active section\n",
      active: false,
    },
    {
      name: "empty active tasks section",
      content: "# Heartbeat\n\n## Active Tasks\n\n",
      active: false,
    },
    {
      name: "bundled template with comments only",
      content: bundledTemplate,
      active: false,
    },
    {
      name: "single task under active tasks",
      content: "# Heartbeat\n\n## Active Tasks\n\n- check pending work\n",
      active: true,
    },
    {
      name: "html comments and headings do not count as tasks",
      content: [
        "# Heartbeat",
        "",
        "## Active Tasks",
        "",
        "<!-- comment only -->",
        "### Later",
        "",
      ].join("\n"),
      active: false,
    },
    {
      name: "task under active subsection counts",
      content: [
        "# Heartbeat",
        "",
        "## Active Tasks",
        "",
        "### Daily",
        "- summarize yesterday",
      ].join("\n"),
      active: true,
    },
    {
      name: "multiline html comments are ignored",
      content: [
        "# Heartbeat",
        "",
        "## Active Tasks",
        "<!--",
        "- hidden task",
        "-->",
      ].join("\n"),
      active: false,
    },
    {
      name: "next h2 ends active tasks section",
      content: [
        "# Heartbeat",
        "",
        "## Active Tasks",
        "",
        "## Backlog",
        "- not active",
      ].join("\n"),
      active: false,
    },
  ];

  for (const { name, content, active } of cases) {
    assert.equal(heartbeatHasActiveTasks(content), active, name);
  }
});

test("heartbeat target selection skips cli system and disabled channels", () => {
  const target = pickHeartbeatTarget(
    [
      { key: "cli:direct" },
      { key: "system:maintenance" },
      { key: "discord:disabled" },
      { key: "telegram:chat-1" },
      { key: "telegram:chat-2" },
    ],
    new Set(["telegram"]),
  );

  assert.deepEqual(target, { channel: "telegram", chatId: "chat-1" });
});

test("heartbeat target selection falls back to cli direct", () => {
  assert.deepEqual(
    pickHeartbeatTarget([{ key: "discord:disabled" }, { key: undefined }], new Set(["telegram"])),
    { channel: "cli", chatId: "direct" },
  );
});

test("heartbeat target selection treats string enabled channel as one channel", () => {
  assert.deepEqual(
    pickHeartbeatTarget([{ key: "telegram:chat-1" }], "telegram"),
    { channel: "telegram", chatId: "chat-1" },
  );
});

test("active heartbeat executes agent callback with heartbeat session and content", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-heartbeat-active-"));
  const heartbeatContent = "## Active Tasks\n\n- check the queue\n";
  await writeFile(join(workspace, "HEARTBEAT.md"), heartbeatContent, "utf8");

  const calls: Array<{ prompt: string; sessionKey: string }> = [];
  const service = new HeartbeatService({
    workspace,
    agent: async (input) => {
      calls.push({ prompt: input.prompt, sessionKey: input.sessionKey });
      return "done";
    },
  });

  const result = await service.runOnce();

  assert.equal(result.active, true);
  assert.equal(result.delivered, false);
  assert.deepEqual(calls.map((call) => call.sessionKey), ["heartbeat"]);
  assert.match(calls[0]?.prompt ?? "", /HEARTBEAT\.md/);
  assert.match(calls[0]?.prompt ?? "", /check the queue/);
});

test("routable heartbeat response publishes outbound to selected channel chat", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-heartbeat-route-"));
  await writeFile(join(workspace, "HEARTBEAT.md"), "## Active Tasks\n\n- tell telegram\n", "utf8");
  const bus = new MessageBus();
  const service = new HeartbeatService({
    workspace,
    publisher: bus,
    enabledChannels: ["telegram"],
    listSessions: async () => [{ key: "telegram:chat-99" }],
    agent: async () => ({ content: "heartbeat response" }),
  });

  const result = await service.runOnce();
  const outbound = await bus.consumeOutbound();

  assert.equal(result.delivered, true);
  assert.equal(outbound.channel, "telegram");
  assert.equal(outbound.chatId, "chat-99");
  assert.equal(outbound.content, "heartbeat response");
});

test("routable heartbeat reuses generator enabled channels across runs", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-heartbeat-generator-"));
  await writeFile(join(workspace, "HEARTBEAT.md"), "## Active Tasks\n\n- tell telegram\n", "utf8");
  const bus = new MessageBus();

  function* enabledChannels(): Iterable<string> {
    yield "telegram";
  }

  const service = new HeartbeatService({
    workspace,
    publisher: bus,
    enabledChannels: enabledChannels(),
    listSessions: async () => [{ key: "telegram:chat-99" }],
    agent: async () => ({ content: "heartbeat response" }),
  });

  const first = await service.runOnce();
  const firstOutbound = await bus.consumeOutbound();
  const second = await service.runOnce();

  assert.deepEqual(first.target, { channel: "telegram", chatId: "chat-99" });
  assert.equal(first.delivered, true);
  assert.equal(firstOutbound.channel, "telegram");
  assert.deepEqual(second.target, { channel: "telegram", chatId: "chat-99" });
  assert.equal(second.delivered, true);
  assert.equal(bus.outboundSize, 1);
  const secondOutbound = await bus.consumeOutbound();
  assert.equal(secondOutbound.channel, "telegram");
});

test("cli fallback executes active heartbeat but stays silent", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-heartbeat-cli-"));
  await writeFile(join(workspace, "HEARTBEAT.md"), "## Active Tasks\n\n- local only\n", "utf8");
  const bus = new MessageBus();
  let calls = 0;
  const service = new HeartbeatService({
    workspace,
    publisher: bus,
    enabledChannels: ["telegram"],
    listSessions: async () => [{ key: "discord:disabled" }],
    agent: async () => {
      calls += 1;
      return "silent response";
    },
  });

  const result = await service.runOnce();

  assert.equal(calls, 1);
  assert.equal(result.delivered, false);
  assert.equal(bus.outboundSize, 0);
});

test("inactive or missing heartbeat file skips callback and delivery", async () => {
  const inactiveWorkspace = await mkdtemp(join(tmpdir(), "nanobot-heartbeat-inactive-"));
  const missingWorkspace = await mkdtemp(join(tmpdir(), "nanobot-heartbeat-missing-"));
  await writeFile(join(inactiveWorkspace, "HEARTBEAT.md"), bundledTemplate, "utf8");

  const calls: string[] = [];
  const bus = new MessageBus();
  const makeService = (workspace: string) => new HeartbeatService({
    workspace,
    publisher: bus,
    enabledChannels: ["telegram"],
    listSessions: async () => [{ key: "telegram:chat-1" }],
    agent: async () => {
      calls.push(workspace);
      return "should not run";
    },
  });

  assert.equal((await makeService(inactiveWorkspace).runOnce()).active, false);
  assert.equal((await makeService(missingWorkspace).runOnce()).active, false);
  assert.deepEqual(calls, []);
  assert.equal(bus.outboundSize, 0);
});

test("heartbeat service is exported from public index", () => {
  assert.equal(PublicHeartbeatService, HeartbeatService);
});
