# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- Updated `@agentclientprotocol/sdk` to 0.22.1 and `@earendil-works/pi-*` packages to 0.77.0.
- Refreshed the `@earendil-works/pi-ai` pnpm patch for DeepSeek reasoning replay on 0.77.0.
- Terminal OAuth login now supports device-code and login-method selection callbacks required by Pi 0.77.
- Cross-project session listing uses `SessionManager.listAll` for custom ACP session directories (Pi 0.77 cwd scoping).

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
