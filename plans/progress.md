# Progress Tracker

Legend:

- [ ] pending
- [x] done

## Current Focus

- [x] Start Phase 0
- [x] Start Phase 2
- [x] Start Phase 3

## Phase 0 — Correctness and Honesty

- [x] Derive agent identity/version from package metadata instead of hardcoding
- [x] Rename ACP agent presentation to Pi-facing values (`pi`, `Pi Coding Agent`)
- [x] Capture and store client capabilities from `initialize()`
- [x] Stop advertising unsupported capabilities (`loadSession`, `session.list`, `session.resume`) until real
- [x] Add clean degradation or explicit errors when required client fs/terminal capabilities are unavailable
- [x] Remove or quarantine non-Pi bridge code paths (`grep`, `find`, `ls`) from the adapter surface
- [x] Add/update tests for initialize capability advertisement
- [x] Verify Phase 0 with `vp check` and `vp test`

## Phase 1 — Zed Tool UI Alignment

- [x] Introduce per-tool-call state instead of session-global `lastEditDiff`
- [x] Map `write` to ACP `edit` semantics for Zed rendering purposes
- [x] Emit ACP diff content for `edit`
- [x] Emit ACP diff/add content for `write`
- [x] Preserve file locations for all file-targeting tool calls
- [x] Improve tool titles for `read`, `write`, `edit`, `bash`
- [x] Preserve structured Pi tool content instead of collapsing everything to plain text
- [x] Populate `rawInput` / `rawOutput` more consistently
- [x] Add/update tests for tool call payload shapes
- [x] Verify Phase 1 with `vp check` and `vp test`

## Phase 2 — Terminal Integration

- [x] Design ACP-aware `bash` execution wrapper around Pi's `bash` tool
- [x] Create ACP terminals with command/args semantics instead of shell-string assumptions
- [x] Associate `toolCallId` with `terminalId` in adapter state
- [x] Emit terminal tool call content so Zed renders the live terminal card
- [x] Keep tool status synchronized with terminal lifecycle
- [x] Attach exit/truncation/full-output metadata to `rawOutput`
- [x] Release terminals safely after completion
- [x] Add/update tests for terminal-backed tool calls
- [x] Verify Phase 2 with `vp check` and `vp test`

## Phase 3 — Session Lifecycle

- [x] Back ACP sessions with Pi `SessionManager`
- [x] Replace ephemeral random ACP session IDs with Pi-backed stable session identity where possible
- [x] Implement real `loadSession`
- [x] Implement `listSessions`
- [x] Implement `unstable_resumeSession`
- [x] Implement `session_info_update` for title and `updatedAt`
- [x] Replay message history during `loadSession`
- [x] Ensure `closeSession` disposes and cleans up active work correctly
- [x] Add/update tests for new/list/load/resume/close flows
- [x] Verify Phase 3 with `vp check` and `vp test`

## Phase 4 — Polish and Compatibility

- [ ] Improve mapping for image/resource content returned by Pi tools
- [ ] Add richer compatibility coverage for Zed-facing ACP payloads
- [ ] Add README documentation for Zed integration behavior and current feature support
- [ ] Document intentional non-goals: no permissions, no subagents, no fake modes, no fake MCP
- [ ] Review `_meta.tool_name`, locations, and raw payload consistency across all tool types
- [ ] Perform end-to-end manual validation in Zed
- [ ] Verify Phase 4 with `vp check` and `vp test`

## Done

- [x] Deep-dive analysis of Zed ACP behavior completed in `../ZED_EDITOR_ACP_PROTOCOL_ANALYSIS.md`
- [x] Alignment strategy documented in `../ZED_EDITOR_ALIGNMENT_PLAN.md`
