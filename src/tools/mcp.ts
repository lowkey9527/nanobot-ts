import { type JsonObject } from "../config/schema.js";

import { type ToolDefinition, type ToolResult, toolError } from "./types.js";

export interface McpToolServerConfig {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  toolTimeout?: number;
  enabledTools?: string[];
}

export interface McpToolOptions {
  servers?: Record<string, McpToolServerConfig>;
  handler?: McpToolHandler;
  client?: McpToolClient;
}

export interface McpToolCall {
  server: string;
  tool: string;
  arguments: JsonObject;
  config: McpToolServerConfig;
  metadata: JsonObject;
}

export type McpToolHandler = (call: McpToolCall) => Promise<ToolResult> | ToolResult;

export interface McpToolClient {
  callTool?: McpToolHandler;
  listTools?(server: string, config: McpToolServerConfig): Promise<ToolResult> | ToolResult;
  reconnect?(server: string, config: McpToolServerConfig): Promise<ToolResult> | ToolResult;
  metadata?(server: string, config: McpToolServerConfig): Promise<ToolResult> | ToolResult;
}

export function createMcpTool(options: McpToolOptions = {}): ToolDefinition {
  const servers = options.servers ?? {};
  const handler: McpToolHandler | undefined = options.handler ?? (
    options.client?.callTool ? (call) => options.client?.callTool?.(call) ?? toolError("MCP client callTool handler is unavailable") : undefined
  );

  return {
    name: "mcp",
    description: "Call an MCP tool",
    inputSchema: {
      type: "object",
      required: ["server", "tool"],
      properties: {
        action: { type: "string" },
        server: { type: "string" },
        tool: { type: "string" },
        arguments: { type: "object" },
      },
    },
    policy: {},
    execute: async (input) => {
      const action = typeof input.action === "string" && input.action.trim() ? input.action.trim() : "call";
      const serverName = String(input.server).trim();
      const toolName = String(input.tool).trim();

      if (!serverName || !toolName) {
        return toolError("MCP server and tool must be non-empty strings");
      }

      const server = servers[serverName];
      if (!server) {
        return toolError(`MCP server '${serverName}' is not configured`);
      }

      if (server.enabledTools && server.enabledTools.length > 0 && !server.enabledTools.includes(toolName)) {
        return toolError(`MCP tool '${toolName}' is not enabled for server '${serverName}'`);
      }

      const metadata = buildMetadata(serverName, toolName, server);

      if (action === "metadata") {
        if (options.client?.metadata) {
          return await options.client.metadata(serverName, server);
        }

        return {
          content: JSON.stringify(metadata),
          status: "configured",
          server: serverName,
          tool: toolName,
          ...metadata,
        };
      }

      if (action === "list") {
        if (options.client?.listTools) {
          return await options.client.listTools(serverName, server);
        }

        return {
          content: JSON.stringify({ server: serverName, tools: server.enabledTools ?? [] }),
          status: "listed",
          server: serverName,
          tools: server.enabledTools ?? [],
        };
      }

      if (action === "reconnect") {
        if (!options.client?.reconnect) {
          return toolError(`MCP reconnect handler is not configured for server '${serverName}'`);
        }

        return await options.client.reconnect(serverName, server);
      }

      if (action !== "call") {
        return toolError(`Unsupported MCP action '${action}'`);
      }

      if (!handler) {
        return toolError(`MCP handler is not configured for server '${serverName}'`);
      }

      const args = toJsonObject(input.arguments);
      if (!args) {
        return toolError("MCP arguments must be a JSON object");
      }

      const call: McpToolCall = {
        server: serverName,
        tool: toolName,
        arguments: args,
        config: server,
        metadata,
      };

      return withCallMetadata(await handler(call), call);
    },
  };
}

function buildMetadata(server: string, tool: string, config: McpToolServerConfig): JsonObject {
  return {
    server,
    tool,
    transport: config.type ?? (config.url ? "streamableHttp" : "stdio"),
    configured: {
      command: config.command ?? "",
      args: config.args ?? [],
      cwd: config.cwd ?? "",
      url: config.url ?? "",
      toolTimeout: config.toolTimeout ?? 0,
      enabledTools: config.enabledTools ?? [],
    },
    policy: {
      clientAttached: true,
      runtime: "mcp_client",
    },
  };
}

function withCallMetadata(result: ToolResult, call: McpToolCall): ToolResult {
  return {
    ...result,
    server: result.server ?? call.server,
    tool: result.tool ?? call.tool,
    arguments: result.arguments ?? call.arguments,
    metadata: result.metadata ?? call.metadata,
  };
}

function toJsonObject(value: unknown): JsonObject | undefined {
  if (value === undefined) {
    return {};
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  try {
    return JSON.parse(JSON.stringify(value)) as JsonObject;
  } catch {
    return undefined;
  }
}
