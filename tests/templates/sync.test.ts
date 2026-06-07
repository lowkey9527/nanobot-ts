import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { syncWorkspaceTemplates } from "../../src/templates/sync.js";

test("syncWorkspaceTemplates creates bundled templates recursively without overwriting edits", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-workspace-"));
  const agentsPath = join(workspace, "AGENTS.md");
  await writeFile(agentsPath, "user-owned", "utf8");

  const firstAdded = await syncWorkspaceTemplates(workspace);

  assert.equal(await readFile(agentsPath, "utf8"), "user-owned");
  assert.equal(firstAdded.includes("AGENTS.md"), false);
  assert.equal(firstAdded.includes(join("memory", "MEMORY.md")), true);
  assert.equal(firstAdded.includes(join("memory", "history.jsonl")), true);
  assert.equal(firstAdded.includes(join("agent", "dream.md")), true);
  assert.match(await readFile(join(workspace, "memory", "MEMORY.md"), "utf8"), /Memory/i);
  assert.equal(await readFile(join(workspace, "memory", "history.jsonl"), "utf8"), "");
  assert.match(await readFile(join(workspace, "agent", "dream.md"), "utf8"), /memory/i);

  const secondAdded = await syncWorkspaceTemplates(workspace);

  assert.deepEqual(secondAdded, []);
});

test("syncWorkspaceTemplates does not overwrite user-owned memory history", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-workspace-"));
  const historyPath = join(workspace, "memory", "history.jsonl");
  await mkdir(join(workspace, "memory"), { recursive: true });
  await writeFile(historyPath, "{\"role\":\"user\"}\n", "utf8");

  const added = await syncWorkspaceTemplates(workspace);

  assert.equal(added.includes(join("memory", "history.jsonl")), false);
  assert.equal(await readFile(historyPath, "utf8"), "{\"role\":\"user\"}\n");
});

test("syncWorkspaceTemplates ignores unrelated templates in the current working directory", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "nanobot-workspace-"));
  const project = await mkdtemp(join(tmpdir(), "nanobot-project-"));
  await mkdir(join(project, "templates"), { recursive: true });
  await writeFile(join(project, "templates", "LOCAL_ONLY.md"), "local template", "utf8");

  const previousCwd = process.cwd();
  try {
    process.chdir(project);
    const added = await syncWorkspaceTemplates(workspace);

    assert.equal(added.includes("AGENTS.md"), true);
    assert.equal(added.includes("LOCAL_ONLY.md"), false);
    assert.match(await readFile(join(workspace, "AGENTS.md"), "utf8"), /nanobot/i);
    await assert.rejects(readFile(join(workspace, "LOCAL_ONLY.md"), "utf8"), { code: "ENOENT" });
  } finally {
    process.chdir(previousCwd);
  }
});
