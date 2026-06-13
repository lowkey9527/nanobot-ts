import { type JsonObject, type JsonValue } from "../config/schema.js";

export interface ChatMessage {
  role: string;
  content?: JsonValue;
  tool_calls?: JsonValue;
  name?: string;
  [key: string]: JsonValue | undefined;
}

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: JsonObject;
  extraContent?: JsonObject;
  providerSpecificFields?: JsonObject;
  functionProviderSpecificFields?: JsonObject;
}

export interface LLMResponse {
  content: string | null;
  toolCalls: ToolCallRequest[];
  finishReason: string;
  usage: Record<string, number>;
  retryAfter?: number;
  reasoningContent?: string;
  thinkingBlocks?: JsonObject[];
  errorStatusCode?: number;
  errorKind?: string;
  errorType?: string;
  errorCode?: string;
  errorRetryAfterS?: number;
  errorShouldRetry?: boolean;
}

export interface GenerationSettings {
  temperature: number;
  maxTokens: number;
  reasoningEffort?: string;
}

export interface ChatOptions {
  messages: ChatMessage[];
  tools?: JsonObject[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: string;
  toolChoice?: string | JsonObject;
  signal?: AbortSignal;
}

export interface LLMProvider {
  readonly defaultModel: string;
  readonly supportsProgressDeltas: boolean;
  generation: GenerationSettings;
  chat(options: ChatOptions): Promise<LLMResponse>;
  getDefaultModel(): string;
}

export function llmResponse(partial: Partial<LLMResponse> = {}): LLMResponse {
  return {
    content: partial.content ?? null,
    toolCalls: partial.toolCalls ?? [],
    finishReason: partial.finishReason ?? "stop",
    usage: partial.usage ?? {},
    retryAfter: partial.retryAfter,
    reasoningContent: partial.reasoningContent,
    thinkingBlocks: partial.thinkingBlocks,
    errorStatusCode: partial.errorStatusCode,
    errorKind: partial.errorKind,
    errorType: partial.errorType,
    errorCode: partial.errorCode,
    errorRetryAfterS: partial.errorRetryAfterS,
    errorShouldRetry: partial.errorShouldRetry,
  };
}
