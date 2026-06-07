import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, test } from "node:test";

import { applyWorkspaceOverride, loadConfig, saveConfig } from "../../src/config/loader.js";
import { defaultConfig } from "../../src/config/schema.js";

const ambientNanobotEnv = snapshotNanobotEnv();

beforeEach(() => {
  clearNanobotEnv();
});

afterEach(() => {
  restoreNanobotEnv(ambientNanobotEnv);
});

test("default config preserves Python camelCase field names", () => {
  const config = defaultConfig();

  assert.equal(config.agents.defaults.model, "anthropic/claude-opus-4-5");
  assert.equal(config.agents.defaults.maxToolIterations, 200);
  assert.equal(config.tools.restrictToWorkspace, false);
  assert.deepEqual(config.tools.mcpServers, {});
  assert.deepEqual(config.channels.telegram?.allowFrom, []);
  assert.equal(config.providers.openai.apiBase, undefined);
  assert.equal(config.providers.azureOpenai.apiKey, undefined);
});

function snapshotNanobotEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env)
      .filter(([key, value]) => key.startsWith("NANOBOT_") && value !== undefined)
      .map(([key, value]) => [key, value as string]),
  );
}

function clearNanobotEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("NANOBOT_")) {
      delete process.env[key];
    }
  }
}

function restoreNanobotEnv(snapshot: Record<string, string>): void {
  clearNanobotEnv();
  for (const [key, value] of Object.entries(snapshot)) {
    process.env[key] = value;
  }
}

test("loadConfig returns defaults when explicit config path is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nanobot-config-"));
  const config = await loadConfig(join(dir, "missing.json"));

  assert.deepEqual(config, defaultConfig());
});

test("loadConfig deep merges camelCase JSON and NANOBOT env overrides", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nanobot-config-"));
  const configPath = join(dir, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      agents: { defaults: { maxToolIterations: 7 } },
      channels: {
        telegram: { allowFrom: ["alice"], enabled: true },
      },
      providers: {
        openai: {
          apiBase: "https://api.example.test/v1",
          extraHeaders: { "APP-Code": "from-file" },
        },
      },
      tools: {
        restrictToWorkspace: true,
        mcpServers: {
          docs: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] },
        },
      },
    }),
    "utf8",
  );

  const previousModel = process.env.NANOBOT_AGENTS__DEFAULTS__MODEL;
  const previousOpenAiKey = process.env.NANOBOT_PROVIDERS__OPENAI__API_KEY;
  process.env.NANOBOT_AGENTS__DEFAULTS__MODEL = "openai/gpt-4.1-mini";
  process.env.NANOBOT_PROVIDERS__OPENAI__API_KEY = "from-env";
  try {
    const config = await loadConfig(configPath);

    assert.equal(config.agents.defaults.model, "openai/gpt-4.1-mini");
    assert.equal(config.agents.defaults.maxToolIterations, 7);
    assert.equal(config.channels.telegram?.enabled, true);
    assert.deepEqual(config.channels.telegram?.allowFrom, ["alice"]);
    assert.equal(config.providers.openai.apiBase, "https://api.example.test/v1");
    assert.equal(config.providers.openai.apiKey, "from-env");
    assert.equal(config.providers.openai.extraHeaders?.["APP-Code"], "from-file");
    assert.equal(config.tools.restrictToWorkspace, true);
    assert.equal(config.tools.mcpServers.docs?.command, "npx");
  } finally {
    if (previousModel === undefined) {
      delete process.env.NANOBOT_AGENTS__DEFAULTS__MODEL;
    } else {
      process.env.NANOBOT_AGENTS__DEFAULTS__MODEL = previousModel;
    }
    if (previousOpenAiKey === undefined) {
      delete process.env.NANOBOT_PROVIDERS__OPENAI__API_KEY;
    } else {
      process.env.NANOBOT_PROVIDERS__OPENAI__API_KEY = previousOpenAiKey;
    }
  }
});

test("saveConfig writes camelCase JSON to an explicit config path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nanobot-config-"));
  const configPath = join(dir, "nested", "config.json");
  const config = applyWorkspaceOverride(defaultConfig(), "/workspace/custom");
  config.providers.openai.apiKey = "secret";

  await saveConfig(config, configPath);

  const saved = JSON.parse(await readFile(configPath, "utf8")) as {
    agents: { defaults: { workspace: string; maxToolIterations: number } };
    providers: { openai: { apiKey: string } };
  };
  assert.equal(saved.agents.defaults.workspace, "/workspace/custom");
  assert.equal(saved.agents.defaults.maxToolIterations, 200);
  assert.equal(saved.providers.openai.apiKey, "secret");
});
