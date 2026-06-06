---
name: upgrade-sdk-dependencies
description: >-
  Analyze and upgrade @agentclientprotocol/sdk and @earendil-works/pi-* dependencies
  in pi-sdk-acp-adapter. Use when updating SDK versions, checking what is new in
  upstream libs, planning dependency bumps, refreshing pnpm patches, or exposing
  new stable ACP capabilities after an SDK release.
---

# Upgrade SDK Dependencies

Workflow for bumping `@agentclientprotocol/sdk` and `@earendil-works/pi-*` in this repo.

## When to use

- User asks to update, upgrade, or analyze SDK dependencies
- `package.json` pins to older `@agentclientprotocol/sdk` or `@earendil-works/pi-*` versions
- Upstream released new ACP or Pi versions and adapter parity is unclear

## Phase 1 — Analyze before changing code

### 1. Establish the version gap

```bash
pnpm view @agentclientprotocol/sdk version
pnpm view @earendil-works/pi-agent-core version
pnpm view @earendil-works/pi-ai version
pnpm view @earendil-works/pi-coding-agent version
```

Compare with `package.json` dependencies (lines 48–52).

Keep all four `@earendil-works/pi-*` packages on the **same version**.

### 2. Read upstream release notes

```bash
gh release list --repo agentclientprotocol/typescript-sdk --limit 10
gh release list --repo earendil-works/pi --limit 10
gh release view <tag> --repo <repo> --json body -q .body
```

Focus on releases **after** the pinned version. Group findings:

| Category             | Examples                                                                    |
| -------------------- | --------------------------------------------------------------------------- |
| **Automatic wins**   | Provider fixes, new models, perf — no adapter code                          |
| **Adapter gaps**     | New stable ACP methods (`deleteSession`, `logout`, `additionalDirectories`) |
| **Breaking / risky** | Removed `unstable_*` APIs, schema changes, renamed exports                  |

### 3. Map usage in this repo

```bash
rg 'from ["'\''"]@earendil-works|from ["'\''"]@agentclientprotocol' src/
rg 'unstable_|deleteSession|logout|additionalDirectories|SessionManager|createAgentSession' src/ tests/
```

Pay attention to:

- `src/adapter/AcpAgent.ts` — ACP `Agent` implementation and `agentCapabilities`
- `src/runtime/` — Pi tool wrappers and `createAgentSession`
- `src/auth/terminalAuth.ts` — OAuth / `AuthStorage`
- `patches/` and `pnpm-workspace.yaml` — `patchedDependencies`

### 4. Check pnpm patches

This project patches `@earendil-works/pi-ai` for DeepSeek reasoning replay. After bumping `pi-ai`:

1. Read `patches/@earendil-works__pi-ai@<version>.patch`
2. Confirm upstream 0.78+ still lacks the fix (grep `thinkingSignature`, `tool_calls && assistantMsg.content`)
3. Rename patch file to match the new version key in `pnpm-workspace.yaml`

Do **not** drop the patch assuming upstream fixed it without verifying.

### 5. Trial upgrade (recommended for unknown jumps)

In an isolated copy:

```bash
cp -a . /tmp/pi-acp-upgrade-test && cd /tmp/pi-acp-upgrade-test
# bump package.json + pnpm-workspace.yaml patch key
CI=true pnpm install --no-frozen-lockfile
vp check && vp test
```

If this passes, the mechanical upgrade is low-risk. Remaining work is optional ACP feature parity.

### 6. Present findings to the user

Use this structure:

```markdown
## Version gap

| Package | Current | Latest |

## What's new upstream

(bullet per release, split ACP vs Pi)

## What a bare bump gives automatically

## New capabilities we could expose (optional)

## Upgrade plan

- Required: version bump, patch refresh, install, validate, CHANGELOG
- Recommended: advertise/fix capability mismatches (e.g. additionalDirectories)
- Optional: new ACP methods (deleteSession, logout, session naming)

## Risks / watchouts
```

Classify work as **required**, **recommended**, or **optional**. Implement only what the user asks for.

---

## Phase 2 — Implement the upgrade

### Checklist

```
- [ ] Bump package.json dependency versions
- [ ] Refresh/rename pi-ai patch + pnpm-workspace.yaml patchedDependencies key
- [ ] Apply recommended adapter changes (if requested)
- [ ] CI=true pnpm install --no-frozen-lockfile
- [ ] vp check
- [ ] vp test
- [ ] Update CHANGELOG.md [Unreleased]
```

### Required steps

1. **Bump `package.json`** — pin exact versions (no `^` on SDK deps):

```json
"@agentclientprotocol/sdk": "<latest>",
"@earendil-works/pi-agent-core": "<latest>",
"@earendil-works/pi-ai": "<latest>",
"@earendil-works/pi-coding-agent": "<latest>"
```

2. **Patch file** — name must match version:

```
patches/@earendil-works__pi-ai@<version>.patch
```

```yaml
# pnpm-workspace.yaml
patchedDependencies:
  "@earendil-works/pi-ai@<version>": patches/@earendil-works__pi-ai@<version>.patch
```

3. **Install and validate**

```bash
CI=true pnpm install --no-frozen-lockfile
vp check
vp test
```

4. **CHANGELOG** — under `[Unreleased]`, note:
   - New dependency versions
   - Patch refresh
   - Any capability or behavior changes

### Recommended adapter fixes (common after ACP bumps)

| Issue                                                                                   | Fix                                                                            |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `additionalDirectories` implemented but `additionalDirectories: null` in `initialize()` | Set `additionalDirectories: {}` in `sessionCapabilities`                       |
| `session/list` omits extra roots                                                        | Pass active session roots into `buildAcpSessionInfo()`                         |
| Initialize test drift                                                                   | Assert `additionalDirectories: {}` in `tests/adapter/agent.initialize.test.ts` |

Pi does **not** persist `additionalDirectories` on disk — only include them for active in-memory sessions.

### Optional follow-ups (only when user requests)

| ACP API               | Adapter hook                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------- |
| `deleteSession`       | Close in-memory session + `unlink` persisted JSONL via `SessionManager.getSessionFile()` |
| `logout`              | `modelRegistry.authStorage.logout(providerId)`                                           |
| Session display names | Pi 0.78+ `AgentSession.setSessionName()`                                                 |

Advertise new capabilities in `initialize()` only when implemented.

---

## Phase 3 — Tests to add or update

| Change                                  | Test location                                                                    |
| --------------------------------------- | -------------------------------------------------------------------------------- |
| Capability advertisement                | `tests/adapter/agent.initialize.test.ts`                                         |
| `buildAcpSessionInfo` + additional dirs | `tests/session-metadata.test.ts`                                                 |
| Tool authorization / additional dirs    | `tests/runtime-read-fallback.test.ts`, `tests/tool-bridge-authorization.test.ts` |
| Session lifecycle                       | `tests/session-lifecycle.test.ts`                                                |

Add focused tests for new behavior; do not duplicate obvious assertions.

---

## Project constraints

- **Toolchain**: Vite+ — use `vp check` and `vp test`, not raw `tsc`/`vitest` (see `AGENTS.md`)
- **Package manager**: pnpm (`packageManager` field in `package.json`)
- **Scope**: Minimize diff — dependency upgrades should not refactor unrelated code
- **Commits**: Only when user explicitly asks
- **Do not edit** `CHANGELOG.md` sections for already-released versions

---

## Quick reference

| Artifact              | Path                                     |
| --------------------- | ---------------------------------------- |
| Dependency pins       | `package.json`                           |
| pi-ai patch           | `patches/@earendil-works__pi-ai@*.patch` |
| Patch config          | `pnpm-workspace.yaml`                    |
| ACP agent surface     | `src/adapter/AcpAgent.ts`                |
| Session list metadata | `src/adapter/session/sessionMetadata.ts` |
| Upstream ACP repo     | `agentclientprotocol/typescript-sdk`     |
| Upstream Pi repo      | `earendil-works/pi`                      |

For integration touchpoints and capability mapping, see [reference.md](reference.md).
