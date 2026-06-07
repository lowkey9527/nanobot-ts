import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { type JsonObject } from "../../src/config/schema.js";
import { defaultConfig } from "../../src/config/schema.js";
import {
  AzureOpenAIProvider,
  GitHubCopilotProvider,
  OpenAICompatibleProvider,
  OpenAICodexProvider,
} from "../../src/providers/adapters.js";
import {
  buildProviderSnapshot,
  makeProvider,
  matchProvider,
} from "../../src/providers/factory.js";
import {
  findProviderSpec,
  providerConfigKey,
} from "../../src/providers/registry.js";
import {
  GroqTranscriptionProvider,
  OpenAITranscriptionProvider,
  resolveTranscriptionUrl,
} from "../../src/providers/transcription.js";

test("provider registry exposes ordered metadata for matching and construction", () => {
  const openrouter = findProviderSpec("openrouter");
  const codex = findProviderSpec("openai-codex");
  const azure = findProviderSpec("azure_openai");

  assert.equal(openrouter?.isGateway, true);
  assert.equal(openrouter?.defaultApiBase, "https://openrouter.ai/api/v1");
  assert.equal(codex?.isOauth, true);
  assert.equal(codex?.backend, "openai_codex");
  assert.equal(azure?.backend, "azure_openai");
  assert.equal(providerConfigKey("github-copilot"), "githubCopilot");
});

test("provider matching follows prefix, keyword, local fallback, and non-OAuth fallback rules", () => {
  const config = defaultConfig();

  assert.equal(matchProvider(config, "github-copilot/gpt-5.4-mini")?.spec.id, "githubCopilot");

  config.providers.anthropic.apiKey = "anthropic-key";
  assert.equal(matchProvider(config, "anthropic/claude-opus-4-5")?.spec.id, "anthropic");

  delete config.providers.anthropic.apiKey;
  config.providers.ollama.apiBase = "http://localhost:11434/v1";
  assert.equal(matchProvider(config, "llama3.2")?.spec.id, "ollama");

  config.providers.ollama.apiBase = undefined;
  config.providers.openrouter.apiKey = "sk-or-test";
  assert.equal(matchProvider(config, "unprefixed-model")?.spec.id, "openrouter");

  config.providers.openrouter.apiKey = undefined;
  config.providers.openaiCodex.apiBase = "https://chatgpt.com/backend-api";
  assert.equal(matchProvider(config, "unprefixed-model"), undefined);
});

test("makeProvider constructs typed providers and validates required credentials", () => {
  const config = defaultConfig();

  assert.throws(
    () => makeProvider(config, { model: "openai/gpt-4.1-mini", provider: "openai" }),
    /No API key configured for provider 'openai'/,
  );

  config.providers.openai.apiKey = "openai-key";
  const openai = makeProvider(config, { model: "openai/gpt-4.1-mini", provider: "openai" });
  assert.ok(openai instanceof OpenAICompatibleProvider);
  assert.equal(openai.apiBase, "https://api.openai.com/v1");
  config.providers.openai.apiKey = undefined;

  config.providers.custom.apiBase = "https://custom.example/v1";
  const custom = makeProvider(config, { model: "custom/model", provider: "custom" });
  assert.ok(custom instanceof OpenAICompatibleProvider);
  assert.equal(custom.defaultModel, "custom/model");
  assert.equal(custom.apiBase, "https://custom.example/v1");

  assert.throws(
    () => makeProvider(config, { model: "azure/gpt-4o", provider: "azureOpenai" }),
    /Azure OpenAI requires apiBase/,
  );
  config.providers.azureOpenai.apiBase = "https://res.openai.azure.com/";
  config.providers.azureOpenai.apiKey = "azure-key";
  const azure = makeProvider(config, { model: "gpt-4o-deployment", provider: "azure-openai" });
  assert.ok(azure instanceof AzureOpenAIProvider);
  assert.equal(azure.apiBase, "https://res.openai.azure.com");
  assert.equal(azure.responsesUrl, "https://res.openai.azure.com/openai/v1/responses");

  const codex = makeProvider(config, { model: "openai-codex/gpt-5.1", provider: "openaiCodex" });
  assert.ok(codex instanceof OpenAICodexProvider);
  assert.equal(codex.supportsProgressDeltas, true);

  const copilot = makeProvider(config, { model: "github-copilot/gpt-5.4-mini", provider: "githubCopilot" });
  assert.ok(copilot instanceof GitHubCopilotProvider);
  assert.equal(copilot.getDefaultModel(), "github-copilot/gpt-5.4-mini");
});

test("provider snapshot captures model settings and provider-sensitive signature", () => {
  const config = defaultConfig();
  config.providers.openai.apiKey = "openai-key";
  config.agents.defaults.model = "openai/gpt-4.1-mini";
  config.agents.defaults.provider = "auto";
  config.agents.defaults.contextWindowTokens = 128_000;
  config.agents.defaults.fallbackModels = [
    {
      model: "custom/fallback",
      provider: "custom",
      contextWindowTokens: 16_000,
    },
  ];
  config.providers.custom.apiBase = "https://fallback.example/v1";

  const snapshot = buildProviderSnapshot(config);

  assert.equal(snapshot.model, "openai/gpt-4.1-mini");
  assert.equal(snapshot.contextWindowTokens, 16_000);
  assert.equal(snapshot.signature.includes("openai-key"), true);
  assert.equal(snapshot.signature.includes("https://fallback.example/v1"), true);
});

test("OpenAI-compatible adapter builds normalized chat request bodies", () => {
  const spec = findProviderSpec("aihubmix");
  assert.ok(spec);
  const provider = new OpenAICompatibleProvider({
    apiKey: "key",
    apiBase: undefined,
    defaultModel: "anthropic/claude-3-5-sonnet",
    spec,
    extraBody: { top_p: 0.9 },
  });

  const body = provider.buildChatCompletionsBody(
    [{ role: "user", content: "Hi" }],
    [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
    undefined,
    0,
    0.1,
    undefined,
    undefined,
  );

  assert.equal(provider.apiBase, "https://aihubmix.com/v1");
  assert.equal(body.model, "claude-3-5-sonnet");
  assert.equal(body.max_tokens, 1);
  assert.equal(body.temperature, 0.1);
  assert.equal(body.top_p, 0.9);
  assert.equal(body.tool_choice, "auto");
  const chatTools = body.tools as { function: { name: string } }[];
  assert.equal(chatTools[0]?.function.name, "lookup");
});

test("OpenAI-compatible adapter normalizes content, thinking blocks, reasoning, and tool calls", async () => {
  const provider = new OpenAICompatibleProvider({
    apiKey: "key",
    apiBase: "https://api.example/v1",
    defaultModel: "test-model",
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: [
              { type: "thinking", text: "private chain" },
              { type: "text", text: "Use the tool." },
            ],
            reasoning_content: "visible reasoning",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                extra_content: { vendor: "extra" },
                provider_specific_fields: { provider: "field" },
                function: {
                  name: "lookup",
                  arguments: "{\"query\":\"nanobot\"}",
                  provider_specific_fields: { fn: "field" },
                },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    }), { status: 200 }),
  });

  const result = await provider.chat({ messages: [{ role: "user", content: "Find" }] });

  assert.equal(result.content, "Use the tool.");
  assert.equal(result.reasoningContent, "visible reasoning");
  assert.deepEqual(result.thinkingBlocks, [{ type: "thinking", text: "private chain" }]);
  assert.equal(result.finishReason, "tool_calls");
  assert.deepEqual(result.usage, { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
  assert.deepEqual(result.toolCalls, [
    {
      id: "call_1",
      name: "lookup",
      arguments: { query: "nanobot" },
      extraContent: { vendor: "extra" },
      providerSpecificFields: { provider: "field" },
      functionProviderSpecificFields: { fn: "field" },
    },
  ]);
});

test("Azure OpenAI adapter builds Responses API request bodies", () => {
  const provider = new AzureOpenAIProvider({
    apiKey: "key",
    apiBase: "https://res.openai.azure.com/",
    defaultModel: "gpt-5-chat",
  });

  const body = provider.buildResponsesBody(
    [
      { role: "system", content: "You are helpful." },
      {
        role: "user",
        content: [
          { type: "text", text: "Describe" },
          { type: "image_url", image_url: { url: "https://example.test/image.png" } },
        ],
      },
    ],
    [{ type: "function", function: { name: "lookup", description: "Lookup", parameters: {} } }],
    undefined,
    0,
    0.7,
    "medium",
    undefined,
  );

  assert.equal(body.model, "gpt-5-chat");
  assert.equal(body.instructions, "You are helpful.");
  assert.equal(body.max_output_tokens, 1);
  assert.deepEqual(body.reasoning, { effort: "medium" });
  assert.equal("temperature" in body, false);
  const responseTools = body.tools as { name: string }[];
  const responseInput = body.input as { content: JsonObject[] }[];
  assert.equal(responseTools[0]?.name, "lookup");
  assert.equal(responseInput[0]?.content[0]?.type, "input_text");
  assert.equal(responseInput[0]?.content[1]?.type, "input_image");
});

test("transcription providers normalize URLs, short-circuit invalid inputs, and retry transient failures", async () => {
  assert.equal(
    resolveTranscriptionUrl("https://api.groq.com/openai/v1/", "https://x/audio/transcriptions"),
    "https://api.groq.com/openai/v1/audio/transcriptions",
  );
  assert.equal(
    resolveTranscriptionUrl(
      "https://api.groq.com/openai/v1/audio/transcriptions",
      "https://x/audio/transcriptions",
    ),
    "https://api.groq.com/openai/v1/audio/transcriptions",
  );

  const dir = await mkdtemp(join(tmpdir(), "nanobot-transcription-"));
  const audioPath = join(dir, "voice.ogg");
  await writeFile(audioPath, Buffer.from("OggS fake"));

  const openaiMissingKey = new OpenAITranscriptionProvider({ apiKey: "" });
  assert.equal(await openaiMissingKey.transcribe(audioPath), "");

  const calls: { url: string; body: FormData }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), body: init?.body as FormData });
    if (calls.length === 1) {
      return new Response("{}", { status: 503 });
    }
    return new Response(JSON.stringify({ text: "groq ok" }), { status: 200 });
  };
  const sleepCalls: number[] = [];
  const groq = new GroqTranscriptionProvider({
    apiKey: "gsk-test",
    apiBase: "https://api.groq.com/openai/v1",
    language: "ja",
    fetchImpl,
    sleep: async (ms: number) => {
      sleepCalls.push(ms);
    },
  });

  assert.equal(await groq.transcribe(audioPath), "groq ok");
  assert.deepEqual(sleepCalls, [1_000]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.url, "https://api.groq.com/openai/v1/audio/transcriptions");
  assert.equal(calls[0]?.body.get("language"), "ja");
  assert.equal(calls[1]?.body.get("language"), "ja");
});
