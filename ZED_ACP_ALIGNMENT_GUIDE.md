# Pi SDK ACP Adapter - Zed Alignment Guide

## Document Purpose

This guide analyzes the gap between our current ACP adapter implementation and Zed's ACP protocol capabilities, providing a prioritized roadmap for achieving full compatibility.

**Protocol Version Analysis:**

- Zed ACP Protocol Version: `0.10.2`
- Our Adapter SDK Version: `0.18.2`
- Alignment Status: **Partial** - Core functionality works, several extensions missing

---

## Executive Summary

Our adapter successfully implements the base ACP protocol for:

- ✅ Session management (new, load, close)
- ✅ Prompt handling with text content
- ✅ Tool execution (read, write, edit, bash) via delegation
- ✅ Basic session configuration (model, thinking level)
- ✅ Event streaming (message chunks, tool calls, updates)

**Critical Gaps for Zed Compatibility:**

- ❌ `_meta` extension support (tool names, subagent tracking, terminal auth)
- ❌ Client capabilities negotiation
- ❌ Resume session capability
- ❌ Permission/authorization flow
- ❌ Plan streaming
- ❌ Available commands streaming
- ❌ Current mode streaming
- ❌ Subagent session support

---

## 1. Critical Priority: \_META Extensions

Zed heavily relies on `_meta` fields for protocol extensions. These are **NOT** optional - they're required for proper functionality.

### 1.1 Tool Name Storage (CRITICAL)

**Current State:** We don't store the programmatic tool name in `_meta`.

**Zed Implementation:**

```rust
pub const TOOL_NAME_META_KEY: &str = "tool_name";

pub fn tool_name_from_meta(meta: &Option<acp::Meta>) -> Option<SharedString> {
    meta.as_ref()
        .and_then(|m| m.get(TOOL_NAME_META_KEY))
        .and_then(|v| v.as_str())
        .map(|s| SharedString::from(s.to_owned()))
}
```

**Action Required:**

1. Add `TOOL_NAME_META_KEY = "tool_name"` constant in `types.ts`
2. Update `mapToolExecutionStart` in `AcpEventMapper.ts` to include `_meta` with tool name:
   ```typescript
   const toolCall = {
     toolCallId: event.toolCallId,
     rawInput: event.args,
     kind: mapToolKind(event.toolName),
     status: "pending",
     title,
     locations,
     _meta: {
       tool_name: event.toolName, // <-- ADD THIS
     },
   };
   ```

**Files to Modify:**

- `src/adapter/types.ts` - Add constant and helper
- `src/adapter/AcpEventMapper.ts` - Add `_meta` to tool_call notifications

---

### 1.2 Subagent Session Tracking (HIGH)

**Current State:** Not implemented.

**Zed Implementation:**

```rust
pub const SUBAGENT_SESSION_INFO_META_KEY: &str = "subagent_session_info";

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SubagentSessionInfo {
    pub session_id: acp::SessionId,
    pub message_start_index: usize,
    pub message_end_index: Option<usize>,
}
```

**Action Required:**

1. Add subagent support tracking types
2. Store parent-child session relationships in `_meta`
3. Update tool call for `spawn_agent` to include subagent info

**Complexity:** Medium - Requires session relationship tracking

---

### 1.3 Terminal Auth via \_meta (MEDIUM)

**Current State:** Pi handles auth internally, no ACP auth flow.

**Zed Implementation:**

```rust
// Legacy support for terminal auth via _meta
fn meta_terminal_auth_task(...) -> Option<SpawnInTerminal> {
    let meta = match method {
        acp::AuthMethod::EnvVar(env_var) => env_var.meta.as_ref(),
        acp::AuthMethod::Terminal(terminal) => terminal.meta.as_ref(),
        ...
    }?;

    let terminal_auth = serde_json::from_value::<MetaTerminalAuth>(
        meta.get("terminal-auth")?.clone()
    ).ok()?;
    ...
}
```

**Note:** Lower priority since Pi handles auth via `auth.json`. Document as known limitation.

---

## 2. High Priority: Client Capabilities

### 2.1 Initialize Response - Missing Capabilities

**Current State:** Basic capabilities declared, missing critical extensions.

**Zed's Client Capabilities (what they expect from us):**

```rust
ClientCapabilities {
    fs: FileSystemCapabilities {
        read_text_file: true,
        write_text_file: true,
    },
    terminal: true,
    auth: AuthCapabilities {
        terminal: true,
    },
    // _meta extensions:
    terminal_output: true,  // <-- WE DON'T DECLARE THIS
    terminal_auth: true,    // <-- WE DON'T DECLARE THIS
}
```

**Our Current Code:**

```typescript
async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    agentInfo: { ... },
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
      sessionCapabilities: { close: {} },
    },
    authMethods: [],
  };
}
```

**Action Required:**

1. Check if ACP SDK supports `_meta` in capabilities
2. If yes, add terminal output/auth declarations:
   ```typescript
   // In initialize response
   _meta: {
     terminal_output: true,
     terminal_auth: false,  // Pi handles auth internally
   }
   ```

**Files to Modify:**

- `src/adapter/AcpAgent.ts` - `initialize()` method

---

### 2.2 Session Resume Capability

**Current State:** `resume: null` (not supported)

**Zed Implementation:**

```rust
sessionCapabilities: {
    list: Option<()>,
    resume: Option<()>,      // <-- ZED EXPECTS THIS
    close: Option<()>,
}
```

**Action Required:**

1. Change `resume: null` to `resume: {}` in capabilities
2. Implement `resumeSession` method in `AcpAgent`
3. Add session state serialization/deserialization

**Files to Modify:**

- `src/adapter/AcpAgent.ts` - Add `resumeSession` method
- `src/adapter/AcpSessionConfig.ts` - Add session persistence helpers

**Complexity:** High - Requires session state serialization

---

## 3. Medium Priority: Missing Session Update Types

### 3.1 Plan Streaming (SessionUpdate::Plan)

**Zed Implementation:**

```rust
pub enum SessionUpdate {
    ...
    Plan(Plan),  // <-- MISSING IN OUR IMPLEMENTATION
    ...
}

pub struct Plan {
    // Plan content for execution visualization
}
```

**Current State:** We don't emit plan updates.

**Action Required:**

1. Determine if Pi exposes plan information
2. Add `SessionUpdate: "plan"` mapping in `AcpEventMapper.ts`
3. Emit plan updates before tool execution sequences

**Files to Modify:**

- `src/adapter/AcpEventMapper.ts` - Add plan event mapping
- `src/adapter/types.ts` - Add Plan type definitions

---

### 3.2 Available Commands Update

**Zed Implementation:**

```rust
pub enum SessionUpdate {
    ...
    AvailableCommandsUpdate(AvailableCommandsUpdate),
    ...
}
```

**Use Case:** Dynamic command availability based on context.

**Current State:** Not implemented.

**Note:** Lower priority unless Pi supports dynamic command exposure.

---

### 3.3 Current Mode Update

**Zed Implementation:**

```rust
pub enum SessionUpdate {
    ...
    CurrentModeUpdate(CurrentModeUpdate),
    ...
}
```

**Action Required:** Map Pi's thinking level changes to mode updates.

---

## 4. Medium Priority: Permission/Authorization Flow

### 4.1 Tool Call Authorization

**Zed Implementation:**

```rust
pub fn request_tool_call_authorization(
    &mut self,
    tool_call: acp::ToolCallUpdate,
    options: PermissionOptions,
    cx: &mut Context<Self>,
) -> Result<Task<RequestPermissionOutcome>> {
    let status = ToolCallStatus::WaitingForConfirmation {
        options,
        respond_tx: tx,
    };
    self.upsert_tool_call_inner(tool_call, status, cx)?;
}
```

**Current State:** Tools execute without authorization prompts.

**Action Required:**

1. Check if ACP SDK exposes authorization hooks
2. Implement permission checks before tool execution
3. Support `WaitingForConfirmation` status

**Files to Modify:**

- `src/runtime/AcpAgentRuntime.ts` - Add permission hooks
- `src/adapter/AcpEventMapper.ts` - Add permission status types

**Complexity:** High - Requires protocol-level changes

---

## 5. Low Priority: Nice-to-Have Features

### 5.1 Image Support in Prompts

**Current State:** `image: false` in capabilities.

**Zed Capability:**

```rust
promptCapabilities: {
    image: true,  // <-- ZED SUPPORTS THIS
    audio: bool,
    embeddedContext: bool,
}
```

**Note:** Depends on Pi SDK image support. Currently disabled correctly.

---

### 5.2 Additional Directories Support

**Current State:** `additionalDirectories: null` (stored but not exposed)

**Zed Capability:**

```rust
sessionCapabilities: {
    additionalDirectories: Option<()>,  // <-- ZED SUPPORTS THIS
}
```

**Action Required:** Expose additional directories in session capabilities.

---

### 5.3 Session Fork Capability

**Current State:** `fork: null` (not supported)

**Zed Capability:** Present in their implementation.

**Note:** Low priority unless specifically requested.

---

## 6. Code Quality Improvements

### 6.1 ToolKind Mapping Alignment

**Current Issue:** Some tool kinds mapped to "other" that Zed has explicit support for.

**Zed's ToolKind:**

```rust
pub enum ToolKind {
    Read,      // ✅ We use this
    Edit,      // ✅ We use this
    Execute,   // ✅ We use this (for bash)
    Fetch,     // ❌ We map to "other" - should be explicit
}
```

**Action Required:**

1. Check if Pi has fetch capabilities
2. Map appropriately if available

### 6.2 StopReason Alignment

**Current Mapping:**

```typescript
export function mapStopReason(reason: string | undefined): StopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "end_turn";
    case "error":
      return "end_turn";
    case "aborted":
      return "cancelled";
    case "refusal":
      return "refusal";
    default:
      return "end_turn";
  }
}
```

**Zed StopReason:**

```rust
pub enum StopReason {
    EndTurn,
    Cancelled,
    MaxTokens,
    MaxTurnRequests,  // <-- WE DON'T HANDLE THIS
    Refusal,
}
```

**Action Required:** Add `max_turn_requests` mapping if Pi supports it.

---

## 7. Implementation Roadmap

### Phase 1: Critical Fixes (1-2 days)

1. **Tool Name in \_meta**
   - Add `TOOL_NAME_META_KEY` constant
   - Update `mapToolExecutionStart` to include `_meta`
   - Test with Zed to verify tool name display

### Phase 2: Capabilities Alignment (2-3 days)

1. **Client Capabilities**
   - Research ACP SDK `_meta` support in capabilities
   - Add terminal output/auth declarations
2. **Resume Session**
   - Implement session serialization
   - Add `resumeSession` method
   - Test session persistence

### Phase 3: Enhanced Streaming (3-5 days)

1. **Plan Streaming**
   - Research Pi plan exposure
   - Add plan update types
   - Implement mapping
2. **Mode Updates**
   - Map thinking level changes to mode updates

### Phase 4: Authorization (1 week)

1. **Permission Flow**
   - Research ACP SDK authorization API
   - Implement permission checks
   - Add `WaitingForConfirmation` status support

### Phase 5: Testing & Hardening (3-5 days)

1. Integration testing with Zed
2. Edge case handling
3. Performance optimization

---

## 8. Detailed Implementation Notes

### 8.1 \_meta Field Access Pattern

Zed uses this pattern extensively:

```rust
// Extract from Option<Meta>
meta.as_ref()
    .and_then(|m| m.get(KEY))
    .and_then(|v| v.as_str())
```

Our TypeScript equivalent:

```typescript
const toolName = notification.update._meta?.tool_name as string | undefined;
```

### 8.2 Session ID Format

Zed uses UUID-based SessionId. We use:

```typescript
`session_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
```

**Recommendation:** Switch to UUID v4 for full compatibility:

```typescript
import { randomUUID } from "crypto";
const sessionId = randomUUID();
```

### 8.3 Terminal Integration Pattern

Zed links terminals to tool calls via updates. Our current implementation:

```typescript
// In AcpToolBridge.ts - we already do this!
if (this.client.currentToolCallId) {
  this.client.sessionUpdate({
    sessionId: this.client.sessionId,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: this.client.currentToolCallId,
      status: "in_progress",
      content: [{ type: "terminal", terminalId: terminal.id }],
    },
  });
}
```

**Status:** ✅ Already aligned with Zed's pattern!

---

## 9. Testing Checklist

### Unit Tests

- [ ] Tool name extraction from \_meta
- [ ] Session ID format validation
- [ ] Stop reason mapping
- [ ] Tool kind mapping

### Integration Tests

- [ ] Full session lifecycle (new → prompt → close)
- [ ] Tool execution with \_meta verification
- [ ] Session resume functionality
- [ ] Configuration option changes

### Zed Compatibility Tests

- [ ] Connection initialization with Zed
- [ ] Tool display with proper names
- [ ] Terminal output linking
- [ ] Session persistence across reconnects

---

## 10. References

### Zed Implementation Files

| File                                  | Lines     | Purpose                          |
| ------------------------------------- | --------- | -------------------------------- |
| `crates/acp_thread/src/acp_thread.rs` | 50-95     | `_meta` key constants            |
| `crates/acp_thread/src/acp_thread.rs` | 250-350   | `ToolCall` struct and conversion |
| `crates/acp_thread/src/acp_thread.rs` | 1420-1480 | `handle_session_update`          |
| `crates/agent_servers/src/acp.rs`     | 200-350   | Connection initialization        |
| `crates/agent_servers/src/acp.rs`     | 580-630   | Terminal auth via \_meta         |
| `crates/agent/src/thread.rs`          | 2765-2810 | Tool to LLM request conversion   |

### Our Implementation Files

| File                  | Priority | Alignment Status            |
| --------------------- | -------- | --------------------------- |
| `AcpEventMapper.ts`   | Critical | Needs `_meta` support       |
| `AcpAgent.ts`         | High     | Needs capabilities update   |
| `types.ts`            | High     | Needs constants added       |
| `AcpSessionConfig.ts` | Medium   | Needs resume support        |
| `AcpToolBridge.ts`    | Low      | ✅ Terminal pattern aligned |
| `AcpAgentRuntime.ts`  | Medium   | Needs permission hooks      |

---

## Summary

The most critical gap is **\_meta extension support**, particularly the `tool_name` field. Without this, Zed cannot properly identify and display tool calls. The second priority is **client capabilities negotiation** to declare our terminal support properly.

**Immediate Next Steps:**

1. Add `tool_name` to `_meta` in tool call notifications (2 hours)
2. Research ACP SDK capability for `_meta` in initialize (1 hour)
3. Test with Zed editor (2 hours)

**Estimated Total Effort:** 2-3 weeks for full alignment
