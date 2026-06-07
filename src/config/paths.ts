import { dirname, join } from "node:path";

import type { Config } from "./schema.js";

export function getDefaultConfigPath(home = process.env.HOME || process.env.USERPROFILE || ""): string {
  return join(home, ".nanobot", "config.json");
}

export function getRuntimeDir(configPath: string): string {
  return dirname(configPath);
}

export function getWorkspacePath(config: Config): string {
  return expandHome(config.agents.defaults.workspace);
}

export function expandHome(input: string, home = process.env.HOME || process.env.USERPROFILE || ""): string {
  if (input === "~") {
    return home;
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return join(home, input.slice(2));
  }
  return input;
}
