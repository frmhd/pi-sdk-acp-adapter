# pi-sdk-acp-adapter

ACP adapter for [Pi Coding Agent](https://github.com/badlogic/pi-mono) with a strong focus on Zed compatibility.

It presents Pi honestly as **Pi Coding Agent** while mapping Pi's native 4-tool workflow onto ACP in a way that renders well in Zed.

## What this adapter does

- speaks ACP over stdio
- exposes Pi as `pi` / `Pi Coding Agent`
- backs ACP sessions with Pi `SessionManager` persistence
- maps Pi tool calls to Zed-friendly ACP payloads
- preserves structured tool output instead of flattening everything to text

## Zed-facing behavior

### Tool mapping

| Pi tool | ACP kind  | Zed rendering goal | Notes                                                                          |
| ------- | --------- | ------------------ | ------------------------------------------------------------------------------ |
| `read`  | `read`    | file/read card     | preserves text and image output, attaches file locations                       |
| `edit`  | `edit`    | diff card          | emits ACP diff content and changed-line locations when available               |
| `write` | `edit`    | diff/add card      | treated as a file mutation so Zed shows diff UI instead of a generic tool card |
| `bash`  | `execute` | live terminal card | uses ACP terminals and keeps terminal metadata in `rawOutput`                  |

### Session behavior

- `newSession` creates a Pi-backed persistent session
- `loadSession` replays prior history through ACP updates
- `unstable_resumeSession` resumes without replay
- `unstable_listSessions` lists persisted Pi sessions
- `session_info_update` keeps title and `updatedAt` in sync
- `available_commands_update` advertises Pi slash commands (extensions, prompt templates, skills)

### Payload conventions used for compatibility

- `_meta.tool_name` is populated for tool calls and tool call updates
- file-targeting tools include `locations` whenever a path is known
- `rawInput` keeps the original Pi tool arguments
- `rawOutput` keeps the final Pi payload, plus ACP terminal metadata for `bash`
- structured tool content is preserved for text, images, resource links, and embedded resources when available

## Supported ACP surface

Implemented and intentionally supported:

- `initialize`
- `session/new`
- `session/load`
- `session/prompt`
- `session/cancel`
- `session/set_config_option`
- `session/list` (`unstable_listSessions`)
- `session/resume` (`unstable_resumeSession`)
- `session/close` (`unstable_closeSession`)
- `session/update` notifications, including:
  - assistant message chunks
  - thought chunks
  - tool calls / tool call updates
  - session info updates
  - available commands updates

Client capability requirements:

- `fs.readTextFile`
- `fs.writeTextFile`
- `terminal`

If an ACP client does not provide those capabilities, the adapter fails fast instead of pretending Pi can operate correctly.

## Intentional non-goals

This adapter does **not** try to turn Pi into Zed's built-in agent.

It intentionally does not add or fake:

- permission prompts
- subagents
- plan / ask / code modes
- MCP support that Pi does not actually implement
- a larger non-Pi tool catalog such as synthetic `grep`, `find`, or `spawn_agent`

Zed is the reference client for UX, but Pi remains the reference product for behavior.

## Development

This project uses Vite+.

### Install

```bash
vp install
```

### Validate

```bash
vp check
vp test
```

### Build

```bash
vp pack
```

## Running the adapter

After building:

```bash
node dist/cli.mjs
```

Or, when installed as a package/binary:

```bash
pi-acp
```

The adapter communicates over stdio using ACP NDJSON streams.

## Manual Zed validation checklist

When validating in Zed, confirm:

- agent identity shows as **Pi Coding Agent**
- `read` tool calls show file locations and preserve image output
- `edit` renders in Zed's diff UI
- `write` renders as diff/add, not a generic tool card
- `bash` renders as a live terminal card
- session list / load / resume work against persisted Pi sessions
- model and thinking-level config options behave correctly
- Pi slash commands appear in the client and are accepted when invoked

## Planning docs

Implementation tracking lives in `plans/`:

- `plans/progress.md`
- `plans/phase-0-correctness-and-honesty.md`
- `plans/phase-1-zed-tool-ui-alignment.md`
- `plans/phase-2-terminal-integration.md`
- `plans/phase-3-session-lifecycle.md`
- `plans/phase-4-polish-and-compatibility.md`
