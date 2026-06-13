import { type JsonObject } from "../config/schema.js";

import { type ToolDefinition, type ToolResult, toolError } from "./types.js";

export type SpawnReasoningEffort = "low" | "medium" | "high";

export interface SpawnRequest {
  task: string;
  agent: string;
  model?: string;
  reasoning?: SpawnReasoningEffort;
  policy: JsonObject;
}

export type SpawnHandler = (request: SpawnRequest) => Promise<ToolResult> | ToolResult;

export interface SpawnToolOptions {
  handler?: SpawnHandler;
}

export function createSpawnTool(options: SpawnToolOptions = {}): ToolDefinition {
  return {
    name: "spawn",
    description: "Spawn a subagent",
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: { type: "string" },
        agent: { type: "string" },
        model: { type: "string" },
        reasoning: { type: "string" },
      },
    },
    policy: { subagentRuntimeRequired: true },
    execute: async (input) => {
      const task = String(input.task).trim();
      if (!task) {
        return toolError("Spawn task must be a non-empty string");
      }

      const agent = typeof input.agent === "string" && input.agent.trim() ? input.agent.trim() : "executor";
      if (!/^[A-Za-z0-9._:-]+$/.test(agent)) {
        return toolError("Spawn agent must contain only letters, numbers, '.', '_', ':', or '-'");
      }

      const model = typeof input.model === "string" && input.model.trim() ? input.model.trim() : undefined;
      if (input.model !== undefined && !model) {
        return toolError("Spawn model must be a non-empty string when provided");
      }

      const reasoning = parseReasoning(input.reasoning);
      if (reasoning === "invalid") {
        return toolError("Spawn reasoning must be one of low, medium, or high");
      }

      if (!options.handler) {
        return toolError(`Spawn handler is not configured for agent '${agent}'`);
      }

      const request: SpawnRequest = {
        task,
        agent,
        model,
        reasoning,
        policy: {
          runtime: "codex_subagents",
          sideEffects: "agent_execution",
          requestedAt: new Date().toISOString(),
        },
      };

      const result = await options.handler(request);

      return {
        ...result,
        task: result.task ?? request.task,
        agent: result.agent ?? request.agent,
        model: result.model ?? request.model,
        reasoning: result.reasoning ?? request.reasoning,
        policy: result.policy ?? request.policy,
      };
    },
  };
}

function parseReasoning(value: unknown): SpawnReasoningEffort | undefined | "invalid" {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    return "invalid";
  }

  const normalized = value.trim();
  if (normalized === "low" || normalized === "medium" || normalized === "high") {
    return normalized;
  }

  return "invalid";
}
