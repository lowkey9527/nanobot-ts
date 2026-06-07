import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { getDefaultConfigPath } from "./paths.js";
import { type Config, defaultConfig, type JsonValue } from "./schema.js";

type UnknownRecord = Record<string, unknown>;

export async function loadConfig(configPath = getDefaultConfigPath()): Promise<Config> {
  let loaded: unknown = {};
  try {
    loaded = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  const withFile = deepMerge(defaultConfig(), normalizeMigrations(asRecord(loaded)));
  const withEnv = deepMerge(withFile, envOverrides());
  return normalizeMcpServers(withEnv);
}

export async function saveConfig(config: Config, configPath = getDefaultConfigPath()): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, undefined, 2)}\n`, "utf8");
}

export function applyWorkspaceOverride(config: Config, workspace?: string): Config {
  if (!workspace) {
    return structuredClone(config);
  }
  return deepMerge(config, { agents: { defaults: { workspace } } });
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function asRecord(value: unknown): UnknownRecord {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as UnknownRecord;
  }
  return {};
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return structuredClone(override === undefined ? base : override) as T;
  }

  const result: UnknownRecord = structuredClone(base) as UnknownRecord;
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) {
      continue;
    }
    const existing = result[key];
    result[key] = isPlainObject(existing) && isPlainObject(value)
      ? deepMerge(existing, value)
      : structuredClone(value);
  }
  return result as T;
}

function isPlainObject(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeMigrations(data: UnknownRecord): UnknownRecord {
  const tools = asRecord(data.tools);
  const exec = asRecord(tools.exec);
  if ("restrictToWorkspace" in exec && !("restrictToWorkspace" in tools)) {
    tools.restrictToWorkspace = exec.restrictToWorkspace;
    delete exec.restrictToWorkspace;
    tools.exec = exec;
    data.tools = tools;
  }
  if ("myEnabled" in tools || "mySet" in tools) {
    const my = asRecord(tools.my);
    if ("myEnabled" in tools && !("enable" in my)) {
      my.enable = tools.myEnabled;
    }
    if ("mySet" in tools && !("allowSet" in my)) {
      my.allowSet = tools.mySet;
    }
    delete tools.myEnabled;
    delete tools.mySet;
    tools.my = my;
    data.tools = tools;
  }
  return data;
}

function envOverrides(): UnknownRecord {
  const root: UnknownRecord = {};
  const prefix = "NANOBOT_";
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith(prefix) || value === undefined) {
      continue;
    }
    const path = name.slice(prefix.length).split("__").filter(Boolean).map(envSegmentToConfigKey);
    if (path.length === 0) {
      continue;
    }
    setNested(root, path, parseEnvValue(value));
  }
  return root;
}

function envSegmentToConfigKey(segment: string): string {
  const parts = segment.toLowerCase().split("_").filter(Boolean);
  if (parts.length === 0) {
    return "";
  }
  return parts[0] + parts.slice(1).map((part) => part[0]?.toUpperCase() + part.slice(1)).join("");
}

function setNested(root: UnknownRecord, path: string[], value: JsonValue): void {
  let current = root;
  for (const key of path.slice(0, -1)) {
    const next = current[key];
    if (!isPlainObject(next)) {
      current[key] = {};
    }
    current = current[key] as UnknownRecord;
  }
  current[path[path.length - 1] ?? ""] = value;
}

function parseEnvValue(value: string): JsonValue {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (value === "null") {
    return null;
  }
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }
  if ((value.startsWith("{") && value.endsWith("}")) || (value.startsWith("[") && value.endsWith("]"))) {
    return JSON.parse(value) as JsonValue;
  }
  return value;
}

function normalizeMcpServers(config: Config): Config {
  const result = structuredClone(config);
  for (const [name, server] of Object.entries(result.tools.mcpServers)) {
    const defaults = {
      command: "",
      args: [],
      env: {},
      cwd: "",
      url: "",
      headers: {},
      toolTimeout: 30,
      enabledTools: ["*"],
    };
    result.tools.mcpServers[name] = { ...defaults, ...server };
  }
  return result;
}
