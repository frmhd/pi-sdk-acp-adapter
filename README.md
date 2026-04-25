# @frmhd/pi-sdk-acp-adapter

An ACP (Agent Client Protocol) adapter for the [Pi Coding Agent](https://github.com/badlogic/pi-mono), enabling native IDE filesystem and terminal delegation.

## Overview

This adapter extends Pi's capabilities by mapping its internal `read`, `edit`, `write`, and `bash` tools to native ACP operations. This allows your IDE to handle diffs, terminal execution, and file modifications directly, providing a fully integrated experience while preserving Pi's session state.

[pi-sdk-demo](https://github.com/user-attachments/assets/f6cc726e-2bc9-49c4-a9b4-6cc9488de629)

## Table of Contents

- [Features](#features)
- [Client Compatibility](#client-compatibility)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Architecture & Fallbacks](#architecture--fallbacks)
- [Development](#development)

## Features

- **Native Filesystem Delegation**: Maps Pi's `write` and `edit` tools to ACP, rendering real side-by-side diffs in supported editors.
- **Native Terminal Execution**: Maps Pi's `bash` tool to ACP terminals, providing live ANSI output, persistent processes, and native UI controls.
- **Interactive Terminal Auth**: Exposes Pi's OAuth flows seamlessly within your IDE's terminal for seamless authentication.
- **Context Window Tracking (Zed)**: Displays context usage and token counts in the Zed agent panel in a hacky way.
- **Session Title Autogeneration**: Automatically generates concise session titles from the first user message when `PI_ACP_SMALL_MODEL` is configured with an authenticated model. Includes a `/regenerate-title` slash command to re-title a session from its conversation history.
- **Agent Skills & Slash Commands**: Full support for Pi agent skills and slash commands (prompt templates), with working discovery and invocation. No extra adapter configuration is required — these work out of the box because Pi handles them natively.
- **Subagent Extensions**: Compatible with subagent extensions such as [@tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents).

## Client Compatibility

Designed with a focus on [Zed](https://zed.dev) as the primary reference client, but built to strictly adhere to the ACP specification for broad compatibility.

- **Zed** — Reference client. Full support for diffs, terminals, auth, and token tracking.
- **WebStorm** — Supported.
- **Obsidian** — Works seamlessly via the Agent Client plugin.
- **Other ACP Clients** — Should work with any ACP-compliant client, but not explicitly tested.

## Quick Start

Configure your ACP client to use the adapter:

#### Using npx

```json
{
  "agent_servers": {
    "Pi": {
      "type": "custom",
      "command": "npx",
      "args": ["@frmhd/pi-sdk-acp-adapter"]
    }
  }
}
```

#### From local source (development)

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

## Configuration

The adapter can be configured via environment variables passed through your ACP client:

| Variable             | Description                                                                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PI_ACP_SMALL_MODEL` | Small/fast model for session title autogeneration. Format: `provider/model-id` (e.g., `opencode-go/minimax-m2.7`). The provider must already be authenticated in Pi (same API key as your main model works). |

Example configuration in Zed's `settings.json`:

```json
{
  "agent_servers": {
    "Pi": {
      "type": "custom",
      "command": "node",
      "args": ["/absolute/path/to/pi-sdk-acp-adapter/dist/cli.mjs"],
      "env": {
        "PI_ACP_SMALL_MODEL": "opencode-go/minimax-m2.7"
      }
    }
  }
}
```

## Architecture & Fallbacks

The adapter safely degrades based on the capabilities advertised by your client during the ACP `initialize` handshake.

- `read` / `write` — Delegated to the editor filesystem when available; falls back to Pi's built-in tools otherwise.
- `edit` — Rendered as a native editor diff UI when available; falls back to Pi's built-in edit tool otherwise.
- `bash` — Routed to the editor's integrated terminal when available; falls back to Pi's local shell otherwise.

The adapter preserves Pi's powerful lack of restrictions on working with directories: it can read files in any directory. The editing tool **will try** to prevent it from changing files outside the working directory.

## Development

### Prerequisites

- Node.js environment
- [Vite+](https://github.com/voidzero-dev/vite-plus) installed (`npm i -g vite-plus`)

### Local Setup

Clone the repository and install dependencies:

```bash
git clone https://github.com/frmhd/pi-sdk-acp-adapter.git
cd pi-sdk-acp-adapter
vp install
```

Build the project:

```bash
vp pack
```

Use the local build in your ACP client config:

```json
{
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "node",
      "args": ["/absolute/path/to/pi-sdk-acp-adapter/dist/cli.mjs"]
    }
  }
}
```

### Development Commands

- **Check Types & Lint**: `vp check`
- **Run Tests**: `vp test`
- **Watch Mode**: `vp run dev`

---

_MIT Licensed._
