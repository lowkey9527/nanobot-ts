import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CronService, CronStore, getCronExecutionContext } from "../../src/cron/service.js";
import { createCronTool } from "../../src/tools/cron.js";

class FakeTimers {
  readonly scheduled: Array<{ callback: () => void | Promise<void>; delayMs: number; handle: object }> = [];

  setTimeout(callback: () => void | Promise<void>, delayMs: number): object {
    const handle = {};
    this.scheduled.push({ callback, delayMs, handle });
    return handle;
  }

  clearTimeout(handle: object): void {
    const index = this.scheduled.findIndex((entry) => entry.handle === handle);
    if (index >= 0) {
      this.scheduled.splice(index, 1);
    }
  }

  async runNext(): Promise<void> {
    const next = this.scheduled.shift();
    assert.ok(next, "expected a scheduled timer");
    await next.callback();
  }
}

class ZeroHandleTimers {
  readonly cleared: unknown[] = [];
  callback: (() => void | Promise<void>) | undefined;
  delayMs: number | undefined;

  setTimeout(callback: () => void | Promise<void>, delayMs: number): number {
    this.callback = callback;
    this.delayMs = delayMs;
    return 0;
  }

  clearTimeout(handle: unknown): void {
    this.cleared.push(handle);
  }
}

test("cron store persists jobs and refuses to replace corrupt JSON", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-cron-store-"));
  const storePath = join(workspace, "cron.json");
  const now = new Date("2026-01-01T00:00:00.000Z");
  let id = 0;

  const store = new CronStore({
    filePath: storePath,
    idGenerator: () => `cron_test_${++id}`,
    now: () => now,
  });

  const job = store.create({
    kind: "every",
    every: "15m",
    timezone: "UTC",
    task: { tool: "send_message", input: { content: "ping" } },
    name: "heartbeat",
    protected: true,
  });

  assert.equal(job.store, "file");
  assert.equal(job.id, "cron_test_1");

  const reloaded = new CronStore({ filePath: storePath });
  assert.deepEqual(reloaded.list().map((entry) => entry.id), ["cron_test_1"]);
  assert.deepEqual(reloaded.get("cron_test_1")?.task, { tool: "send_message", input: { content: "ping" } });

  await writeFile(storePath, "{ definitely not json", "utf8");
  assert.throws(() => new CronStore({ filePath: storePath }), /Failed to load cron store/);
  assert.equal(await readFile(storePath, "utf8"), "{ definitely not json");
});

test("cron store rejects parseable invalid job JSON without rewriting it", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-cron-invalid-store-"));
  const storePath = join(workspace, "cron.json");
  const invalidPayload = JSON.stringify({
    version: 1,
    jobs: [
      {
        id: "cron_bad",
        kind: "every",
        every: "1m",
        timezone: "UTC",
        task: { tool: "send_message" },
        protected: false,
        status: "scheduled",
        store: "file",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        runCount: "not-a-number",
        failureCount: 0,
        history: "bad",
      },
    ],
  });

  await writeFile(storePath, invalidPayload, "utf8");

  assert.throws(() => new CronStore({ filePath: storePath }), /Failed to load cron store/);
  assert.equal(await readFile(storePath, "utf8"), invalidPayload);
});

test("cron service executes and removes one-shot at jobs when configured", async () => {
  let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const timers = new FakeTimers();
  const store = new CronStore({
    idGenerator: () => "cron_at",
    now: () => new Date(nowMs),
  });
  const seen: string[] = [];

  store.create({
    kind: "at",
    at: new Date(nowMs + 1_000).toISOString(),
    timezone: "UTC",
    task: { tool: "send_message" },
    protected: false,
    removeAfterRun: true,
  });

  const service = new CronService({
    store,
    timers,
    now: () => new Date(nowMs),
    execute: async (job, context) => {
      seen.push(`${job.id}:${context.triggeredAt}`);
    },
  });

  service.start();
  assert.equal(timers.scheduled.length, 1);
  assert.equal(timers.scheduled[0].delayMs, 1_000);

  nowMs += 1_000;
  await timers.runNext();

  assert.deepEqual(seen, ["cron_at:2026-01-01T00:00:01.000Z"]);
  assert.equal(store.get("cron_at"), undefined);
  service.dispose();
});

test("cron service reschedules every jobs and records bounded run history", async () => {
  let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const timers = new FakeTimers();
  const store = new CronStore({
    historyLimit: 1,
    idGenerator: () => "cron_every",
    now: () => new Date(nowMs),
  });
  let runs = 0;

  store.create({
    kind: "every",
    every: "2s",
    timezone: "UTC",
    task: { tool: "send_message" },
    protected: false,
  });

  const service = new CronService({
    store,
    timers,
    now: () => new Date(nowMs),
    execute: async () => {
      runs += 1;
      return { run: runs };
    },
  });

  service.start();
  assert.equal(timers.scheduled[0].delayMs, 2_000);

  nowMs += 2_000;
  await timers.runNext();

  let job = store.get("cron_every");
  assert.equal(runs, 1);
  assert.equal(job?.lastRunAt, "2026-01-01T00:00:02.000Z");
  assert.equal(job?.nextRunAt, "2026-01-01T00:00:04.000Z");
  assert.equal(job?.runCount, 1);
  assert.deepEqual(job?.history.map((entry) => entry.status), ["success"]);

  nowMs += 2_000;
  await timers.runNext();

  job = store.get("cron_every");
  assert.equal(runs, 2);
  assert.equal(job?.lastRunAt, "2026-01-01T00:00:04.000Z");
  assert.equal(job?.nextRunAt, "2026-01-01T00:00:06.000Z");
  assert.equal(job?.runCount, 2);
  assert.deepEqual(job?.history.map((entry) => entry.finishedAt), ["2026-01-01T00:00:04.000Z"]);
  service.dispose();
});

test("cron service leaves completed at jobs in place without rescheduling", async () => {
  const nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const timers = new FakeTimers();
  const store = new CronStore({
    idGenerator: () => "cron_at_keep",
    now: () => new Date(nowMs),
  });
  let runs = 0;

  store.create({
    kind: "at",
    at: new Date(nowMs).toISOString(),
    timezone: "UTC",
    task: { tool: "send_message" },
    protected: false,
  });

  const service = new CronService({
    store,
    timers,
    now: () => new Date(nowMs),
    execute: async () => {
      runs += 1;
    },
  });

  service.start();
  await timers.runNext();

  assert.equal(runs, 1);
  assert.equal(store.get("cron_at_keep")?.status, "completed");
  assert.equal(store.get("cron_at_keep")?.nextRunAt, undefined);
  assert.equal(timers.scheduled.length, 0);
  service.dispose();
});

test("cron service chunks long delays instead of executing before nextRunAt", async () => {
  let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const timers = new FakeTimers();
  const store = new CronStore({
    idGenerator: () => "cron_later",
    now: () => new Date(nowMs),
  });
  let runs = 0;

  store.create({
    kind: "at",
    at: new Date(nowMs + 60 * 24 * 60 * 60 * 1_000).toISOString(),
    timezone: "UTC",
    task: { tool: "send_message" },
    protected: false,
  });

  const service = new CronService({
    store,
    timers,
    now: () => new Date(nowMs),
    execute: async () => {
      runs += 1;
    },
  });

  service.start();
  assert.equal(timers.scheduled[0].delayMs, 2_147_483_647);

  nowMs += 2_147_483_647;
  await timers.runNext();
  assert.equal(runs, 0);
  assert.equal(timers.scheduled.length, 1);

  nowMs = Date.parse(store.get("cron_later")?.nextRunAt ?? "");
  await timers.runNext();
  assert.equal(runs, 1);
  service.dispose();
});

test("cron service gives cron expressions a dependency-free next minute run", () => {
  const nowMs = Date.parse("2026-01-01T00:00:30.000Z");
  const timers = new FakeTimers();
  const store = new CronStore({
    idGenerator: () => "cron_expr",
    now: () => new Date(nowMs),
  });

  store.create({
    kind: "cron",
    schedule: "* * * * *",
    timezone: "UTC",
    task: { tool: "send_message" },
    protected: false,
  });

  const service = new CronService({
    store,
    timers,
    now: () => new Date(nowMs),
    execute: async () => undefined,
  });

  service.start();
  assert.equal(timers.scheduled[0].delayMs, 30_000);
  assert.equal(store.get("cron_expr")?.nextRunAt, "2026-01-01T00:01:00.000Z");
  service.dispose();
});

test("running cron service schedules jobs created through cron tool after start", async () => {
  const nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const timers = new FakeTimers();
  const store = new CronStore({
    idGenerator: () => "cron_after_start",
    now: () => new Date(nowMs),
  });
  const tool = createCronTool({ store });
  const service = new CronService({
    store,
    timers,
    now: () => new Date(nowMs),
    execute: async () => undefined,
  });

  service.start();
  assert.equal(timers.scheduled.length, 0);

  const created = await tool.execute({ every: "1m", task: { tool: "send_message" } });

  assert.equal(created.error, undefined);
  assert.equal(timers.scheduled.length, 1);
  assert.equal(timers.scheduled[0].delayMs, 60_000);
  assert.equal(store.get("cron_after_start")?.nextRunAt, "2026-01-01T00:01:00.000Z");
  service.dispose();
});

test("running cron service clears zero-valued handles when rearming jobs", async () => {
  const nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const timers = new ZeroHandleTimers();
  const store = new CronStore({
    idGenerator: () => "cron_zero_rearm",
    now: () => new Date(nowMs),
  });

  store.create({
    kind: "every",
    every: "1m",
    timezone: "UTC",
    task: { tool: "send_message" },
    protected: false,
  });

  const service = new CronService({
    store,
    timers,
    now: () => new Date(nowMs),
    execute: async () => undefined,
  });

  service.start();
  store.create({
    kind: "every",
    every: "2m",
    timezone: "UTC",
    task: { tool: "send_message" },
    protected: false,
  });

  assert.deepEqual(timers.cleared, [0]);
  assert.equal(timers.delayMs, 120_000);
  service.dispose();
});

test("running cron service clears zero-valued handles when removing jobs", () => {
  const nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const timers = new ZeroHandleTimers();
  const store = new CronStore({
    idGenerator: () => "cron_zero_remove",
    now: () => new Date(nowMs),
  });

  store.create({
    kind: "every",
    every: "1m",
    timezone: "UTC",
    task: { tool: "send_message" },
    protected: false,
  });

  const service = new CronService({
    store,
    timers,
    now: () => new Date(nowMs),
    execute: async () => undefined,
  });

  service.start();
  store.remove("cron_zero_remove");

  assert.deepEqual(timers.cleared, [0]);
  service.dispose();
});

test("cron service evaluates cron expressions in the job timezone", () => {
  const nowMs = Date.parse("2026-01-01T15:30:00.000Z");
  const timers = new FakeTimers();
  const store = new CronStore({
    idGenerator: () => "cron_shanghai",
    now: () => new Date(nowMs),
  });

  store.create({
    kind: "cron",
    schedule: "0 9 * * *",
    timezone: "Asia/Shanghai",
    task: { tool: "send_message" },
    protected: false,
  });

  const service = new CronService({
    store,
    timers,
    now: () => new Date(nowMs),
    execute: async () => undefined,
  });

  service.start();
  assert.equal(store.get("cron_shanghai")?.nextRunAt, "2026-01-02T01:00:00.000Z");
  assert.equal(timers.scheduled[0].delayMs, 34_200_000);
  service.dispose();
});

test("cron service searches far enough to schedule sparse leap-day cron expressions", () => {
  const nowMs = Date.parse("2026-03-01T00:00:00.000Z");
  const timers = new FakeTimers();
  const store = new CronStore({
    idGenerator: () => "cron_leap_day",
    now: () => new Date(nowMs),
  });

  store.create({
    kind: "cron",
    schedule: "0 0 29 2 *",
    timezone: "UTC",
    task: { tool: "send_message" },
    protected: false,
  });

  const service = new CronService({
    store,
    timers,
    now: () => new Date(nowMs),
    execute: async () => undefined,
  });

  service.start();
  assert.equal(store.get("cron_leap_day")?.nextRunAt, "2028-02-29T00:00:00.000Z");
  assert.equal(timers.scheduled.length, 1);
  service.dispose();
});

test("cron service rejects impossible cron expressions without blocking startup", () => {
  const nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const timers = new FakeTimers();
  const store = new CronStore({
    idGenerator: () => "cron_impossible",
    now: () => new Date(nowMs),
  });

  store.create({
    kind: "cron",
    schedule: "0 0 31 2 *",
    timezone: "UTC",
    task: { tool: "send_message" },
    protected: false,
  });

  const service = new CronService({
    store,
    timers,
    now: () => new Date(nowMs),
    execute: async () => undefined,
  });

  service.start();
  assert.equal(timers.scheduled.length, 0);
  assert.equal(store.get("cron_impossible")?.nextRunAt, undefined);
  service.dispose();
});

test("cron store rejects persisted invalid cron and every schedules without rewriting them", async () => {
  const cases = [
    {
      name: "invalid-cron",
      job: {
        kind: "cron",
        schedule: "99 99 * * *",
      },
    },
    {
      name: "invalid-every",
      job: {
        kind: "every",
        every: "0m",
      },
    },
  ];

  for (const current of cases) {
    const workspace = await mkdtemp(join(tmpdir(), `nanobot-cron-${current.name}-`));
    const storePath = join(workspace, "cron.json");
    const invalidPayload = JSON.stringify({
      version: 1,
      jobs: [
        {
          id: `cron_${current.name}`,
          timezone: "UTC",
          task: { tool: "send_message" },
          protected: false,
          status: "scheduled",
          store: "file",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          runCount: 0,
          failureCount: 0,
          history: [],
          ...current.job,
        },
      ],
    });

    await writeFile(storePath, invalidPayload, "utf8");

    assert.throws(() => new CronStore({ filePath: storePath }), /Failed to load cron store/);
    assert.equal(await readFile(storePath, "utf8"), invalidPayload);
  }
});

test("cron store rejects invalid direct create inputs before persisting", async () => {
  const cases = [
    {
      name: "invalid-cron",
      input: {
        kind: "cron" as const,
        schedule: "99 99 * * *",
        timezone: "UTC",
      },
    },
    {
      name: "invalid-at",
      input: {
        kind: "at" as const,
        at: "not-a-date",
        timezone: "UTC",
      },
    },
    {
      name: "invalid-every",
      input: {
        kind: "every" as const,
        every: "0m",
        timezone: "UTC",
      },
    },
    {
      name: "unschedulable-every",
      input: {
        kind: "every" as const,
        every: "999999999999d",
        timezone: "UTC",
      },
    },
    {
      name: "invalid-timezone",
      input: {
        kind: "every" as const,
        every: "1m",
        timezone: "Not/AZone",
      },
    },
  ];

  for (const current of cases) {
    const workspace = await mkdtemp(join(tmpdir(), `nanobot-cron-create-${current.name}-`));
    const storePath = join(workspace, "cron.json");
    const now = new Date("2026-01-01T00:00:00.000Z");
    let id = 0;
    const store = new CronStore({
      filePath: storePath,
      idGenerator: () => `cron_create_${++id}`,
      now: () => now,
    });

    store.create({
      kind: "every",
      every: "1m",
      timezone: "UTC",
      task: { tool: "send_message" },
      protected: false,
    });
    const previousJson = await readFile(storePath, "utf8");

    assert.throws(
      () =>
        store.create({
          ...current.input,
          task: { tool: "send_message" },
          protected: false,
        }),
      /Invalid cron job/,
    );
    assert.equal(await readFile(storePath, "utf8"), previousJson);
    assert.deepEqual(new CronStore({ filePath: storePath }).list().map((job) => job.id), ["cron_create_1"]);
  }
});

test("cron store rejects invalid direct updates without changing persisted state", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-cron-update-invalid-"));
  const storePath = join(workspace, "cron.json");
  const now = new Date("2026-01-01T00:00:00.000Z");
  const store = new CronStore({
    filePath: storePath,
    idGenerator: () => "cron_update_preserve",
    now: () => now,
  });

  store.create({
    kind: "every",
    every: "1m",
    timezone: "UTC",
    task: { tool: "send_message" },
    protected: false,
  });
  const previousJson = await readFile(storePath, "utf8");

  assert.throws(
    () =>
      store.update("cron_update_preserve", (draft) => {
        draft.every = "0m";
      }),
    /Invalid cron job/,
  );

  assert.equal(await readFile(storePath, "utf8"), previousJson);
  assert.equal(store.get("cron_update_preserve")?.every, "1m");
  assert.deepEqual(new CronStore({ filePath: storePath }).get("cron_update_preserve")?.every, "1m");
});

test("cron callbacks expose execution context and cron tool blocks recursive creation", async () => {
  const nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const timers = new FakeTimers();
  const store = new CronStore({
    idGenerator: () => "cron_parent",
    now: () => new Date(nowMs),
  });
  const tool = createCronTool({ store });
  let recursiveCreateMessage = "";

  store.create({
    kind: "at",
    at: new Date(nowMs).toISOString(),
    timezone: "UTC",
    task: { tool: "send_message" },
    protected: false,
  });

  const service = new CronService({
    store,
    timers,
    now: () => new Date(nowMs),
    execute: async (job) => {
      assert.equal(getCronExecutionContext()?.jobId, job.id);
      const result = await tool.execute({ every: "1m", task: { tool: "send_message" } });
      assert.equal(result.error, true);
      recursiveCreateMessage = result.content;
    },
  });

  service.start();
  await timers.runNext();

  assert.match(recursiveCreateMessage, /Cannot create cron jobs while executing cron job 'cron_parent'/);
  assert.equal(store.list().length, 1);
  service.dispose();
});

test("cron tool reports file-backed store metadata for persistent stores", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-cron-tool-store-"));
  const store = new CronStore({ filePath: join(workspace, "cron.json") });
  const tool = createCronTool({ store });

  const created = await tool.execute({ every: "1m", task: { tool: "send_message" } });
  assert.equal(created.error, undefined);
  assert.equal(created.store, "file");

  const listed = await tool.execute({ action: "list" });
  assert.equal(listed.error, undefined);
  assert.equal(listed.store, "file");

  const removed = await tool.execute({ action: "remove", id: created.jobId });
  assert.equal(removed.error, undefined);
  assert.equal(removed.store, "file");
});

test("cron tool rejects unschedulable every durations without persisting them", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-cron-tool-invalid-every-"));
  const storePath = join(workspace, "cron.json");
  const store = new CronStore({ filePath: storePath });
  const tool = createCronTool({ store });

  const created = await tool.execute({
    every: "999999999999d",
    task: { tool: "send_message" },
  });

  assert.equal(created.error, true);
  assert.match(created.content, /Invalid every schedule/);
  assert.deepEqual(store.list(), []);
  assert.deepEqual(new CronStore({ filePath: storePath }).list(), []);
});

test("cron tool rejects malformed slash and range segments without poisoning file stores", async () => {
  const cases = ["1/2/3 * * * *", "1-2-3 * * * *"];

  for (const schedule of cases) {
    const workspace = await mkdtemp(join(tmpdir(), "nanobot-cron-tool-invalid-"));
    const storePath = join(workspace, "cron.json");
    const store = new CronStore({ filePath: storePath });
    const tool = createCronTool({ store });

    const created = await tool.execute({
      schedule,
      task: { tool: "send_message" },
    });

    assert.equal(created.error, true);
    assert.match(created.content, /Invalid cron schedule/);
    assert.deepEqual(store.list(), []);
    assert.deepEqual(new CronStore({ filePath: storePath }).list(), []);
  }
});
