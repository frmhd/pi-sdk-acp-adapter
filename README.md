# pi-sdk-acp-adapter

ACP adapter for [Pi Coding Agent](https://github.com/badlogic/pi-mono) implementing the Agent Communication Protocol (ACP).

It presents Pi honestly as **Pi Coding Agent** while mapping Pi's native 4-tool workflow onto ACP. Tested primarily with [Zed](https://zed.dev) as the reference client. Tool backends are selected per client/session from the ACP capabilities the client advertises: ACP-backed where available, local Pi backends otherwise. When `terminal` is unavailable, bash falls back to local execution.

## What this adapter does

- speaks ACP over stdio
- exposes Pi as `pi` / `Pi Coding Agent`
- backs ACP sessions with Pi `SessionManager` persistence
- maps Pi tool calls to Zed-friendly ACP payloads
- preserves structured tool output instead of flattening everything to text

## Client-facing behavior

### Tool mapping

| Pi tool | ACP kind  | Rendering goal                   | Notes                                                                                                                          |
| ------- | --------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `read`  | `read`    | file/read card                   | preserves text and image output, attaches file locations                                                                       |
| `edit`  | `edit`    | diff card                        | emits ACP diff content and changed-line locations when available                                                               |
| `write` | `edit`    | diff/add card                    | treated as a file mutation so Zed shows diff UI instead of a generic tool card                                                 |
| `bash`  | `execute` | live terminal card / text output | prefers ACP terminals and keeps terminal metadata in `rawOutput`; falls back to local execution when terminals are unavailable |

### Session behavior (Zed reference)

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
- `authenticate` (ACP terminal auth for Pi OAuth providers when the client advertises `auth.terminal`)
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

Client capability handling:

- `fs.readTextFile` — optional; when present, `read` prefers ACP with intentional local fallback for authorized paths outside ACP-visible roots
- `fs.writeTextFile` — optional; when present, `write` uses ACP-backed writes
- `terminal` — optional; when present, `bash` uses ACP terminal embedding

Optional client auth capability:

- `auth.terminal` — enables ACP terminal auth methods for Pi's built-in OAuth providers

Backend selection rules in the current first pass:

| Tool    | Selected backend                                                                                          |
| ------- | --------------------------------------------------------------------------------------------------------- |
| `read`  | ACP-backed mixed read when `fs.readTextFile` is available, else local Pi read                             |
| `write` | ACP-backed write when `fs.writeTextFile` is available, else local Pi write                                |
| `edit`  | ACP-backed edit only when both `fs.readTextFile` and `fs.writeTextFile` are available, else local Pi edit |
| `bash`  | ACP terminal-backed bash when `terminal` is available, else local Pi bash                                 |

This means missing ACP filesystem/terminal capabilities do **not** block initialization or session creation. The adapter stays ACP-compliant by only calling ACP methods the client actually advertised, while preserving Pi behavior through local tool backends where needed.

Client-specific UX enhancements are driven by compatibility testing (Zed is the reference), but Pi's native behavior remains the source of truth.

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

## Terminal auth mode

When an ACP client advertises `auth.terminal`, the adapter now exposes ACP terminal auth methods for Pi's built-in OAuth providers. Those methods re-run the same `pi-acp` binary with an internal flag:

```bash
pi-acp --acp-terminal-auth anthropic
```

That interactive flow stores credentials in Pi's standard auth store (`~/.pi/agent/auth.json`).
