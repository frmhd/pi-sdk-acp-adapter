# Progress Tracker

Legend:

- [ ] pending
- [x] done

## Current Focus

- [x] Start Phase 0

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

- [ ] Introduce per-tool-call state instead of session-global `lastEditDiff`
- [ ] Map `write` to ACP `edit` semantics for Zed rendering purposes
- [ ] Emit ACP diff content for `edit`
- [ ] Emit ACP diff/add content for `write`
- [ ] Preserve file locations for all file-targeting tool calls
- [ ] Improve tool titles for `read`, `write`, `edit`, `bash`
- [ ] Preserve structured Pi tool content instead of collapsing everything to plain text
- [ ] Populate `rawInput` / `rawOutput` more consistently
- [ ] Add/update tests for tool call payload shapes
- [ ] Verify Phase 1 with `vp check` and `vp test`

## Phase 2 — Terminal Integration

- [ ] Design ACP-aware `bash` execution wrapper around Pi's `bash` tool
- [ ] Create ACP terminals with command/args semantics instead of shell-string assumptions
- [ ] Associate `toolCallId` with `terminalId` in adapter state
- [ ] Emit terminal tool call content so Zed renders the live terminal card
- [ ] Keep tool status synchronized with terminal lifecycle
- [ ] Attach exit/truncation/full-output metadata to `rawOutput`
- [ ] Release terminals safely after completion
- [ ] Add/update tests for terminal-backed tool calls
- [ ] Verify Phase 2 with `vp check` and `vp test`

## Phase 3 — Session Lifecycle

- [ ] Back ACP sessions with Pi `SessionManager`
- [ ] Replace ephemeral random ACP session IDs with Pi-backed stable session identity where possible
- [ ] Implement real `loadSession`
- [ ] Implement `listSessions`
- [ ] Implement `unstable_resumeSession`
- [ ] Implement `session_info_update` for title and `updatedAt`
- [ ] Replay message history during `loadSession`
- [ ] Ensure `closeSession` disposes and cleans up active work correctly
- [ ] Add/update tests for new/list/load/resume/close flows
- [ ] Verify Phase 3 with `vp check` and `vp test`

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
