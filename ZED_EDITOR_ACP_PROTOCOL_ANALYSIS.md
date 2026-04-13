# Zed Editor - Agent Client Protocol (ACP) Deep Analysis

## Overview

Zed Editor implements the **Agent Client Protocol (ACP)** - a JSON-RPC 2.0-based protocol for communication between AI agents (servers) and the Zed editor (client). The protocol enables bi-directional streaming communication for tool execution, session management, and real-time updates.

**Protocol Version:** 0.10.2 (as specified in `/home/frmhd/dev/github/zed/Cargo.toml`)

**External Crate:** `agent-client-protocol` (from crates.io)

---

## Architecture

### Communication Model

```
┌─────────────────┐                    ┌──────────────────┐
│   AI Agent      │ ◄──── JSON-RPC ────► │   Zed Editor     │
│  (ACp Server)   │   (stdio/stdio)    │  (ACP Client)    │
└─────────────────┘                    └──────────────────┘
         │                                      │
         │   agent_client_protocol crate        │
         │   (rust types + JSON encoding)       │
         │                                      │
    ┌────▼───────────────────────────────────────▼────┐
    │  Connection: ClientSideConnection            │
    │  - stdin/stdout based message passing        │
    │  - Streaming with request/response correlation │
    └────────────────────────────────────────────────┘
```

### Key Crates

| Crate                   | Path                                               | Purpose                                     |
| ----------------------- | -------------------------------------------------- | ------------------------------------------- |
| `acp_thread`            | `/home/frmhd/dev/github/zed/crates/acp_thread/`    | Main thread handling, session management    |
| `acp_tools`             | `/home/frmhd/dev/github/zed/crates/acp_tools/`     | ACP connection registry and debugging       |
| `agent_servers`         | `/home/frmhd/dev/github/zed/crates/agent_servers/` | External agent server connection management |
| `agent_client_protocol` | External crate (v0.10.2)                           | Protocol types and JSON-RPC implementation  |

---

## 2. Communication Protocol Details

### 2.1 Connection Establishment

**Location:** `/home/frmhd/dev/github/zed/crates/agent_servers/src/acp.rs:200-350`

```rust
// Initialize connection with client capabilities
let response = connection
    .initialize(
        acp::InitializeRequest::new(acp::ProtocolVersion::V1)
            .client_capabilities(
                acp::ClientCapabilities::new()
                    .fs(acp::FileSystemCapabilities::new()
                        .read_text_file(true)
                        .write_text_file(true))
                    .terminal(true)
                    .auth(acp::AuthCapabilities::new().terminal(true))
                    // _META EXTENSION: Terminal output capability
                    .meta(acp::Meta::from_iter([
                        ("terminal_output".into(), true.into()),
                        ("terminal-auth".into(), true.into()),
                    ])),
            )
            .client_info(
                acp::Implementation::new("zed", version)
                    .title(release_channel.map(ToOwned::to_owned)),
            ),
    )
    .await?;
```

### 2.2 Session Management

Sessions are identified by `SessionId` (UUID-based string).

**Operations:**

- `new_session` - Create new session
- `load_session` - Load existing with history replay
- `resume_session` - Resume without history replay
- `close_session` - Close and cleanup

**Location:** `/home/frmhd/dev/github/zed/crates/acp_thread/src/connection.rs:28-94`

---

## 3. Request/Response Types

### 3.1 Prompt Request (User → Agent)

**Location:** `/home/frmhd/dev/github/zed/crates/acp_thread/src/acp_thread.rs:2120-2170`

```rust
// ACP::PromptRequest structure
pub struct PromptRequest {
    pub session_id: SessionId,
    pub prompt: Vec<ContentBlock>,  // User message content
}

// Content block variants
pub enum ContentBlock {
    Text(TextContent),
    ResourceLink(ResourceLink),
    Image(ImageContent),
    Resource(EmbeddedResource),
}
```

### 3.2 Prompt Response (Agent → User)

```rust
pub struct PromptResponse {
    pub stop_reason: StopReason,
}

pub enum StopReason {
    EndTurn,           // Normal completion
    Cancelled,         // User cancelled
    MaxTokens,         // Token limit reached
    MaxTurnRequests,   // Max turns exceeded
    Refusal,           // Model refused
}
```

### 3.3 Session Updates (Streaming from Agent)

**Location:** `/home/frmhd/dev/github/zed/crates/acp_thread/src/acp_thread.rs:1420-1470`

```rust
pub enum SessionUpdate {
    UserMessageChunk(ContentChunk),      // User message echo
    AgentMessageChunk(ContentChunk),     // Assistant text
    AgentThoughtChunk(ContentChunk),     // Thinking/reasoning
    ToolCall(ToolCall),                  // Tool invocation
    ToolCallUpdate(ToolCallUpdate),      // Tool progress update
    Plan(Plan),                          // Execution plan
    SessionInfoUpdate(SessionInfoUpdate), // Title/update
    AvailableCommandsUpdate(AvailableCommandsUpdate),
    CurrentModeUpdate(CurrentModeUpdate),
    ConfigOptionUpdate(ConfigOptionUpdate),
}
```

---

## 4. Tool Call Schema

### 4.1 Core Tool Call Structure

**Location:** `/home/frmhd/dev/github/zed/crates/acp_thread/src/acp_thread.rs:250-330`

```rust
pub struct ToolCall {
    pub tool_call_id: ToolCallId,        // Unique ID (UUID)
    pub title: String,                    // Display title
    pub kind: ToolKind,                   // Type: Read, Edit, Execute, Fetch
    pub content: Vec<ToolCallContent>,    // Output content
    pub status: ToolCallStatus,           // State
    pub locations: Vec<ToolCallLocation>, // File locations
    pub raw_input: Option<Value>,         // Raw JSON input
    pub raw_output: Option<Value>,        // Raw JSON output
    pub meta: Option<Meta>,               // EXTENSION PROPERTIES
}

pub enum ToolKind {
    Read,      // File reading
    Edit,      // File modification
    Execute,   // Terminal/command execution
    Fetch,     // Web/HTTP fetching
}

pub enum ToolCallStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
}
```

### 4.2 Tool Call Update (Incremental Updates)

**Location:** `/home/frmhd/dev/github/zed/crates/acp_thread/src/acp_thread.rs:876-890`

```rust
pub struct ToolCallUpdate {
    pub tool_call_id: ToolCallId,
    pub fields: ToolCallUpdateFields,
    pub meta: Option<Meta>,  // _META extension
}

pub struct ToolCallUpdateFields {
    pub kind: Option<ToolKind>,
    pub status: Option<ToolCallStatus>,
    pub title: Option<String>,
    pub content: Option<Vec<ToolCallContent>>,
    pub locations: Option<Vec<ToolCallLocation>>,
    pub raw_input: Option<Value>,
    pub raw_output: Option<Value>,
}
```

### 4.3 Tool Call Content Types

```rust
pub enum ToolCallContent {
    Content(Content),           // Markdown/text content
    Diff(Diff),                 // File diff (old_text/new_text)
    Terminal(Terminal),         // Terminal reference
}

pub struct Diff {
    pub path: PathBuf,
    pub old_text: Option<String>,
    pub new_text: String,
}

pub struct Terminal {
    pub terminal_id: TerminalId,
}
```

---

## 5. \_META Extensions (Non-Standard Properties)

Zed uses `_meta` fields (across ACP's `Meta` type) for protocol extensions. These are **not** part of the official ACP specification but are crucial for functionality.

### 5.1 TOOL_NAME_META_KEY Extension

**Purpose:** Store the programmatic tool name since ACP's ToolCall lacks a dedicated name field.

**Location:** `/home/frmhd/dev/github/zed/crates/acp_thread/src/acp_thread.rs:50-70`

```rust
/// Key used in ACP ToolCall meta to store the tool's programmatic name.
/// This is a workaround since ACP's ToolCall doesn't have a dedicated name field.
pub const TOOL_NAME_META_KEY: &str = "tool_name";

/// Helper to extract tool name from ACP meta
pub fn tool_name_from_meta(meta: &Option<acp::Meta>) -> Option<SharedString> {
    meta.as_ref()
        .and_then(|m| m.get(TOOL_NAME_META_KEY))
        .and_then(|v| v.as_str())
        .map(|s| SharedString::from(s.to_owned()))
}

/// Helper to create meta with tool name
pub fn meta_with_tool_name(tool_name: &str) -> acp::Meta {
    acp::Meta::from_iter([(TOOL_NAME_META_KEY.into(), tool_name.into())])
}
```

### 5.2 SUBAGENT_SESSION_INFO_META_KEY Extension

**Purpose:** Track subagent session relationships for spawned agents.

**Location:** `/home/frmhd/dev/github/zed/crates/acp_thread/src/acp_thread.rs:72-95`

```rust
/// Key used in ACP ToolCall meta to store the session id and message indexes
pub const SUBAGENT_SESSION_INFO_META_KEY: &str = "subagent_session_info";

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SubagentSessionInfo {
    /// The session id of the subagent session that was spawned
    pub session_id: acp::SessionId,
    /// The index of the message of the start of the "turn" run by this tool call
    pub message_start_index: usize,
    /// The index of the output of the message that the subagent has returned
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_end_index: Option<usize>,
}
```

### 5.3 Terminal Auth Extension (In Client Capabilities)

**Location:** `/home/frmhd/dev/github/zed/crates/agent_servers/src/acp.rs:280-295`

```rust
// In initialize request - indicates terminal-based auth is supported
.meta(acp::Meta::from_iter([
    ("terminal_output".into(), true.into()),      // Agent can send terminal output
    ("terminal-auth".into(), true.into()),       // Terminal-based auth supported
]))
```

### 5.4 Meta-Based Terminal Auth Task

**Location:** `/home/frmhd/dev/github/zed/crates/agent_servers/src/acp.rs:580-630`

```rust
// Legacy support for terminal auth via _meta
fn meta_terminal_auth_task(
    agent_id: &AgentId,
    method_id: &acp::AuthMethodId,
    method: &acp::AuthMethod,
) -> Option<SpawnInTerminal> {
    #[derive(Deserialize)]
    struct MetaTerminalAuth {
        label: String,
        command: String,
        args: Vec<String>,
        env: HashMap<String, String>,
    }

    let meta = match method {
        acp::AuthMethod::EnvVar(env_var) => env_var.meta.as_ref(),
        acp::AuthMethod::Terminal(terminal) => terminal.meta.as_ref(),
        acp::AuthMethod::Agent(agent) => agent.meta.as_ref(),
        _ => None,
    }?;

    // Extract terminal auth config from _meta["terminal-auth"]
    let terminal_auth = serde_json::from_value::<MetaTerminalAuth>(
        meta.get("terminal-auth")?.clone()
    ).ok()?;

    // Build spawn task from meta-defined command
    Some(build_terminal_auth_task(...))
}
```

### 5.5 Tool Permissions in Meta

**Location:** `/home/frmhd/dev/github/zed/crates/acp_thread/src/acp_thread.rs:2030-2050`

```rust
// When requesting tool authorization, permission options are passed
// with the tool call via _meta
pub fn request_tool_call_authorization(
    &mut self,
    tool_call: acp::ToolCallUpdate,
    options: PermissionOptions,
    cx: &mut Context<Self>,
) -> Result<Task<RequestPermissionOutcome>> {
    // ... creates status with options and response channel
    let status = ToolCallStatus::WaitingForConfirmation {
        options,
        respond_tx: tx,
    };
    self.upsert_tool_call_inner(tool_call, status, cx)?;
}
```

---

## 6. Native Agent Tool Integration

### 6.1 Tool Schema Definition

**Location:** `/home/frmhd/dev/github/zed/crates/agent/src/tools/read_file_tool.rs:20-50`

```rust
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct ReadFileToolInput {
    /// The relative path of the file to read.
    pub path: String,
    /// Optional line number to start reading on (1-based index)
    #[serde(default)]
    pub start_line: Option<u32>,
    /// Optional line number to end reading on (1-based index, inclusive)
    #[serde(default)]
    pub end_line: Option<u32>,
}

pub struct ReadFileTool {
    project: Entity<Project>,
    action_log: Entity<ActionLog>,
    update_agent_location: bool,
}

impl AgentTool for ReadFileTool {
    type Input = ReadFileToolInput;
    type Output = LanguageModelToolResultContent;
    const NAME: &'static str = "read_file";

    fn kind() -> acp::ToolKind {
        acp::ToolKind::Read
    }
}
```

### 6.2 ACP Tool to Native Tool Mapping

**Location:** `/home/frmhd/dev/github/zed/crates/agent/src/thread.rs:2768-2800`

```rust
// Convert internal tool to LanguageModelRequestTool for LLM
Some(LanguageModelRequestTool {
    name: tool.name().to_string(),
    description: tool.description(),
    input_schema: tool.input_schema(model.tool_input_format()).log_err()?,
})

// Input schema generation
fn input_schema(format: LanguageModelToolSchemaFormat) -> Schema {
    language_model::tool_schema::root_schema_for::<Self::Input>(format)
}

// Schema adapts to model format (JSON Schema, Anthropic, etc.)
```

---

## 7. JSON-RPC Message Format

### 7.1 Example: Prompt Request (Outgoing)

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "prompt",
  "params": {
    "session_id": "550e8400-e29b-41d4-a716-446655440000",
    "prompt": [
      {
        "type": "text",
        "text": "Read the file src/main.rs"
      }
    ]
  }
}
```

### 7.2 Example: Tool Call (Incoming)

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "type": "ToolCall",
    "tool_call": {
      "tool_call_id": "call-12345",
      "title": "Read file `src/main.rs`",
      "kind": "Read",
      "content": [],
      "status": "Pending",
      "locations": [{ "path": "/home/user/project/src/main.rs", "line": 0 }],
      "raw_input": { "path": "src/main.rs" },
      "_meta": {
        "tool_name": "read_file"
      }
    }
  }
}
```

### 7.3 Example: Tool Call Update (Streaming)

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "type": "ToolCallUpdate",
    "update": {
      "tool_call_id": "call-12345",
      "fields": {
        "status": "InProgress",
        "content": [
          {
            "type": "Content",
            "content": {
              "type": "Text",
              "text": "File content here..."
            }
          }
        ]
      }
    }
  }
}
```

---

## 8. Key Source Files with Line Numbers

### 8.1 Connection & Protocol

| File                                                             | Lines   | Description                          |
| ---------------------------------------------------------------- | ------- | ------------------------------------ |
| `/home/frmhd/dev/github/zed/crates/agent_servers/src/acp.rs`     | 200-350 | Connection initialization, handshake |
| `/home/frmhd/dev/github/zed/crates/agent_servers/src/acp.rs`     | 440-550 | `AgentConnection` impl for ACP       |
| `/home/frmhd/dev/github/zed/crates/acp_thread/src/connection.rs` | 25-100  | `AgentConnection` trait definition   |

### 8.2 Session & Thread Management

| File                                                             | Lines     | Description                             |
| ---------------------------------------------------------------- | --------- | --------------------------------------- |
| `/home/frmhd/dev/github/zed/crates/acp_thread/src/acp_thread.rs` | 470-550   | `AcpThread` struct, session handling    |
| `/home/frmhd/dev/github/zed/crates/acp_thread/src/acp_thread.rs` | 1420-1480 | `handle_session_update` - main dispatch |
| `/home/frmhd/dev/github/zed/crates/agent/src/agent.rs`           | 400-500   | Native agent `AgentConnection` impl     |

### 8.3 Tool Call Handling

| File                                                             | Lines     | Description                            |
| ---------------------------------------------------------------- | --------- | -------------------------------------- |
| `/home/frmhd/dev/github/zed/crates/acp_thread/src/acp_thread.rs` | 50-95     | `_meta` key constants                  |
| `/home/frmhd/dev/github/zed/crates/acp_thread/src/acp_thread.rs` | 250-350   | `ToolCall` struct and conversion       |
| `/home/frmhd/dev/github/zed/crates/acp_thread/src/acp_thread.rs` | 1760-1880 | `update_tool_call`, `upsert_tool_call` |
| `/home/frmhd/dev/github/zed/crates/agent/src/thread.rs`          | 2765-2810 | Tool to LLM request conversion         |

### 8.4 Permission & Authorization

| File                                                             | Lines     | Description                                       |
| ---------------------------------------------------------------- | --------- | ------------------------------------------------- |
| `/home/frmhd/dev/github/zed/crates/acp_thread/src/acp_thread.rs` | 2030-2080 | `request_tool_call_authorization`                 |
| `/home/frmhd/dev/github/zed/crates/agent/src/thread.rs`          | 1180-1280 | `ToolPermissionContext::build_permission_options` |

### 8.5 Message Streaming

| File                                                           | Lines     | Description                                   |
| -------------------------------------------------------------- | --------- | --------------------------------------------- |
| `/home/frmhd/dev/github/zed/crates/acp_tools/src/acp_tools.rs` | 180-280   | `AcpTools` log viewer, message observation    |
| `/home/frmhd/dev/github/zed/crates/agent/src/agent.rs`         | 1570-1640 | `NativeAgentConnection::handle_thread_events` |

---

## 9. Protocol Capabilities

### 9.1 Client Capabilities (Zed → Agent)

```rust
ClientCapabilities {
    fs: FileSystemCapabilities {
        read_text_file: true,
        write_text_file: true,
    },
    terminal: true,
    auth: AuthCapabilities {
        terminal: true,  // Supports terminal-based auth
    },
    // _meta extensions:
    terminal_output: true,  // Can render terminal output
    terminal_auth: true,   // Can spawn auth in terminal
}
```

### 9.2 Agent Capabilities (Agent → Zed)

```rust
AgentCapabilities {
    load_session: bool,      // Can load persisted sessions
    session_capabilities: SessionCapabilities {
        list: Option<()>,
        resume: Option<()>,
        close: Option<()>,
    },
    prompt_capabilities: PromptCapabilities {
        image: bool,
        audio: bool,
        embedded_context: bool,
    },
}
```

---

## 10. Security: Tool Permissions

Zed implements permission checks before tool execution:

**Location:** `/home/frmhd/dev/github/zed/crates/agent/src/thread.rs:1180-1280`

```rust
pub enum PermissionOptionKind {
    AllowOnce,      // Single execution
    AllowAlways,    // Pattern-based always allow
    RejectOnce,     // Single rejection
    RejectAlways,   // Always reject
}

// Permission options attached via _meta
pub struct ToolCallAuthorization {
    pub tool_call: acp::ToolCallUpdate,
    pub options: PermissionOptions,
    pub response: oneshot::Sender<SelectedPermissionOutcome>,
    pub context: Option<ToolPermissionContext>,
}
```

---

## 11. Subagents (Nested Sessions)

Zed supports spawning subagents via `spawn_agent` tool:

**Location:** `/home/frmhd/dev/github/zed/crates/agent/src/agent.rs:2370-2450`

```rust
pub fn create_subagent(&self, label: String, cx: &mut App) -> Result<Rc<dyn SubagentHandle>> {
    let current_depth = parent_thread.depth();
    if current_depth >= MAX_SUBAGENT_DEPTH {
        return Err(anyhow!("Maximum subagent depth ({}) reached", MAX_SUBAGENT_DEPTH));
    }
    // Creates new session with parent reference
    // Stores SUBAGENT_SESSION_INFO in _meta
}
```

**\_Meta Usage:** The `spawn_agent` tool call stores `subagent_session_info` in `_meta` to track the relationship between parent and child sessions.

---

## Summary of \_META Extensions

| Extension             | Key                     | Purpose                                        |
| --------------------- | ----------------------- | ---------------------------------------------- |
| Tool Name             | `tool_name`             | Store programmatic tool name (ACP lacks field) |
| Subagent Tracking     | `subagent_session_info` | Link subagent sessions                         |
| Terminal Capabilities | `terminal_output`       | Client supports terminal output                |
| Auth Method           | `terminal-auth`         | Define terminal-based auth command             |
| Permission Context    | (implicit)              | Tool permissions via authorization flow        |

---

## 12. UI Rendering: Tool Display Mapping (Critical for Agent Developers)

This section describes how Zed renders different tools in the UI. This is critical for external ACP agent developers to ensure proper display of tool calls.

### 12.1 Rendering Architecture: Three-Level Differentiation

Zed determines tool UI appearance through three levels:

1. **`ToolKind`** - Visual icon selection (8 variants)
2. **`ToolCallContent` type** - Content rendering (Text, Diff, Terminal)
3. **Special tool detection** - Subagent, file location handling

**Main Rendering Dispatcher:**

- **File:** `/home/frmhd/dev/github/zed/crates/agent_ui/src/conversation_view/thread_view.rs:6155-6205`

```rust
fn render_tool_call_wrapper(...) -> Div {
    if tool_call.is_subagent() {
        // SPECIAL: Subagent gets nested thread view
        self.render_subagent_tool_call(...)
    } else if tool_call.terminals().next().is_some() {
        // SPECIAL: Terminal gets live output widget
        self.render_terminal_tool_call(...)
    } else {
        // DEFAULT: Standard tool call rendering
        self.render_tool_call(...)
    }
}
```

### 12.2 Level 1: ToolKind → Icon Mapping

**Source:** `/home/frmhd/dev/github/zed/crates/agent_ui/src/conversation_view/thread_view.rs:7229-7239`

| ToolKind     | Icon | IconName         | Usage                    |
| ------------ | ---- | ---------------- | ------------------------ |
| `Read`       | 🔍   | `ToolSearch`     | File reading, searching  |
| `Edit`       | ✏️   | `ToolPencil`     | File modifications       |
| `Delete`     | 🗑️   | `ToolDeleteFile` | File deletion            |
| `Move`       | ↔️   | `ArrowRightLeft` | File movement            |
| `Search`     | 🔍   | `ToolSearch`     | Grep, find operations    |
| `Execute`    | 💻   | `ToolTerminal`   | Terminal commands        |
| `Think`      | 💡   | `ToolThink`      | Reasoning/thinking steps |
| `Fetch`      | 🌐   | `ToolWeb`        | Web requests, URLs       |
| `SwitchMode` | ↔️   | `ArrowRightLeft` | Mode switching           |
| `Other`      | 🔨   | `ToolHammer`     | Generic/MCP tools        |

**Important:** The icon is selected purely by `ToolKind`, not by tool name. Tools with the same `ToolKind` share the same icon unless they have special content handling.

```rust
// Icon selection code
Icon::new(match tool_call.kind {
    acp::ToolKind::Read => IconName::ToolSearch,
    acp::ToolKind::Edit => IconName::ToolPencil,
    acp::ToolKind::Delete => IconName::ToolDeleteFile,
    acp::ToolKind::Move => IconName::ArrowRightLeft,
    acp::ToolKind::Search => IconName::ToolSearch,
    acp::ToolKind::Execute => IconName::ToolTerminal,
    acp::ToolKind::Think => IconName::ToolThink,
    acp::ToolKind::Fetch => IconName::ToolWeb,
    acp::ToolKind::SwitchMode => IconName::ArrowRightLeft,
    acp::ToolKind::Other | _ => IconName::ToolHammer,
})
```

### 12.3 Level 2: Content Type → Rendering Widget

**Source:** `/home/frmhd/dev/github/zed/crates/agent_ui/src/conversation_view/thread_view.rs:7382-7426`

Zed dispatch rendering based on `ToolCallContent` variant:

```rust
fn render_tool_call_content(...) -> AnyElement {
    match content {
        ToolCallContent::ContentBlock(content) => {
            // Standard content: Markdown, text, or images
            match content {
                ResourceLink => render_resource_link(),
                Markdown => render_markdown_output(),
                Image => render_image_output(),
            }
        }
        ToolCallContent::Diff(diff) => {
            // DIFF EDITOR: Side-by-side code diff view
            self.render_diff_editor(entry_ix, diff, tool_call, has_failed, cx)
        }
        ToolCallContent::Terminal(terminal) => {
            // LIVE TERMINAL: Real-time terminal output
            self.render_terminal_tool_call(...)
        }
    }
}
```

#### ContentBlock Rendering (Default)

**Source:** `/home/frmhd/dev/github/zed/crates/agent_ui/src/conversation_view/thread_view.rs:7397-7420`

- **Markdown Text:** Syntax highlighted, clickable links
- **Images:** Direct image display with proper sizing
- **Resource Links:** Clickable file/URL references with icons

**Example:** Standard tool output like `grep` results, `read_file` content

#### Diff Rendering (ToolCallContent::Diff)

**Source:** `/home/frmhd/dev/github/zed/crates/agent_ui/src/conversation_view/thread_view.rs:7430-7460` and `/home/frmhd/dev/github/zed/crates/agent_ui/src/conversation_view/thread_view.rs:7480-7550`

When a tool returns `ToolCallContent::Diff`:

- **Full diff editor** with syntax highlighting
- **Side-by-side or inline** view modes
- **Gutter decorations** showing insertions/deletions
- **Clickable file navigation** (opens file at location)
- **Loading state** while streaming diff

**Visual styling:**

- Top border separator
- Failed edits: Dashed border warning
- In-progress: Loading spinner

**Required for:** `edit_file`, `streaming_edit_file`

#### Terminal Rendering (ToolCallContent::Terminal)

**Source:** `/home/frmhd/dev/github/zed/crates/agent_ui/src/conversation_view/thread_view.rs:5846-6100`

When a tool returns `ToolCallContent::Terminal`:

- **Live terminal output** with ANSI color support
- **Collapsible command header** showing working directory
- **Stop button** (red) while command running
- **Truncation indicator** if output exceeds limits
- **Time elapsed** display for long-running commands
- **Exit status** indicator (success/failure)

**Card layout features:**

```rust
.rounded_md()
.border_1()
.bg(cx.theme().colors().editor_background)
.overflow_hidden()
```

**Required for:** `terminal` tool

### 12.4 Level 3: Special Tool Handling

#### Subagent Detection (spawn_agent)

**Source:** `/home/frmhd/dev/github/zed/crates/agent_ui/src/conversation_view/thread_view.rs:6166-6190` and `/home/frmhd/dev/github/zed/crates/acp_thread/src/acp_thread.rs:435-450`

Zed detects subagent tools via:

1. `_meta["tool_name"] == "spawn_agent"` OR
2. `_meta["subagent_session_info"]` exists

**UI differences for subagent:**

- **Agent icon** instead of tool icon: `Icon::new(self.agent_icon)`
- **Nested thread view** showing complete subagent conversation
- **Indentation** in the thread hierarchy
- **Session ID linking** via `subagent_session_info`
- **No backdrop blur** (simpler styling)

**Detection code:**

```rust
pub fn is_subagent(&self) -> bool {
    self.tool_name.as_ref().is_some_and(|s| s == "spawn_agent")
        || self.subagent_session_info.is_some()
}
```

#### File Location Handling

**Source:** `/home/frmhd/dev/github/zed/crates/agent_ui/src/conversation_view/thread_view.rs:7188-7220`

When `tool_call.locations.len() == 1`:

- **File icon** extracted from path extension: `FileIcons::get_icon(path, cx)`
- **Clickable header** navigates to file (Ctrl+Click)
- **Tooltip:** "Go to File"
- **Label:** Shows filename with path styling

**Example:** `read_file`, `edit_file` with single location

### 12.5 Layout Variants by Tool Category

**Source:** `/home/frmhd/dev/github/zed/crates/agent_ui/src/conversation_view/thread_view.rs:6248-6280`

| Category          | Condition                                          | Layout                    | Styling                             |
| ----------------- | -------------------------------------------------- | ------------------------- | ----------------------------------- |
| **Card Layout**   | `needs_confirmation \|\| is_edit \|\| is_terminal` | Bordered card with header | `rounded_md`, `border_1`, editor bg |
| **Inline Layout** | Default                                            | Left border only          | `border_l_1`, panel bg              |
| **Compact**       | File with location                                 | Minimal spacing           | `ml_4` margins                      |

**Card layout code:**

```rust
let use_card_layout = needs_confirmation || is_edit || is_terminal_tool;

if use_card_layout {
    this.my_1p5()
        .rounded_md()
        .border_1()
        .when(failed_or_canceled, |this| this.border_dashed())
        .border_color(self.tool_card_border_color(cx))
        .bg(cx.theme().colors().editor_background)
        .overflow_hidden()
} else {
    // Inline: just left border
    this.my_1().ml(rems(0.4)).px_3p5().border_l_1()
}
```

### 12.6 Raw Input Display Rules

**Source:** `/home/frmhd/dev/github/zed/crates/agent_ui/src/conversation_view/thread_view.rs:6260-6270`

Raw input (JSON arguments) is shown as collapsible JSON, but **hidden** for:

- Terminal tools (`is_terminal_tool`) - Command shown in header instead
- Edit tools (`is_edit`) - Diff shown instead
- Image tools (`has_image_content`) - Image shown instead

```rust
let should_show_raw_input = !is_terminal_tool && !is_edit && !has_image_content;
```

### 12.7 Status-Based Visual Effects

**Source:** `/home/frmhd/dev/github/zed/crates/agent_ui/src/conversation_view/thread_view.rs:6218-6245`

| Status                  | Visual Effect                                 |
| ----------------------- | --------------------------------------------- |
| **InProgress**          | Animated spinner: `.with_rotate_animation(2)` |
| **Failed/Canceled**     | Dashed border + warning decoration            |
| **WaitingConfirmation** | Expanded by default + permission buttons      |
| **Completed**           | Collapsible disclosure (chevron)              |

### 12.8 Complete Tool Mapping Reference

| Tool Name                | ToolKind  | Content Type              | Icon       | Special UI                        |
| ------------------------ | --------- | ------------------------- | ---------- | --------------------------------- |
| `read_file`              | `Read`    | `ContentBlock` (Markdown) | Search     | File icon, clickable location     |
| `edit_file`              | `Edit`    | `Diff`                    | Pencil     | Diff editor, card layout          |
| `streaming_edit_file`    | `Edit`    | `Diff` (streaming)        | Pencil     | Live diff updates                 |
| `terminal`               | `Execute` | `Terminal`                | Terminal   | Live terminal widget, stop button |
| `spawn_agent`            | `Execute` | `ContentBlock`            | Agent\*    | Nested thread, subagent view      |
| `fetch`                  | `Fetch`   | `ContentBlock`            | Web        | External link styling             |
| `search_web`             | `Fetch`   | `ContentBlock`            | Web        | Search results                    |
| `grep`                   | `Search`  | `ContentBlock`            | Search     | File result list                  |
| `find_path`              | `Search`  | `ContentBlock`            | Search     | File results                      |
| `list_directory`         | `Read`    | `ContentBlock`            | Search     | Directory tree                    |
| `copy_path`              | `Execute` | `ContentBlock`            | Move       | Simple status                     |
| `move_path`              | `Execute` | `ContentBlock`            | Move       | Path display                      |
| `delete_path`            | `Execute` | `ContentBlock`            | DeleteFile | Warning styling                   |
| `create_directory`       | `Execute` | `ContentBlock`            | Hammer     | Status message                    |
| `save_file`              | `Execute` | `ContentBlock`            | Pencil     | File save confirmation            |
| `diagnostics`            | `Read`    | `ContentBlock`            | Search     | Error/warning list                |
| `now`                    | `Read`    | `ContentBlock`            | Hammer     | Simple text                       |
| `open`                   | `Execute` | `ContentBlock`            | Terminal   | File opening status               |
| `restore_file_from_disk` | `Execute` | `ContentBlock`            | Hammer     | Restore confirmation              |
| `update_plan`            | `Execute` | `ContentBlock`            | Hammer     | Plan checklist                    |
| MCP tools                | `Other`   | `ContentBlock`            | Hammer     | Generic rendering                 |

\* Subagent uses agent icon via `is_subagent()` detection

### 12.9 Best Practices for External Agents

To ensure proper display in Zed:

1. **Set `ToolKind` correctly:**
   - Use `Edit` for file modifications (enables diff view)
   - Use `Execute` for terminal commands (enables terminal widget)
   - Use `Read` for file queries (enables file icon)
   - Use `Fetch` for web requests

2. **Include proper content:**
   - Edit tools: Return `ToolCallContent::Diff` with `old_text`/`new_text`
   - Terminal tools: Return `ToolCallContent::Terminal` with terminal_id
   - Other tools: Return `ToolCallContent::Content` with markdown

3. **Set `_meta["tool_name"]`:**
   - Required for subagent detection (`"spawn_agent"`)
   - Used for permission pattern matching

4. **Set `locations` for file tools:**
   - Enables file icon extraction
   - Enables "Go to File" navigation
   - Single location = file icon, multiple = generic

5. **Stream updates properly:**
   - Send `ToolCallUpdate` with incremental content
   - Update `status` to `InProgress` → `Completed`/`Failed`

### 12.10 Example: Proper Tool Call Response

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "type": "ToolCall",
    "tool_call": {
      "tool_call_id": "call_123",
      "title": "Edit file `src/main.rs`",
      "kind": "Edit",
      "content": [
        {
          "type": "Diff",
          "diff": {
            "path": "/home/user/project/src/main.rs",
            "old_text": "fn old() {}",
            "new_text": "fn new() {}"
          }
        }
      ],
      "status": "Completed",
      "locations": [{ "path": "/home/user/project/src/main.rs", "line": 42 }],
      "raw_input": { "path": "src/main.rs", "changes": "..." },
      "_meta": {
        "tool_name": "edit_file"
      }
    }
  }
}
```

---

## References

1. **Agent Client Protocol Crate:** https://crates.io/crates/agent-client-protocol (v0.10.2)
2. **Zed ACP Implementation:** `/home/frmhd/dev/github/zed/crates/acp_thread/`
3. **External Agent Support:** `/home/frmhd/dev/github/zed/crates/agent_servers/src/acp.rs`
4. **Native Agent:** `/home/frmhd/dev/github/zed/crates/agent/src/agent.rs`
5. **UI Rendering - Thread View:** `/home/frmhd/dev/github/zed/crates/agent_ui/src/conversation_view/thread_view.rs`
6. **Tool Icons:** `/home/frmhd/dev/github/zed/crates/icons/src/icons.rs`
7. **Tool Definitions:** `/home/frmhd/dev/github/zed/crates/agent/src/tools/`
