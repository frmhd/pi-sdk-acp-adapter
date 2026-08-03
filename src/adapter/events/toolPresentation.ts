import type { ToolCallLocation } from "@agentclientprotocol/sdk";

import type { AcpToolCallState } from "../types.js";
import { TOOL_NAME_META_KEY } from "../types.js";
import { resolveToolPath, toDisplayPath } from "../../shared/paths.js";

export interface ToolEventMappingContext {
  cwd?: string;
  toolCallState?: AcpToolCallState;
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
