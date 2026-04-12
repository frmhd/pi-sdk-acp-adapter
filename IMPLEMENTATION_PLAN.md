# Pi SDK ACP Adapter - Implementation Plan

## Overview

This adapter bridges the **Pi Coding Agent SDK** (`@mariozechner/pi-coding-agent`) with the **Agent Client Protocol (ACP)** (`@agentclientprotocol/sdk`), enabling ACP-compatible clients like Zed to use Pi as their backend coding agent.

## Project Structure

```
pi-sdk-acp-adapter/
├── src/
│   ├── index.ts                    # Main exports
│   ├── adapter/
│   │   ├── AcpAgent.ts            # ACP Agent implementation (implements ACP Agent interface)
│   │   ├── AcpSession.ts          # ACP session management
│   │   ├── AcpToolBridge.ts       # Bridge Pi tools to ACP tool calls
│   │   ├── AcpEventMapper.ts      # Map Pi events to ACP notifications
│   │   └── types.ts              # Adapter-specific types
│   ├── runtime/
│   │   ├── AcpAgentRuntime.ts     # Runtime factory for Pi AgentSession
│   │   └── index.ts
│   └── cli/
│       └── main.ts               # CLI entry point for stdio mode
├── tests/
│   └── *.test.ts
├── package.json
└── tsconfig.json
```

## Documentation References

### ACP Protocol Specification

- **Protocol Overview:** https://agentclientprotocol.com/protocol/overview.md
- **Initialization:** https://agentclientprotocol.com/protocol/initialization.md
- **Session Setup:** https://agentclientprotocol.com/protocol/session-setup.md
- **Prompt Turn:** https://agentclientprotocol.com/protocol/prompt-turn.md
- **Tool Calls:** https://agentclientprotocol.com/protocol/tool-calls.md
- **Terminals:** https://agentclientprotocol.com/protocol/terminals.md
- **Session Config:** https://agentclientprotocol.com/protocol/session-config.md
- **Content:** https://agentclientprotocol.com/protocol/content.md

### ACP SDK Source Files

- **Main exports:** `/node_modules/@agentclientprotocol/sdk/dist/acp.d.ts`
- **Schema types:** `/node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts`
- **Example agent:** `/node_modules/@agentclientprotocol/sdk/dist/examples/agent.js`
- **Protocol version:** `PROTOCOL_VERSION = 1`

### Pi SDK Documentation

- **SDK Docs:** https://raw.githubusercontent.com/badlogic/pi-mono/refs/heads/main/packages/coding-agent/docs/sdk.md
- **Main SDK exports:** `/node_modules/@mariozechner/pi-coding-agent/dist/index.d.ts`
- **AgentSession:** `/node_modules/@mariozechner/pi-coding-agent/dist/core/agent-session.d.ts`
- **SDK factory:** `/node_modules/@mariozechner/pi-coding-agent/dist/core/sdk.d.ts`
- **Session Runtime:** `/node_modules/@mariozechner/pi-coding-agent/dist/core/agent-session-runtime.d.ts`
- **Session Services:** `/node_modules/@mariozechner/pi-coding-agent/dist/core/agent-session-services.d.ts`

### Pi Agent Core Types

- **Agent types:** `/node_modules/@mariozechner/pi-agent-core/dist/types.d.ts`
- **Thinking levels:** `"off" | "minimal" | "low" | "medium" | "high" | "xhigh"`

### Pi AI Types

- **Model type:** `/node_modules/@mariozechner/pi-ai/dist/types.d.ts`
- **Model structure:** `{ id, name, api, provider, baseUrl, reasoning, input, cost, contextWindow, maxTokens }`

---

## Phase 1: Core Adapter Infrastructure

### 1.1 Types Definition

**File:** `src/adapter/types.ts`

```typescript
import type {
  Agent,
  AgentCapabilities,
  SessionCapabilities,
  PromptCapabilities,
} from "@agentclientprotocol/sdk";
import type { AgentSession, Model } from "@mariozechner/pi-coding-agent";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Provider, Model as PiModel } from "@mariozechner/pi-ai";

/** ACP session state */
export interface AcpSessionState {
  sessionId: string;
  session: AgentSession | null;
  cwd: string;
  additionalDirectories: string[];
  currentModelId?: string;
  currentThinkingLevel?: ThinkingLevel;
}

/** Session config for model list and thinking level */
export interface SessionConfigOptions {
  modelList: {
    id: string;
    name: string;
    provider: string;
    reasoning: boolean;
  }[];
  thinkingLevels: ThinkingLevel[];
}

/** Map ACP config option category to Pi setting */
export type ConfigCategory = "model" | "thought_level" | "mode";
```

### 1.2 ACP Event Mapper

**File:** `src/adapter/AcpEventMapper.ts`

Maps Pi `AgentEvent` → ACP `SessionNotification`:

| Pi Event Type                       | ACP SessionUpdate Type | Notes               |
| ----------------------------------- | ---------------------- | ------------------- |
| `message_update` + `text_delta`     | `agent_message_chunk`  | Text content        |
| `message_update` + `thinking_delta` | `reasoning_chunk`      | If supported        |
| `tool_execution_start`              | `tool_call`            | kind from tool name |
| `tool_execution_update`             | `tool_call_update`     | Streaming output    |
| `tool_execution_end`                | `tool_call_update`     | Final result        |
| `agent_end`                         | -                      | Check stopReason    |

**Key mappings to implement:**

```typescript
// Map Pi tool name → ACP ToolKind
function mapToolKind(toolName: string): ToolKind {
  switch (toolName) {
    case "read":
      return "read";
    case "write":
      return "write";
    case "edit":
      return "edit";
    case "bash":
      return "shell";
    case "grep":
      return "search";
    case "find":
      return "search";
    case "ls":
      return "list";
    default:
      return "custom";
  }
}

// Map Pi stopReason → ACP StopReason
function mapStopReason(reason: string): StopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "toolUse":
      return "end_turn";
    case "error":
      return "end_turn";
    case "aborted":
      return "cancelled";
    default:
      return "end_turn";
  }
}
```

**Reference:** ACP schema types at `/node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts`:

- `SessionNotification` (line 4092)
- `ToolCall` (line 4630)
- `ToolCallUpdate` (line 4739)
- `ToolCallStatus` (line 4730)
- `StopReason` (line 4354)

---

## Phase 2: Tool Bridge Implementation

### 2.1 AcpToolBridge

**File:** `src/adapter/AcpToolBridge.ts`

Bridges Pi's built-in tools (read, write, edit, bash, grep, find, ls) to ACP tool call protocol.

**Tool Definition Mapping:**

Pi tools use TypeBox schemas; ACP uses JSON Schema-like structures.

```typescript
interface ToolMapping {
  piToolName: string;
  acpToolKind: ToolKind;
  mapInput: (args: unknown) => Record<string, unknown>;
  mapOutput: (result: unknown) => ToolCallContent[];
}
```

**Built-in tools to support:**

| Pi Tool | ACP Kind | Input Schema                                         | Notes              |
| ------- | -------- | ---------------------------------------------------- | ------------------ |
| `read`  | `read`   | `{ path: string }`                                   | Read file contents |
| `write` | `write`  | `{ path: string, content: string }`                  | Write file         |
| `edit`  | `edit`   | `{ path: string, oldText: string, newText: string }` | Edit file          |
| `bash`  | `shell`  | `{ command: string, cwd?: string }`                  | Execute command    |
| `grep`  | `search` | `{ pattern: string, path?: string }`                 | Search files       |
| `find`  | `search` | `{ path?: string }`                                  | List directory     |
| `ls`    | `list`   | `{ path?: string }`                                  | List directory     |

**Reference:** Pi tool definitions at `/node_modules/@mariozechner/pi-coding-agent/dist/core/tools/index.d.ts`

### 2.2 Terminal Management

ACP supports delegating terminal execution to the client. The adapter should override the Pi SDK's default `bash` tool operations to use ACP's terminal methods instead of spawning local processes.

**Implementation approach:**

1. During initialization, verify if the ACP client supports the `terminal` capability.
2. Override Pi's `BashOperations` when creating tools (e.g., using `operations` in `createCodingTools` or `createBashTool`).
3. When the agent uses the `bash` tool, use `acpConnection.createTerminal(params)` to ask the client to create a terminal.
4. Read output using the returned `TerminalHandle` and stream it back to Pi's tool execution state.
5. Use `TerminalHandle.waitForExit()` to wait for command completion and `TerminalHandle.kill()` to abort if needed.

---

## Phase 3: Session Configuration (Model List & Thinking Level)

### 3.1 Session Config Options

ACP uses `SessionConfigOption` for UI configuration:

**File:** `src/adapter/AcpSessionConfig.ts`

```typescript
/** Generate model list config option */
function createModelConfigOption(
  availableModels: PiModel[],
  currentModelId: string,
): SessionConfigOption {
  return {
    type: "select",
    id: "model",
    name: "Model",
    description: "Select the AI model to use",
    category: "model",
    currentValue: currentModelId,
    options: {
      type: "group",
      options: availableModels.map((model) => ({
        id: model.id,
        label: `${model.name} (${model.provider})`,
        description: model.reasoning ? "Supports thinking" : undefined,
      })),
    },
  };
}

/** Generate thinking level config option */
function createThinkingConfigOption(
  availableLevels: ThinkingLevel[],
  currentLevel: ThinkingLevel,
): SessionConfigOption {
  return {
    type: "select",
    id: "thinking_level",
    name: "Thinking Level",
    description: "Set the model's thinking/reasoning level",
    category: "thought_level",
    currentValue: currentLevel,
    options: {
      type: "group",
      options: availableLevels.map((level) => ({
        id: level,
        label: level.charAt(0).toUpperCase() + level.slice(1),
      })),
    },
  };
}
```

### 3.2 setSessionConfigOption Handler

Handle `session/set_config_option` request:

```typescript
async setSessionConfigOption(params: SetSessionConfigOptionRequest) {
  const { sessionId, configOption } = params;
  const session = this.sessions.get(sessionId);

  switch (configOption.id) {
    case "model":
      const model = this.findModelById(configOption.currentValue);
      if (model) await session.session.setModel(model);
      break;
    case "thinking_level":
      session.session.setThinkingLevel(configOption.currentValue as ThinkingLevel);
      break;
  }

  return {
    configOptions: this.getCurrentConfigOptions(session),
  };
}
```

### 3.3 Model Registry Integration

Use `ModelRegistry` to get available models:

```typescript
import { ModelRegistry } from "@mariozechner/pi-coding-agent";

async function getAvailableModels(modelRegistry: ModelRegistry) {
  const available = await modelRegistry.getAvailable();
  return available.map((model) => ({
    id: model.id,
    name: model.name,
    provider: model.provider,
    reasoning: model.reasoning,
  }));
}
```

**Reference:** `ModelRegistry.getAvailable()` at `/node_modules/@mariozechner/pi-coding-agent/dist/core/model-registry.d.ts`

---

## Phase 4: ACP Agent Implementation

### 4.1 AcpAgent Class

**File:** `src/adapter/AcpAgent.ts`

Implements ACP `Agent` interface:

```typescript
import { Agent, AgentSideConnection } from "@agentclientprotocol/sdk";

export class AcpAgent implements Agent {
  private connection: AgentSideConnection;
  private sessions: Map<string, AcpSessionState>;
  private modelRegistry: ModelRegistry;
  private config: AcpAdapterConfig;

  constructor(connection: AgentSideConnection, config: AcpAdapterConfig) {
    this.connection = connection;
    this.sessions = new Map();
    this.modelRegistry = config.modelRegistry;
    this.config = config;
  }
}
```

### 4.2 Required ACP Methods

| Method                     | Implementation                        | Notes                   |
| -------------------------- | ------------------------------------- | ----------------------- |
| `initialize()`             | Return capabilities, protocol version | Line 1737 in ACP schema |
| `newSession()`             | Create Pi AgentSession                | Line 1796               |
| `prompt()`                 | Forward to session.prompt()           | Line 1803               |
| `cancel()`                 | Call session.abort()                  | Line 1834               |
| `setSessionMode()`         | Optional mode switching               | Line 1815               |
| `setSessionConfigOption()` | Model/thinking level                  | Required for config UI  |
| `authenticate()`           | No auth needed (uses Pi's own auth)   | Line 1720               |
| `loadSession()`            | Optional - not implemented initially  | Line 1776               |

### 4.3 Capability Declaration

In `initialize()` response:

```typescript
async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
  const availableModels = await getAvailableModels(this.modelRegistry);
  const thinkingLevels = this.getSupportedThinkingLevels();

  return {
    protocolVersion: PROTOCOL_VERSION,
    agentInfo: {
      name: "pi-acp-adapter",
      version: "0.1.0",
    },
    agentCapabilities: {
      loadSession: false, // Optional: implement later
      promptCapabilities: {
        image: true,
        audio: false,
        embeddedContext: false,
      },
      sessionCapabilities: {
        list: null,
        fork: null,
        close: null,
        additionalDirectories: null,
        resume: null,
      },
    },
    authMethods: [], // Pi handles its own auth
  };
}
```

**Reference:** ACP schema:

- `InitializeResponse` (line 1770)
- `AgentCapabilities` (line 59)
- `PromptCapabilities` (line 3267)
- `SessionCapabilities` (line 4014)

### 4.4 Prompt Handler

```typescript
async prompt(params: PromptRequest): Promise<PromptResponse> {
  const session = this.sessions.get(params.sessionId);
  if (!session?.session) {
    throw new Error(`Session ${params.sessionId} not found`);
  }

  // Convert ACP ContentBlock[] to text
  const userText = extractTextFromContent(params.prompt);

  // Subscribe to events and forward to connection.sessionUpdate()
  const unsubscribe = session.session.subscribe(event => {
    this.mapAndSendUpdate(params.sessionId, event);
  });

  try {
    await session.session.prompt(userText, {
      images: extractImagesFromContent(params.prompt),
    });

    return {
      stopReason: mapStopReason(session.session.state.model?.stopReason ?? "end_turn"),
    };
  } finally {
    unsubscribe();
  }
}
```

---

## Phase 5: Runtime Factory

### 5.1 AcpAgentRuntime

**File:** `src/runtime/AcpAgentRuntime.ts`

Follows Pi SDK's `AgentSessionRuntime` pattern:

```typescript
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  type CreateAgentSessionRuntimeFactory,
} from "@mariozechner/pi-coding-agent";
import { createCodingTools } from "@mariozechner/pi-coding-agent/dist/core/tools/index.js";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";

export const createAcpAgentRuntime =
  (acpConnection: AgentSideConnection): CreateAgentSessionRuntimeFactory =>
  async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    // IMPORTANT: Delegate FS operations to ACP Client
    // Pi tools support pluggable operations to override default local fs/child_process usage.
    // When the client supports fs.readTextFile/fs.writeTextFile, tools must be configured to use them.
    const tools = createCodingTools(cwd, {
      read: {
        operations: {
          readFile: async (path) => {
            const res = await acpConnection.readTextFile({ path });
            return Buffer.from(res.content, "utf-8");
          },
          access: async (path) => {
            /* Check if client can read it, or rely on read failure */
          },
        },
      },
      write: {
        operations: {
          writeFile: async (path, content) => {
            await acpConnection.writeTextFile({ path, content });
          },
          mkdir: async (dir) => {
            /* Implement via client if supported, else local fallback */
          },
        },
      },
      // Also override edit, ls, bash operations here to delegate to ACP connection
    });

    // Create Pi SDK services with custom delegated tools
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      tools,
    });

    // Create session with ACP-compatible tools
    const result = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
    });

    return {
      ...result,
      services,
      diagnostics: services.diagnostics,
    };
  };
```

**Reference:** `/node_modules/@mariozechner/pi-coding-agent/dist/core/agent-session-runtime.d.ts`

---

## Phase 6: CLI Entry Point

### 6.1 Main CLI

**File:** `src/cli/main.ts`

```typescript
import * as acp from "@agentclientprotocol/sdk";
import { AcpAgent } from "../adapter/AcpAgent";
import { createAcpAgentRuntime } from "../runtime";
import { AgentSessionManager } from "./session-manager";
import { getAgentDir, SettingsManager } from "@mariozechner/pi-coding-agent";

async function main() {
  const config = await loadAdapterConfig();

  // Set up stdio stream first to get connection
  const input = Writable.toWeb(process.stdout);
  const output = Readable.toWeb(process.stdin);
  const stream = acp.ndJsonStream(input, output);

  let agent: AcpAgent;

  // Initialize connection
  const connection = new acp.AgentSideConnection((conn) => {
    // Create session manager for ACP sessions using the connection for tool delegation
    const sessionManager = new AgentSessionManager({
      createRuntime: createAcpAgentRuntime(conn),
      cwd: process.cwd(),
      agentDir: getAgentDir(),
    });

    agent = new AcpAgent(conn, config, sessionManager);
    return agent;
  }, stream);
}

main().catch(console.error);
```

---

## Phase 7: Testing Plan

### 7.1 Unit Tests

| Test                     | Description                          |
| ------------------------ | ------------------------------------ |
| `AcpEventMapper.test.ts` | Event mapping correctness            |
| `ToolBridge.test.ts`     | Tool input/output conversion         |
| `SessionConfig.test.ts`  | Model list and thinking level config |

### 7.2 Integration Tests

| Test               | Description                       |
| ------------------ | --------------------------------- |
| `AcpAgent.test.ts` | Full ACP message flow             |
| `EndToEnd.test.ts` | ACP client → Adapter → Pi session |

---

## Implementation Order

### Phase 1: Core Adapter Infrastructure (Day 1) ✅

- [x] Define adapter types (`src/adapter/types.ts`)
- [x] Implement AcpEventMapper (`src/adapter/AcpEventMapper.ts`)

### Phase 2: Tool Bridge Implementation (Day 1-2) ✅

- [x] Implement AcpToolBridge (`src/adapter/AcpToolBridge.ts`)
- [x] Implement Terminal Management delegation
- [x] Implement Read Operations (via ACP fs.readTextFile)
- [x] Implement Write Operations (via ACP fs.writeTextFile)
- [x] Implement Edit Operations (read + write)
- [x] Implement Grep Operations (via terminal)
- [x] Implement Find Operations (via terminal)
- [x] Implement Ls Operations (via terminal)

### Phase 3: Session Configuration (Day 2) ✅

- [x] Implement SessionConfigOptions (`src/adapter/AcpSessionConfig.ts`)
- [x] Implement setSessionConfigOption Handler
- [x] Implement Model Registry Integration
- [x] Bug fixes applied:
  - All thinking levels supported (including `xhigh`)
  - `getAvailableModels` is synchronous (matches Pi SDK)
  - Proper union type handling via `"type" in params` check
  - Valid `currentValue` always set (falls back to first model)
  - Model lookup uses provider disambiguation
  - `SetConfigResult` provides explicit success/failure feedback
  - `handleSetSessionConfigOption` returns result; `buildSetSessionConfigOptionResponse` builds response

### Phase 4: ACP Agent Implementation (Day 2-3) ✅

- [x] Implement AcpAgent Class (`src/adapter/AcpAgent.ts`)
- [x] Implement `initialize()`, `newSession()`, `prompt()`, `cancel()`, and `setSessionConfigOption()`
- [x] Implement AcpAgentRuntime (`src/runtime/AcpAgentRuntime.ts`)

### Phase 5: Runtime Factory (Day 3-4) ✅

- [x] Implement AcpAgentRuntime with tool delegation (`src/runtime/AcpAgentRuntime.ts`)
- [x] AcpConnectionAdapter to adapt ACP connection to AcpClientInterface
- [x] Read Operations (via ACP fs.readTextFile)
- [x] Write Operations (via ACP fs.writeTextFile)
- [x] Edit Operations (read + write)
- [x] Bash Operations (via ACP terminal)
- [x] Grep Operations (via ACP terminal + isDirectory/readFile for context)
- [x] Find Operations (via ACP terminal)
- [x] Ls Operations (via ACP terminal)

### Phase 6: CLI Entry Point (Day 4)

- [x] Implement Main CLI entry point (`src/cli/main.ts`)
- [x] Configure `package.json` exports and binary

### Phase 7: Testing Plan (Day 4-5)

- [x] Unit tests for core components (see `tests/index.test.ts`)
- [ ] Integration tests (`AcpAgent.test.ts`, `EndToEnd.test.ts`)
- [ ] Manual testing with Zed

---

## Key Interface References

### ACP Agent Interface

```
src/adapter/AcpAgent.ts implements Agent
├── initialize(params: InitializeRequest): Promise<InitializeResponse>
├── newSession(params: NewSessionRequest): Promise<NewSessionResponse>
├── prompt(params: PromptRequest): Promise<PromptResponse>
├── cancel(params: CancelNotification): Promise<void>
├── setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse>
├── authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse>
└── (optional) loadSession, setSessionMode, etc.
```

### Pi SDK Factory Pattern

```
createAgentSession(options?: CreateAgentSessionOptions): Promise<CreateAgentSessionResult>
├── session: AgentSession
├── extensionsResult: LoadExtensionsResult
└── modelFallbackMessage?: string

AgentSession {
  ├── prompt(text: string, options?: PromptOptions): Promise<void>
  ├── subscribe(listener: AgentSessionEventListener): () => void
  ├── setModel(model: Model): Promise<void>
  ├── setThinkingLevel(level: ThinkingLevel): void
  ├── abort(): Promise<void>
  ├── agent: Agent
  └── state: AgentState
}
```

### Event Mapping

```
Pi AgentEvent → ACP SessionNotification
├── message_update.text_delta → agent_message_chunk
├── tool_execution_start → tool_call
├── tool_execution_update → tool_call_update (streaming)
├── tool_execution_end → tool_call_update (final)
└── agent_end → check stopReason
```

---

## Configuration Files

### package.json (update)

```json
{
  "name": "pi-sdk-acp-adapter",
  "exports": {
    ".": "./dist/index.mjs",
    "./cli": "./dist/cli.js"
  },
  "bin": {
    "pi-acp": "./dist/cli.js"
  },
  "dependencies": {
    "@agentclientprotocol/sdk": "^0.18.0",
    "@mariozechner/pi-coding-agent": "^0.66.0"
  }
}
```

---

## Future Enhancements (Out of Scope for V1)

- [ ] Session persistence (loadSession capability)
- [ ] MCP server support
- [ ] NES (Next Edit Suggestions)
- [ ] Session fork/resume
- [ ] Multi-session management
