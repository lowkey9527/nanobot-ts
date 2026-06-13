import { isIP } from "node:net";

import { type ToolDefinition, toolError } from "./types.js";

const DEFAULT_MAX_BYTES = 1_000_000;

export function createWebFetchTool(): ToolDefinition {
  return {
    name: "web_fetch",
    description: "Fetch web content",
    inputSchema: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string" },
        maxBytes: { type: "number" },
      },
    },
    policy: { readOnly: true },
    execute: async (input) => {
      const parsed = parseHttpUrl(String(input.url));
      if (!parsed.ok) {
        return toolError(parsed.error);
      }

      const maxBytes = typeof input.maxBytes === "number" && input.maxBytes > 0 ? Math.floor(input.maxBytes) : DEFAULT_MAX_BYTES;

      try {
        const response = await fetch(parsed.url);
        const text = await response.text();
        const content = text.length > maxBytes ? text.slice(0, maxBytes) : text;

        if (!response.ok) {
          return toolError(`Fetch failed with HTTP ${response.status}: ${content}`);
        }

        return {
          content,
          status: response.status,
          url: response.url || parsed.url,
          truncated: text.length > maxBytes,
        };
      } catch (error) {
        return toolError(`Fetch failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}

function parseHttpUrl(rawUrl: string): { ok: true; url: string } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, error: "Invalid URL" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "Only http(s) URLs are allowed" };
  }

  if (isLocalOrPrivateHost(url.hostname)) {
    return { ok: false, error: "Refusing to fetch local or private network URL" };
  }

  return { ok: true, url: url.toString() };
}

function isLocalOrPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return true;
  }

  const ipVersion = isIP(host);
  if (ipVersion === 4) {
    return isPrivateIpv4(host);
  }

  if (ipVersion === 6) {
    return isPrivateIpv6(host);
  }

  return false;
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".").map((part) => Number(part));
  const [a, b] = parts;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpv6(host: string): boolean {
  return (
    host === "::" ||
    host === "::1" ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    host.startsWith("fe80") ||
    host.startsWith("ff") ||
    host.startsWith("::ffff:127.") ||
    host.startsWith("::ffff:10.") ||
    host.startsWith("::ffff:192.168.")
  );
}
