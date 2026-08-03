import type { AcpSessionState, AcpToolCallState } from "../types.js";

export function getOrCreateToolCallState(
  sessionState: AcpSessionState,
  toolCallId: string,
): AcpToolCallState {
  const existing = sessionState.pendingToolCalls.get(toolCallId);
  if (existing) {
    return existing;
  }

  const created: AcpToolCallState = {};
  sessionState.pendingToolCalls.set(toolCallId, created);
  return created;
}

export function extractFirstChangedLine(result: unknown): number | undefined {
  if (typeof result !== "object" || result === null) {
    return undefined;
  }

  const details = (result as { details?: { firstChangedLine?: unknown } }).details;
  return typeof details?.firstChangedLine === "number" ? details.firstChangedLine : undefined;
}

/** Clear per-call rendering state without any resource release. */
export function clearPendingToolCallState(sessionState: AcpSessionState): void {
  sessionState.pendingToolCalls.clear();
}
