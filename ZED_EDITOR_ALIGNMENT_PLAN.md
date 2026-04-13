# Zed Editor Alignment Plan for `pi-sdk-acp-adapter`

Companion document to `ZED_EDITOR_ACP_PROTOCOL_ANALYSIS.md`.

## Executive Summary

We should make `pi-sdk-acp-adapter` feel native inside Zed **without pretending Pi is Zed’s own agent**.

That means:

- embrace ACP and Zed’s rendering model where it improves UX,
- represent Pi honestly as a distinct agent,
- keep Pi’s design choices intact:
  - only 4 core tools (`read`, `write`, `edit`, `bash`),
  - no permission system,
  - no built-in plan mode,
  - no subagents,
  - no MCP requirement.

The adapter should therefore optimize for:

1. **correct ACP semantics**,
2. **best possible Zed UI rendering**,
3. **Pi-native behavior and philosophy**,
4. **stable session lifecycle and persistence**.

---

## What “first class citizen in Zed” should mean for Pi

Pi should feel excellent in Zed in the following ways:

- Zed clearly shows the agent as **Pi** with proper name/version.
- Pi tool calls render with the **best Zed-native widgets**:
  - `read` → file/read UI
  - `edit` → diff UI
  - `write` → diff/add UI instead of generic hammer output
  - `bash` → live terminal UI instead of plain text blobs
- Session list/load/resume works like a real agent integration, not like a single-process toy session map.
- Session titles and timestamps appear in Zed’s session history.
- Model + thinking level config appears naturally through ACP session config options.
- Pi does **not** fake unsupported features just to imitate Zed’s internal agent.

Non-goals:

- Do **not** invent a permission flow just because Zed supports it.
- Do **not** add fake subagent support.
- Do **not** expand Pi’s tool surface to mirror Zed’s larger internal tool catalog.
- Do **not** claim MCP support unless Pi actually supports the requested MCP transports through a real integration.

---

## Reference Inputs Used

### This repo

- `src/adapter/AcpAgent.ts`
- `src/adapter/AcpEventMapper.ts`
- `src/runtime/AcpAgentRuntime.ts`
- `src/adapter/types.ts`
- `src/adapter/AcpToolBridge.ts`

### Zed implementation

- `/home/frmhd/dev/github/zed/crates/agent_servers/src/acp.rs`
- `/home/frmhd/dev/github/zed/crates/acp_thread/src/acp_thread.rs`
- `/home/frmhd/dev/github/zed/crates/agent_ui/src/conversation_view/thread_view.rs`
- `/home/frmhd/dev/github/zed/Cargo.toml`

### ACP docs

- `https://agentclientprotocol.com/protocol/initialization.md`
- `https://agentclientprotocol.com/protocol/tool-calls.md`
- `https://agentclientprotocol.com/protocol/terminals.md`
- `https://agentclientprotocol.com/protocol/session-config-options.md`
- `https://agentclientprotocol.com/protocol/session-setup.md`
- `https://agentclientprotocol.com/protocol/session-list.md`
- `https://agentclientprotocol.com/announcements/implementation-information.md`

### Pi SDK / docs

- `node_modules/@mariozechner/pi-coding-agent/README.md`
- `node_modules/@mariozechner/pi-coding-agent/docs/sdk.md`
- `node_modules/@mariozechner/pi-coding-agent/docs/session.md`
- `node_modules/@mariozechner/pi-agent-core/README.md`
- `node_modules/@mariozechner/pi-coding-agent/docs/rpc.md`

---

## Current State Assessment

## What is already good

- ACP stdio transport exists and is structured reasonably.
- `agentInfo` is returned.
- Session config options for **model** and **thinking level** already exist.
- `_meta.tool_name` is already emitted.
- File `locations` are set for some tools.
- `edit` already attempts ACP diff rendering.
- `@path` expansion is implemented for prompt text.

## Biggest gaps

### 1. Session capabilities are overstated

Current adapter advertises `loadSession: true`, but `loadSession()` only checks the in-memory map. That is not ACP-compliant and not Zed-grade behavior.

Impact:

- Zed may think Pi supports real persistent session restore.
- Reloading the adapter process loses all sessions.
- Session history UX is misleading.

### 2. No `session/list`, no real `resume`, no session metadata updates

Zed supports session discovery and displays titles / update timestamps. The adapter currently has no real bridge for that.

Impact:

- Pi does not feel integrated with Zed’s session UX.
- Existing Pi session persistence is unused.

### 3. `bash` is not using ACP terminal embedding correctly

Current runtime delegates bash through `terminal/create`, but ACP updates are mapped back into plain text content. That means Zed cannot render the live terminal card that its UI is built for.

Also, current terminal creation appears shell-string-oriented, while ACP terminal requests are command + args oriented.

Impact:

- poor Zed rendering,
- likely weaker command fidelity,
- loses one of the best ACP/Zed UX affordances.

### 4. `write` is mapped to `other`

In Zed, `ToolKind::Other` renders as a generic hammer. For Pi, a file write is semantically much closer to an edit / file mutation.

Impact:

- file creation/overwrite looks generic,
- misses Zed diff UI,
- Pi appears less polished than it should.

### 5. Diff tracking is fragile

Current code stores only one `lastEditDiff` per session.

Impact:

- wrong diff can be attached if multiple tool calls happen in one turn,
- concurrent or repeated edits are unsafe,
- `write` is not represented as diff at all.

### 6. Tool result mapping is too text-only

Pi tool updates/results already carry structured `content` and `details`, but current mapper reduces almost everything to extracted text.

Impact:

- images are lost,
- edit diff metadata is ignored,
- bash truncation/full-output metadata is ignored,
- raw output is underused.

### 7. Client capability negotiation is not really used

The adapter currently ignores the initialize request payload for practical runtime behavior.

Impact:

- the adapter cannot degrade cleanly if a client lacks fs/terminal support,
- protocol alignment is weaker than it should be.

### 8. Pi-specific scope is blurred by dead abstractions

`AcpToolBridge.ts` still contains grep/find/ls bridge code even though this adapter should represent Pi’s 4-tool model.

Impact:

- unnecessary complexity,
- confusing design story,
- harder to keep the adapter honest and maintainable.

---

## Pi-Specific Alignment Principles

### 1. Align the UI, not the identity

Pi should not masquerade as “Zed Agent”.

Recommended identity:

- `agentInfo.name`: `pi`
- `agentInfo.title`: `Pi Coding Agent`
- `agentInfo.version`: adapter package version, ideally plus Pi SDK version in `_meta`

### 2. Keep Pi’s 4-tool philosophy

The adapter should expose Pi as:

- `read`
- `write`
- `edit`
- `bash`

Do not synthesize `grep`, `find`, `list_directory`, `spawn_agent`, `update_plan`, etc. just to mirror Zed.

### 3. Use ACP/Zed rendering primitives aggressively

We should absolutely use:

- `ToolKind`
- `ToolCallContent::Diff`
- `ToolCallContent::Terminal`
- `locations`
- `rawInput`
- `rawOutput`
- `session_info_update`
- `configOptions`

These are protocol/UI features, not product philosophy compromises.

### 4. Be explicit about intentional omissions

Pi intentionally omits:

- permissions,
- plan mode,
- subagents,
- built-in MCP,
- large built-in tool catalogs.

The adapter should simply not advertise or invoke those ACP features.

---

## Target Tool Mapping for Zed

| Pi tool | ACP kind  | Zed goal            | Required ACP content                                     | Notes                                                                    |
| ------- | --------- | ------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------ |
| `read`  | `read`    | file/read rendering | text or image content, `locations`                       | preserve Pi read content, including images when present                  |
| `edit`  | `edit`    | diff card           | `diff` content                                           | use Pi edit diff/details; include changed line when available            |
| `write` | `edit`    | diff/add card       | `diff` content with `oldText = null` or previous content | represent creation/overwrite as file mutation, not generic `other`       |
| `bash`  | `execute` | live terminal card  | `terminal` content                                       | embed real ACP terminal; optionally add summary/raw output on completion |

## Recommended per-tool behavior

### `read`

- `kind = read`
- title format: `Read <path>`
- always set `_meta.tool_name = "read"`
- always set `locations` with absolute path
- if request includes offset/limit, include a line location when possible
- preserve structured output from Pi:
  - text -> ACP text content
  - image -> ACP image content

### `edit`

- `kind = edit`
- title format: `Edit <path>`
- use ACP `diff` content, not plain text summary
- pull diff from Pi’s edit result/details instead of only manual old/new interception
- set location line from `firstChangedLine` when available
- include `rawInput` and optionally `rawOutput`

### `write`

- **map as `kind = edit`**, not `other`
- title format: `Write <path>` or `Create <path>` when file did not exist
- produce ACP `diff` content:
  - file create: `oldText = null`, `newText = ...`
  - overwrite: `oldText = previous file content`, `newText = ...`
- set single file location so Zed gives file navigation

This is the single most important visual improvement after terminal embedding.

### `bash`

- `kind = execute`
- title format: command summary, e.g. `Run: npm test`
- create ACP terminal and attach `ToolCallContent::Terminal` immediately
- keep tool call status in sync with terminal lifecycle
- release terminal when done, but only after Zed has the terminal id embedded in the tool call
- include `rawInput` command/timeout and `rawOutput` exit/truncation metadata

This is what will make Pi look genuinely native in Zed.

---

## Zed-Specific Rendering Rules We Should Target

Based on Zed’s ACP implementation:

1. **Tool kind drives icon choice.**
   - `read` → search icon
   - `edit` → pencil icon
   - `execute` → terminal icon
   - `other` → hammer icon

2. **Diff content triggers the real diff editor.**
   If we want first-class file mutation UX, we must emit ACP diff content.

3. **Terminal content triggers the live terminal widget.**
   If we only emit text for bash, we lose the best Zed UX.

4. **Single location enables better file affordances.**
   Absolute file paths should be attached whenever a tool targets one file.

5. **`_meta.tool_name` should always be set.**
   Zed already relies on it for some special cases and general metadata.

6. **Raw input is useful except for edit/terminal-heavy tools.**
   Zed hides raw input for some tool types anyway, so sending it is still fine.

---

## Recommended Session Lifecycle Design

## Goal

Back ACP sessions with **real Pi sessions**, not just a transient in-memory map.

## Proposed session model

For each ACP session, store:

- ACP session id
- Pi `AgentSession`
- Pi `SessionManager`
- session file path
- cwd
- additional directories
- current model id
- current thinking level
- title
- updatedAt
- per-tool-call state map

## Session ID strategy

Use Pi’s persisted session identity as the ACP `sessionId` whenever possible.

Recommended rule:

- persistent session: use Pi session header/session id
- truly ephemeral session: generate adapter-local id and mark it non-persistent internally

Do **not** use `session_${Date.now()}_${random}` for all cases.

## Capabilities to implement honestly

### Must support well

- `session/new`
- `session/prompt`
- `session/cancel`
- `session/update`
- `session/set_config_option`
- `session/close`

### Should support next

- `loadSession`
- `listSessions`
- `unstable_resumeSession`
- `session_info_update`

### Should not advertise yet unless truly implemented

- `fork`
- MCP capabilities
- permissions
- mode switching
- subagents

---

## Concrete Session Plan

### Phase A: stop overstating support

If real persistent load/list/resume is not implemented yet:

- set `loadSession: false`
- set `sessionCapabilities.list = null`
- set `sessionCapabilities.resume = null`

This is the minimum correctness fix.

### Phase B: implement Pi-backed persistence

Use Pi session APIs already available in the SDK:

- `SessionManager.create(cwd)`
- `SessionManager.open(path)`
- `SessionManager.continueRecent(cwd)`
- `SessionManager.list(cwd)`
- `SessionManager.listAll(cwd)`

Adapter behavior:

- `session/new` -> create persistent Pi session unless explicitly configured ephemeral
- `session/list` -> map `SessionManager.list` / `listAll` into ACP session info
- `session/load` -> open the selected Pi session and replay history
- `session/resume` -> open without replay
- `session/close` -> dispose runtime and flush session metadata

### Phase C: history replay for `loadSession`

ACP requires replaying prior conversation through `session/update` notifications.

Map Pi session file entries to ACP updates:

- Pi `user` message -> `user_message_chunk`
- Pi `assistant` text -> `agent_message_chunk`
- Pi `assistant` thinking -> `agent_thought_chunk`
- Pi tool calls/results -> reconstructed `tool_call` / `tool_call_update` where possible
- Pi `bashExecution` messages -> execute tool history or summarized terminal result

For initial alignment, it is acceptable to replay message history faithfully even if historical tool replay is summarized.

### Phase D: session metadata updates

Emit `session_info_update` with at least:

- `title`
- `updatedAt`

Suggested title strategy:

- first meaningful user prompt, trimmed
- or Pi session listing’s `firstMessage`
- capped to a sane length

This immediately improves Zed’s session history UX.

---

## Recommended Runtime / Tool Architecture Changes

## 1. Replace fragile global diff capture with per-tool-call state

Current `lastEditDiff` should become something like:

```ts
pendingToolCalls: Map<
  string,
  {
    toolName: "read" | "write" | "edit" | "bash";
    path?: string;
    terminalId?: string;
    diff?: { path: string; oldText?: string | null; newText: string };
    rawInput?: unknown;
    rawOutput?: unknown;
  }
>;
```

This avoids cross-talk between multiple tool calls.

## 2. Move from generic event inference to ACP-aware tool wrappers

Pi custom tool execution receives `toolCallId`. That is exactly what we need.

Recommended direction:

- build ACP-aware wrappers around Pi’s 4 tools,
- delegate actual work to Pi built-ins or custom operations,
- capture `toolCallId`-specific metadata at execution time.

This is especially important for:

- `bash` terminal id association,
- `write` diff capture,
- `edit` diff capture,
- richer raw output/details.

## 3. Prefer Pi tool result details over reverse-engineering text

Pi already exposes structured tool result details:

- `EditToolDetails.diff`
- `EditToolDetails.firstChangedLine`
- `BashToolDetails.truncation`
- `BashToolDetails.fullOutputPath`
- `ReadToolDetails.truncation`

The ACP mapper should use these directly instead of extracting strings from arbitrary result shapes.

## 4. Preserve structured tool content

Current mapper should stop collapsing everything into text.

Needed mapping layer:

- Pi text content -> ACP text content
- Pi image content -> ACP image content
- Pi diff details -> ACP diff content
- Pi terminal details -> ACP terminal content

---

## Bash / Terminal Alignment Plan

This deserves its own section because it is the most visible gap in Zed.

## Desired behavior

When Pi runs `bash` in Zed:

- Zed should show a terminal card with live output,
- the user should see the command running in real time,
- completion/failure should update the same tool call,
- output truncation metadata should remain available.

## Implementation direction

### Preferred

Create a Pi custom `bash` wrapper that:

1. receives `toolCallId`,
2. creates an ACP terminal immediately,
3. stores `terminalId` in per-tool-call state,
4. emits partial updates whose details include terminal association,
5. finishes with exit metadata.

Then the ACP event mapper can emit:

- `tool_call` with terminal content immediately, or
- `tool_call_update` that upgrades the tool call to terminal content as soon as the id exists.

### Important protocol detail

ACP terminal requests are command + args based. We should not rely on passing a full shell command as a raw executable string unless that is explicitly intentional.

Recommended execution model:

- POSIX: run `sh -lc <command>` or configurable shell wrapper
- Windows: platform-aware equivalent

That keeps Pi’s bash semantics while remaining ACP-correct.

---

## Config Option Plan

Current model + thinking level support is directionally correct and should stay.

Recommendations:

- keep config order as:
  1. `model`
  2. `thinking_level`
- make labels cleaner and Pi-branded
- derive current values from the active Pi session, not only cached adapter state
- if a config change occurs outside the adapter in future, emit `config_option_update` when useful

Do **not** add a fake mode config just to imitate Zed’s mode UX.

---

## MCP, Permissions, Modes, Subagents

## MCP

ACP session requests may include `mcpServers`, but Pi core explicitly does not center MCP.

Plan:

- do not advertise ACP MCP capabilities unless there is a real Pi-side implementation,
- explicitly document that MCP is currently unsupported by the adapter,
- later, if Pi gains an extension/package-based MCP integration, bridge that honestly.

## Permissions

Pi intentionally has no permission popup system.

Plan:

- never call `session/request_permission`
- do not emulate ask/code modes just for Zed
- let Zed treat Pi as an always-autonomous ACP agent

## Modes / plan mode

Do not implement fake `session/set_mode` support.
Use session config options only for things Pi truly has.

## Subagents

Do not emit `spawn_agent` or related `_meta` structures.

---

## Implementation Phases

## Phase 0 — Correctness and honesty

Priority: **P0**

- derive `agentInfo.version` from `package.json`
- rename identity to Pi-facing values (`pi`, `Pi Coding Agent`)
- stop advertising unsupported capabilities (`loadSession`, `list`, `resume`) until real
- store client capabilities from `initialize`
- fail or degrade cleanly if required fs/terminal capabilities are missing
- remove or quarantine grep/find/ls code paths that do not match Pi’s intended surface

## Phase 1 — Zed UI alignment for tools

Priority: **P0**

- map `write` -> `edit`
- emit ACP diff content for both `edit` and `write`
- replace session-global diff capture with per-tool-call state
- preserve structured Pi content instead of text-only extraction
- improve titles, locations, and raw input/output mapping

## Phase 2 — Real terminal integration

Priority: **P0**

- introduce ACP-aware `bash` wrapper using real terminal ids
- emit terminal content so Zed shows live terminal cards
- use ACP-correct command/args execution model
- attach exit/truncation metadata in raw output

## Phase 3 — Real session lifecycle

Priority: **P1**

- back sessions with Pi `SessionManager`
- implement honest `loadSession`
- implement `listSessions`
- implement `unstable_resumeSession`
- implement `session_info_update`
- replay history correctly on load

## Phase 4 — Polish and compatibility hardening

Priority: **P2**

- improve image/resource output mapping
- add tests for Zed-facing payload shapes
- add compatibility matrix in README
- prepare registry/distribution story for easier Zed installation if desired

---

## Suggested Acceptance Criteria

The adapter can be considered “first class in Zed” when all of the following are true:

### Identity

- Zed shows the agent as **Pi Coding Agent**
- version is accurate and not hardcoded separately from package metadata

### Tool rendering

- `read` shows as a file/read tool with file navigation
- `edit` shows in Zed’s diff editor
- `write` also shows as a diff/add card, not a hammer
- `bash` shows in Zed’s terminal card with live output

### Sessions

- Zed can list Pi sessions
- Zed can load an old Pi session and see replayed history
- Zed can resume a Pi session without replay when requested
- Zed shows titles and updated timestamps

### Config

- model selector works
- thinking level selector works
- no fake mode selector exists

### Philosophy preservation

- no permission prompts are introduced
- no fake subagent behavior exists
- only Pi’s real 4 tools are exposed

---

## Recommended Immediate Next Steps

1. **Fix capability honesty first**
   - stop claiming `loadSession` until it is real

2. **Implement proper `write` and `edit` diff mapping**
   - biggest visual win after terminal integration

3. **Implement real terminal embedding for `bash`**
   - biggest Zed-native UX win overall

4. **Replace ephemeral session map with Pi-backed session persistence**
   - enables load/list/resume/session_info_update

5. **Refactor mapper around per-tool-call state**
   - necessary foundation for correct diffs and terminals

---

## Final Recommendation

We should treat **Zed as the reference ACP client implementation for UX**, but **Pi as the reference product implementation for agent behavior**.

In practice:

- follow Zed’s ACP rendering model very closely,
- use ACP features that improve presentation and lifecycle,
- keep Pi’s philosophy intact,
- never fake product features Pi intentionally does not have.

That is the right path to making `pi-acp-adapter` a true first-class citizen in Zed.
