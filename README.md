# @frmhd/pi-sdk-acp-adapter

An ACP (Agent Client Protocol) adapter for the [Pi Coding Agent](https://github.com/badlogic/pi-mono), presenting Pi's native tools inside ACP clients.

## Overview

This adapter connects the Pi Coding Agent to ACP-compatible clients such as Zed. Pi executes its own built-in `read`, `edit`, `write`, and `bash` tools directly — the adapter does not delegate filesystem or terminal operations to the client, and it applies no adapter-specific path authorization. The adapter's job is presentation: it maps Pi's tool lifecycle events into ACP tool cards, file locations, edit/write diff cards, structured output, and plain text bash output.

[pi-sdk-demo](https://github.com/user-attachments/assets/f6cc726e-2bc9-49c4-a9b4-6cc9488de629)

## Table of Contents

- [Features](#features)
- [Client Compatibility](#client-compatibility)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Development](#development)

## Features

- **Native Pi Tool Execution**: Pi's own `read`, `edit`, `write`, and `bash` tools run unchanged, with Pi's file mutation queue, schemas, settings, and cancellation behavior intact.
- **ACP Diff Cards**: Successful `edit`/`write` calls render as ACP diff cards in supported editors, including create/overwrite detection and first-changed-line navigation.
- **Tool Presentation**: Every tool call is surfaced as an ACP tool card with a title, file locations, structured output, and plain text bash updates.
- **Interactive Terminal Auth**: Exposes Pi's OAuth flows seamlessly within your IDE's terminal for seamless authentication.
- **Context Window Tracking (Zed)**: Displays context usage and token counts in the Zed agent panel in a hacky way.
- **Session Title Autogeneration**: Automatically generates concise session titles from the first user message when `PI_ACP_SMALL_MODEL` is configured with an authenticated model. Includes a `/regenerate-title` slash command to re-title a session from its conversation history.
- **Agent Skills & Slash Commands**: Full support for Pi agent skills and slash commands (prompt templates), with working discovery and invocation. No extra adapter configuration is required — these work out of the box because Pi handles them natively.
- **Subagent Extensions**: Compatible with subagent extensions such as [@tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents).

## Client Compatibility

Designed with a focus on [Zed](https://zed.dev) as the primary reference client, but built to strictly adhere to the ACP specification for broad compatibility.

- **Zed** — Reference client. Full support for diffs, auth, and token tracking.
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

## Architecture

The adapter is a presentation/session layer over Pi's native runtime:

- Pi creates and executes its built-in `read`, `edit`, `write`, and `bash` tools directly. The adapter never shadows them with same-name tools and never routes their operations to ACP client filesystem or terminal methods.
- An observation-only tracker chains Pi's public tool lifecycle hooks to capture the inputs, resolved paths, and before/after file snapshots needed for ACP presentation. Snapshot reads are display-only and never affect Pi execution.
- `edit`/`write` calls render as ACP diff cards when display snapshots succeed; bash output is presented as ordinary ACP text/structured content.
- Prompt text is passed to Pi unchanged. Path handling and any path/reference semantics are Pi's own — the adapter applies no path authorization.

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
