import { constants as fsConstants } from "node:fs";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function syncWorkspaceTemplates(workspace: string): Promise<string[]> {
  const source = await resolveTemplateSource();
  const files = await listFiles(source);
  const added: string[] = [];

  await mkdir(workspace, { recursive: true });
  for (const file of files) {
    const rel = relative(source, file);
    const target = join(workspace, rel);
    if (await exists(target)) {
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(file));
    added.push(rel);
  }
  const historyRel = join("memory", "history.jsonl");
  const historyPath = join(workspace, historyRel);
  if (!await exists(historyPath)) {
    await mkdir(dirname(historyPath), { recursive: true });
    await writeFile(historyPath, "", "utf8");
    added.push(historyRel);
  }
  await mkdir(join(workspace, "skills"), { recursive: true });
  return added.sort();
}

async function resolveTemplateSource(): Promise<string> {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDir, "../../../templates"),
    resolve(moduleDir, "../../templates"),
  ];
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Bundled templates directory not found. Checked: ${candidates.join(", ")}`);
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}
