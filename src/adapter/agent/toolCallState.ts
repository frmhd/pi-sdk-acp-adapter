import type { AcpBashTerminalRawOutput, AcpSessionState, AcpToolCallState } from "../types.js";

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

function isAcpTerminalRawOutput(value: unknown): value is AcpBashTerminalRawOutput {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "acp_terminal"
  );
}

export function mergeCapturedRawOutput(
  toolCallState: AcpToolCallState | undefined,
  nextValue: unknown,
  phase: "update" | "end",
): unknown {
  if (toolCallState?.toolName !== "bash" || !isAcpTerminalRawOutput(toolCallState?.rawOutput)) {
    return nextValue;
  }

  const rawOutputRecord = toolCallState.rawOutput;

  if (phase === "end") {
    const terminalOutput = typeof rawOutputRecord.output === "string" ? rawOutputRecord.output : "";
    const piPartialResult = {
      content: [{ type: "text", text: terminalOutput }],
      details: {},
    };

    return {
      ...rawOutputRecord,
      piPartialResult,
      piResult: nextValue,
    };
  }

  return {
    ...rawOutputRecord,
    piPartialResult: nextValue,
  };
}

export async function releaseToolCallResources(
  toolCallState: AcpToolCallState | undefined,
): Promise<void> {
  const releaseTerminal = toolCallState?.releaseTerminal;
  if (!releaseTerminal) {
    return;
  }

  delete toolCallState.releaseTerminal;

  await releaseTerminal().catch((error) => {
    console.warn("Failed to release ACP terminal:", error);
  });
}

export async function releasePendingToolCallResources(
  sessionState: AcpSessionState,
): Promise<void> {
  const pendingToolCalls = Array.from(sessionState.pendingToolCalls.values());
  await Promise.all(
    pendingToolCalls.map((toolCallState) => releaseToolCallResources(toolCallState)),
  );
  sessionState.pendingToolCalls.clear();
}
