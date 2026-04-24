# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
