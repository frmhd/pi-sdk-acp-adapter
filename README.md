# pi-sdk-acp-adapter

[![npm version](https://img.shields.io/badge/version-0.1.0-blue.svg)](https://www.npmjs.com/package/pi-sdk-acp-adapter)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Vite+](https://img.shields.io/badge/built%20with-Vite+-646cff.svg)](https://github.com/voidzero-dev/vite-plus)

An ACP (Agent Client Protocol) adapter for the [Pi Coding Agent](https://github.com/badlogic/pi-mono), enabling native IDE filesystem and terminal delegation.

## Overview

This adapter extends Pi's capabilities by mapping its internal `read`, `edit`, `write`, and `bash` tools to native ACP operations. This allows your IDE to handle diffs, terminal execution, and file modifications directly, providing a fully integrated and secure experience while preserving Pi's session state.

[pi-sdk-demo](https://github.com/user-attachments/assets/f6cc726e-2bc9-49c4-a9b4-6cc9488de629)

## Table of Contents

- [Features](#features)
- [Client Compatibility](#client-compatibility)
- [Quick Start](#quick-start)
- [Architecture & Fallbacks](#architecture--fallbacks)
- [Development](#development)

## Features

- **Native Filesystem Delegation**: Maps Pi's `write` and `edit` tools to ACP, rendering real side-by-side diffs in supported editors.
- **Native Terminal Execution**: Maps Pi's `bash` tool to ACP terminals, providing live ANSI output, persistent processes, and native UI controls.
- **Interactive Terminal Auth**: Exposes Pi's OAuth flows seamlessly within your IDE's terminal for seamless authentication.
- **Context Window Tracking (Zed)**: Includes a specialized configuration option that displays real-time context usage and token counts directly in the Zed session panel.

## Client Compatibility

Designed with a focus on [Zed](https://zed.dev) as the primary reference client, but built to strictly adhere to the ACP specification for broad compatibility.

| Client                | Status       | Notes                                                                 |
| :-------------------- | :----------- | :-------------------------------------------------------------------- |
| **Zed**               | 🏆 Reference | Full support for diffs, terminals, auth, and token tracking.          |
| **WebStorm**          | ✅ Supported | Full support.                                                         |
| **Obsidian**          | ✅ Supported | Works seamlessly via the Agent Client plugin for knowledge bases.     |
| **Other ACP Clients** | ⚠️ Untested  | Should work with any ACP-compliant client, but not explicitly tested. |

## Quick Start

### Prerequisites

- Node.js environment
- [Vite+](https://github.com/voidzero-dev/vite-plus) installed (`npm i -g vite-plus`)

### Installation

Clone the repository and install dependencies:

```bash
vp install
```

Build the project:

```bash
vp pack
```

### Usage

Configure your ACP client (e.g., Zed `settings.json`) to use the built executable:

```json
{
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "node",
      "args": ["/absolute/path/to/pi-sdk-acp-adapter/dist/cli.mjs"],
      "env": {}
    }
  }
}
```

Or, if installed globally:

```json
{
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "pi-acp",
      "args": []
    }
  }
}
```

## Architecture & Fallbacks

The adapter safely degrades based on the capabilities advertised by your client during the ACP `initialize` handshake.

| Pi Tool          | When Client Supports ACP Capabilities | Fallback (No Client Support) |
| :--------------- | :------------------------------------ | :--------------------------- |
| `read` / `write` | Delegated to Editor FS                | Pi Local Execution           |
| `edit`           | Native Editor Diff UI                 | Pi Local Edit                |
| `bash`           | Editor Integrated Terminal            | Pi Local Shell               |

## Development

This project uses Vite+ for toolchain management.

- **Check Types & Lint**: `vp check`
- **Run Tests**: `vp test`
- **Watch Mode**: `vp run dev`

---

_MIT Licensed._
