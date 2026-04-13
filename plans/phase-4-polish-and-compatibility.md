# Phase 4 — Polish and Compatibility

## Goal

Harden the adapter, improve edge-case rendering, and document Zed behavior clearly.

## Why This Phase Matters

After the major behavior work is complete, this phase makes the integration maintainable and trustworthy.

It is where we improve confidence, documentation, and end-to-end quality.

## Scope

In scope:

- image/resource output polish
- compatibility and regression coverage
- README updates
- explicit documentation of intentional non-goals
- end-to-end manual verification in Zed

Out of scope:

- changing Pi philosophy to match Zed's native agent feature set

## Tasks

### 1. Improve structured content mapping

Audit all remaining places where Pi content is flattened or degraded.

Pay special attention to:

- image content from `read`
- resource links if introduced
- unusual tool result shapes

Potential files:

- `src/adapter/AcpEventMapper.ts`
- `src/adapter/types.ts`

### 2. Expand compatibility coverage

Add regression tests for Zed-facing payload shapes and edge cases.

Examples:

- write-as-edit file creation
- terminal completion metadata
- session info updates
- image/tool content preservation

Potential files:

- `tests/`

### 3. Update project documentation

Document:

- how the adapter presents itself in Zed
- supported ACP features
- intentionally unsupported features
- current design principles

Potential files:

- `README.md`
- maybe `docs/` additions if useful

### 4. Document intentional non-goals

Be explicit that the adapter does not add:

- permission prompts
- subagents
- fake plan modes
- fake MCP support

This is important to prevent future drift.

Potential files:

- `README.md`
- maybe `docs/` additions

### 5. Manual end-to-end Zed validation

Run the adapter in Zed and confirm:

- identity display
- tool card rendering
- diff behavior
- terminal behavior
- session list/load/resume UX
- config option UX

Capture any findings back into docs or follow-up tasks.

## Acceptance Criteria

- edge-case payloads are better covered
- README clearly explains support and non-goals
- manual Zed validation is completed
- follow-up issues, if any, are documented clearly
- tests pass

## Suggested Commit Shape

A good Phase 4 commit should mostly touch:

- `README.md`
- `tests/`
- any final mapper polishing files
