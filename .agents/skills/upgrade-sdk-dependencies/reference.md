# SDK Integration Reference

Adapter-specific map for dependency upgrade analysis.

## Dependency roles

| Package                           | Role in this adapter                                                         |
| --------------------------------- | ---------------------------------------------------------------------------- |
| `@agentclientprotocol/sdk`        | ACP wire protocol, `Agent` / `AgentSideConnection`, types                    |
| `@earendil-works/pi-coding-agent` | `createAgentSession`, `SessionManager`, tools, `AuthStorage`, slash commands |
| `@earendil-works/pi-ai`           | `Model`, `Provider`, OAuth types, `completeSimple` (title generation)        |
| `@earendil-works/pi-agent-core`   | `ThinkingLevel`, `AgentEvent`                                                |

All four `@earendil-works/pi-*` packages must stay version-aligned.

## ACP methods implemented today

| Method                   | File                                    | Notes                                                                        |
| ------------------------ | --------------------------------------- | ---------------------------------------------------------------------------- |
| `initialize`             | `src/adapter/AcpAgent.ts`               | Advertises `loadSession`, session list/resume/close, `additionalDirectories` |
| `newSession`             | `src/adapter/AcpAgent.ts`               | Honors `additionalDirectories` from client                                   |
| `loadSession`            | `src/adapter/AcpAgent.ts`               | Replays history via `sessionHistoryReplay.ts`                                |
| `listSessions`           | `src/adapter/AcpAgent.ts`               | Uses `listPersistedPiSessions` + `buildAcpSessionInfo`                       |
| `resumeSession`          | `src/adapter/AcpAgent.ts`               | No history replay                                                            |
| `closeSession`           | `src/adapter/AcpAgent.ts`               | In-memory teardown only                                                      |
| `prompt` / `cancel`      | `src/adapter/agent/promptExecution.ts`  |                                                                              |
| `setSessionConfigOption` | `src/adapter/session/configHandlers.ts` | Model + thinking level                                                       |
| `authenticate`           | `src/adapter/AcpAgent.ts`               | Terminal OAuth pre-requisite check                                           |

### Not implemented (optional after ACP 0.23–0.25)

- `deleteSession` — persisted file deletion
- `logout` — `AuthStorage.logout(provider)`

## Capability vs implementation mismatches

Watch for code that **handles** a feature but **does not advertise** it in `initialize()`:

```typescript
// src/adapter/AcpAgent.ts — sessionCapabilities
additionalDirectories: {
} // advertise when supported
```

`additionalDirectories` flows through:

- `src/runtime/toolSelection.ts` → authorized roots for read/write/edit/bash
- `src/adapter/tools/authorization.ts` → `getAuthorizedRoots(cwd, additionalDirectories)`
- `src/adapter/resolvePromptPaths.ts` → prompt attachment paths

## pi-ai patch rationale

File: `patches/@earendil-works__pi-ai@*.patch`

Fixes in `dist/providers/openai-completions.js`:

1. Keep thinking blocks with empty `thinking` but non-empty `thinkingSignature` (DeepSeek replay)
2. Set `content: ""` when `tool_calls` present and `content === null` (provider rejection)

Re-apply after every `pi-ai` version bump until upstream includes equivalent logic.

## Session persistence quirks

- ACP sessions stored under `~/.pi/agent/sessions/--<cwd-encoded>--/` via `getAcpSessionDirectory`
- Cross-project listing uses `SessionManager.listAll` when `listSessions` has no `cwd` (Pi 0.77+)
- Pi `SessionInfo` has `name`, `cwd`, `firstMessage` — **no** `additionalDirectories` field
- Session titles: explicit name → first user message → `session_info` entries (`sessionMetadata.ts`)

## Terminal auth (Pi 0.77+)

`src/auth/terminalAuth.ts` wires Pi OAuth with device-code and login-method selection callbacks. After `pi-coding-agent` bumps, verify `OAuthSelectPrompt` / `onSelect` signatures still match.

## Commands for release-note mining

```bash
# ACP SDK commits between versions
gh api repos/agentclientprotocol/typescript-sdk/compare/v0.22.1...v0.25.0 \
  --jq '.commits[].commit.message' | head -30

# Inspect exported Agent interface from a version
mkdir -p /tmp/acp-inspect && cd /tmp/acp-inspect
npm pack @agentclientprotocol/sdk@<version>
tar -xzf agentclientprotocol-sdk-*.tgz
rg 'deleteSession|logout|additionalDirectories' package/dist/acp.d.ts
```

## Validation gate

Every upgrade must pass:

```bash
CI=true pnpm install --no-frozen-lockfile
vp check    # format + oxlint + typecheck
vp test     # vitest via Vite+
```

Target: zero type errors, all tests green before marking work complete.
