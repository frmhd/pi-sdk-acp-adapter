# @frmhd/pi-sdk-acp-adapter

An ACP (Agent Client Protocol) adapter for the [Pi Coding Agent](https://github.com/badlogic/pi-mono), presenting Pi's native tools inside ACP clients.

## Overview

This adapter connects the Pi Coding Agent to ACP-compatible clients such as Zed. Pi runs locally and executes its own tools; the ACP client displays their progress and results.

> [!IMPORTANT]
> Filesystem and shell operations are **intentionally not delegated to the ACP client**, aligning with the upcoming ACP v2's removal of client-delegated filesystem and terminal operations. Pi's native `read`, `edit`, `write`, and `bash` tools access the local environment of the adapter process directly. Client roots and `additionalDirectories` are session metadata, not an authorization boundary; configure permissions and sandboxing where Pi runs.

The adapter observes Pi's tool lifecycle and maps it to ACP tool cards, file locations, edit/write diff cards, structured output, and plain-text shell output. It does not replace Pi's tools or alter prompts before execution.

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
- **Interactive Authentication**: Uses the ACP client terminal only for Pi's OAuth login flow; agent shell commands still run through Pi's native `bash` tool.
- **Context Window Tracking (Zed)**: Displays context usage and token counts in the Zed agent panel in a hacky way.
- **Session Title Autogeneration**: Automatically generates concise session titles from the first user message when `PI_ACP_SMALL_MODEL` is configured with an authenticated model. Includes a `/regenerate-title` slash command to re-title a session from its conversation history.
- **Agent Skills & Slash Commands**: Full support for Pi agent skills and slash commands (prompt templates), with working discovery and invocation. No extra adapter configuration is required — these work out of the box because Pi handles them natively.
- **Subagent Extensions**: Compatible with subagent extensions such as [@tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents).

## Client Compatibility

Designed with a focus on [Zed](https://zed.dev) as the primary reference client, but built to strictly adhere to the ACP specification for broad compatibility.

- **Zed** — Reference client. Supports diff presentation, interactive authentication, and token tracking.
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

- Pi creates and executes its built-in `read`, `edit`, `write`, and `bash` tools directly in the adapter process. The adapter never shadows them with same-name tools and never calls ACP client filesystem or terminal methods for agent operations.
- The ACP terminal may be used for interactive OAuth authentication only; it is not the backend for Pi's `bash` tool.
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
