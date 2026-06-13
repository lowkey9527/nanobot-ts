import { createCronTool, type CronStore } from "./cron.js";
import { createFilesystemTools } from "./filesystem.js";
import { createMcpTool, type McpToolClient, type McpToolHandler, type McpToolServerConfig } from "./mcp.js";
import { type MessageRoute, createSendMessageTool } from "./message.js";
import { type MessageBus } from "../bus/queue.js";
import { createShellTool } from "./shell.js";
import { createSpawnTool, type SpawnHandler } from "./spawn.js";
import {
  type ToolDefinition,
  type ToolExecutionOptions,
  type ToolInputSchema,
  type ToolResult,
  type ToolSchemaProperty,
  toolError,
} from "./types.js";
import { createWebFetchTool } from "./web.js";

export interface CoreToolOptions {
  workspace: string;
  restrictToWorkspace: boolean;
  bus: MessageBus;
  route: MessageRoute;
  mcpServers?: Record<string, McpToolServerConfig>;
  mcpHandler?: McpToolHandler;
  mcpClient?: McpToolClient;
  spawnHandler?: SpawnHandler;
  cronStore?: CronStore;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  async execute(name: string, input: unknown, options: ToolExecutionOptions = {}): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return toolError(`Unknown tool '${name}'`);
    }

    const validationError = validateInput(tool.inputSchema, input);
    if (validationError) {
      return toolError(validationError);
    }

    try {
      return await tool.execute(input as Record<string, unknown>, options);
    } catch (error) {
      return toolError(error instanceof Error ? error.message : String(error));
    }
  }
}

export function createCoreTools(options: CoreToolOptions): ToolDefinition[] {
  return [
    ...createFilesystemTools({
      workspace: options.workspace,
      restrictToWorkspace: options.restrictToWorkspace,
    }),
    createShellTool({
      workspace: options.workspace,
      restrictToWorkspace: options.restrictToWorkspace,
    }),
    createSendMessageTool({ bus: options.bus, route: options.route }),
    createWebFetchTool(),
    createCronTool({ store: options.cronStore }),
    createMcpTool({ servers: options.mcpServers, handler: options.mcpHandler, client: options.mcpClient }),
    createSpawnTool({ handler: options.spawnHandler }),
  ];
}

function validateInput(schema: ToolInputSchema, input: unknown): string | undefined {
  if (schema.type !== "object") {
    return `Unsupported schema type '${schema.type}'`;
  }

  if (!isPlainObject(input)) {
    return "Expected input to be an object";
  }

  for (const field of schema.required ?? []) {
    if (!(field in input)) {
      return `Missing required field '${field}'`;
    }
  }

  for (const [field, propertySchema] of Object.entries(schema.properties ?? {})) {
    const value = input[field];
    if (value === undefined) {
      continue;
    }

    const typeError = validateValue(field, value, propertySchema);
    if (typeError) {
      return typeError;
    }
  }

  return undefined;
}

function validateValue(field: string, value: unknown, schema: ToolSchemaProperty): string | undefined {
  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      return `Field '${field}' must be an array`;
    }

    if (schema.items) {
      for (const item of value) {
        const itemTypeError = validateValue(field, item, schema.items);
        if (itemTypeError) {
          return itemTypeError.replace(`Field '${field}'`, `Items in field '${field}'`);
        }
      }
    }

    return undefined;
  }

  if (schema.type === "object") {
    if (!isPlainObject(value)) {
      return `Field '${field}' must be an object`;
    }

    return undefined;
  }

  if (typeof value !== schema.type) {
    return `Field '${field}' must be a ${schema.type}`;
  }

  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
