import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const TRANSCRIPTIONS_PATH = "audio/transcriptions";
const MAX_RETRIES = 3;
const BACKOFF_MS = [1_000, 2_000, 4_000] as const;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export interface TranscriptionProviderOptions {
  apiKey?: string;
  apiBase?: string;
  language?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export function resolveTranscriptionUrl(apiBase: string | undefined, defaultUrl: string): string {
  if (!apiBase) {
    return defaultUrl;
  }
  const base = apiBase.replace(/\/+$/, "");
  if (base.endsWith(TRANSCRIPTIONS_PATH)) {
    return base;
  }
  return `${base}/${TRANSCRIPTIONS_PATH}`;
}

export class OpenAITranscriptionProvider {
  readonly apiKey?: string;
  readonly apiUrl: string;
  readonly language?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: TranscriptionProviderOptions = {}) {
    this.apiKey = options.apiKey === undefined ? process.env.OPENAI_API_KEY : options.apiKey;
    this.apiUrl = resolveTranscriptionUrl(
      options.apiBase ?? process.env.OPENAI_TRANSCRIPTION_BASE_URL,
      "https://api.openai.com/v1/audio/transcriptions",
    );
    this.language = options.language || undefined;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async transcribe(filePath: string): Promise<string> {
    if (!this.apiKey) {
      return "";
    }
    return postTranscriptionWithRetry({
      url: this.apiUrl,
      apiKey: this.apiKey,
      filePath,
      model: "whisper-1",
      language: this.language,
      fetchImpl: this.fetchImpl,
      sleep: this.sleep,
    });
  }
}

export class GroqTranscriptionProvider {
  readonly apiKey?: string;
  readonly apiUrl: string;
  readonly language?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: TranscriptionProviderOptions = {}) {
    this.apiKey = options.apiKey === undefined ? process.env.GROQ_API_KEY : options.apiKey;
    this.apiUrl = resolveTranscriptionUrl(
      options.apiBase ?? process.env.GROQ_BASE_URL,
      "https://api.groq.com/openai/v1/audio/transcriptions",
    );
    this.language = options.language || undefined;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async transcribe(filePath: string): Promise<string> {
    if (!this.apiKey) {
      return "";
    }
    return postTranscriptionWithRetry({
      url: this.apiUrl,
      apiKey: this.apiKey,
      filePath,
      model: "whisper-large-v3",
      language: this.language,
      fetchImpl: this.fetchImpl,
      sleep: this.sleep,
    });
  }
}

interface PostTranscriptionOptions {
  url: string;
  apiKey: string;
  filePath: string;
  model: string;
  language?: string;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
}

async function postTranscriptionWithRetry(options: PostTranscriptionOptions): Promise<string> {
  let data: Buffer;
  try {
    data = await readFile(options.filePath);
  } catch {
    return "";
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await options.fetchImpl(options.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
        },
        body: buildFormData(options.filePath, data, options.model, options.language),
      });
      if (RETRYABLE_STATUS.has(response.status) && attempt < MAX_RETRIES) {
        await options.sleep(BACKOFF_MS[attempt] ?? BACKOFF_MS[BACKOFF_MS.length - 1]);
        continue;
      }
      if (!response.ok) {
        return "";
      }
      const payload = await response.json() as unknown;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return "";
      }
      const text = (payload as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    } catch (error) {
      if (isRetryableFetchError(error) && attempt < MAX_RETRIES) {
        await options.sleep(BACKOFF_MS[attempt] ?? BACKOFF_MS[BACKOFF_MS.length - 1]);
        continue;
      }
      return "";
    }
  }
  return "";
}

function buildFormData(
  filePath: string,
  data: Buffer,
  model: string,
  language: string | undefined,
): FormData {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(data)]), basename(filePath));
  form.append("model", model);
  if (language) {
    form.append("language", language);
  }
  return form;
}

function isRetryableFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /timeout|timed out|connect|network|socket|econn|etimedout|fetch failed/i.test(error.message)
    || error.name === "TimeoutError"
    || error.name === "AbortError";
}
