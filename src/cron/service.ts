import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { type JsonValue } from "../config/schema.js";

import {
  type CronCallback,
  type CronExecutionContext,
  type CronJob,
  type CronJobCreateInput,
  type CronRunHistoryEntry,
  type CronTimerHandle,
  type CronTimerScheduler,
} from "./types.js";

export type {
  CronCallback,
  CronCallbackResult,
  CronExecutionContext,
  CronJob,
  CronJobCreateInput,
  CronJobKind,
  CronJobStatus,
  CronRunHistoryEntry,
  CronRunStatus,
  CronStoreKind,
  CronTimerHandle,
  CronTimerScheduler,
} from "./types.js";

export interface CronStoreOptions {
  filePath?: string;
  historyLimit?: number;
  idGenerator?: () => string;
  now?: () => Date;
}

export interface CronServiceOptions {
  store: CronStore;
  execute: CronCallback;
  timers?: CronTimerScheduler;
  now?: () => Date;
}

type CronStoreEvent =
  | { type: "created"; jobId: string }
  | { type: "removed"; jobId: string };

interface SerializedCronStore {
  version: 1;
  jobs: CronJob[];
}

const DEFAULT_HISTORY_LIMIT = 10;
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_DATE_TIME_MS = 8_640_000_000_000_000;
const CRON_SEARCH_YEARS = 8;
const executionContext = new AsyncLocalStorage<CronExecutionContext>();
const timezoneFormatters = new Map<string, Intl.DateTimeFormat>();

export function getCronExecutionContext(): CronExecutionContext | undefined {
  return executionContext.getStore();
}

export class CronStore {
  private readonly jobs = new Map<string, CronJob>();
  private readonly listeners = new Set<(event: CronStoreEvent) => void>();
  private readonly filePath: string | undefined;
  private readonly historyLimit: number;
  private readonly idGenerator: () => string;
  private readonly now: () => Date;

  constructor(options: CronStoreOptions = {}) {
    this.filePath = options.filePath;
    this.historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    this.idGenerator = options.idGenerator ?? (() => `cron_${randomUUID()}`);
    this.now = options.now ?? (() => new Date());

    if (this.filePath && existsSync(this.filePath)) {
      this.loadFromFile(this.filePath);
    }
  }

  get kind(): "memory" | "file" {
    return this.filePath ? "file" : "memory";
  }

  create(input: CronJobCreateInput): CronJob {
    const createdAt = this.now();
    const now = createdAt.toISOString();
    const job: CronJob = {
      ...input,
      id: this.idGenerator(),
      status: "scheduled",
      store: this.filePath ? "file" : "memory",
      createdAt: now,
      updatedAt: now,
      runCount: 0,
      failureCount: 0,
      history: [],
    };

    assertValidCronJob(job, createdAt);
    this.jobs.set(job.id, cloneJob(job));
    this.persist();
    this.emit({ type: "created", jobId: job.id });
    return cloneJob(job);
  }

  list(): CronJob[] {
    return [...this.jobs.values()]
      .map(cloneJob)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  get(id: string): CronJob | undefined {
    const job = this.jobs.get(id);
    return job ? cloneJob(job) : undefined;
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
    this.persist();
    this.emit({ type: "removed", jobId: id });
    return cloneJob(job);
  }

  update(id: string, updater: (job: CronJob) => void): CronJob | undefined {
    const existing = this.jobs.get(id);
    if (!existing) {
      return undefined;
    }

    const next = cloneJob(existing);
    updater(next);
    const updatedAt = this.now();
    next.updatedAt = updatedAt.toISOString();
    next.history = next.history.slice(-this.historyLimit);
    assertValidCronJob(next, updatedAt);
    this.jobs.set(id, next);
    this.persist();
    return cloneJob(next);
  }

  private loadFromFile(filePath: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(filePath, "utf8"));
    } catch (error) {
      throw new Error(`Failed to load cron store '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!isSerializedCronStore(parsed, this.now())) {
      throw new Error(`Failed to load cron store '${filePath}': expected { version: 1, jobs: [] }`);
    }

    for (const job of parsed.jobs) {
      this.jobs.set(job.id, normalizeLoadedJob(job, this.kind, this.historyLimit));
    }
  }

  private persist(): void {
    if (!this.filePath) {
      return;
    }

    const payload: SerializedCronStore = {
      version: 1,
      jobs: this.list(),
    };
    const directory = dirname(this.filePath);
    mkdirSync(directory, { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    renameSync(tempPath, this.filePath);
  }

  subscribe(listener: (event: CronStoreEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: CronStoreEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

export class CronService {
  private readonly store: CronStore;
  private readonly executeCallback: CronCallback;
  private readonly timers: CronTimerScheduler;
  private readonly now: () => Date;
  private readonly unsubscribeStore: () => void;
  private readonly handles = new Map<string, CronTimerHandle>();
  private running = false;
  private disposed = false;

  constructor(options: CronServiceOptions) {
    this.store = options.store;
    this.executeCallback = options.execute;
    this.timers = options.timers ?? nodeTimers;
    this.now = options.now ?? (() => new Date());
    this.unsubscribeStore = this.store.subscribe((event) => {
      if (event.type === "created") {
        this.scheduleJob(event.jobId);
        return;
      }

      this.clearTimer(event.jobId);
    });
  }

  start(): void {
    if (this.running || this.disposed) {
      return;
    }

    this.running = true;
    for (const job of this.store.list()) {
      this.scheduleJob(job.id);
    }
  }

  stop(): void {
    this.running = false;
    for (const handle of this.handles.values()) {
      this.timers.clearTimeout(handle);
    }
    this.handles.clear();
  }

  dispose(): void {
    this.stop();
    this.disposed = true;
    this.unsubscribeStore();
  }

  private scheduleJob(jobId: string): void {
    if (!this.running || this.disposed) {
      return;
    }

    const job = this.store.get(jobId);
    if (!job) {
      return;
    }

    const nextRun = computeNextRun(job, this.now());
    if (!nextRun) {
      this.store.update(job.id, (draft) => {
        draft.status = draft.status === "running" ? "completed" : draft.status;
        draft.nextRunAt = undefined;
      });
      return;
    }

    this.store.update(job.id, (draft) => {
      draft.status = "scheduled";
      draft.nextRunAt = nextRun.toISOString();
    });

    this.armTimer(job.id, nextRun);
  }

  private async runJob(jobId: string): Promise<void> {
    this.handles.delete(jobId);
    const job = this.store.get(jobId);
    if (!job || this.disposed) {
      return;
    }

    const currentTime = this.now();
    if (job.nextRunAt) {
      const nextRunAt = new Date(job.nextRunAt);
      if (!Number.isNaN(nextRunAt.getTime()) && nextRunAt.getTime() > currentTime.getTime()) {
        this.armTimer(job.id, nextRunAt);
        return;
      }
    }

    const triggeredAt = currentTime.toISOString();
    const context: CronExecutionContext = {
      jobId: job.id,
      triggeredAt,
      task: job.task,
    };

    this.store.update(job.id, (draft) => {
      draft.status = "running";
      draft.lastRunAt = triggeredAt;
    });

    let runEntry: CronRunHistoryEntry;
    try {
      const result = await executionContext.run(context, () => this.executeCallback(job, context));
      const finishedAt = this.now().toISOString();
      runEntry = {
        startedAt: triggeredAt,
        finishedAt,
        status: "success",
        result: result === undefined ? undefined : toJsonValue(result),
      };
      this.store.update(job.id, (draft) => {
        draft.status = job.kind === "at" ? "completed" : "scheduled";
        draft.runCount += 1;
        draft.history.push(runEntry);
      });
    } catch (error) {
      const finishedAt = this.now().toISOString();
      runEntry = {
        startedAt: triggeredAt,
        finishedAt,
        status: "failure",
        error: error instanceof Error ? error.message : String(error),
      };
      this.store.update(job.id, (draft) => {
        draft.status = "failed";
        draft.runCount += 1;
        draft.failureCount += 1;
        draft.history.push(runEntry);
      });
    }

    const latest = this.store.get(job.id);
    if (!latest || !this.running || this.disposed) {
      return;
    }

    if (latest.kind === "at" && latest.removeAfterRun) {
      this.store.remove(latest.id, { force: true });
      return;
    }

    this.scheduleJob(latest.id);
  }

  private armTimer(jobId: string, nextRun: Date): void {
    this.clearTimer(jobId);

    const delayMs = Math.min(Math.max(0, nextRun.getTime() - this.now().getTime()), MAX_TIMEOUT_MS);
    const handle = this.timers.setTimeout(() => this.runJob(jobId), delayMs);
    this.handles.set(jobId, handle);
  }

  private clearTimer(jobId: string): void {
    if (!this.handles.has(jobId)) {
      return;
    }

    const handle = this.handles.get(jobId);
    this.handles.delete(jobId);
    if (handle !== undefined) {
      this.timers.clearTimeout(handle);
    }
  }
}

const nodeTimers: CronTimerScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function computeNextRun(job: CronJob, from: Date): Date | undefined {
  if (job.kind === "at") {
    if (job.lastRunAt) {
      return undefined;
    }
    if (!job.at) {
      return undefined;
    }
    const at = new Date(job.at);
    return Number.isNaN(at.getTime()) ? undefined : new Date(Math.max(at.getTime(), from.getTime()));
  }

  if (job.kind === "every") {
    const durationMs = job.every ? parseDurationMs(job.every) : undefined;
    if (durationMs === undefined) {
      return undefined;
    }

    const nextRunMs = from.getTime() + durationMs;
    return isValidDateTimeMs(nextRunMs) ? new Date(nextRunMs) : undefined;
  }

  return job.schedule ? nextCronRun(job.schedule, from, job.timezone) : undefined;
}

function parseDurationMs(value: string): number | undefined {
  const match = /^([1-9]\d*)([smhd])$/.exec(value);
  if (!match) {
    return undefined;
  }

  const amount = Number(match[1]);
  const unit = match[2];
  if (!Number.isSafeInteger(amount)) {
    return undefined;
  }

  let durationMs: number;
  if (unit === "s") {
    durationMs = amount * 1_000;
  } else if (unit === "m") {
    durationMs = amount * 60_000;
  } else if (unit === "h") {
    durationMs = amount * 3_600_000;
  } else {
    durationMs = amount * 86_400_000;
  }

  return Number.isSafeInteger(durationMs) ? durationMs : undefined;
}

interface ParsedCronSchedule {
  withSeconds: boolean;
  seconds: number[];
  minute: (value: number) => boolean;
  hour: (value: number) => boolean;
  day: (value: number) => boolean;
  month: (value: number) => boolean;
  weekday: (value: number) => boolean;
  dayField: string;
  monthField: string;
}

interface ZonedDateParts {
  second: number;
  minute: number;
  hour: number;
  day: number;
  month: number;
  weekday: number;
}

function nextCronRun(schedule: string, from: Date, timezone: string): Date | undefined {
  const parsed = parseCronSchedule(schedule);
  if (!parsed || !isValidTimezone(timezone)) {
    return undefined;
  }

  if (!hasPossibleDayMonth(parsed.dayField, parsed.monthField)) {
    return undefined;
  }

  const cursor = new Date(from.getTime() + (parsed.withSeconds ? 1_000 : 60_000));
  cursor.setUTCMilliseconds(0);
  if (!parsed.withSeconds) {
    cursor.setUTCSeconds(0);
  }

  const maxChecks = CRON_SEARCH_YEARS * 366 * 24 * 60;
  for (let checked = 0; checked < maxChecks; checked += 1) {
    const parts = getZonedDateParts(cursor, timezone);
    if (!parts) {
      return undefined;
    }

    if (
      parsed.minute(parts.minute) &&
      parsed.hour(parts.hour) &&
      parsed.day(parts.day) &&
      parsed.month(parts.month) &&
      parsed.weekday(parts.weekday)
    ) {
      if (!parsed.withSeconds) {
        return cursor;
      }

      const currentMinute = checked === 0;
      const earliestSecond = currentMinute ? cursor.getUTCSeconds() : 0;
      const second = parsed.seconds.find((value) => value >= earliestSecond);
      if (second !== undefined) {
        const candidate = new Date(cursor);
        candidate.setUTCSeconds(second, 0);
        return candidate;
      }
    }

    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1, 0, 0);
  }

  return undefined;
}

function parseCronSchedule(schedule: string): ParsedCronSchedule | undefined {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) {
    return undefined;
  }

  const withSeconds = fields.length === 6;
  const [secondField, minuteField, hourField, dayField, monthField, weekdayField] = withSeconds
    ? fields
    : ["0", ...fields];
  const seconds = expandCronValues(secondField, 0, 59);
  const matchers = {
    minute: buildCronMatcher(minuteField, 0, 59),
    hour: buildCronMatcher(hourField, 0, 23),
    day: buildCronMatcher(dayField, 1, 31),
    month: buildCronMatcher(monthField, 1, 12),
    weekday: buildWeekdayCronMatcher(weekdayField),
  };

  if (
    !seconds ||
    !matchers.minute ||
    !matchers.hour ||
    !matchers.day ||
    !matchers.month ||
    !matchers.weekday
  ) {
    return undefined;
  }

  return {
    withSeconds,
    seconds: seconds.sort((left, right) => left - right),
    minute: matchers.minute,
    hour: matchers.hour,
    day: matchers.day,
    month: matchers.month,
    weekday: matchers.weekday,
    dayField,
    monthField,
  };
}

export function isValidCronSchedule(schedule: string): boolean {
  return parseCronSchedule(schedule) !== undefined;
}

export function isValidCronEverySchedule(value: string, from: Date = new Date()): boolean {
  const durationMs = parseDurationMs(value);
  if (durationMs === undefined || !isValidDateTimeMs(from.getTime())) {
    return false;
  }

  return isValidDateTimeMs(from.getTime() + durationMs);
}

function isValidDateTimeMs(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= MAX_DATE_TIME_MS;
}

function hasPossibleDayMonth(dayField: string, monthField: string): boolean {
  const days = expandCronValues(dayField, 1, 31);
  const months = expandCronValues(monthField, 1, 12);
  if (!days || !months) {
    return false;
  }

  return months.some((month) => days.some((day) => day <= daysInMonth(2024, month)));
}

function expandCronValues(field: string, min: number, max: number): number[] | undefined {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const pieces = part.split("/");
    if (pieces.length > 2) {
      return undefined;
    }

    const [base, stepValue] = pieces;
    if (!base) {
      return undefined;
    }

    const step = stepValue === undefined ? 1 : Number(stepValue);
    if (!Number.isInteger(step) || step < 1) {
      return undefined;
    }

    let start: number;
    let end: number;
    if (base === "*") {
      start = min;
      end = max;
    } else if (base.includes("-")) {
      const rangePieces = base.split("-");
      if (rangePieces.length !== 2) {
        return undefined;
      }

      const [startValue, endValue] = rangePieces;
      start = Number(startValue);
      end = Number(endValue);
    } else {
      start = Number(base);
      end = start;
    }

    if (!isCronNumber(start, min, max) || !isCronNumber(end, min, max) || start > end) {
      return undefined;
    }

    for (let value = start; value <= end; value += step) {
      values.add(value);
    }
  }

  return [...values.values()];
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function buildCronMatcher(field: string, min: number, max: number): ((value: number) => boolean) | undefined {
  const values = expandCronValues(field, min, max);
  if (!values) {
    return undefined;
  }
  const valueSet = new Set(values);
  return (value) => valueSet.has(value);
}

function buildWeekdayCronMatcher(field: string): ((value: number) => boolean) | undefined {
  const values = expandCronValues(field, 0, 7);
  if (!values) {
    return undefined;
  }

  const valueSet = new Set(values.map((value) => (value === 7 ? 0 : value)));
  return (value) => valueSet.has(value);
}

function isCronNumber(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

function toJsonValue(value: JsonValue): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function cloneJob(job: CronJob): CronJob {
  return structuredClone(job);
}

function normalizeLoadedJob(job: CronJob, store: "memory" | "file", historyLimit: number): CronJob {
  return {
    ...cloneJob(job),
    store,
    runCount: job.runCount ?? 0,
    failureCount: job.failureCount ?? 0,
    history: (job.history ?? []).slice(-historyLimit),
  };
}

export function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function getZonedDateParts(date: Date, timezone: string): ZonedDateParts | undefined {
  if (timezone === "UTC" || timezone === "Etc/UTC") {
    return {
      second: date.getUTCSeconds(),
      minute: date.getUTCMinutes(),
      hour: date.getUTCHours(),
      day: date.getUTCDate(),
      month: date.getUTCMonth() + 1,
      weekday: date.getUTCDay(),
    };
  }

  let formatter = timezoneFormatters.get(timezone);
  try {
    if (!formatter) {
      formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        hourCycle: "h23",
        weekday: "short",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
      });
      timezoneFormatters.set(timezone, formatter);
    }
  } catch {
    return undefined;
  }

  const parts = formatter.formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const weekday = parseWeekday(values.get("weekday"));
  const second = Number(values.get("second"));
  const minute = Number(values.get("minute"));
  const hour = Number(values.get("hour"));
  const day = Number(values.get("day"));
  const month = Number(values.get("month"));
  if (
    weekday === undefined ||
    !isCronNumber(second, 0, 59) ||
    !isCronNumber(minute, 0, 59) ||
    !isCronNumber(hour, 0, 23) ||
    !isCronNumber(day, 1, 31) ||
    !isCronNumber(month, 1, 12)
  ) {
    return undefined;
  }

  return { second, minute, hour, day, month, weekday };
}

function parseWeekday(value: string | undefined): number | undefined {
  switch (value) {
    case "Sun":
      return 0;
    case "Mon":
      return 1;
    case "Tue":
      return 2;
    case "Wed":
      return 3;
    case "Thu":
      return 4;
    case "Fri":
      return 5;
    case "Sat":
      return 6;
    default:
      return undefined;
  }
}

function isSerializedCronStore(value: unknown, from: Date): value is SerializedCronStore {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return record.version === 1 && Array.isArray(record.jobs) && record.jobs.every((job) => isCronJob(job, from));
}

function assertValidCronJob(job: CronJob, from: Date): void {
  const value: unknown = job;
  if (!isCronJob(value, from)) {
    throw new Error(`Invalid cron job '${job.id}': expected a valid cron job`);
  }
}

function isCronJob(value: unknown, from: Date): value is CronJob {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  const statusValues = new Set(["scheduled", "running", "completed", "failed"]);
  return (
    typeof record.id === "string" &&
    (record.kind === "cron" || record.kind === "at" || record.kind === "every") &&
    isValidLoadedSchedule(record, from) &&
    typeof record.timezone === "string" &&
    isValidTimezone(record.timezone) &&
    isJsonObject(record.task) &&
    typeof record.protected === "boolean" &&
    (record.removeAfterRun === undefined || typeof record.removeAfterRun === "boolean") &&
    typeof record.status === "string" &&
    statusValues.has(record.status) &&
    (record.store === "memory" || record.store === "file") &&
    typeof record.createdAt === "string" &&
    !Number.isNaN(Date.parse(record.createdAt)) &&
    typeof record.updatedAt === "string" &&
    !Number.isNaN(Date.parse(record.updatedAt)) &&
    (record.lastRunAt === undefined || (typeof record.lastRunAt === "string" && !Number.isNaN(Date.parse(record.lastRunAt)))) &&
    (record.nextRunAt === undefined || (typeof record.nextRunAt === "string" && !Number.isNaN(Date.parse(record.nextRunAt)))) &&
    typeof record.runCount === "number" &&
    Number.isInteger(record.runCount) &&
    record.runCount >= 0 &&
    typeof record.failureCount === "number" &&
    Number.isInteger(record.failureCount) &&
    record.failureCount >= 0 &&
    Array.isArray(record.history) &&
    record.history.every(isCronRunHistoryEntry)
  );
}

function isValidLoadedSchedule(record: Record<string, unknown>, from: Date): boolean {
  if (record.kind === "cron") {
    return (
      typeof record.schedule === "string" &&
      parseCronSchedule(record.schedule) !== undefined &&
      record.at === undefined &&
      record.every === undefined
    );
  }
  if (record.kind === "at") {
    return typeof record.at === "string" && !Number.isNaN(Date.parse(record.at)) && record.schedule === undefined && record.every === undefined;
  }
  return typeof record.every === "string" && isValidCronEverySchedule(record.every, from) && record.schedule === undefined && record.at === undefined;
}

function isCronRunHistoryEntry(value: unknown): value is CronRunHistoryEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.startedAt === "string" &&
    !Number.isNaN(Date.parse(record.startedAt)) &&
    typeof record.finishedAt === "string" &&
    !Number.isNaN(Date.parse(record.finishedAt)) &&
    (record.status === "success" || record.status === "failure") &&
    (record.error === undefined || typeof record.error === "string") &&
    (record.result === undefined || isJsonValue(record.result))
  );
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).every(isJsonValue);
  }
  return false;
}

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every(isJsonValue);
}
