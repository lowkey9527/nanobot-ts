export type ProviderBackend =
  | "openai_compat"
  | "anthropic"
  | "azure_openai"
  | "openai_codex"
  | "github_copilot"
  | "bedrock";

export interface ProviderSpec {
  id: string;
  keywords: readonly string[];
  envKey: string;
  displayName: string;
  backend: ProviderBackend;
  envExtras?: readonly (readonly [string, string])[];
  isGateway?: boolean;
  isLocal?: boolean;
  detectByKeyPrefix?: string;
  detectByBaseKeyword?: string;
  defaultApiBase?: string;
  stripModelPrefix?: boolean;
  supportsMaxCompletionTokens?: boolean;
  modelOverrides?: readonly (readonly [string, Record<string, unknown>])[];
  isOauth?: boolean;
  isDirect?: boolean;
  supportsPromptCaching?: boolean;
  thinkingStyle?: "" | "thinking_type" | "enable_thinking" | "reasoning_split";
  gatewayReasoningStyle?: "" | "reasoning_effort";
  reasoningAsContent?: boolean;
}

export const PROVIDER_SPECS: readonly ProviderSpec[] = [
  spec({ id: "custom", displayName: "Custom", envKey: "", backend: "openai_compat", isDirect: true }),
  spec({ id: "azureOpenai", keywords: ["azure", "azure-openai"], displayName: "Azure OpenAI", envKey: "", backend: "azure_openai", isDirect: true }),
  spec({
    id: "bedrock",
    keywords: ["bedrock", "anthropic.claude", "amazon.nova", "meta.", "mistral.", "cohere.", "qwen.", "deepseek.", "openai.gpt-oss", "ai21.", "moonshot.", "writer.", "zai."],
    displayName: "AWS Bedrock",
    envKey: "AWS_BEARER_TOKEN_BEDROCK",
    backend: "bedrock",
    isDirect: true,
  }),
  spec({ id: "openrouter", keywords: ["openrouter"], displayName: "OpenRouter", envKey: "OPENROUTER_API_KEY", isGateway: true, detectByKeyPrefix: "sk-or-", detectByBaseKeyword: "openrouter", defaultApiBase: "https://openrouter.ai/api/v1", supportsPromptCaching: true, gatewayReasoningStyle: "reasoning_effort" }),
  spec({ id: "huggingface", keywords: ["huggingface", "hugging-face"], displayName: "Hugging Face", envKey: "HF_TOKEN", isGateway: true, detectByKeyPrefix: "hf_", detectByBaseKeyword: "huggingface", defaultApiBase: "https://router.huggingface.co/v1" }),
  spec({ id: "skywork", keywords: ["skywork", "skyclaw", "apifree"], displayName: "Skywork", envKey: "SKYWORK_API_KEY", envExtras: [["APIFREE_API_KEY", "{api_key}"]], isGateway: true, detectByBaseKeyword: "apifree.ai", defaultApiBase: "https://api.apifree.ai/agent/v1" }),
  spec({ id: "aihubmix", keywords: ["aihubmix"], displayName: "AiHubMix", envKey: "OPENAI_API_KEY", isGateway: true, detectByBaseKeyword: "aihubmix", defaultApiBase: "https://aihubmix.com/v1", stripModelPrefix: true }),
  spec({ id: "siliconflow", keywords: ["siliconflow"], displayName: "SiliconFlow", envKey: "OPENAI_API_KEY", isGateway: true, detectByBaseKeyword: "siliconflow", defaultApiBase: "https://api.siliconflow.cn/v1" }),
  spec({ id: "novita", keywords: ["novita"], displayName: "Novita AI", envKey: "NOVITA_API_KEY", isGateway: true, detectByBaseKeyword: "novita", defaultApiBase: "https://api.novita.ai/openai" }),
  spec({ id: "volcengine", keywords: ["volcengine", "volces", "ark"], displayName: "VolcEngine", envKey: "OPENAI_API_KEY", isGateway: true, detectByBaseKeyword: "volces", defaultApiBase: "https://ark.cn-beijing.volces.com/api/v3", thinkingStyle: "thinking_type", supportsMaxCompletionTokens: true }),
  spec({ id: "volcengineCodingPlan", keywords: ["volcengine-plan"], displayName: "VolcEngine Coding Plan", envKey: "OPENAI_API_KEY", isGateway: true, defaultApiBase: "https://ark.cn-beijing.volces.com/api/coding/v3", stripModelPrefix: true, thinkingStyle: "thinking_type", supportsMaxCompletionTokens: true }),
  spec({ id: "byteplus", keywords: ["byteplus"], displayName: "BytePlus", envKey: "OPENAI_API_KEY", isGateway: true, detectByBaseKeyword: "bytepluses", defaultApiBase: "https://ark.ap-southeast.bytepluses.com/api/v3", stripModelPrefix: true, thinkingStyle: "thinking_type" }),
  spec({ id: "byteplusCodingPlan", keywords: ["byteplus-plan"], displayName: "BytePlus Coding Plan", envKey: "OPENAI_API_KEY", isGateway: true, defaultApiBase: "https://ark.ap-southeast.bytepluses.com/api/coding/v3", stripModelPrefix: true, thinkingStyle: "thinking_type" }),
  spec({ id: "anthropic", keywords: ["anthropic", "claude"], displayName: "Anthropic", envKey: "ANTHROPIC_API_KEY", backend: "anthropic", supportsPromptCaching: true }),
  spec({ id: "openai", keywords: ["openai", "gpt"], displayName: "OpenAI", envKey: "OPENAI_API_KEY", defaultApiBase: "https://api.openai.com/v1", supportsMaxCompletionTokens: true }),
  spec({ id: "openaiCodex", keywords: ["openai-codex"], displayName: "OpenAI Codex", envKey: "", backend: "openai_codex", detectByBaseKeyword: "codex", defaultApiBase: "https://chatgpt.com/backend-api", isOauth: true }),
  spec({ id: "githubCopilot", keywords: ["github_copilot", "copilot"], displayName: "Github Copilot", envKey: "", backend: "github_copilot", defaultApiBase: "https://api.githubcopilot.com", stripModelPrefix: true, isOauth: true, supportsMaxCompletionTokens: true }),
  spec({ id: "deepseek", keywords: ["deepseek"], displayName: "DeepSeek", envKey: "DEEPSEEK_API_KEY", defaultApiBase: "https://api.deepseek.com", thinkingStyle: "thinking_type" }),
  spec({ id: "gemini", keywords: ["gemini", "gemma"], displayName: "Gemini", envKey: "GEMINI_API_KEY", defaultApiBase: "https://generativelanguage.googleapis.com/v1beta/openai/" }),
  spec({ id: "zhipu", keywords: ["zhipu", "glm", "zai"], displayName: "Zhipu AI", envKey: "ZAI_API_KEY", envExtras: [["ZHIPUAI_API_KEY", "{api_key}"]], defaultApiBase: "https://open.bigmodel.cn/api/paas/v4" }),
  spec({ id: "dashscope", keywords: ["qwen", "dashscope"], displayName: "DashScope", envKey: "DASHSCOPE_API_KEY", defaultApiBase: "https://dashscope.aliyuncs.com/compatible-mode/v1", thinkingStyle: "enable_thinking" }),
  spec({ id: "moonshot", keywords: ["moonshot", "kimi"], displayName: "Moonshot", envKey: "MOONSHOT_API_KEY", defaultApiBase: "https://api.moonshot.ai/v1", modelOverrides: [["kimi-k2.5", { temperature: 1.0 }], ["kimi-k2.6", { temperature: 1.0 }]] }),
  spec({ id: "minimax", keywords: ["minimax"], displayName: "MiniMax", envKey: "MINIMAX_API_KEY", defaultApiBase: "https://api.minimax.io/v1", thinkingStyle: "reasoning_split" }),
  spec({ id: "minimaxAnthropic", keywords: ["minimax_anthropic"], displayName: "MiniMax (Anthropic)", envKey: "MINIMAX_API_KEY", backend: "anthropic", defaultApiBase: "https://api.minimax.io/anthropic" }),
  spec({ id: "mistral", keywords: ["mistral"], displayName: "Mistral", envKey: "MISTRAL_API_KEY", defaultApiBase: "https://api.mistral.ai/v1" }),
  spec({ id: "stepfun", keywords: ["stepfun", "step"], displayName: "Step Fun", envKey: "STEPFUN_API_KEY", defaultApiBase: "https://api.stepfun.com/v1", reasoningAsContent: true }),
  spec({ id: "xiaomiMimo", keywords: ["xiaomi_mimo", "mimo"], displayName: "Xiaomi MIMO", envKey: "XIAOMIMIMO_API_KEY", defaultApiBase: "https://api.xiaomimimo.com/v1", thinkingStyle: "thinking_type" }),
  spec({ id: "longcat", keywords: ["longcat"], displayName: "LongCat", envKey: "LONGCAT_API_KEY", defaultApiBase: "https://api.longcat.chat/openai/v1" }),
  spec({ id: "antLing", keywords: ["ant_ling", "ant-ling", "ling-", "ring-"], displayName: "Ant Ling", envKey: "ANT_LING_API_KEY", detectByBaseKeyword: "ant-ling.com", defaultApiBase: "https://api.ant-ling.com/v1" }),
  spec({ id: "vllm", keywords: ["vllm"], displayName: "vLLM", envKey: "HOSTED_VLLM_API_KEY", isLocal: true }),
  spec({ id: "ollama", keywords: ["ollama", "nemotron"], displayName: "Ollama", envKey: "OLLAMA_API_KEY", isLocal: true, detectByBaseKeyword: "11434", defaultApiBase: "http://localhost:11434/v1" }),
  spec({ id: "lmStudio", keywords: ["lm-studio", "lmstudio", "lm_studio"], displayName: "LM Studio", envKey: "LM_STUDIO_API_KEY", isLocal: true, detectByBaseKeyword: "1234", defaultApiBase: "http://localhost:1234/v1" }),
  spec({ id: "atomicChat", keywords: ["atomic-chat", "atomic_chat", "atomicchat"], displayName: "Atomic Chat", envKey: "ATOMIC_CHAT_API_KEY", isLocal: true, detectByBaseKeyword: "1337", defaultApiBase: "http://localhost:1337/v1" }),
  spec({ id: "ovms", keywords: ["openvino", "ovms"], displayName: "OpenVINO Model Server", envKey: "", isDirect: true, isLocal: true, defaultApiBase: "http://localhost:8000/v3" }),
  spec({ id: "nvidia", keywords: ["nvidia", "nemotron", "nvapi"], displayName: "NVIDIA NIM", envKey: "NVIDIA_NIM_API_KEY", detectByKeyPrefix: "nvapi-", detectByBaseKeyword: "nvidia.com", defaultApiBase: "https://integrate.api.nvidia.com/v1" }),
  spec({ id: "groq", keywords: ["groq"], displayName: "Groq", envKey: "GROQ_API_KEY", defaultApiBase: "https://api.groq.com/openai/v1" }),
  spec({ id: "qianfan", keywords: ["qianfan", "ernie"], displayName: "Qianfan", envKey: "QIANFAN_API_KEY", defaultApiBase: "https://qianfan.baidubce.com/v2" }),
];

export function findProviderSpec(name: string): ProviderSpec | undefined {
  const normalized = normalizeProviderName(name);
  return PROVIDER_SPECS.find((specItem) => normalizeProviderName(specItem.id) === normalized);
}

export function providerConfigKey(name: string): string {
  const parts = name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").split(/[-_\s]+/).filter(Boolean);
  return parts.map((part, index) => {
    const lower = part.toLowerCase();
    return index === 0 ? lower : lower[0]?.toUpperCase() + lower.slice(1);
  }).join("");
}

export function normalizeProviderName(name: string): string {
  return providerConfigKey(name).toLowerCase();
}

function spec(input: Partial<ProviderSpec> & Pick<ProviderSpec, "id" | "displayName" | "envKey">): ProviderSpec {
  return {
    keywords: [],
    backend: "openai_compat",
    envExtras: [],
    isGateway: false,
    isLocal: false,
    detectByKeyPrefix: "",
    detectByBaseKeyword: "",
    defaultApiBase: "",
    stripModelPrefix: false,
    supportsMaxCompletionTokens: false,
    modelOverrides: [],
    isOauth: false,
    isDirect: false,
    supportsPromptCaching: false,
    thinkingStyle: "",
    gatewayReasoningStyle: "",
    reasoningAsContent: false,
    ...input,
  };
}
