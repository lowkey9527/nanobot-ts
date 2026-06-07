# Python Nanobot Public Runtime Inventory

This inventory records the Python `../nanobot` runtime surfaces that the
TypeScript rewrite must preserve or explicitly document as exceptions. Sources
reviewed for this first pass:

- `../nanobot/README.md`
- `../nanobot/pyproject.toml`
- `../nanobot/nanobot`
- `../nanobot/tests`
- `../nanobot/bridge`

## CLI Commands

Python entry point: `nanobot = "nanobot.cli.commands:app"` from
`../nanobot/pyproject.toml`.

Primary Typer command surfaces in `../nanobot/nanobot/cli/commands.py`:

- `nanobot onboard`
  - Options: `--workspace/-w`, `--config/-c`, `--wizard`.
  - Creates or refreshes config, applies workspace override, runs optional
    interactive wizard, injects discovered channel plugin defaults, creates the
    workspace, and syncs bundled templates.
- `nanobot gateway`
  - Options include config path and gateway host/port overrides.
  - Starts the bus-backed gateway runtime: provider, sessions, cron, heartbeat,
    agent loop, enabled channels, OpenAI-compatible API, WebUI/WebSocket
    services where configured.
- `nanobot desktop-gateway`
  - Hidden compatibility command used by desktop/WebUI startup paths.
- `nanobot agent`
  - Options include direct `--message/-m`, config path, workspace override,
    session, model, provider, max tokens, context window, temperature, markdown
    rendering, and related runtime controls.
  - Supports one-shot direct mode and interactive prompt mode.
- `nanobot status`
  - Prints config path, workspace path, selected model/preset, and provider
    credential availability without exposing secrets.
- `nanobot provider login <provider>`
  - OAuth login for `openai-codex` and `github-copilot`.
- `nanobot provider logout <provider>`
  - Clears local OAuth credentials for supported OAuth providers.
- `nanobot channels status`
  - Lists discovered channels and whether their config is enabled.
- `nanobot channels login <channel>`
  - Runs channel-specific interactive login where implemented.
- `nanobot plugins list`
  - Lists built-in and entry-point channel plugins with enabled state.

In-chat command surfaces from `../nanobot/docs/chat-commands.md` and
`BUILTIN_COMMAND_SPECS` in `../nanobot/nanobot/command/builtin.py` include
`/new`, `/stop`, `/restart`, `/status`, `/model`, `/model <preset>`,
`/history`, `/goal`, `/dream`, `/dream-log`, `/dream-log <sha>`,
`/dream-restore`, `/dream-restore <sha>`, `/skill`, `/help`, `/pairing`,
`/pairing approve <code>`, `/pairing deny <code>`,
`/pairing revoke <user_id>`, and `/pairing revoke <channel> <user_id>`.

## Config Fields

Root schema: `../nanobot/nanobot/config/schema.py`. Config accepts both
camelCase and snake_case keys through Pydantic alias generation and uses
`NANOBOT_` with `__` as the nested environment delimiter.

Top-level sections:

- `agents`
  - `defaults.workspace`
  - `defaults.modelPreset`
  - `defaults.model`
  - `defaults.provider`
  - `defaults.maxTokens`
  - `defaults.contextWindowTokens`
  - `defaults.contextBlockLimit`
  - `defaults.temperature`
  - `defaults.fallbackModels`
  - `defaults.maxToolIterations`
  - `defaults.maxConcurrentSubagents`
  - `defaults.maxToolResultChars`
  - `defaults.providerRetryMode`
  - `defaults.toolHintMaxLength`
  - `defaults.reasoningEffort`
  - `defaults.timezone`
  - `defaults.botName`
  - `defaults.botIcon`
  - `defaults.unifiedSession`
  - `defaults.disabledSkills`
  - `defaults.idleCompactAfterMinutes`
  - `defaults.maxMessages`
  - `defaults.consolidationRatio`
  - `defaults.dream`
- `agents.defaults.dream`
  - `enabled`
  - `intervalH`
  - `cron`
  - `modelOverride`
  - Deprecated compatibility fields: `maxBatchSize`, `maxIterations`,
    `annotateLineAges`.
- `channels`
  - Global fields: `sendProgress`, `sendToolHints`, `showReasoning`,
    `extractDocumentText`, `sendMaxRetries`, `transcriptionProvider`,
    `transcriptionLanguage`.
  - Extra per-channel fields are allowed and parsed by each channel adapter.
  - Common per-channel concepts include `enabled`, `allowFrom`, `streaming`,
    group policy/isolation, reply/thread metadata, and platform credentials.
- `providers`
  - Provider blocks share `apiKey`, `apiBase`, `apiType`, `extraHeaders`, and
    `extraBody`.
  - Bedrock also supports `region` and `profile`.
  - `providers.openai.apiType` supports `auto`, `chat_completions`, and
    `responses`; other providers must keep `apiType` at `auto`.
- `api`
  - `host`, `port`, `timeout`.
- `gateway`
  - `host`, `port`, `heartbeat`.
- `gateway.heartbeat`
  - `enabled`, `intervalS`, `keepRecentMessages`.
- `tools`
  - `web`, `exec`, `cliApps`, `my`, `imageGeneration`,
    `restrictToWorkspace`, `webuiAllowLocalServiceAccess`, `mcpServers`,
    `ssrfWhitelist`.
- `tools.mcpServers.<name>`
  - `type`, `command`, `args`, `env`, `cwd`, `url`, `headers`,
    `toolTimeout`, `enabledTools`.
- `modelPresets`
  - Named presets with `label`, `model`, `provider`, `maxTokens`,
    `contextWindowTokens`, `temperature`, and `reasoningEffort`.
  - `default` is reserved for the implicit preset derived from
    `agents.defaults`.

Path behavior from `../nanobot/docs/multiple-instances.md`:

- Config defaults to `~/.nanobot/config.json`.
- Workspace defaults to `~/.nanobot/workspace`.
- Runtime data such as cron state follows the selected config directory.
- Workspace-specific state such as memory, sessions, and skills follows the
  selected workspace.
- `--config` and `--workspace` support multiple isolated instances.

## Providers

Registry source: `../nanobot/nanobot/providers/registry.py`.

Provider metadata includes name, model keywords, credential environment key,
display name, backend, gateway/local/OAuth/direct flags, API-base defaults,
prefix stripping, prompt caching support, thinking/reasoning controls, and
model overrides.

Provider list by registry order:

| Provider | Backend | Notes |
| --- | --- | --- |
| `custom` | `openai_compat` | Direct OpenAI-compatible endpoint. |
| `azure_openai` | `azure_openai` | Direct Azure OpenAI endpoint. |
| `bedrock` | `bedrock` | AWS Bedrock Converse. |
| `openrouter` | `openai_compat` | Gateway, `https://openrouter.ai/api/v1`. |
| `huggingface` | `openai_compat` | Gateway, Hugging Face router. |
| `skywork` | `openai_compat` | Gateway, APIFree/Skywork. |
| `aihubmix` | `openai_compat` | Gateway, strips model prefix. |
| `siliconflow` | `openai_compat` | Gateway. |
| `novita` | `openai_compat` | Gateway. |
| `volcengine` | `openai_compat` | Gateway, thinking controls. |
| `volcengine_coding_plan` | `openai_compat` | Coding-plan gateway. |
| `byteplus` | `openai_compat` | Gateway, strips model prefix. |
| `byteplus_coding_plan` | `openai_compat` | Coding-plan gateway. |
| `anthropic` | `anthropic` | Native Anthropic provider. |
| `openai` | `openai_compat` | OpenAI Chat Completions/Responses routing. |
| `openai_codex` | `openai_codex` | OAuth, not API-key fallback. |
| `github_copilot` | `github_copilot` | OAuth, strips model prefix. |
| `deepseek` | `openai_compat` | Thinking controls. |
| `gemini` | `openai_compat` | Google OpenAI-compatible endpoint. |
| `zhipu` | `openai_compat` | Zhipu AI. |
| `dashscope` | `openai_compat` | Qwen/DashScope, thinking toggle. |
| `moonshot` | `openai_compat` | Kimi temperature overrides. |
| `minimax` | `openai_compat` | Generic MiniMax. |
| `minimax_anthropic` | `anthropic` | MiniMax Anthropic-compatible endpoint. |
| `mistral` | `openai_compat` | Mistral. |
| `stepfun` | `openai_compat` | Reasoning may be answer content. |
| `xiaomi_mimo` | `openai_compat` | Thinking controls. |
| `longcat` | `openai_compat` | LongCat. |
| `ant_ling` | `openai_compat` | Ant Ling. |
| `vllm` | `openai_compat` | Local provider. |
| `ollama` | `openai_compat` | Local provider, default `localhost:11434`. |
| `lm_studio` | `openai_compat` | Local provider, default `localhost:1234`. |
| `atomic_chat` | `openai_compat` | Local provider, default `localhost:1337`. |
| `ovms` | `openai_compat` | Local direct OpenVINO Model Server. |
| `nvidia` | `openai_compat` | NVIDIA NIM. |
| `groq` | `openai_compat` | LLM provider and default transcription backend. |
| `qianfan` | `openai_compat` | Baidu Qianfan. |

Provider matching behavior:

- Forced `agents.defaults.provider` wins when it names a registry provider.
- Explicit model prefixes such as `openai/...` or `ollama/...` win over loose
  keyword matching.
- Keyword matching follows registry order.
- Configured local providers can match without provider-specific model
  keywords when their base URL is configured.
- Non-OAuth providers with API keys are used as final fallbacks.
- OAuth providers are never selected as generic fallbacks.

## Tools

Tool loader source: `../nanobot/nanobot/agent/tools/loader.py`. Built-in tools
are discovered by scanning modules under `nanobot.agent.tools`; external tools
can register via Python entry point group `nanobot.tools`. Tool registration is
scope-aware and skips disabled tools based on config.

Tool registry source: `../nanobot/nanobot/agent/tools/registry.py`.

- Registered tools expose schemas for LLM tool calls.
- Definitions are sorted with built-ins first and MCP tools after, producing a
  stable prompt-cache-friendly order.
- Calls are cast and validated before execution.
- Missing or invalid tools return model-visible error strings with retry hints.

Built-in tool modules:

- `apply_patch`
- `cli_apps`
- `cron`
- `exec_session`
- `filesystem`
- `image_generation`
- `long_task`
- `message`
- `search`
- `self`
- `shell`
- `spawn`
- `web` (`web_search`, `web_fetch`)

MCP wrappers are registered dynamically by `mcp.py` using names such as
`mcp_<server>_<tool>`, `mcp_<server>_resource_<name>`, and
`mcp_<server>_prompt_<name>`.

Security-sensitive tool behavior:

- `tools.restrictToWorkspace` restricts filesystem and shell-capable tools.
- `tools.exec.enable` can disable shell execution.
- `tools.exec.sandbox` supports the Linux `bwrap` backend.
- Web fetch/search uses SSRF checks and an optional `tools.ssrfWhitelist`.

## Channels

Discovery source: `../nanobot/nanobot/channels/registry.py`. Built-in channel
modules are scanned lazily; external channel plugins can register through entry
point group `nanobot.channels`. Built-ins take precedence over plugins with the
same name.

Built-in channel adapters:

| Channel key | Display name |
| --- | --- |
| `dingtalk` | DingTalk |
| `discord` | Discord |
| `email` | Email |
| `feishu` | Feishu |
| `matrix` | Matrix |
| `mochat` | Mochat |
| `msteams` | Microsoft Teams |
| `napcat` | Napcat (QQ) |
| `qq` | QQ |
| `signal` | Signal |
| `slack` | Slack |
| `telegram` | Telegram |
| `websocket` | WebSocket |
| `wecom` | WeCom |
| `weixin` | WeChat |
| `whatsapp` | WhatsApp |

Common channel behavior:

- Base channel checks access before publishing inbound messages.
- `allowFrom` can allow all, restrict to known IDs, or rely on pairing-only
  mode.
- `channels.sendProgress`, `channels.sendToolHints`, and
  `channels.showReasoning` control progress/reasoning delivery.
- Channels may opt into streaming by implementing `send_delta`.
- Media is normalized to local paths where downloaded and is attached to
  inbound/outbound bus messages.
- Channel manager retries outbound delivery according to `sendMaxRetries`.

WhatsApp bridge source:

- `../nanobot/bridge` is an existing Node/TypeScript package named
  `nanobot-whatsapp-bridge`.
- It requires Node `>=20.0.0`, uses Baileys, WebSocket transport, and
  `qrcode-terminal`, and exposes build/start/dev scripts.

## Cron

Sources:

- `../nanobot/nanobot/cron/types.py`
- `../nanobot/nanobot/cron/service.py`
- `../nanobot/nanobot/agent/tools/cron.py`

Cron schedule kinds:

- `at` with `atMs`.
- `every` with `everyMs`.
- `cron` with `expr` and optional IANA `tz`.

Cron payload kinds:

- `agent_turn`
- `system_event`

Persisted job fields:

- `id`, `name`, `enabled`, `schedule`, `payload`, `state`, `createdAtMs`,
  `updatedAtMs`, `deleteAfterRun`.
- Runtime state includes next run, last run, last status/error, and a bounded
  run history.

Persistence behavior:

- Jobs are stored in JSON under the runtime/config directory.
- Writes are atomic and fsynced where supported.
- Corrupt stores are preserved with a `.corrupt-<ts>` suffix and are not
  silently overwritten with an empty job list.
- An action log supports cross-instance job updates when the service is not
  running.
- Protected `system_event` jobs cannot be removed or modified by normal cron
  commands.

## Heartbeat

Sources:

- `../nanobot/nanobot/cli/commands.py`
- `../nanobot/nanobot/templates/HEARTBEAT.md`
- `../nanobot/docs/chat-commands.md`

Behavior:

- Gateway heartbeat defaults to enabled.
- It wakes on the configured interval, defaulting to 30 minutes.
- It reads workspace `HEARTBEAT.md`.
- If `## Active Tasks` contains actionable lines, it runs an agent turn with a
  preamble that instructs the model to return only a user-facing message.
- It delivers the result to the most recently active eligible chat channel when
  available.
- If no active tasks exist, heartbeat is skipped silently.

## Sessions

Source: `../nanobot/nanobot/session/manager.py`.

Session behavior:

- Session key is usually `channel:chat_id`.
- `agents.defaults.unifiedSession` can share one session across channels.
- Sessions are persisted under the workspace `sessions` directory as JSONL.
- Legacy global session files are migrated into the workspace on first load.
- Files are written atomically; graceful shutdown can fsync cached sessions.
- Corrupt JSONL lines can be repaired by skipping invalid lines.
- History replay is bounded by `agents.defaults.maxMessages` and token budget.
- History replay avoids orphan tool results and assistant-only prefixes where
  possible.
- User turns can be annotated with message timestamps for relative-date
  reasoning.
- Media, CLI app attachments, and MCP preset attachments are replayed as
  textual breadcrumbs.
- Session files enforce a hard cap and archive/consolidate old prefixes.

## Memory

Sources:

- `../nanobot/docs/memory.md`
- `../nanobot/nanobot/agent/memory.py`
- `../nanobot/nanobot/agent/autocompact.py`
- `../nanobot/nanobot/templates/memory/MEMORY.md`

Memory layers:

- `session.messages` is short-term conversation state.
- `memory/history.jsonl` stores append-only compressed history.
- `SOUL.md`, `USER.md`, and `memory/MEMORY.md` are durable long-term knowledge
  files.

Flow:

- Consolidator summarizes older safe conversation slices into
  `memory/history.jsonl`.
- Dream runs on a schedule or via `/dream`, consumes new history entries, and
  edits long-term memory files.
- Dream changes can be recorded by `GitStore` for audit and restore.
- User commands expose Dream execution, log inspection, and restore.

Config:

- `agents.defaults.dream.enabled`
- `agents.defaults.dream.intervalH`
- `agents.defaults.dream.cron`
- `agents.defaults.consolidationRatio`
- `agents.defaults.idleCompactAfterMinutes`
- `agents.defaults.maxMessages`

## MCP

Sources:

- `../nanobot/docs/configuration.md`
- `../nanobot/nanobot/agent/tools/mcp.py`
- `../nanobot/nanobot/webui/mcp_presets_api.py`
- `../nanobot/nanobot/webui/mcp_presets_runtime.py`

Behavior:

- Config is compatible with Claude Desktop/Cursor server shapes.
- Supports stdio servers via `command`, `args`, `env`, and `cwd`.
- Supports remote HTTP/SSE-style servers via `url` and `headers`.
- Auto-detects server type when possible.
- `enabledTools` can include raw MCP tool names, wrapped nanobot names,
  `["*"]`, or `[]`.
- MCP tools, resources, and prompts are wrapped as normal agent tools.
- Tool wrappers use sanitized `mcp_<server>_...` names.
- Runtime supports reload/reconnect and WebUI MCP preset metadata.

## Templates

Template source: `../nanobot/nanobot/templates`.

Bundled templates:

- `AGENTS.md`
- `HEARTBEAT.md`
- `SOUL.md`
- `USER.md`
- `agent/_snippets/untrusted_content.md`
- `agent/consolidator_archive.md`
- `agent/dream.md`
- `agent/evaluator.md`
- `agent/identity.md`
- `agent/max_iterations_message.md`
- `agent/platform_policy.md`
- `agent/skills_section.md`
- `agent/subagent_announce.md`
- `agent/subagent_system.md`
- `agent/tool_contract.md`
- `memory/MEMORY.md`

Onboarding/runtime template sync creates missing workspace templates without
unexpectedly overwriting user-owned files.

## Skills

Skill loader source: `../nanobot/nanobot/agent/skills.py`.

Behavior:

- Built-in skills live under `../nanobot/nanobot/skills`.
- Workspace skills live under `<workspace>/skills`.
- Workspace skills override built-ins with the same directory name.
- `agents.defaults.disabledSkills` hides named skills.
- Frontmatter can define descriptions, availability requirements, and
  always-load metadata.
- Skill content is progressively loaded into context when needed.

Bundled skill directories:

- `clawhub`
- `cron`
- `github`
- `image-generation`
- `long-goal`
- `memory`
- `my`
- `skill-creator`
- `summarize`
- `tmux`
- `update-setup`
- `weather`

## Tests

Python test inventory source: `../nanobot/tests`.

Major test areas:

- Agent runtime and context:
  - auto compact, consolidator, context builder, prompt cache, Dream,
    evaluator, runner, loop, progress, reasoning, task cancellation, workspace
    scope, session handling, subagents, and skills.
- Tooling:
  - filesystem read/write/edit/list, apply patch, shell exec, exec sessions,
    web search/fetch, MCP, message suppression, sandboxing, schemas, tool
    registry, and validation.
- Providers:
  - Anthropic, Azure OpenAI, Bedrock, custom, GitHub Copilot, OpenAI Codex,
    OpenAI-compatible behavior, Responses API, reasoning, retry behavior,
    fallback, local endpoint detection, image generation, transcription, and
    provider-specific variants.
- Channels:
  - base channel, channel manager, Telegram, Discord, WhatsApp, Feishu,
    DingTalk, Slack, Email, QQ/Napcat, Matrix, Signal, WeCom, Weixin,
    WebSocket, media handling, access control, threading, streaming, markdown,
    and retries.
- Config and paths:
  - config migration, path resolution, environment interpolation, Dream config,
    model presets, multiple-instance behavior.
- Background services:
  - cron persistence, cron service, cron tool listing/schema, heartbeat-related
    loop and chat-command behavior.
- CLI and command routing:
  - Typer commands, interactive input, bot identity, restart command, safe file
    history, model command, skill command, pairing store.
- API/WebUI:
  - OpenAI-compatible API, streaming, attachments, build status, WebUI settings,
    MCP presets, transcripts, workspaces, sidebar state, and thread helpers.
- Security/utilities:
  - network SSRF policy, workspace policy/sandbox, media decoding, artifacts,
    file edit events, restart handling, token estimation, and path utilities.

Test parity expectation:

- TypeScript tests should be ported subsystem-by-subsystem from the Python test
  names above.
- External provider/channel tests should keep live network boundaries mocked
  unless a later task explicitly adds credentialed integration coverage.
