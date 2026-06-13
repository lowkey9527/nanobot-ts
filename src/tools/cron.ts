import { randomUUID } from "node:crypto";

import { type JsonObject } from "../config/schema.js";

import { type ToolDefinition, toolError } from "./types.js";

export type CronJobKind = "cron" | "at" | "every";

export interface CronJob {
  id: string;
  kind: CronJobKind;
  schedule?: string;
  at?: string;
  every?: string;
  timezone: string;
  task: JsonObject;
  name?: string;
  protected: boolean;
  status: "scheduled";
  store: "memory";
  createdAt: string;
  updatedAt: string;
}

export class CronStore {
  private readonly jobs = new Map<string, CronJob>();

  create(input: Omit<CronJob, "id" | "status" | "store" | "createdAt" | "updatedAt">): CronJob {
    const now = new Date().toISOString();
    const job: CronJob = {
      ...input,
      id: `cron_${randomUUID()}`,
      status: "scheduled",
      store: "memory",
      createdAt: now,
      updatedAt: now,
    };

    this.jobs.set(job.id, job);
    return job;
  }

  list(): CronJob[] {
    return [...this.jobs.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  get(id: string): CronJob | undefined {
    return this.jobs.get(id);
  }

  remove(id: string, options: { force?: boolean } = {}): CronJob | undefined | "protected" {
    const job = this.jobs.get(id);
    if (!job) {
      return undefined;
    }

    if (job.protected && options.force !== true) {
      return "protected";
    }

    this.jobs.delete(id);
    return { ...job, status: "scheduled" };
  }
}

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
          store: "memory",
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
          store: "memory",
          jobId: removed.id,
          job: jobToJson(removed),
        };
      }

      if (action !== "create") {
        return toolError(`Unsupported cron action '${action}'`);
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

  if (!isValidEvery(every)) {
    return "Invalid every schedule; expected a duration like 30s, 15m, 2h, or 1d";
  }

  return { kind: "every", every };
}

function isValidCronSchedule(schedule: string): boolean {
  const fields = schedule.split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) {
    return false;
  }

  const ranges = fields.length === 5
    ? [
        [0, 59],
        [0, 23],
        [1, 31],
        [1, 12],
        [0, 7],
      ]
    : [
        [0, 59],
        [0, 59],
        [0, 23],
        [1, 31],
        [1, 12],
        [0, 7],
      ];

  return fields.every((field, index) => isValidCronField(field, ranges[index][0], ranges[index][1]));
}

function isValidCronField(field: string, min: number, max: number): boolean {
  return field.split(",").every((part) => isValidCronPart(part, min, max));
}

function isValidCronPart(part: string, min: number, max: number): boolean {
  const [base, step] = part.split("/");
  if (step !== undefined && !isInRange(step, 1, max)) {
    return false;
  }

  if (base === "*") {
    return true;
  }

  if (base.includes("-")) {
    const [start, end] = base.split("-");
    return isInRange(start, min, max) && isInRange(end, min, max) && Number(start) <= Number(end);
  }

  return isInRange(base, min, max);
}

function isInRange(value: string, min: number, max: number): boolean {
  if (!/^\d+$/.test(value)) {
    return false;
  }

  const numeric = Number(value);
  return numeric >= min && numeric <= max;
}

function isValidEvery(value: string): boolean {
  return /^[1-9]\d*[smhd]$/.test(value);
}

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
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
    status: job.status,
    store: job.store,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}
