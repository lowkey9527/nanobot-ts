import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { logo, version } from "../../src/index.js";

test("exports foundation identity metadata", () => {
  assert.equal(version, "0.1.0");
  assert.equal(logo, "nanobot");
});

test("package bin target is emitted by the build", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    bin: { nanobot: string };
  };
  assert.equal(existsSync(resolve(packageJson.bin.nanobot)), true);
});
