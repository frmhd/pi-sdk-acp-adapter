# Implementation Plans

This directory contains the execution plan for aligning `pi-sdk-acp-adapter` with Zed Editor's ACP expectations while keeping Pi's product philosophy intact.

Primary reference docs:

- `../ZED_EDITOR_ACP_PROTOCOL_ANALYSIS.md`
- `../ZED_EDITOR_ALIGNMENT_PLAN.md`

## Plan Files

- `progress.md` — central task tracker with checkboxes
- `phase-0-correctness-and-honesty.md` — capability honesty, identity, cleanup
- `phase-1-zed-tool-ui-alignment.md` — diff/file rendering alignment for Pi tools
- `phase-2-terminal-integration.md` — real ACP terminal embedding for `bash`
- `phase-3-session-lifecycle.md` — persistent Pi-backed session lifecycle
- `phase-4-polish-and-compatibility.md` — polish, tests, compatibility hardening

## Working Rules

- Zed is the reference ACP client implementation for UX.
- Pi is the reference implementation for agent behavior and philosophy.
- Do not fake unsupported features like permissions, subagents, MCP, or session modes.
- Prefer honest capability advertising over partial or misleading implementations.
