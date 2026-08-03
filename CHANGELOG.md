# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.2.0] - 2026-08-03

### Removed

- **Breaking: removed ACP client filesystem and terminal delegation.** The adapter no longer routes Pi's `read`, `edit`, `write`, and `bash` tools through ACP client `fs/*` or `terminal/*` methods, and no longer applies adapter-owned path authorization. Pi now creates and executes its own built-in tools directly, with the adapter acting as an observation-only presentation layer (tool cards, locations, edit/write diff cards, structured output, and plain text bash output). Prompt text is passed to Pi unchanged (`@path` preprocessing removed). `additionalDirectories` remains session metadata but no longer gates Pi tools.
- **Breaking: removed public capability/terminal helpers.** Removed `getMissingRequiredClientCapabilities()`, `createMissingClientCapabilitiesMessage()`, `createTerminalContent()`, the `AcpBashTerminalRawOutput` type, and the `supportsReadTextFile` / `supportsWriteTextFile` / `supportsTerminal` fields of `AcpClientCapabilitiesSnapshot` (terminal auth via `supportsTerminalAuth` and client identity via `clientInfo` are retained).
- `CreateAcpAgentRuntimeOptions` no longer accepts `acpConnection`, `clientCapabilities`, `sessionId`, or `additionalDirectories`; `createAcpAgentRuntimeFactory()` no longer closes over an ACP client context.
- Removed the `AcpToolBridge`, `AcpConnectionAdapter`, ACP/local/hybrid tool operation backends, terminal request helpers, and adapter pager environment overrides.

### Changed

- Updated `@agentclientprotocol/sdk` to 1.3.0 and `@earendil-works/pi-*` packages to 0.83.0.
- Migrated the adapter from the deprecated `ModelRegistry` facade to the canonical `ModelRuntime` (`ModelRuntime.create()` in the CLI, `modelRuntime` in `AcpAdapterConfig`/`CreateAcpAgentRuntimeOptions`, `session.modelRuntime` for title generation). Session titles now use `ModelRuntime.completeSimple` with `checkAuth`-gated auth; terminal OAuth runs against `ModelRuntime` providers and `login(providerId, "oauth", { prompt, notify })`, with per-prompt `AbortSignal` support.
- `authenticate()` now refreshes/reloads the `ModelRuntime` (via the new optional `reloadModelRuntime` config callback, used by the CLI to re-read `auth.json` written by the terminal auth process) and validates auth with `checkAuth(providerId)`.
- Added `max` to the advertised thinking levels.
- Removed the `@earendil-works/pi-ai` DeepSeek reasoning replay patch; upstream provider fixes make it unnecessary.
- Advertise stable `additionalDirectories` session capability and include active session roots in `session/list` responses.
- Terminal OAuth login now supports device-code and login-method selection callbacks required by Pi 0.77.
- Cross-project session listing uses `SessionManager.listAll` for custom ACP session directories (Pi 0.77 cwd scoping).

### Removed

- DeepSeek reasoning replay tests and the `pi-ai` pnpm patch.

### Breaking Changes

- Requires ACP SDK 1.3.0 and Pi 0.83.0, with runtime integrations migrated to `ModelRuntime` and `AcpAgentClientContext`.
- ACP clients no longer handle filesystem or terminal operations; the adapter now observes Pi’s built-in tools.
- Removed the adapter-provided subagent tool and the `usage` configuration option.

### New Features

- Advertises `additionalDirectories` support and includes additional directories in session listings.
- Persists per-model thinking-level preferences across sessions.
- Adds an agent skill for upgrading SDK dependencies.

### Bug Fixes

- Prompt failures are now returned gracefully as ACP message chunks.
- Improved session refresh reliability by adding a short scheduling delay.

## [0.1.7] - 2026-04-29

### Bug Fixes

- Updated `@agentclientprotocol/sdk` to v0.21.0 and `@mariozechner/pi-*` packages to v0.70.6.

## [0.1.6] - 2026-04-25

### New Features

- Auto-generate session titles on the first prompt using the `PI_ACP_SMALL_MODEL` environment variable.
- Add a slash command to regenerate session titles from all user messages.

## [0.1.5] - 2026-04-24

### Changed

- Updated `@agentclientprotocol/sdk` to 0.20.0 and `@mariozechner/pi-*` to 0.70.2.
- Session lifecycle methods (`listSessions`, `resumeSession`, `closeSession`) updated to stable SDK API (removed `unstable_` prefix).

### Bug Fixes

- Extension tools are now properly loaded instead of being overridden by a hardcoded default tools array.

## [0.1.4] - 2026-04-24

- Updated SDK dependencies to `@mariozechner/pi-*` 0.70.0.

### New Features

- Added support for `@mariozechner/pi-*` 0.70.0.

### Bug Fixes

- Improved reliability of changelog manipulation by replacing brittle regex parsing with a structured parser.

## [0.1.3] - 2026-04-22

### Breaking Changes

- Removed the `enabled` flag from terminal authentication; auth methods are now always built.

### New Features

- Added `pi-sdk-acp-adapter` as an additional CLI binary entry point.
- Added a pi symbol icon SVG to the package assets.

## [0.1.2] - 2026-04-22

### New Features

- Added automated release pipeline for more consistent and reliable publishes.
- Updated underlying SDK dependencies to support `@mariozechner/pi-*` 0.68.1 and `@agentclientprotocol/sdk` 0.19.1.
