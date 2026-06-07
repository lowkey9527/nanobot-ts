import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import {
  expandHome,
  getDefaultConfigPath,
  getRuntimeDir,
  getWorkspacePath,
} from "../../src/config/paths.js";
import { defaultConfig } from "../../src/config/schema.js";

test("getDefaultConfigPath derives the Python default from home", () => {
  assert.equal(getDefaultConfigPath("/home/alice"), join("/home/alice", ".nanobot", "config.json"));
});

test("getRuntimeDir follows the selected config directory", () => {
  assert.equal(getRuntimeDir(join("/tmp", "instance-a", "config.json")), join("/tmp", "instance-a"));
});

test("expandHome expands only leading tilde segments", () => {
  assert.equal(expandHome("~/workspace", "/home/alice"), join("/home/alice", "workspace"));
  assert.equal(expandHome("~", "/home/alice"), "/home/alice");
  assert.equal(expandHome("/tmp/~/workspace", "/home/alice"), "/tmp/~/workspace");
});

test("getWorkspacePath expands the config workspace", () => {
  const config = defaultConfig();
  config.agents.defaults.workspace = "~/custom-workspace";

  assert.equal(getWorkspacePath(config), join(process.env.HOME || process.env.USERPROFILE || "", "custom-workspace"));
});
