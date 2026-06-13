import { type JsonObject } from "../config/schema.js";
import { type ChatMessage } from "../providers/base.js";

export interface AgentContextInput {
  workspace: string;
  userContent: string;
  history?: ChatMessage[];
  botIdentity?: string;
  runtimePolicy?: string;
  tools?: AgentContextTool[];
  memoryContent?: string;
  memoryHistory?: string;
  media?: string[];
  modelSettings?: AgentModelSettings;
}

export interface AgentContextTool {
  name: string;
  description?: string;
}

export interface AgentModelSettings {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: string;
}

export function buildSystemPrompt(input: string | AgentContextInput, recentMemory = ""): string {
  const context: AgentContextInput = typeof input === "string"
    ? { workspace: input, userContent: "", memoryHistory: recentMemory }
    : input;
  const memoryContent = context.memoryContent?.trim();
  const memoryHistory = context.memoryHistory?.trim();
  const tools = (context.tools ?? []).map((tool) => `- ${tool.name}${tool.description ? `: ${tool.description}` : ""}`);
  const media = (context.media ?? []).map((item, index) => `- ${index + 1}. ${item}`);
  const modelSettings = formatModelSettings(context.modelSettings);

  return [
    "## Bot Identity",
    context.botIdentity ?? "You are nanobot, a personal AI assistant.",
    "## Runtime Policy",
    context.runtimePolicy ?? "Use available tools when they are needed, and keep responses concise.",
    "## Workspace",
    `Workspace: ${context.workspace}`,
    tools.length > 0 ? `## Available Tools\n${tools.join("\n")}` : "",
    modelSettings ? `## Model Settings\n${modelSettings}` : "",
    memoryContent ? `## Long-term Memory\n${memoryContent}` : "",
    memoryHistory ? `## Recent Memory History\n${memoryHistory}` : "",
    media.length > 0 ? `## Media Breadcrumbs\n${media.join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}

export function buildAgentMessages(input: AgentContextInput): ChatMessage[] {
  return [
    { role: "system", content: buildSystemPrompt(input) },
    ...(input.history ?? []),
    { role: "user", content: input.userContent },
  ];
}

function formatModelSettings(settings: AgentModelSettings | undefined): string {
  if (!settings) {
    return "";
  }

  return [
    settings.model ? `model: ${settings.model}` : "",
    settings.maxTokens !== undefined ? `maxTokens: ${settings.maxTokens}` : "",
    settings.temperature !== undefined ? `temperature: ${settings.temperature}` : "",
    settings.reasoningEffort ? `reasoningEffort: ${settings.reasoningEffort}` : "",
  ].filter(Boolean).join("\n");
}

export function toolCallMessage(toolCall: { id: string; name: string; arguments: JsonObject }): ChatMessage {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: toolCall.id,
        type: "function",
        function: {
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.arguments),
        },
      },
    ],
  };
}

export function toolResultMessage(toolCall: { id: string; name: string }, content: string): ChatMessage {
  return {
    role: "tool",
    name: toolCall.name,
    content,
    tool_call_id: toolCall.id,
  };
}
