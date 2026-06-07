import {
  type Config,
  type FallbackCandidate,
  type ModelPresetConfig,
  type ProviderConfig,
} from "../config/schema.js";
import { AzureOpenAIProvider, GitHubCopilotProvider, OpenAICompatibleProvider, OpenAICodexProvider } from "./adapters.js";
import { type LLMProvider } from "./base.js";
import { type ProviderSpec, PROVIDER_SPECS, findProviderSpec, normalizeProviderName } from "./registry.js";

export interface ProviderSelection {
  provider: ProviderConfig;
  spec: ProviderSpec;
}

export interface ProviderSnapshot {
  provider: LLMProvider;
  model: string;
  contextWindowTokens: number;
  signature: unknown[];
}

export function resolvePreset(
  config: Config,
  preset?: Partial<ModelPresetConfig>,
): ModelPresetConfig {
  if (preset) {
    return {
      model: preset.model ?? config.agents.defaults.model,
      provider: preset.provider ?? config.agents.defaults.provider,
      maxTokens: preset.maxTokens ?? config.agents.defaults.maxTokens,
      contextWindowTokens: preset.contextWindowTokens ?? config.agents.defaults.contextWindowTokens,
      temperature: preset.temperature ?? config.agents.defaults.temperature,
      reasoningEffort: preset.reasoningEffort ?? config.agents.defaults.reasoningEffort,
    };
  }
  const presetName = config.agents.defaults.modelPreset;
  if (presetName && presetName !== "default") {
    const named = config.modelPresets[presetName];
    if (!named) {
      throw new Error(`modelPreset '${presetName}' not found in modelPresets`);
    }
    return named;
  }
  return {
    model: config.agents.defaults.model,
    provider: config.agents.defaults.provider,
    maxTokens: config.agents.defaults.maxTokens,
    contextWindowTokens: config.agents.defaults.contextWindowTokens,
    temperature: config.agents.defaults.temperature,
    reasoningEffort: config.agents.defaults.reasoningEffort,
  };
}

export function matchProvider(
  config: Config,
  model?: string,
  preset?: Partial<ModelPresetConfig>,
): ProviderSelection | undefined {
  const resolved = resolvePreset(config, preset);
  const forced = resolved.provider;
  if (forced !== "auto") {
    const spec = findProviderSpec(forced);
    return spec ? { provider: providerConfig(config, spec), spec } : undefined;
  }

  const modelLower = (model ?? resolved.model).toLowerCase();
  const modelNormalized = modelLower.replace(/-/g, "_");
  const modelPrefix = modelLower.includes("/") ? modelLower.split("/", 1)[0] ?? "" : "";
  const normalizedPrefix = normalizeProviderName(modelPrefix);

  for (const spec of PROVIDER_SPECS) {
    const candidate = providerConfig(config, spec);
    if (modelPrefix && normalizedPrefix === normalizeProviderName(spec.id) && providerIsSelectable(candidate, spec)) {
      return { provider: candidate, spec };
    }
  }

  for (const spec of PROVIDER_SPECS) {
    const candidate = providerConfig(config, spec);
    if (spec.keywords.some((keyword) => keywordMatches(keyword, modelLower, modelNormalized)) && providerIsSelectable(candidate, spec)) {
      return { provider: candidate, spec };
    }
  }

  let localFallback: ProviderSelection | undefined;
  for (const spec of PROVIDER_SPECS) {
    if (!spec.isLocal) {
      continue;
    }
    const candidate = providerConfig(config, spec);
    if (!candidate.apiBase) {
      continue;
    }
    if (spec.detectByBaseKeyword && candidate.apiBase.toLowerCase().includes(spec.detectByBaseKeyword.toLowerCase())) {
      return { provider: candidate, spec };
    }
    localFallback ??= { provider: candidate, spec };
  }
  if (localFallback) {
    return localFallback;
  }

  for (const spec of PROVIDER_SPECS) {
    if (spec.isOauth) {
      continue;
    }
    const candidate = providerConfig(config, spec);
    if (candidate.apiKey) {
      return { provider: candidate, spec };
    }
  }
  return undefined;
}

export function makeProvider(
  config: Config,
  preset?: Partial<ModelPresetConfig>,
): LLMProvider {
  const resolved = resolvePreset(config, preset);
  const selection = matchProvider(config, resolved.model, resolved);
  if (!selection) {
    throw new Error(`No provider matched model '${resolved.model}'.`);
  }
  const provider = constructProvider(selection, resolved.model);
  provider.generation = {
    maxTokens: resolved.maxTokens,
    temperature: resolved.temperature,
    reasoningEffort: resolved.reasoningEffort,
  };
  return provider;
}

export function buildProviderSnapshot(
  config: Config,
  preset?: Partial<ModelPresetConfig>,
): ProviderSnapshot {
  const resolved = resolvePreset(config, preset);
  const fallbackPresets = resolveFallbackPresets(config, resolved);
  return {
    provider: makeProvider(config, resolved),
    model: resolved.model,
    contextWindowTokens: Math.min(
      resolved.contextWindowTokens,
      ...fallbackPresets.map((fallback) => fallback.contextWindowTokens),
    ),
    signature: providerSignature(config, resolved, fallbackPresets),
  };
}

export function providerSignature(
  config: Config,
  preset?: Partial<ModelPresetConfig>,
  fallbackPresets = resolveFallbackPresets(config, resolvePreset(config, preset)),
): unknown[] {
  const resolved = resolvePreset(config, preset);
  return [
    ...presetSignature(config, resolved),
    ...fallbackPresets.flatMap((fallback) => presetSignature(config, fallback)),
  ];
}

function constructProvider(selection: ProviderSelection, model: string): LLMProvider {
  const { provider, spec } = selection;
  switch (spec.backend) {
    case "azure_openai":
      if (!provider.apiBase) {
        throw new Error("Azure OpenAI requires apiBase in config.");
      }
      return new AzureOpenAIProvider({
        apiKey: provider.apiKey,
        apiBase: provider.apiBase,
        defaultModel: model,
      });
    case "openai_codex":
      return new OpenAICodexProvider(model);
    case "github_copilot":
      return new GitHubCopilotProvider(model);
    case "openai_compat":
    case "anthropic":
    case "bedrock":
      if (!provider.apiKey && !spec.isOauth && !spec.isLocal && !spec.isDirect) {
        throw new Error(`No API key configured for provider '${spec.id}'.`);
      }
      return new OpenAICompatibleProvider({
        apiKey: provider.apiKey,
        apiBase: provider.apiBase,
        defaultModel: model,
        spec,
        extraHeaders: provider.extraHeaders,
        extraBody: provider.extraBody,
        apiType: spec.id === "openai" ? provider.apiType : "auto",
      });
  }
}

function resolveFallbackPresets(config: Config, primary: ModelPresetConfig): ModelPresetConfig[] {
  return config.agents.defaults.fallbackModels.map((fallback) => {
    if (typeof fallback === "string") {
      const named = config.modelPresets[fallback];
      if (!named) {
        throw new Error(`fallbackModels entry '${fallback}' not found in modelPresets`);
      }
      return named;
    }
    return inlineFallbackPreset(primary, fallback);
  });
}

function inlineFallbackPreset(primary: ModelPresetConfig, fallback: Exclude<FallbackCandidate, string>): ModelPresetConfig {
  return {
    model: fallback.model,
    provider: fallback.provider,
    maxTokens: fallback.maxTokens ?? primary.maxTokens,
    contextWindowTokens: fallback.contextWindowTokens ?? primary.contextWindowTokens,
    temperature: fallback.temperature ?? primary.temperature,
    reasoningEffort: fallback.reasoningEffort,
  };
}

function presetSignature(config: Config, preset: ModelPresetConfig): unknown[] {
  const selection = matchProvider(config, preset.model, preset);
  const provider = selection?.provider;
  return [
    preset.model,
    preset.provider,
    selection?.spec.id,
    provider?.apiKey,
    provider?.apiBase,
    provider?.extraHeaders,
    provider?.extraBody,
    provider?.apiType,
    provider?.region,
    provider?.profile,
    preset.maxTokens,
    preset.temperature,
    preset.reasoningEffort,
    preset.contextWindowTokens,
  ];
}

function providerConfig(config: Config, spec: ProviderSpec): ProviderConfig {
  return (config.providers as unknown as Record<string, ProviderConfig>)[spec.id] ?? { apiType: "auto" };
}

function providerIsSelectable(provider: ProviderConfig, spec: ProviderSpec): boolean {
  return Boolean(spec.isOauth || spec.isLocal || spec.isDirect || provider.apiKey);
}

function keywordMatches(keyword: string, modelLower: string, modelNormalized: string): boolean {
  const normalizedKeyword = keyword.toLowerCase();
  return modelLower.includes(normalizedKeyword) || modelNormalized.includes(normalizedKeyword.replace(/-/g, "_"));
}
