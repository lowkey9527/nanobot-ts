import { execFile } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { type ToolDefinition, toolError } from "./types.js";

const execFileAsync = promisify(execFile);

export interface ShellToolOptions {
  workspace: string;
  restrictToWorkspace: boolean;
}

export function createShellTool(options: ShellToolOptions): ToolDefinition {
  return {
    name: "shell",
    description: "Run a command with explicit arguments",
    inputSchema: {
      type: "object",
      required: ["command"],
      properties: {
        command: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
      },
    },
    policy: {
      execute: "execFile",
      workspaceRestricted: options.restrictToWorkspace,
      cwd: options.restrictToWorkspace ? "within_workspace" : "caller_supplied",
    },
    execute: async (input) => {
      const args = Array.isArray(input.args) ? input.args.map(String) : [];
      const cwd = resolveShellCwd(options.workspace, typeof input.cwd === "string" ? input.cwd : undefined, options.restrictToWorkspace);
      if (!cwd.allowed) {
        return toolError(`Shell cwd '${input.cwd}' is outside workspace`);
      }

      try {
        const { stdout, stderr } = await execFileAsync(String(input.command), args, { cwd: cwd.path, encoding: "utf8" });
        return { content: `${stdout}${stderr}` };
      } catch (error) {
        const execError = error as { stdout?: string; stderr?: string; message?: string };
        const output = `${execError.stdout ?? ""}${execError.stderr ?? ""}`.trim();
        return toolError(output || execError.message || "Command failed");
      }
    },
  };
}

function resolveShellCwd(workspace: string, requestedCwd: string | undefined, restrictToWorkspace: boolean): { allowed: boolean; path: string } {
  const workspaceRoot = resolve(workspace);
  const cwd = requestedCwd ? resolve(workspaceRoot, requestedCwd) : workspaceRoot;

  if (!restrictToWorkspace) {
    return { allowed: true, path: cwd };
  }

  const relation = relative(workspaceRoot, cwd);
  const allowed = relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
  return { allowed, path: cwd };
}
