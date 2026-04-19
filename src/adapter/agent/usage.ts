import type { AcpSessionState, AcpSessionUsageSnapshot } from "../types.js";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeTokenCount(value: number): number {
  return Math.max(0, Math.round(value));
}

export function buildSessionUsageSnapshot(
  session: NonNullable<AcpSessionState["session"]>,
): AcpSessionUsageSnapshot | undefined {
  const contextUsage = session.getContextUsage?.();
  const stats = session.getSessionStats?.();

  const size =
    contextUsage?.contextWindow ??
    stats?.contextUsage?.contextWindow ??
    session.state.model?.contextWindow;

  const rawUsed = contextUsage?.tokens != null ? contextUsage.tokens : stats?.contextUsage?.tokens;

  if (!isFiniteNumber(size) || size <= 0 || rawUsed === null || rawUsed === undefined) {
    return undefined;
  }

  return {
    size: normalizeTokenCount(size),
    used: normalizeTokenCount(rawUsed),
  };
}
