import { type JsonObject } from "../config/schema.js";
import { OutboundMessage, type InboundMessageInput, type OutboundMessageInput } from "../bus/events.js";
import { MessageBus } from "../bus/queue.js";

import { type ToolDefinition } from "./types.js";

export { InboundMessage, OutboundMessage } from "../bus/events.js";
export { MessageBus } from "../bus/queue.js";

export interface MessageRoute {
  channel: string;
  chatId: string;
  senderId?: string;
}

export type MessageMetadata = JsonObject;

export type InboundMessageOptions = InboundMessageInput;
export type OutboundMessageOptions = OutboundMessageInput;

export interface MessageToolOptions {
  bus: MessageBus;
  route: MessageRoute;
}

export function createSendMessageTool(options: MessageToolOptions): ToolDefinition {
  return {
    name: "send_message",
    description: "Send an outbound message on the configured route",
    inputSchema: {
      type: "object",
      required: ["content"],
      properties: { content: { type: "string" } },
    },
    policy: {},
    execute: async (input) => {
      await options.bus.publishOutbound(
        new OutboundMessage({
          channel: options.route.channel,
          chatId: options.route.chatId,
          content: String(input.content),
        }),
      );
      return { content: "Message sent" };
    },
  };
}
