import { readFile } from "node:fs/promises";

import type {
  AfterToolCallContext,
  AfterToolCallResult,
  Agent,
  BeforeToolCallContext,
  BeforeToolCallResult,
} from "@earendil-works/pi-agent-core";

import type { AcpToolCallDiff, AcpToolCallState } from "../adapter/types.js";
import { resolveToolPath } from "../shared/paths.js";

/**
 * Observation-only display tracking for ACP presentation.
 *
 * Pi owns the read/edit/write/bash tools entirely; this module never defines,
 * wraps, or executes them. It chains Pi's public `agent.beforeToolCall` /
 * `agent.afterToolCall` hooks to capture the inputs and file snapshots the ACP
 * event mapper needs for tool cards, locations, and edit/write diff rendering.
 *
 * Snapshot reads are presentation-only: failures are swallowed and never alter
 * Pi tool execution or results.
 */
export function installToolDisplayTracking(options: {
  agent: Agent;
  cwd: string;
  onToolCallStateCaptured?: (toolCallId: string, update: Partial<AcpToolCallState>) => void;
}): () => void {
  const { agent, cwd, onToolCallStateCaptured } = options;

  /** Old-file snapshots keyed by tool-call id so concurrent calls stay isolated. */
  const beforeSnapshots = new Map<string, { oldText: string | null; path: string }>();

  const originalBeforeToolCall = agent.beforeToolCall;
  const originalAfterToolCall = agent.afterToolCall;

  function captureBaseState(toolCallId: string, toolName: string, args: unknown): void {
    const update: Partial<AcpToolCallState> = { toolName, rawInput: args };

    const pathArg = getPathArg(args);
    if (pathArg !== undefined) {
      update.path = resolveToolPath(pathArg, cwd);
    }

    onToolCallStateCaptured?.(toolCallId, update);
  }

  async function captureBeforeSnapshot(
    toolCallId: string,
    toolName: string,
    args: unknown,
  ): Promise<void> {
    // Snapshot reads exist only to render edit/write diff cards. Other
    // path-bearing tools (e.g. read) must not trigger adapter filesystem reads.
    if (toolName !== "edit" && toolName !== "write") {
      return;
    }

    const pathArg = getPathArg(args);
    if (pathArg === undefined) {
      return;
    }

    const path = resolveToolPath(pathArg, cwd);

    let oldText: string | null = null;
    try {
      oldText = await readFile(path, "utf-8");
    } catch {
      // Best-effort display capture: unreadable/missing files render as creation.
      oldText = null;
    }

    beforeSnapshots.set(toolCallId, { oldText, path });
  }

  async function captureAfterSnapshot(
    context: AfterToolCallContext,
    toolCallId: string,
    toolName: string,
    effectiveIsError: boolean,
    effectiveDetails: unknown,
  ): Promise<void> {
    if (effectiveIsError || (toolName !== "edit" && toolName !== "write")) {
      return;
    }

    const snapshot = beforeSnapshots.get(toolCallId);
    if (!snapshot) {
      return;
    }

    let newText: string | null = null;
    try {
      newText = await readFile(snapshot.path, "utf-8");
    } catch {
      newText = null;
    }

    // Write carries its full target content in the input; use it when the
    // post-read fails so the diff card can still be rendered.
    if (newText === null && toolName === "write") {
      const content = getWriteContent(context.args);
      if (content !== undefined) {
        newText = content;
      }
    }

    if (newText === null) {
      return;
    }

    const diff: AcpToolCallDiff = {
      path: snapshot.path,
      oldText: snapshot.oldText,
      newText,
    };

    const update: Partial<AcpToolCallState> = { diff };

    if (toolName === "edit") {
      const firstChangedLine = extractFirstChangedLine(effectiveDetails);
      if (firstChangedLine !== undefined) {
        update.firstChangedLine = firstChangedLine;
      }
    }

    onToolCallStateCaptured?.(toolCallId, update);
  }

  const wrappedBeforeToolCall = async (
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ): Promise<BeforeToolCallResult | undefined> => {
    const result = await originalBeforeToolCall?.(context, signal);
    if (result?.block) {
      return result;
    }

    const toolCallId = context.toolCall.id;
    const toolName = context.toolCall.name;
    const args = context.args;

    try {
      captureBaseState(toolCallId, toolName, args);
      await captureBeforeSnapshot(toolCallId, toolName, args);
    } catch (error) {
      // Display capture must never block or fail the Pi tool itself.
      console.warn("ACP display tracking failed to capture tool state:", error);
    }

    return result;
  };

  const wrappedAfterToolCall = async (
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ): Promise<AfterToolCallResult | undefined> => {
    let hookError: unknown;
    let result: AfterToolCallResult | undefined;
    try {
      result = await originalAfterToolCall?.(context, signal);
    } catch (error) {
      // Preserve Pi/extension hook semantics: a throwing afterToolCall hook
      // still converts the tool result into an error upstream in the agent loop.
      hookError = error;
    }

    try {
      const toolCallId = context.toolCall.id;
      const toolName = context.toolCall.name;

      // Apply extension result rewrites (field-by-field overrides) so display
      // capture reflects the final effective result, not the executed one.
      const effectiveIsError = result?.isError ?? context.isError;
      const effectiveDetails =
        result?.details !== undefined ? result.details : context.result.details;

      await captureAfterSnapshot(context, toolCallId, toolName, effectiveIsError, effectiveDetails);
    } catch (error) {
      // Snapshot/diff capture is presentation-only; never alter tool results.
      console.warn("ACP display tracking failed to capture tool diff:", error);
    } finally {
      beforeSnapshots.delete(context.toolCall.id);
    }

    if (hookError !== undefined) {
      throw hookError;
    }
    return result;
  };

  agent.beforeToolCall = wrappedBeforeToolCall;
  agent.afterToolCall = wrappedAfterToolCall;

  return () => {
    beforeSnapshots.clear();
    if (agent.beforeToolCall === wrappedBeforeToolCall) {
      agent.beforeToolCall = originalBeforeToolCall;
    }
    if (agent.afterToolCall === wrappedAfterToolCall) {
      agent.afterToolCall = originalAfterToolCall;
    }
  };
}

function getPathArg(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) {
    return undefined;
  }

  const record = args as Record<string, unknown>;
  return typeof record.path === "string"
    ? record.path
    : typeof record.file_path === "string"
      ? record.file_path
      : undefined;
}

function getWriteContent(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) {
    return undefined;
  }

  const content = (args as Record<string, unknown>).content;
  return typeof content === "string" ? content : undefined;
}

function extractFirstChangedLine(details: unknown): number | undefined {
  if (typeof details !== "object" || details === null) {
    return undefined;
  }

  const firstChangedLine = (details as { firstChangedLine?: unknown }).firstChangedLine;
  return typeof firstChangedLine === "number" ? firstChangedLine : undefined;
}
