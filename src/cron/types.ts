import { type JsonObject, type JsonValue } from "../config/schema.js";

export type CronJobKind = "cron" | "at" | "every";
export type CronJobStatus = "scheduled" | "running" | "completed" | "failed";
export type CronStoreKind = "memory" | "file";
export type CronRunStatus = "success" | "failure";

export interface CronRunHistoryEntry {
  startedAt: string;
  finishedAt: string;
  status: CronRunStatus;
  error?: string;
  result?: JsonValue;
}

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
  removeAfterRun?: boolean;
  status: CronJobStatus;
  store: CronStoreKind;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  nextRunAt?: string;
  runCount: number;
  failureCount: number;
  history: CronRunHistoryEntry[];
}

export interface CronJobCreateInput {
  kind: CronJobKind;
  schedule?: string;
  at?: string;
  every?: string;
  timezone: string;
  task: JsonObject;
  name?: string;
  protected: boolean;
  removeAfterRun?: boolean;
}

export interface CronExecutionContext {
  jobId: string;
  triggeredAt: string;
  task: JsonObject;
}

export type CronCallbackResult = JsonValue | void;

export type CronCallback = (
  job: CronJob,
  context: CronExecutionContext,
) => CronCallbackResult | Promise<CronCallbackResult>;

export type CronTimerHandle = object | number | string;

export interface CronTimerScheduler {
  setTimeout(callback: () => void | Promise<void>, delayMs: number): CronTimerHandle;
  clearTimeout(handle: CronTimerHandle): void;
}
