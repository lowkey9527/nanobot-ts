import { type JsonObject, type JsonValue, type ProviderApiType } from "../config/schema.js";
import { type ChatMessage, type ChatOptions, type GenerationSettings, type LLMProvider, type LLMResponse, type ToolCallRequest, llmResponse } from "./base.js";
import { type ProviderSpec } from "./registry.js";

export interface OpenAICompatibleProviderOptions {
  apiKey?: string;
  apiBase?: string;
  defaultModel: string;
  spec?: ProviderSpec;
  extraHeaders?: Record<string, string>;
  extraBody?: JsonObject;
  apiType?: ProviderApiType;
  fetchImpl?: typeof fetch;
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly supportsProgressDeltas = false;
  readonly apiKey?: string;
  readonly apiBase?: string;
  readonly defaultModel: string;
  readonly extraHeaders?: Record<string, string>;
  readonly extraBody?: JsonObject;
  readonly apiType: ProviderApiType;
  readonly spec?: ProviderSpec;
  generation: GenerationSettings = { temperature: 0.7, maxTokens: 4096 };
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAICompatibleProviderOptions) {
    this.apiKey = options.apiKey;
    this.spec = options.spec;
    this.apiBase = trimTrailingSlash(options.apiBase || options.spec?.defaultApiBase || undefined);
    this.defaultModel = options.defaultModel;
    this.extraHeaders = options.extraHeaders;
    this.extraBody = options.extraBody;
    this.apiType = options.apiType ?? "auto";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  getDefaultModel(): string {
    return this.defaultModel;
  }

  buildChatCompletionsBody(
    messages: ChatMessage[],
    tools: JsonObject[] | undefined,
    model: string | undefined,
    maxTokens: number,
    temperature: number,
    reasoningEffort: string | undefined,
    toolChoice: string | JsonObject | undefined,
  ): JsonObject {
    const requestModel = this.prepareModel(model ?? this.defaultModel);
    const body: JsonObject = {
      ...structuredClone(this.extraBody ?? {}),
      model: requestModel,
      messages: structuredClone(messages) as JsonValue,
      temperature,
    };
    const tokenKey = this.spec?.supportsMaxCompletionTokens ? "max_completion_tokens" : "max_tokens";
    body[tokenKey] = Math.max(1, maxTokens);
    if (tools && tools.length > 0) {
      body.tools = structuredClone(tools) as JsonValue;
      body.tool_choice = toolChoice ?? "auto";
    } else if (toolChoice !== undefined) {
      body.tool_choice = structuredClone(toolChoice) as JsonValue;
    }
    if (
      reasoningEffort
      && reasoningEffort !== "none"
      && this.spec?.gatewayReasoningStyle === "reasoning_effort"
    ) {
      body.reasoning = { effort: reasoningEffort };
    }
    return body;
  }

  async chat(options: ChatOptions): Promise<LLMResponse> {
    if (!this.apiBase) {
      return providerError("OpenAI-compatible provider requires apiBase.");
    }
    const response = await this.fetchImpl(`${this.apiBase}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        ...(this.extraHeaders ?? {}),
      },
      body: JSON.stringify(this.buildChatCompletionsBody(
        options.messages,
        options.tools,
        options.model,
        options.maxTokens ?? this.generation.maxTokens,
        options.temperature ?? this.generation.temperature,
        options.reasoningEffort ?? this.generation.reasoningEffort,
        options.toolChoice,
      )),
    });
    if (!response.ok) {
      return providerError(`HTTP ${response.status}: provider request failed`, response.status);
    }
    const payload = await response.json() as ChatCompletionsPayload;
    return parseChatCompletionsPayload(payload, this.spec);
  }

  private prepareModel(model: string): string {
    if (this.spec?.stripModelPrefix && model.includes("/")) {
      return model.split("/").slice(1).join("/");
    }
    return model;
  }
}

export interface AzureOpenAIProviderOptions {
  apiKey?: string;
  apiBase: string;
  defaultModel?: string;
  fetchImpl?: typeof fetch;
}

export class AzureOpenAIProvider implements LLMProvider {
  readonly supportsProgressDeltas = false;
  readonly apiKey?: string;
  readonly apiBase: string;
  readonly defaultModel: string;
  readonly responsesUrl: string;
  generation: GenerationSettings = { temperature: 0.7, maxTokens: 4096 };
  private readonly fetchImpl: typeof fetch;

  constructor(options: AzureOpenAIProviderOptions) {
    if (!options.apiBase) {
      throw new ValueError("Azure OpenAI apiBase is required.");
    }
    this.apiKey = options.apiKey;
    this.apiBase = trimTrailingSlash(options.apiBase) ?? "";
    this.defaultModel = options.defaultModel ?? "gpt-4o";
    this.responsesUrl = `${this.apiBase}/openai/v1/responses`;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  getDefaultModel(): string {
    return this.defaultModel;
  }

  buildResponsesBody(
    messages: ChatMessage[],
    tools: JsonObject[] | undefined,
    model: string | undefined,
    maxTokens: number,
    temperature: number,
    reasoningEffort: string | undefined,
    toolChoice: string | JsonObject | undefined,
  ): JsonObject {
    const instructions = messages
      .filter((message) => message.role === "system")
      .map((message) => contentToInstruction(message.content))
      .filter(Boolean)
      .join("\n\n");
    const input = messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role,
        content: toResponsesContent(message.content),
      }));
    const body: JsonObject = {
      model: model ?? this.defaultModel,
      input: input as JsonValue,
      max_output_tokens: Math.max(1, maxTokens),
      store: false,
    };
    if (instructions) {
      body.instructions = instructions;
    }
    if (supportsTemperature(model ?? this.defaultModel, reasoningEffort)) {
      body.temperature = temperature;
    }
    if (reasoningEffort && reasoningEffort !== "none") {
      body.reasoning = { effort: reasoningEffort };
      body.include = ["reasoning.encrypted_content"];
    }
    if (tools && tools.length > 0) {
      body.tools = tools.map(toResponsesTool) as JsonValue;
      body.tool_choice = toolChoice ?? "auto";
    } else if (toolChoice !== undefined) {
      body.tool_choice = structuredClone(toolChoice) as JsonValue;
    }
    return body;
  }

  async chat(options: ChatOptions): Promise<LLMResponse> {
    const response = await this.fetchImpl(this.responsesUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { "api-key": this.apiKey, authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify(this.buildResponsesBody(
        options.messages,
        options.tools,
        options.model,
        options.maxTokens ?? this.generation.maxTokens,
        options.temperature ?? this.generation.temperature,
        options.reasoningEffort ?? this.generation.reasoningEffort,
        options.toolChoice,
      )),
    });
    if (!response.ok) {
      return providerError(`HTTP ${response.status}: Azure OpenAI request failed`, response.status);
    }
    const payload = await response.json() as {
      output?: { type?: string; content?: { type?: string; text?: string }[] }[];
      usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
      status?: string;
    };
    const content = payload.output
      ?.flatMap((item) => item.content ?? [])
      .filter((item) => item.type === "output_text")
      .map((item) => item.text ?? "")
      .join("") ?? "";
    return llmResponse({
      content,
      finishReason: payload.status === "failed" ? "error" : "stop",
      usage: {
        prompt_tokens: payload.usage?.input_tokens ?? 0,
        completion_tokens: payload.usage?.output_tokens ?? 0,
        total_tokens: payload.usage?.total_tokens ?? 0,
      },
    });
  }

  static supportsTemperature(model: string, reasoningEffort?: string): boolean {
    return supportsTemperature(model, reasoningEffort);
  }
}

class UnsupportedOAuthProvider implements LLMProvider {
  readonly supportsProgressDeltas: boolean = false;
  readonly defaultModel: string;
  generation: GenerationSettings = { temperature: 0.7, maxTokens: 4096 };

  constructor(defaultModel: string, private readonly label: string) {
    this.defaultModel = defaultModel;
  }

  getDefaultModel(): string {
    return this.defaultModel;
  }

  async chat(): Promise<LLMResponse> {
    return providerError(`${this.label} OAuth adapter is not implemented in the TypeScript runtime yet.`);
  }
}

interface ChatCompletionsPayload {
  choices?: {
    message?: {
      content?: JsonValue;
      reasoning?: JsonValue;
      reasoning_content?: JsonValue;
      reasoningContent?: JsonValue;
      thinking_blocks?: JsonValue;
      thinkingBlocks?: JsonValue;
      tool_calls?: JsonValue;
      toolCalls?: JsonValue;
    };
    finish_reason?: string;
    finishReason?: string;
  }[];
  usage?: Record<string, number>;
}

export class OpenAICodexProvider extends UnsupportedOAuthProvider {
  constructor(defaultModel = "openai-codex/gpt-5") {
    super(defaultModel, "OpenAI Codex");
  }

  override readonly supportsProgressDeltas = true;
}

export class GitHubCopilotProvider extends UnsupportedOAuthProvider {
  constructor(defaultModel = "github-copilot/gpt-5") {
    super(defaultModel, "GitHub Copilot");
  }
}

function supportsTemperature(model: string, reasoningEffort?: string): boolean {
  if (reasoningEffort && reasoningEffort !== "none") {
    return false;
  }
  const normalized = model.toLowerCase();
  return !/^(o\d|.*\/o\d|gpt-5)/.test(normalized) && !normalized.includes("/gpt-5");
}

function parseChatCompletionsPayload(payload: ChatCompletionsPayload, spec: ProviderSpec | undefined): LLMResponse {
  const choices = payload.choices ?? [];
  const firstChoice = choices[0];
  const firstMessage = firstChoice?.message;
  const contentParts = normalizeMessageContent(firstMessage?.content);
  const reasoningContent = extractStringContent(firstMessage?.reasoning_content)
    ?? extractStringContent(firstMessage?.reasoningContent)
    ?? extractStringContent(firstMessage?.reasoning);
  const thinkingBlocks = [
    ...contentParts.thinkingBlocks,
    ...coerceObjectArray(firstMessage?.thinking_blocks),
    ...coerceObjectArray(firstMessage?.thinkingBlocks),
  ];
  const rawToolCalls = choices.flatMap((choice) => coerceArray(
    choice.message?.tool_calls ?? choice.message?.toolCalls,
  ));
  const toolCalls = rawToolCalls.map(parseToolCall).filter((toolCall): toolCall is ToolCallRequest => toolCall !== undefined);
  const finishReason = firstChoice?.finish_reason ?? firstChoice?.finishReason ?? (toolCalls.length > 0 ? "tool_calls" : "stop");

  return llmResponse({
    content: contentParts.text ?? (spec?.reasoningAsContent ? reasoningContent ?? null : null),
    toolCalls,
    finishReason,
    usage: payload.usage ?? {},
    reasoningContent,
    thinkingBlocks: thinkingBlocks.length > 0 ? thinkingBlocks : undefined,
  });
}

function normalizeMessageContent(content: JsonValue | undefined): { text: string | null; thinkingBlocks: JsonObject[] } {
  if (typeof content === "string") {
    return { text: content, thinkingBlocks: [] };
  }
  if (content === null || content === undefined) {
    return { text: null, thinkingBlocks: [] };
  }
  if (!Array.isArray(content)) {
    return { text: extractStringContent(content) ?? null, thinkingBlocks: [] };
  }

  const textParts: string[] = [];
  const thinkingBlocks: JsonObject[] = [];
  for (const item of content) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      continue;
    }
    const block = item as JsonObject;
    const type = typeof block.type === "string" ? block.type : "";
    if (type === "text" || type === "output_text") {
      const text = typeof block.text === "string" ? block.text : undefined;
      if (text) {
        textParts.push(text);
      }
      continue;
    }
    if (type.includes("thinking") || type === "reasoning") {
      thinkingBlocks.push(structuredClone(block));
    }
  }

  return {
    text: textParts.length > 0 ? textParts.join("") : null,
    thinkingBlocks,
  };
}

function parseToolCall(raw: JsonValue): ToolCallRequest | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const toolCall = raw as JsonObject;
  const fn = typeof toolCall.function === "object" && toolCall.function !== null && !Array.isArray(toolCall.function)
    ? toolCall.function as JsonObject
    : {};
  const name = typeof fn.name === "string" ? fn.name : "";
  if (!name) {
    return undefined;
  }
  return {
    id: typeof toolCall.id === "string" ? toolCall.id : "call_0",
    name,
    arguments: parseToolArguments(fn.arguments),
    extraContent: coerceObject(toolCall.extra_content ?? toolCall.extraContent),
    providerSpecificFields: coerceObject(toolCall.provider_specific_fields ?? toolCall.providerSpecificFields),
    functionProviderSpecificFields: coerceObject(fn.provider_specific_fields ?? fn.providerSpecificFields),
  };
}

function parseToolArguments(value: JsonValue | undefined): JsonObject {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return structuredClone(value as JsonObject);
  }
  if (typeof value !== "string") {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as JsonObject;
    }
  } catch {
    return { raw: value };
  }
  return {};
}

function extractStringContent(value: JsonValue | undefined): string | undefined {
  if (typeof value === "string") {
    return value || undefined;
  }
  if (Array.isArray(value)) {
    const parts = value.map((item) => extractStringContent(item)).filter((item): item is string => Boolean(item));
    return parts.length > 0 ? parts.join("") : undefined;
  }
  if (typeof value === "object" && value !== null) {
    const objectValue = value as JsonObject;
    if (typeof objectValue.text === "string") {
      return objectValue.text;
    }
    if (typeof objectValue.content === "string") {
      return objectValue.content;
    }
  }
  return undefined;
}

function coerceArray(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

function coerceObject(value: JsonValue | undefined): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? structuredClone(value as JsonObject)
    : undefined;
}

function coerceObjectArray(value: JsonValue | undefined): JsonObject[] {
  return coerceArray(value)
    .filter((item): item is JsonObject => typeof item === "object" && item !== null && !Array.isArray(item))
    .map((item) => structuredClone(item));
}

function toResponsesTool(tool: JsonObject): JsonObject {
  const fn = typeof tool.function === "object" && tool.function !== null && !Array.isArray(tool.function)
    ? tool.function as JsonObject
    : {};
  return {
    type: "function",
    name: typeof fn.name === "string" ? fn.name : "",
    description: typeof fn.description === "string" ? fn.description : "",
    parameters: (typeof fn.parameters === "object" && fn.parameters !== null ? fn.parameters : {}) as JsonValue,
  };
}

function toResponsesContent(content: JsonValue | undefined): JsonValue {
  if (Array.isArray(content)) {
    return content.map((item) => convertResponsesBlock(item));
  }
  if (typeof content === "object" && content !== null) {
    return [convertResponsesBlock(content)];
  }
  return [{ type: "input_text", text: String(content ?? "") }];
}

function convertResponsesBlock(item: JsonValue): JsonObject {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    return { type: "input_text", text: String(item ?? "") };
  }
  const block = item as JsonObject;
  if (block.type === "image_url") {
    const imageUrl = typeof block.image_url === "object" && block.image_url !== null && !Array.isArray(block.image_url)
      ? (block.image_url as JsonObject).url
      : undefined;
    return { type: "input_image", image_url: typeof imageUrl === "string" ? imageUrl : "" };
  }
  if (block.type === "text" || block.type === "input_text" || block.type === "output_text") {
    return { type: "input_text", text: typeof block.text === "string" ? block.text : "" };
  }
  return structuredClone(block);
}

function contentToInstruction(content: JsonValue | undefined): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === "object" && item !== null && !Array.isArray(item) && typeof item.text === "string") {
        return item.text;
      }
      return "";
    }).filter(Boolean).join("\n");
  }
  return "";
}

function providerError(content: string, statusCode?: number): LLMResponse {
  return llmResponse({
    content,
    finishReason: "error",
    errorStatusCode: statusCode,
    errorKind: statusCode === undefined ? undefined : "http",
    errorShouldRetry: statusCode === undefined ? undefined : statusCode >= 500 || statusCode === 408 || statusCode === 429,
  });
}

function trimTrailingSlash(value: string | undefined): string | undefined {
  return value ? value.replace(/\/+$/, "") : undefined;
}

class ValueError extends Error {}
