export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type ProviderApiType = "auto" | "chat_completions" | "responses";
export type ProviderRetryMode = "standard" | "persistent";
export type McpServerType = "stdio" | "sse" | "streamableHttp";

export interface DreamConfig {
  enabled: boolean;
  intervalH: number;
  cron?: string;
  modelOverride?: string;
  maxBatchSize: number;
  maxIterations: number;
  annotateLineAges: boolean;
}

export interface InlineFallbackConfig {
  model: string;
  provider: string;
  maxTokens?: number;
  contextWindowTokens?: number;
  temperature?: number;
  reasoningEffort?: string;
}

export type FallbackCandidate = string | InlineFallbackConfig;

export interface AgentDefaults {
  workspace: string;
  modelPreset?: string;
  model: string;
  provider: string;
  maxTokens: number;
  contextWindowTokens: number;
  contextBlockLimit?: number;
  temperature: number;
  fallbackModels: FallbackCandidate[];
  maxToolIterations: number;
  maxConcurrentSubagents: number;
  maxToolResultChars: number;
  providerRetryMode: ProviderRetryMode;
  toolHintMaxLength: number;
  reasoningEffort?: string;
  timezone: string;
  botName: string;
  botIcon: string;
  unifiedSession: boolean;
  disabledSkills: string[];
  idleCompactAfterMinutes: number;
  maxMessages: number;
  consolidationRatio: number;
  dream: DreamConfig;
}

export interface AgentsConfig {
  defaults: AgentDefaults;
}

export interface ChannelConfig {
  enabled?: boolean;
  allowFrom?: string[];
  streaming?: boolean;
  [key: string]: JsonValue | undefined;
}

export interface ChannelsConfig {
  sendProgress: boolean;
  sendToolHints: boolean;
  showReasoning: boolean;
  extractDocumentText: boolean;
  sendMaxRetries: number;
  transcriptionProvider: string;
  transcriptionLanguage?: string;
  dingtalk?: ChannelConfig;
  discord?: ChannelConfig;
  email?: ChannelConfig;
  feishu?: ChannelConfig;
  matrix?: ChannelConfig;
  mochat?: ChannelConfig;
  msteams?: ChannelConfig;
  napcat?: ChannelConfig;
  qq?: ChannelConfig;
  signal?: ChannelConfig;
  slack?: ChannelConfig;
  telegram?: ChannelConfig;
  websocket?: ChannelConfig;
  wecom?: ChannelConfig;
  weixin?: ChannelConfig;
  whatsapp?: ChannelConfig;
  [key: string]: JsonValue | ChannelConfig | undefined;
}

export interface ProviderConfig {
  apiKey?: string;
  apiBase?: string;
  apiType: ProviderApiType;
  extraHeaders?: Record<string, string>;
  extraBody?: JsonObject;
  region?: string;
  profile?: string;
}

export interface ProvidersConfig {
  custom: ProviderConfig;
  azureOpenai: ProviderConfig;
  bedrock: ProviderConfig;
  anthropic: ProviderConfig;
  openai: ProviderConfig;
  openrouter: ProviderConfig;
  huggingface: ProviderConfig;
  skywork: ProviderConfig;
  deepseek: ProviderConfig;
  groq: ProviderConfig;
  zhipu: ProviderConfig;
  dashscope: ProviderConfig;
  vllm: ProviderConfig;
  ollama: ProviderConfig;
  lmStudio: ProviderConfig;
  atomicChat: ProviderConfig;
  ovms: ProviderConfig;
  gemini: ProviderConfig;
  moonshot: ProviderConfig;
  minimax: ProviderConfig;
  minimaxAnthropic: ProviderConfig;
  mistral: ProviderConfig;
  stepfun: ProviderConfig;
  xiaomiMimo: ProviderConfig;
  longcat: ProviderConfig;
  antLing: ProviderConfig;
  aihubmix: ProviderConfig;
  siliconflow: ProviderConfig;
  novita: ProviderConfig;
  volcengine: ProviderConfig;
  volcengineCodingPlan: ProviderConfig;
  byteplus: ProviderConfig;
  byteplusCodingPlan: ProviderConfig;
  openaiCodex: ProviderConfig;
  githubCopilot: ProviderConfig;
  qianfan: ProviderConfig;
  nvidia: ProviderConfig;
}

export interface HeartbeatConfig {
  enabled: boolean;
  intervalS: number;
  keepRecentMessages: number;
}

export interface ApiConfig {
  host: string;
  port: number;
  timeout: number;
}

export interface GatewayConfig {
  host: string;
  port: number;
  heartbeat: HeartbeatConfig;
}

export interface McpServerConfig {
  type?: McpServerType;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  url: string;
  headers: Record<string, string>;
  toolTimeout: number;
  enabledTools: string[];
}

export interface ToolSubConfig {
  enable?: boolean;
  allowSet?: boolean;
  [key: string]: JsonValue | undefined;
}

export interface ToolsConfig {
  web: ToolSubConfig;
  exec: ToolSubConfig;
  cliApps: ToolSubConfig;
  my: ToolSubConfig;
  imageGeneration: ToolSubConfig;
  restrictToWorkspace: boolean;
  webuiAllowLocalServiceAccess: boolean;
  mcpServers: Record<string, McpServerConfig>;
  ssrfWhitelist: string[];
}

export interface ModelPresetConfig {
  label?: string;
  model: string;
  provider: string;
  maxTokens: number;
  contextWindowTokens: number;
  temperature: number;
  reasoningEffort?: string;
}

export interface Config {
  agents: AgentsConfig;
  channels: ChannelsConfig;
  providers: ProvidersConfig;
  api: ApiConfig;
  gateway: GatewayConfig;
  tools: ToolsConfig;
  modelPresets: Record<string, ModelPresetConfig>;
}

const providerDefaults = (): ProviderConfig => ({
  apiType: "auto",
});

const channelDefaults = (): ChannelConfig => ({
  enabled: false,
  allowFrom: [],
});

export function defaultConfig(): Config {
  const config: Config = {
    agents: {
      defaults: {
        workspace: "~/.nanobot/workspace",
        model: "anthropic/claude-opus-4-5",
        provider: "auto",
        maxTokens: 8192,
        contextWindowTokens: 65_536,
        temperature: 0.1,
        fallbackModels: [],
        maxToolIterations: 200,
        maxConcurrentSubagents: 1,
        maxToolResultChars: 16_000,
        providerRetryMode: "standard",
        toolHintMaxLength: 40,
        timezone: "UTC",
        botName: "nanobot",
        botIcon: "🐈",
        unifiedSession: false,
        disabledSkills: [],
        idleCompactAfterMinutes: 0,
        maxMessages: 120,
        consolidationRatio: 0.5,
        dream: {
          enabled: true,
          intervalH: 2,
          maxBatchSize: 20,
          maxIterations: 15,
          annotateLineAges: true,
        },
      },
    },
    channels: {
      sendProgress: true,
      sendToolHints: false,
      showReasoning: true,
      extractDocumentText: true,
      sendMaxRetries: 3,
      transcriptionProvider: "groq",
      dingtalk: channelDefaults(),
      discord: channelDefaults(),
      email: channelDefaults(),
      feishu: channelDefaults(),
      matrix: channelDefaults(),
      mochat: channelDefaults(),
      msteams: channelDefaults(),
      napcat: channelDefaults(),
      qq: channelDefaults(),
      signal: channelDefaults(),
      slack: channelDefaults(),
      telegram: channelDefaults(),
      websocket: channelDefaults(),
      wecom: channelDefaults(),
      weixin: channelDefaults(),
      whatsapp: channelDefaults(),
    },
    providers: {
      custom: providerDefaults(),
      azureOpenai: providerDefaults(),
      bedrock: providerDefaults(),
      anthropic: providerDefaults(),
      openai: providerDefaults(),
      openrouter: providerDefaults(),
      huggingface: providerDefaults(),
      skywork: providerDefaults(),
      deepseek: providerDefaults(),
      groq: providerDefaults(),
      zhipu: providerDefaults(),
      dashscope: providerDefaults(),
      vllm: providerDefaults(),
      ollama: providerDefaults(),
      lmStudio: providerDefaults(),
      atomicChat: providerDefaults(),
      ovms: providerDefaults(),
      gemini: providerDefaults(),
      moonshot: providerDefaults(),
      minimax: providerDefaults(),
      minimaxAnthropic: providerDefaults(),
      mistral: providerDefaults(),
      stepfun: providerDefaults(),
      xiaomiMimo: providerDefaults(),
      longcat: providerDefaults(),
      antLing: providerDefaults(),
      aihubmix: providerDefaults(),
      siliconflow: providerDefaults(),
      novita: providerDefaults(),
      volcengine: providerDefaults(),
      volcengineCodingPlan: providerDefaults(),
      byteplus: providerDefaults(),
      byteplusCodingPlan: providerDefaults(),
      openaiCodex: providerDefaults(),
      githubCopilot: providerDefaults(),
      qianfan: providerDefaults(),
      nvidia: providerDefaults(),
    },
    api: {
      host: "127.0.0.1",
      port: 8900,
      timeout: 120,
    },
    gateway: {
      host: "127.0.0.1",
      port: 18790,
      heartbeat: {
        enabled: true,
        intervalS: 30 * 60,
        keepRecentMessages: 8,
      },
    },
    tools: {
      web: {},
      exec: {},
      cliApps: {},
      my: {},
      imageGeneration: {},
      restrictToWorkspace: false,
      webuiAllowLocalServiceAccess: true,
      mcpServers: {},
      ssrfWhitelist: [],
    },
    modelPresets: {},
  };

  return structuredClone(config);
}
