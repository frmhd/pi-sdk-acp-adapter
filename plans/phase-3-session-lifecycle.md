# Phase 3 — Session Lifecycle

## Goal

Back ACP sessions with real Pi sessions so Zed can list, load, resume, and manage them as a first-class integration.

## Why This Phase Matters

This is the phase that moves the adapter from a transient bridge to a real ACP agent implementation.

Without it:

- sessions disappear with process restarts,
- `loadSession` is misleading,
- Zed's session history UX cannot shine.

## Scope

In scope:

- Pi `SessionManager` integration
- stable session identity
- real `loadSession`
- `listSessions`
- `unstable_resumeSession`
- `session_info_update`
- message history replay
- close/cleanup behavior

Out of scope:

- permissions, subagents, fake modes, fake MCP

## Tasks

### 1. Introduce Pi-backed session state

Store session state with references to Pi session persistence primitives, not just an in-memory ACP session map.

Potential files:

- `src/adapter/types.ts`
- `src/adapter/AcpAgent.ts`
- `src/runtime/AcpAgentRuntime.ts`

### 2. Use stable session identity

Where possible, the ACP session id should align with Pi's persisted session identity rather than a random adapter-local value.

Potential files:

- `src/adapter/AcpAgent.ts`

### 3. Implement real `loadSession`

Open an existing Pi session and restore active runtime state.

ACP expects history replay before the `loadSession` response completes.

Potential files:

- `src/adapter/AcpAgent.ts`
- maybe new session replay helpers

### 4. Implement `listSessions`

Map Pi session listings into ACP `SessionInfo` values.

Useful Pi APIs already exist:

- `SessionManager.list(cwd)`
- `SessionManager.listAll(cwd)`

Potential files:

- `src/adapter/AcpAgent.ts`
- maybe a new mapper/helper module for session info

### 5. Implement `unstable_resumeSession`

Support resuming an existing session without replaying prior messages.

Potential files:

- `src/adapter/AcpAgent.ts`

### 6. Emit `session_info_update`

Send title and `updatedAt` updates so Zed can keep session metadata fresh.

Potential files:

- `src/adapter/AcpAgent.ts`
- `src/adapter/AcpEventMapper.ts`
- maybe new session metadata helpers

### 7. Replay history for ACP load

Map persisted Pi messages into ACP notifications:

- user -> `user_message_chunk`
- assistant text -> `agent_message_chunk`
- assistant thinking -> `agent_thought_chunk`
- tool-related history -> best-effort tool/session updates

Potential files:

- likely new replay helper module
- `src/adapter/AcpAgent.ts`

### 8. Ensure close/cleanup correctness

`unstable_closeSession` should:

- cancel active work if needed
- dispose the session/runtime
- release resources
- remove active tracking state

Potential files:

- `src/adapter/AcpAgent.ts`

### 9. Tests

Add/update tests for:

- new/load/list/resume/close flows
- metadata updates
- history replay behavior

Potential files:

- new dedicated session lifecycle tests likely recommended

## Acceptance Criteria

- session listing works
- session loading works honestly
- resume works honestly
- session metadata updates reach Zed
- close cleans up correctly
- no misleading capability claims remain
- tests pass

## Suggested Commit Shape

A good Phase 3 commit will likely touch:

- `src/adapter/AcpAgent.ts`
- `src/runtime/AcpAgentRuntime.ts`
- `src/adapter/types.ts`
- one or more new session helper modules
- tests
