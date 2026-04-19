import type { AcpSessionState } from "../types.js";

export const USAGE_CONFIG_OPTION_ID = "_usage";
export const USAGE_CONFIG_OPTION_VALUE = "current";

export function formatCompactNumber(value: number): string {
  const absValue = Math.abs(value);

  if (absValue >= 1_000_000) {
    const scaled = value / 1_000_000;
    return `${scaled >= 10 ? scaled.toFixed(0) : scaled.toFixed(1).replace(/\.0$/, "")}m`;
  }

  if (absValue >= 1_000) {
    const scaled = value / 1_000;
    return `${scaled >= 10 ? scaled.toFixed(0) : scaled.toFixed(1).replace(/\.0$/, "")}k`;
  }

  return `${Math.round(value)}`;
}

export function formatPercent(percent: number): string {
  const rounded = percent >= 10 ? percent.toFixed(0) : percent.toFixed(1);
  return `${rounded.replace(/\.0$/, "")}%`;
}

export function formatUsd(amount: number): string {
  if (amount >= 1) {
    return `$${amount.toFixed(2).replace(/\.00$/, "")}`;
  }

  if (amount >= 0.1) {
    return `$${amount.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}`;
  }

  return `$${amount.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
}

export function getSessionUsageDetails(session: AcpSessionState): {
  contextWindow?: number;
  usedTokens?: number;
  percent?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  cost?: number;
} {
  const contextUsage = session.session?.getContextUsage?.();
  const stats = session.session?.getSessionStats?.();

  return {
    contextWindow:
      contextUsage?.contextWindow ??
      stats?.contextUsage?.contextWindow ??
      session.session?.state.model?.contextWindow,
    usedTokens: contextUsage?.tokens ?? stats?.contextUsage?.tokens ?? undefined,
    percent: contextUsage?.percent ?? stats?.contextUsage?.percent ?? undefined,
    inputTokens: stats?.tokens.input,
    outputTokens: stats?.tokens.output,
    cacheReadTokens: stats?.tokens.cacheRead,
    cacheWriteTokens: stats?.tokens.cacheWrite,
    totalTokens: stats?.tokens.total,
    cost: stats?.cost,
  };
}

export function buildUsageConfigLabel(session: AcpSessionState): string {
  const usage = getSessionUsageDetails(session);
  const usedLabel =
    typeof usage.usedTokens === "number" ? formatCompactNumber(Math.max(0, usage.usedTokens)) : "?";
  const sizeLabel =
    typeof usage.contextWindow === "number"
      ? formatCompactNumber(Math.max(0, usage.contextWindow))
      : "?";
  const percentLabel =
    typeof usage.percent === "number" && Number.isFinite(usage.percent)
      ? ` · ${formatPercent(Math.max(0, usage.percent))}`
      : "";

  return `${usedLabel}/${sizeLabel}${percentLabel}`;
}

export function buildUsageConfigDescription(session: AcpSessionState): string {
  const usage = getSessionUsageDetails(session);
  const parts: string[] = [];

  if (typeof usage.inputTokens === "number") {
    parts.push(`↑${formatCompactNumber(Math.max(0, usage.inputTokens))}`);
  }

  if (typeof usage.outputTokens === "number") {
    parts.push(`↓${formatCompactNumber(Math.max(0, usage.outputTokens))}`);
  }

  if (typeof usage.cacheReadTokens === "number" && usage.cacheReadTokens > 0) {
    parts.push(`R${formatCompactNumber(usage.cacheReadTokens)}`);
  }

  if (typeof usage.cacheWriteTokens === "number" && usage.cacheWriteTokens > 0) {
    parts.push(`W${formatCompactNumber(usage.cacheWriteTokens)}`);
  }

  if (typeof usage.cost === "number" && usage.cost > 0) {
    parts.push(formatUsd(usage.cost));
  }

  const contextLabel = buildUsageConfigLabel(session);
  return parts.length > 0
    ? `${parts.join(" · ")} · ${contextLabel}`
    : `Read-only session usage: ctx ${contextLabel}`;
}
