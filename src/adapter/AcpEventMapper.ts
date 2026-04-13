/**
 * ACP Event Mapper
 *
 * Maps Pi AgentSession events to ACP SessionNotification protocol messages.
 */

import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";

import type {
  SessionNotification,
  ToolCall,
  ToolCallUpdate,
  ToolCallContent,
  ToolCallLocation,
  ContentChunk,
  StopReason,
  ToolCallStatus,
  ContentBlock,
} from "@agentclientprotocol/sdk";

import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";

import type { AgentEvent } from "@mariozechner/pi-agent-core";

import type { AssistantMessageEvent } from "@mariozechner/pi-ai";

import {
  type AcpToolCallState,
  mapToolKind,
  mapStopReason,
  createStructuredToolCallContent,
  createToolCallContent,
  createDiffContent,
  createTerminalContent,
  TOOL_NAME_META_KEY,
} from "./types.js";

/** Extra context available while mapping Pi tool events to ACP. */
export interface ToolEventMappingContext {
  /** Session working directory, used to normalize tool paths for ACP locations. */
  cwd?: string;
  /** Per-tool-call state captured by the adapter/runtime. */
  toolCallState?: AcpToolCallState;
}

// =============================================================================
// Path / Title Helpers
// =============================================================================

function expandToolPath(filePath: string): string {
  if (filePath === "~") {
    return homedir();
  }

  if (filePath.startsWith("~/")) {
    return `${homedir()}${filePath.slice(1)}`;
  }

  return filePath.startsWith("@") ? filePath.slice(1) : filePath;
}

function resolveToolPath(filePath: string, cwd?: string): string {
  const expanded = expandToolPath(filePath);
  if (isAbsolute(expanded) || !cwd) {
    return expanded;
  }
  return resolvePath(cwd, expanded);
}

function getToolArgs(args: unknown): Record<string, unknown> {
  return typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
}

function getToolName(
  context: ToolEventMappingContext | undefined,
  fallback?: string,
): string | undefined {
  return context?.toolCallState?.toolName ?? fallback;
}

function getPathArg(args: Record<string, unknown>): string | undefined {
  return typeof args.path === "string"
    ? args.path
    : typeof args.file_path === "string"
      ? args.file_path
      : undefined;
}

function getAbsoluteToolPath(
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

function buildToolTitle(
  toolName: string | undefined,
  args: Record<string, unknown>,
  context?: ToolEventMappingContext,
): string {
  const path = getAbsoluteToolPath(args, context);

  switch (toolName) {
    case "read":
      return path ? `Read ${path}` : "Read file";
    case "edit":
      return path ? `Edit ${path}` : "Edit file";
    case "write":
      if (context?.toolCallState?.diff?.oldText === null) {
        return path ? `Create ${path}` : "Create file";
      }
      return path ? `Write ${path}` : "Write file";
    case "bash":
      return typeof args.command === "string" ? `Run: ${args.command}` : "Run command";
    default:
      return toolName ?? "Tool";
  }
}

function buildToolLocations(
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

// =============================================================================
// Tool Result Content Mapping
// =============================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getOptionalObjectField(
  record: Record<string, unknown>,
  field: string,
): Record<string, unknown> | null | undefined {
  const value = record[field];
  return value === null ? null : isRecord(value) ? value : undefined;
}

function getOptionalStringField(
  record: Record<string, unknown>,
  field: string,
): string | undefined {
  return typeof record[field] === "string" ? (record[field] as string) : undefined;
}

function getOptionalNumberField(
  record: Record<string, unknown>,
  field: string,
): number | undefined {
  return typeof record[field] === "number" ? (record[field] as number) : undefined;
}

function mapPiContentBlock(block: unknown): ContentBlock | undefined {
  if (!isRecord(block)) {
    return undefined;
  }

  if (block.type === "text" && typeof block.text === "string") {
    return {
      type: "text",
      text: block.text,
      ...(getOptionalObjectField(block, "_meta") !== undefined
        ? { _meta: getOptionalObjectField(block, "_meta") }
        : {}),
    } satisfies ContentBlock;
  }

  const mimeType =
    getOptionalStringField(block, "mimeType") ?? getOptionalStringField(block, "mime_type");

  if (block.type === "image" && typeof block.data === "string" && mimeType) {
    return {
      type: "image",
      data: block.data,
      mimeType,
      ...(getOptionalStringField(block, "uri")
        ? { uri: getOptionalStringField(block, "uri") }
        : {}),
      ...(getOptionalObjectField(block, "_meta") !== undefined
        ? { _meta: getOptionalObjectField(block, "_meta") }
        : {}),
    } satisfies ContentBlock;
  }

  if (block.type === "audio" && typeof block.data === "string" && mimeType) {
    return {
      type: "audio",
      data: block.data,
      mimeType,
      ...(getOptionalObjectField(block, "_meta") !== undefined
        ? { _meta: getOptionalObjectField(block, "_meta") }
        : {}),
    } satisfies ContentBlock;
  }

  if (
    block.type === "resource_link" &&
    typeof block.name === "string" &&
    typeof block.uri === "string"
  ) {
    return {
      type: "resource_link",
      name: block.name,
      uri: block.uri,
      ...(getOptionalStringField(block, "title")
        ? { title: getOptionalStringField(block, "title") }
        : {}),
      ...(getOptionalStringField(block, "description")
        ? { description: getOptionalStringField(block, "description") }
        : {}),
      ...(mimeType ? { mimeType } : {}),
      ...(getOptionalNumberField(block, "size") !== undefined
        ? { size: getOptionalNumberField(block, "size") }
        : {}),
      ...(getOptionalObjectField(block, "_meta") !== undefined
        ? { _meta: getOptionalObjectField(block, "_meta") }
        : {}),
    } satisfies ContentBlock;
  }

  if (block.type === "resource") {
    const resource = getOptionalObjectField(block, "resource");
    if (!resource || typeof resource.uri !== "string") {
      return undefined;
    }

    const resourceMimeType =
      getOptionalStringField(resource, "mimeType") ?? getOptionalStringField(resource, "mime_type");
    const embeddedResource =
      typeof resource.text === "string"
        ? {
            text: resource.text,
            uri: resource.uri,
            ...(resourceMimeType ? { mimeType: resourceMimeType } : {}),
            ...(getOptionalObjectField(resource, "_meta") !== undefined
              ? { _meta: getOptionalObjectField(resource, "_meta") }
              : {}),
          }
        : typeof resource.blob === "string"
          ? {
              blob: resource.blob,
              uri: resource.uri,
              ...(resourceMimeType ? { mimeType: resourceMimeType } : {}),
              ...(getOptionalObjectField(resource, "_meta") !== undefined
                ? { _meta: getOptionalObjectField(resource, "_meta") }
                : {}),
            }
          : undefined;

    if (!embeddedResource) {
      return undefined;
    }

    return {
      type: "resource",
      resource: embeddedResource,
      ...(getOptionalObjectField(block, "_meta") !== undefined
        ? { _meta: getOptionalObjectField(block, "_meta") }
        : {}),
    } satisfies ContentBlock;
  }

  return undefined;
}

function mapPiContentBlockToAcp(block: unknown): ToolCallContent | undefined {
  const content = mapPiContentBlock(block);
  return content ? createStructuredToolCallContent(content) : undefined;
}

function mapStructuredToolResultContent(result: unknown): ToolCallContent[] | undefined {
  if (typeof result !== "object" || result === null) {
    return undefined;
  }

  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) {
    return undefined;
  }

  const mapped = content.map(mapPiContentBlockToAcp).filter(Boolean) as ToolCallContent[];
  return mapped.length > 0 ? mapped : undefined;
}

function extractTextFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const textFields = ["stdout", "content", "output", "result", "message", "text", "data", "stderr"];

  for (const field of textFields) {
    if (typeof record[field] === "string") {
      return record[field] as string;
    }
  }

  for (const field of textFields) {
    if (Array.isArray(record[field])) {
      const parts: string[] = [];

      for (const item of record[field] as unknown[]) {
        if (typeof item === "string") {
          parts.push(item);
          continue;
        }

        if (typeof item === "object" && item !== null) {
          const objectItem = item as Record<string, unknown>;
          if (typeof objectItem.text === "string") {
            parts.push(objectItem.text);
          } else if (typeof objectItem.path === "string") {
            parts.push(objectItem.path);
          } else if (typeof objectItem.match === "string") {
            parts.push(objectItem.match);
          }
        }
      }

      if (parts.length > 0) {
        return parts.join("\n");
      }
    }
  }

  if (typeof record.exitCode === "number") {
    return `Exit code: ${record.exitCode}`;
  }

  return undefined;
}

function mapToolResultContent(result: unknown): ToolCallContent[] | undefined {
  const structuredContent = mapStructuredToolResultContent(result);
  if (structuredContent && structuredContent.length > 0) {
    return structuredContent;
  }

  const text = extractTextFromUnknown(result);
  return text ? [createToolCallContent(text)] : undefined;
}

function mapTerminalToolContent(context?: ToolEventMappingContext): ToolCallContent[] | undefined {
  const terminalId = context?.toolCallState?.terminalId;
  return terminalId ? [createTerminalContent(terminalId)] : undefined;
}

function buildToolMeta(toolName: string | undefined): Record<string, unknown> | undefined {
  return toolName ? { [TOOL_NAME_META_KEY]: toolName } : undefined;
}

// =============================================================================
// Message Chunk Mapping
// =============================================================================

/**
 * Map a message_update event to an agent_message_chunk or agent_thought_chunk notification
 */
export function mapMessageUpdate(
  sessionId: string,
  event: AgentEvent & { type: "message_update"; assistantMessageEvent: AssistantMessageEvent },
): SessionNotification | undefined {
  const { assistantMessageEvent } = event;

  if (assistantMessageEvent.type === "text_delta") {
    const chunk: ContentChunk = { content: { type: "text", text: assistantMessageEvent.delta } };
    return {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        ...chunk,
      },
    };
  }

  if (assistantMessageEvent.type === "thinking_delta") {
    const chunk: ContentChunk = { content: { type: "text", text: assistantMessageEvent.delta } };
    return {
      sessionId,
      update: {
        sessionUpdate: "agent_thought_chunk",
        ...chunk,
      },
    };
  }

  return undefined;
}

/**
 * Convert tool execution start to an ACP ToolCall notification.
 */
export function mapToolExecutionStart(
  sessionId: string,
  event: { toolCallId: string; toolName: string; args: unknown },
  context?: ToolEventMappingContext,
): SessionNotification {
  const args = getToolArgs(event.args ?? context?.toolCallState?.rawInput);
  const toolName = getToolName(context, event.toolName) ?? event.toolName;

  const toolCall: ToolCall = {
    toolCallId: event.toolCallId,
    rawInput: context?.toolCallState?.rawInput ?? event.args,
    kind: mapToolKind(toolName),
    status: "pending",
    title: buildToolTitle(toolName, args, context),
    locations: buildToolLocations(toolName, args, context),
    _meta: buildToolMeta(toolName),
  };

  return {
    sessionId,
    update: {
      sessionUpdate: "tool_call",
      ...toolCall,
    },
  };
}

/**
 * Convert a tool execution update event to an ACP ToolCallUpdate notification.
 */
export function mapToolExecutionUpdate(
  sessionId: string,
  event: { toolCallId: string; toolName?: string; args?: unknown; partialResult: unknown },
  context?: ToolEventMappingContext,
): SessionNotification {
  const args = getToolArgs(event.args ?? context?.toolCallState?.rawInput);
  const toolName = getToolName(context, event.toolName);

  const toolUpdate: ToolCallUpdate = {
    toolCallId: event.toolCallId,
    status: "in_progress",
    content:
      (toolName === "bash" ? mapTerminalToolContent(context) : undefined) ??
      mapToolResultContent(event.partialResult),
    rawOutput: context?.toolCallState?.rawOutput ?? event.partialResult,
    title: toolName ? buildToolTitle(toolName, args, context) : undefined,
    locations: buildToolLocations(toolName, args, context),
    _meta: buildToolMeta(toolName),
  };

  return {
    sessionId,
    update: {
      sessionUpdate: "tool_call_update",
      ...toolUpdate,
    },
  };
}

/**
 * Convert a tool execution end event to an ACP ToolCallUpdate notification.
 */
export function mapToolExecutionEnd(
  sessionId: string,
  event: {
    toolCallId: string;
    toolName?: string;
    args?: unknown;
    result: unknown;
    isError: boolean;
  },
  context?: ToolEventMappingContext,
): SessionNotification {
  const args = getToolArgs(event.args ?? context?.toolCallState?.rawInput);
  const toolName = getToolName(context, event.toolName);
  const toolStatus: ToolCallStatus = event.isError ? "failed" : "completed";

  let content: ToolCallContent[] | undefined;

  if (toolName === "bash") {
    content = mapTerminalToolContent(context) ?? mapToolResultContent(event.result);
  } else if (!event.isError && context?.toolCallState?.diff) {
    const diff = context.toolCallState.diff;
    content = [createDiffContent(diff.path, diff.newText, diff.oldText ?? undefined)];
  } else {
    content = mapToolResultContent(event.result);
  }

  if ((!content || content.length === 0) && event.isError) {
    const errorMessage = extractTextFromUnknown(event.result) ?? "Tool execution failed";
    content = [createToolCallContent(`Error: ${errorMessage}`)];
  }

  const toolUpdate: ToolCallUpdate = {
    toolCallId: event.toolCallId,
    kind: toolName ? mapToolKind(toolName) : undefined,
    status: toolStatus,
    content,
    rawOutput: context?.toolCallState?.rawOutput ?? event.result,
    title: toolName ? buildToolTitle(toolName, args, context) : undefined,
    locations: buildToolLocations(toolName, args, context),
    _meta: buildToolMeta(toolName),
  };

  return {
    sessionId,
    update: {
      sessionUpdate: "tool_call_update",
      ...toolUpdate,
    },
  };
}

// =============================================================================
// Main Event Mapper
// =============================================================================

/**
 * Main function to map any Pi AgentSessionEvent to an ACP SessionNotification
 */
export function mapAgentEvent(
  sessionId: string,
  event: AgentSessionEvent,
  context?: ToolEventMappingContext,
): SessionNotification | undefined {
  if ("type" in event) {
    const eventType = (event as { type: string }).type;

    switch (eventType) {
      case "message_update": {
        const msgEvent = event as AgentEvent & {
          type: "message_update";
          assistantMessageEvent: AssistantMessageEvent;
        };
        return mapMessageUpdate(sessionId, msgEvent);
      }

      case "tool_execution_start": {
        const toolEvent = event as {
          type: "tool_execution_start";
          toolCallId: string;
          toolName: string;
          args: unknown;
        };
        return mapToolExecutionStart(sessionId, toolEvent, context);
      }

      case "tool_execution_update": {
        const toolEvent = event as {
          type: "tool_execution_update";
          toolCallId: string;
          toolName?: string;
          args?: unknown;
          partialResult: unknown;
        };
        return mapToolExecutionUpdate(sessionId, toolEvent, context);
      }

      case "tool_execution_end": {
        const toolEvent = event as {
          type: "tool_execution_end";
          toolCallId: string;
          toolName?: string;
          args?: unknown;
          result: unknown;
          isError: boolean;
        };
        return mapToolExecutionEnd(sessionId, toolEvent, context);
      }

      case "agent_end":
      case "message_end":
      case "turn_end":
        return undefined;

      case "agent_start":
      case "turn_start":
      case "message_start":
        return undefined;
    }
  }

  return undefined;
}

/**
 * Get stop reason from agent end event
 */
export function getStopReasonFromEnd(event: AgentEvent & { type: "agent_end" }): StopReason {
  const lastMessage = event.messages[event.messages.length - 1];
  if (lastMessage && "stopReason" in lastMessage) {
    return mapStopReason((lastMessage as { stopReason?: string }).stopReason);
  }
  return "end_turn";
}

/**
 * Check if an event represents the final update for a prompt turn
 */
export function isFinalEvent(event: AgentSessionEvent): boolean {
  return (event as { type: string }).type === "agent_end";
}

// =============================================================================
// Re-exports
// =============================================================================

export {
  mapToolKind,
  mapStopReason,
  createStructuredToolCallContent,
  createToolCallContent,
  createDiffContent,
  createTerminalContent,
} from "./types.js";
