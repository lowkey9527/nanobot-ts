import { type JsonValue } from "../config/schema.js";

export type PrimitiveSchemaType = "string" | "number" | "boolean" | "object" | "array";

export interface ToolSchemaProperty {
  type: PrimitiveSchemaType;
  items?: ToolSchemaProperty;
}

export interface ToolInputSchema {
  type: "object";
  required?: string[];
  properties?: Record<string, ToolSchemaProperty>;
}

export interface ToolPolicy {
  readOnly?: boolean;
  workspaceRestricted?: boolean;
  [key: string]: boolean | string | number | undefined;
}

export interface ToolResult {
  content: string;
  error?: true;
  [key: string]: JsonValue | undefined;
}

export interface ToolExecutionOptions {
  signal?: AbortSignal;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  policy: ToolPolicy;
  execute(input: Record<string, unknown>, options?: ToolExecutionOptions): Promise<ToolResult> | ToolResult;
}

export function toolError(content: string): ToolResult {
  return { content, error: true };
}
