# Phase 1 — Zed Tool UI Alignment

## Goal

Make Pi's 4 tools render in Zed using the best possible ACP payloads.

This phase focuses on file/tool visualization, especially diff rendering and consistent metadata.

## Why This Phase Matters

Zed's ACP UI strongly depends on:

- `ToolKind`
- `ToolCallContent`
- `locations`
- `_meta.tool_name`

If these are wrong, Pi looks generic and underpowered even if the underlying behavior is correct.

## Scope

In scope:

- per-tool-call state
- diff modeling for `edit` and `write`
- better `ToolKind` mapping
- richer `rawInput` / `rawOutput`
- better titles and file locations
- better structured content preservation

Out of scope:

- real ACP terminal embedding for `bash`
- full session persistence/load/list/resume

## Tasks

### 1. Replace session-global diff capture

Current `lastEditDiff` is too fragile.

Introduce a per-tool-call state map keyed by `toolCallId`, so concurrent or repeated tool calls cannot overwrite each other.

Potential files:

- `src/adapter/types.ts`
- `src/adapter/AcpAgent.ts`
- `src/runtime/AcpAgentRuntime.ts`
- `src/adapter/AcpEventMapper.ts`

### 2. Map `write` as file mutation, not generic tool

For Zed rendering, `write` should behave like a file edit/create operation.

Recommended behavior:

- map `write` to ACP `edit`
- emit a `diff` tool content entry
- use `oldText = null` for file creation when appropriate
- use previous file content for overwrite when available

Potential files:

- `src/adapter/types.ts`
- `src/runtime/AcpAgentRuntime.ts`
- `src/adapter/AcpEventMapper.ts`

### 3. Emit real diff content for `edit`

Use structured diff data rather than only string output.

Possible sources:

- captured old/new file content
- Pi tool `details.diff`
- Pi tool `details.firstChangedLine`

Potential files:

- `src/runtime/AcpAgentRuntime.ts`
- `src/adapter/AcpEventMapper.ts`
- `src/adapter/types.ts`

### 4. Preserve file locations

Ensure `read`, `write`, and `edit` attach a single absolute location whenever the tool targets one file.

This enables better file icon and navigation behavior in Zed.

Potential files:

- `src/adapter/AcpEventMapper.ts`

### 5. Improve titles and metadata

Refine tool titles to be clean and user-facing:

- `Read <path>`
- `Edit <path>`
- `Write <path>` / `Create <path>`
- `Run: <command>`

Also ensure `_meta.tool_name` is always present.

Potential files:

- `src/adapter/AcpEventMapper.ts`
- `src/adapter/types.ts`

### 6. Preserve structured Pi content

Stop reducing all tool results to plain text when structured content exists.

At minimum, preserve:

- text content
- image content
- diff content where available
- raw structured details for later mapping

Potential files:

- `src/adapter/AcpEventMapper.ts`
- `src/adapter/types.ts`

### 7. Improve raw payloads

Populate `rawInput` and `rawOutput` consistently for debugging and better ACP transparency.

Potential files:

- `src/adapter/AcpEventMapper.ts`

### 8. Tests

Add/update tests for:

- `write` mapping to edit semantics
- diff payload generation
- location emission
- `_meta.tool_name`
- raw payload consistency

Potential files:

- `tests/index.test.ts`
- additional focused test files if helpful

## Acceptance Criteria

- `edit` renders as ACP diff content
- `write` also renders as ACP diff/add content
- file-targeting tools attach useful locations
- no session-global diff race remains
- payloads are richer and more Zed-friendly
- tests pass

## Suggested Commit Shape

A good Phase 1 commit should mostly touch:

- `src/adapter/AcpEventMapper.ts`
- `src/runtime/AcpAgentRuntime.ts`
- `src/adapter/types.ts`
- tests
