import { type JsonObject } from "../config/schema.js";
import {
  CronStore,
  getCronExecutionContext,
  isValidCronEverySchedule,
  isValidCronSchedule,
  isValidTimezone,
  type CronJob,
  type CronJobKind,
} from "../cron/service.js";

import { type ToolDefinition, toolError } from "./types.js";

export { CronStore };
export type { CronJob, CronJobKind };

export interface CronToolOptions {
  store?: CronStore;
}

export function createCronTool(options: CronToolOptions = {}): ToolDefinition {
  const store = options.store ?? new CronStore();

  return {
    name: "cron",
    description: "Manage scheduled jobs",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string" },
        id: { type: "string" },
        schedule: { type: "string" },
        at: { type: "string" },
        every: { type: "string" },
        timezone: { type: "string" },
        task: { type: "object" },
        name: { type: "string" },
        protected: { type: "boolean" },
        removeAfterRun: { type: "boolean" },
        force: { type: "boolean" },
      },
    },
    policy: { durableRegistration: "memory" },
    execute: (input) => {
      const action = typeof input.action === "string" && input.action.trim() ? input.action.trim() : "create";

      if (action === "list") {
        const jobs = store.list().map(jobToJson);
        return {
          content: JSON.stringify({ jobs }),
          action,
          status: "listed",
          store: store.kind,
          count: jobs.length,
          jobs,
        };
      }

      if (action === "remove") {
        const id = typeof input.id === "string" ? input.id.trim() : "";
        if (!id) {
          return toolError("Cron remove requires a non-empty id");
        }

        const removed = store.remove(id, { force: input.force === true });
        if (removed === undefined) {
          return toolError(`Cron job '${id}' was not found`);
        }

        if (removed === "protected") {
          return toolError(`Cron job '${id}' is protected; pass force=true to remove it`);
        }

        return {
          content: JSON.stringify(jobToJson(removed)),
          action,
          status: "removed",
          store: store.kind,
          jobId: removed.id,
          job: jobToJson(removed),
        };
      }

      if (action !== "create") {
        return toolError(`Unsupported cron action '${action}'`);
      }

      const cronContext = getCronExecutionContext();
      if (cronContext) {
        return toolError(`Cannot create cron jobs while executing cron job '${cronContext.jobId}'`);
      }

      const scheduleInput = typeof input.schedule === "string" ? input.schedule.trim() : "";
      const atInput = typeof input.at === "string" ? input.at.trim() : "";
      const everyInput = typeof input.every === "string" ? input.every.trim() : "";
      const scheduleFields = [scheduleInput, atInput, everyInput].filter(Boolean);
      if (scheduleFields.length !== 1) {
        return toolError("Cron create requires exactly one of schedule, at, or every");
      }

      const timezone = typeof input.timezone === "string" && input.timezone.trim() ? input.timezone.trim() : "UTC";
      if (!isValidTimezone(timezone)) {
        return toolError(`Invalid timezone '${timezone}'`);
      }

      const task = toJsonObject(input.task);
      if (!task) {
        return toolError("Cron task must be a JSON object");
      }

      const schedule = normalizeSchedule(scheduleInput, atInput, everyInput);
      if (typeof schedule === "string") {
        return toolError(schedule);
      }

      const job = store.create({
        ...schedule,
        timezone,
        task,
        name: typeof input.name === "string" ? input.name : undefined,
        protected: input.protected === true,
        removeAfterRun: input.removeAfterRun === true,
      });

      return {
        content: JSON.stringify(jobToJson(job)),
        action,
        jobId: job.id,
        kind: job.kind,
        schedule: job.schedule,
        at: job.at,
        every: job.every,
        timezone: job.timezone,
        status: job.status,
        store: job.store,
        protected: job.protected,
        removeAfterRun: job.removeAfterRun === true,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      };
    },
  };
}

function normalizeSchedule(schedule: string, at: string, every: string): Pick<CronJob, "kind" | "schedule" | "at" | "every"> | string {
  if (schedule) {
    if (!isValidCronSchedule(schedule)) {
      return "Invalid cron schedule; expected a 5-field or 6-field cron expression";
    }

    return { kind: "cron", schedule };
  }

  if (at) {
    const date = new Date(at);
    if (Number.isNaN(date.getTime())) {
      return "Invalid at schedule; expected an ISO date string";
    }

    return { kind: "at", at: date.toISOString() };
  }

  if (!isValidCronEverySchedule(every)) {
    return "Invalid every schedule; expected a duration like 30s, 15m, 2h, or 1d";
  }

  return { kind: "every", every };
}

function toJsonObject(value: unknown): JsonObject | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  try {
    return JSON.parse(JSON.stringify(value)) as JsonObject;
  } catch {
    return undefined;
  }
}

function jobToJson(job: CronJob): JsonObject {
  return {
    id: job.id,
    kind: job.kind,
    schedule: job.schedule ?? null,
    at: job.at ?? null,
    every: job.every ?? null,
    timezone: job.timezone,
    task: job.task,
    name: job.name ?? null,
    protected: job.protected,
    removeAfterRun: job.removeAfterRun === true,
    status: job.status,
    store: job.store,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    lastRunAt: job.lastRunAt ?? null,
    nextRunAt: job.nextRunAt ?? null,
    runCount: job.runCount,
    failureCount: job.failureCount,
    history: JSON.parse(JSON.stringify(job.history)),
  };
}
