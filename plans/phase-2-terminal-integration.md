# Phase 2 — Terminal Integration

## Goal

Make Pi's `bash` tool render as a real live terminal inside Zed using ACP terminal content.

## Why This Phase Matters

This is the most visible Zed-native upgrade.

Without ACP terminal embedding, `bash` appears as generic text output. With it, Pi gets:

- live output streaming
- terminal card UI in Zed
- better status visibility
- closer parity with Zed's reference ACP integrations

## Scope

In scope:

- ACP-aware `bash` wrapper design
- command/args terminal creation semantics
- `toolCallId` <-> `terminalId` association
- terminal content emission
- status synchronization
- exit/truncation metadata handling
- terminal lifecycle cleanup

Out of scope:

- session list/load/resume
- non-bash tool rendering changes already covered in Phase 1

## Tasks

### 1. Design ACP-aware `bash` wrapper

The runtime should know which `toolCallId` owns which ACP terminal.

This likely requires a more direct wrapper than the current generic bridge flow.

Potential files:

- `src/runtime/AcpAgentRuntime.ts`
- `src/adapter/AcpToolBridge.ts`
- `src/adapter/types.ts`

### 2. Use ACP terminal requests correctly

ACP terminals support `command` plus optional `args`.

We should avoid depending on ambiguous shell-string behavior and instead choose an explicit shell strategy, e.g.:

- `sh -lc <command>` on POSIX
- platform-appropriate equivalent elsewhere

Potential files:

- `src/adapter/AcpToolBridge.ts`
- `src/runtime/AcpAgentRuntime.ts`

### 3. Associate tool calls with terminals

Maintain terminal state by `toolCallId` so the mapper can emit terminal-backed tool call payloads.

Potential files:

- `src/adapter/types.ts`
- `src/adapter/AcpAgent.ts`
- `src/adapter/AcpEventMapper.ts`

### 4. Emit terminal content for Zed

Send ACP tool call content of type `terminal` so Zed renders the live terminal widget.

Potential files:

- `src/adapter/AcpEventMapper.ts`
- `src/adapter/types.ts`

### 5. Keep status in sync

Statuses should move through something like:

- `pending`
- `in_progress`
- `completed` or `failed`

and reflect real terminal lifecycle events.

Potential files:

- `src/adapter/AcpEventMapper.ts`
- `src/adapter/AcpToolBridge.ts`

### 6. Carry rich output metadata

Include terminal completion metadata in `rawOutput`, such as:

- exit code
- truncation state
- full output path if present

Potential files:

- `src/adapter/AcpEventMapper.ts`
- `src/adapter/AcpToolBridge.ts`

### 7. Release terminals safely

Ensure `terminal.release()` happens reliably after completion or cancellation.

Potential files:

- `src/adapter/AcpToolBridge.ts`

### 8. Tests

Add/update tests for:

- terminal-backed tool call content
- status transitions
- raw output metadata
- cleanup behavior where testable

Potential files:

- tests for mapper/bridge/runtime pieces

## Acceptance Criteria

- `bash` renders as a terminal-backed execute tool in Zed
- terminal id is associated with the correct tool call
- status transitions are correct
- exit and truncation metadata are retained
- terminals are released safely
- tests pass

## Suggested Commit Shape

A good Phase 2 commit should mostly touch:

- `src/adapter/AcpToolBridge.ts`
- `src/runtime/AcpAgentRuntime.ts`
- `src/adapter/AcpEventMapper.ts`
- `src/adapter/types.ts`
- tests
