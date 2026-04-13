# Phase 0 — Correctness and Honesty

## Goal

Make the adapter honest, stable, and easier to evolve before we optimize Zed-specific rendering.

This phase is about fixing protocol claims, identity, capability handling, and code surface area.

## Why This Phase Comes First

Right now the adapter over-claims some ACP capabilities and mixes Pi's intended 4-tool model with extra bridge abstractions.

If we do not fix that first:

- Zed may rely on features we do not really support,
- later work on sessions and rendering will build on misleading assumptions,
- the adapter will remain harder to maintain.

## Scope

In scope:

- agent identity and version cleanup
- client capability capture
- honest capability advertisement
- graceful degradation on missing client capabilities
- cleanup of non-Pi tool bridge surface
- tests for initialization/capability behavior

Out of scope:

- real session persistence
- terminal embedding
- diff rendering improvements

## Tasks

### 1. Agent identity and version

Update the adapter so `initialize()` returns Pi-facing identity:

- `agentInfo.name = "pi"`
- `agentInfo.title = "Pi Coding Agent"`
- `agentInfo.version` derived from `package.json`

Potential files:

- `src/adapter/AcpAgent.ts`
- `src/cli.ts`
- maybe a shared version helper if useful

### 2. Capture client capabilities

Store the incoming `InitializeRequest` capabilities in adapter state and make them accessible to runtime/tool layers.

At minimum we need to know whether the client supports:

- file reads
- file writes
- terminals

Potential files:

- `src/adapter/AcpAgent.ts`
- `src/adapter/types.ts`
- `src/runtime/AcpAgentRuntime.ts`

### 3. Honest capability advertisement

If real persistence/list/resume is not implemented yet, do not advertise it.

Review and correct:

- `loadSession`
- `sessionCapabilities.list`
- `sessionCapabilities.resume`

Keep only what is truly supported.

Potential files:

- `src/adapter/AcpAgent.ts`

### 4. Capability-based degradation

When the client does not support required ACP client methods:

- fail early with a clear error, or
- disable unsupported functionality in a predictable way

For Pi in Zed, missing fs or terminal capabilities should likely be treated as a hard incompatibility.

Potential files:

- `src/adapter/AcpAgent.ts`
- `src/runtime/AcpAgentRuntime.ts`
- `src/adapter/AcpToolBridge.ts`

### 5. Adapter surface cleanup

Remove or isolate bridge code that does not match the intended Pi-facing tool surface:

- `grep`
- `find`
- `ls`

This does not mean deleting useful code blindly; it means making the adapter's public behavior clearly centered on Pi's 4 tools.

Potential files:

- `src/adapter/AcpToolBridge.ts`
- `src/runtime/AcpAgentRuntime.ts`
- `src/index.ts`

### 6. Tests

Add or update tests for:

- `initialize()` payload
- honest capability advertisement
- identity/version values
- failure/degradation behavior for missing client capabilities where applicable

Potential files:

- `tests/index.test.ts`
- add new test files if clearer

## Acceptance Criteria

- adapter identifies itself clearly as Pi
- version is not hardcoded separately from package metadata
- unsupported capabilities are no longer advertised
- client capabilities are captured and used
- adapter surface is clearly aligned with Pi's 4-tool model
- tests pass

## Suggested Commit Shape

A good Phase 0 commit should mostly touch:

- `src/adapter/AcpAgent.ts`
- `src/runtime/AcpAgentRuntime.ts`
- `src/adapter/AcpToolBridge.ts`
- `src/adapter/types.ts`
- tests
