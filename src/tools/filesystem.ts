import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { type ToolDefinition, toolError } from "./types.js";

export interface FilesystemToolOptions {
  workspace: string;
  restrictToWorkspace: boolean;
}

export function createFilesystemTools(options: FilesystemToolOptions): ToolDefinition[] {
  return [
    {
      name: "read_file",
      description: "Read a UTF-8 file from the workspace",
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: { path: { type: "string" } },
      },
      policy: { readOnly: true, workspaceRestricted: options.restrictToWorkspace },
      execute: async (input) => {
        const target = resolveWorkspacePath(options.workspace, String(input.path), options.restrictToWorkspace);
        if (!target.allowed) {
          return toolError(`Path '${String(input.path)}' is outside workspace`);
        }

        return { content: await readFile(target.path, "utf8") };
      },
    },
    {
      name: "write_file",
      description: "Write UTF-8 content to a workspace file",
      inputSchema: {
        type: "object",
        required: ["path", "content"],
        properties: { path: { type: "string" }, content: { type: "string" } },
      },
      policy: { workspaceRestricted: options.restrictToWorkspace },
      execute: async (input) => {
        const target = resolveWorkspacePath(options.workspace, String(input.path), options.restrictToWorkspace);
        if (!target.allowed) {
          return toolError(`Path '${String(input.path)}' is outside workspace`);
        }

        await mkdir(dirname(target.path), { recursive: true });
        await writeFile(target.path, String(input.content), "utf8");
        return { content: `Wrote ${target.path}` };
      },
    },
  ];
}

function resolveWorkspacePath(workspace: string, requestedPath: string, restrictToWorkspace: boolean): { allowed: boolean; path: string } {
  const workspaceRoot = resolve(workspace);
  const targetPath = resolve(workspaceRoot, requestedPath);

  if (!restrictToWorkspace) {
    return { allowed: true, path: targetPath };
  }

  const relation = relative(workspaceRoot, targetPath);
  const allowed = relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
  return { allowed, path: targetPath };
}
