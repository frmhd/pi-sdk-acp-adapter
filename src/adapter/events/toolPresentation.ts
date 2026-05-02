import type { ToolCallLocation } from "@agentclientprotocol/sdk";

import type { AcpToolCallState } from "../types.js";
import { TOOL_NAME_META_KEY } from "../types.js";
import { resolveToolPath, toDisplayPath } from "../../shared/paths.js";

export interface ToolEventMappingContext {
  cwd?: string;
  toolCallState?: AcpToolCallState;
}

// ---------------------------------------------------------------------------
// Subagent detail extraction (shape originates from runtime/wrapSubagentTool.ts)
// ---------------------------------------------------------------------------

interface SubagentResultLike {
  agent: string;
  exitCode: number;
  lastProgress?: string;
  step?: number;
}

interface SubagentDetailsLike {
  mode: "single" | "parallel" | "chain";
  results: SubagentResultLike[];
}

function getSubagentString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = (value as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

function getSubagentNumber(value: unknown, key: string): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = (value as Record<string, unknown>)[key];
  return typeof v === "number" ? v : undefined;
}

function extractSubagentDetails(rawOutput: unknown): SubagentDetailsLike | undefined {
  if (typeof rawOutput !== "object" || rawOutput === null) return undefined;
  const candidate = rawOutput as Record<string, unknown>;
  const details = candidate.details;
  if (typeof details !== "object" || details === null) return undefined;
  const d = details as Record<string, unknown>;
  const mode = d.mode;
  if (mode !== "single" && mode !== "parallel" && mode !== "chain") return undefined;
  const results = Array.isArray(d.results)
    ? d.results.map((r) => ({
        agent: getSubagentString(r, "agent") ?? "unknown",
        exitCode: getSubagentNumber(r, "exitCode") ?? -1,
        lastProgress: getSubagentString(r, "lastProgress"),
        step: getSubagentNumber(r, "step"),
      }))
    : [];
  return { mode: mode as SubagentDetailsLike["mode"], results };
}

function formatSubagentTitle(
  args: Record<string, unknown>,
  context?: ToolEventMappingContext,
): string {
  const details = extractSubagentDetails(context?.toolCallState?.rawOutput);

  // Single mode
  if (typeof args.agent === "string") {
    const agent = args.agent;
    if (details?.mode === "single") {
      const result = details.results[0];
      if (result?.lastProgress) {
        const progress = result.lastProgress.slice(0, 40);
        return `Subagent: ${agent} — ${progress}${result.lastProgress.length > 40 ? "…" : ""}`;
      }
    }
    return `Subagent: ${agent}`;
  }

  // Parallel mode
  if (Array.isArray(args.tasks)) {
    const tasks = args.tasks as unknown[];
    const agents = tasks
      .map((t) =>
        typeof t === "object" &&
        t !== null &&
        typeof (t as Record<string, unknown>).agent === "string"
          ? ((t as Record<string, unknown>).agent as string)
          : null,
      )
      .filter((a): a is string => a !== null);
    const count = agents.length;
    const agentList =
      agents.slice(0, 3).join(", ") + (agents.length > 3 ? ` +${agents.length - 3}` : "");

    if (details?.mode === "parallel") {
      const total = details.results.length;
      const done = details.results.filter((r) => r.exitCode !== -1).length;
      const success = details.results.filter((r) => r.exitCode === 0).length;
      if (done === total && total > 0) {
        return success === total
          ? `Subagents (${total}): all succeeded`
          : `Subagents (${total}): ${success}/${total} succeeded`;
      }
      return `Subagents (${total || count}): ${done}/${total || count} done`;
    }
    return `Subagents (${count}): ${agentList}`;
  }

  // Chain mode
  if (Array.isArray(args.chain)) {
    const chain = args.chain as unknown[];
    const agents = chain
      .map((c) =>
        typeof c === "object" &&
        c !== null &&
        typeof (c as Record<string, unknown>).agent === "string"
          ? ((c as Record<string, unknown>).agent as string)
          : null,
      )
      .filter((a): a is string => a !== null);
    const count = agents.length;
    const arrowList =
      agents.slice(0, 3).join(" → ") + (agents.length > 3 ? ` → +${agents.length - 3}` : "");

    if (details?.mode === "chain") {
      const current = details.results[details.results.length - 1];
      if (current) {
        const step = current.step !== undefined ? current.step : details.results.length;
        if (current.exitCode !== -1 && current.exitCode !== 0) {
          return `Chain: failed at step ${step} (${current.agent})`;
        }
        if (step === count && current.exitCode === 0 && count > 0) {
          return `Chain (${count}): completed`;
        }
        const progress = current.lastProgress
          ? ` — ${current.lastProgress.slice(0, 30)}${current.lastProgress.length > 30 ? "…" : ""}`
          : "";
        return `Chain (${step}/${count}): ${current.agent}${progress}`;
      }
    }
    return `Chain (${count}): ${arrowList}`;
  }

  return "Subagent";
}

export function getToolArgs(args: unknown): Record<string, unknown> {
  return typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
}

export function getToolName(
  context: ToolEventMappingContext | undefined,
  fallback?: string,
): string | undefined {
  return context?.toolCallState?.toolName ?? fallback;
}

export function getPathArg(args: Record<string, unknown>): string | undefined {
  return typeof args.path === "string"
    ? args.path
    : typeof args.file_path === "string"
      ? args.file_path
      : undefined;
}

export function getAbsoluteToolPath(
  args: Record<string, unknown>,
  context?: ToolEventMappingContext,
): string | undefined {
  const statePath = context?.toolCallState?.path;
  if (typeof statePath === "string" && statePath.length > 0) {
    return statePath;
  }

  const pathArg = getPathArg(args);
  return pathArg ? resolveToolPath(pathArg, context?.cwd) : undefined;
}

export function buildToolTitle(
  toolName: string | undefined,
  args: Record<string, unknown>,
  context?: ToolEventMappingContext,
): string {
  const path = getAbsoluteToolPath(args, context);
  const displayPath = path ? toDisplayPath(path, context?.cwd) : undefined;

  switch (toolName) {
    case "read":
      return displayPath ? `Read ${displayPath}` : "Read file";
    case "edit":
      return displayPath ? `Edit ${displayPath}` : "Edit file";
    case "write":
      if (context?.toolCallState?.diff?.oldText === null) {
        return displayPath ? `Create ${displayPath}` : "Create file";
      }
      return displayPath ? `Write ${displayPath}` : "Write file";
    case "bash":
      return typeof args.command === "string" ? `Run: ${args.command}` : "Run command";
    case "subagent":
      return formatSubagentTitle(args, context);
    default:
      return toolName ?? "Tool";
  }
}

export function buildToolLocations(
  toolName: string | undefined,
  args: Record<string, unknown>,
  context?: ToolEventMappingContext,
): ToolCallLocation[] | undefined {
  const path = getAbsoluteToolPath(args, context);
  if (!path) {
    return undefined;
  }

  const location: ToolCallLocation = { path };

  if (toolName === "read" && typeof args.offset === "number") {
    location.line = args.offset;
  }

  if ((toolName === "edit" || toolName === "write") && context?.toolCallState?.firstChangedLine) {
    location.line = context.toolCallState.firstChangedLine;
  }

  return [location];
}

export function buildToolMeta(toolName: string | undefined): Record<string, unknown> | undefined {
  return toolName ? { [TOOL_NAME_META_KEY]: toolName } : undefined;
}
