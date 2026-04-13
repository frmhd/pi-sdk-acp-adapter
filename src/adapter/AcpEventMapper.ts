/**
 * ACP Event Mapper
 *
 * Maps Pi AgentSession events to ACP SessionNotification protocol messages.
 */

import type {
  SessionNotification,
  ToolCall,
  ToolCallUpdate,
  ToolCallContent,
  ToolCallLocation,
  ContentChunk,
  StopReason,
  ToolCallStatus,
} from "@agentclientprotocol/sdk";

import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";

import type { AgentEvent } from "@mariozechner/pi-agent-core";

import type { AssistantMessageEvent } from "@mariozechner/pi-ai";

import { mapToolKind, mapStopReason, createToolCallContent, createDiffContent } from "./types.js";

// =============================================================================
// Meta Constants
// =============================================================================

/** Key for storing tool name in _meta (Zed compatibility) */
const TOOL_NAME_META_KEY = "tool_name";

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
 *
 * Provides descriptive titles and file locations for transparency in the UI.
 * (Gemini CLI feature parity)
 */
export function mapToolExecutionStart(
  sessionId: string,
  event: { toolCallId: string; toolName: string; args: unknown },
): SessionNotification {
  const args = (event.args as Record<string, unknown>) || {};
  let title = event.toolName;
  const locations: ToolCallLocation[] = [];

  // Generate descriptive titles and locations based on tool and args
  switch (event.toolName) {
    case "bash":
      if (typeof args.command === "string") {
        title = `Running: ${args.command}`;
      }
      break;
    case "read":
    case "readFile":
      if (typeof args.path === "string") {
        title = `Reading: ${args.path}`;
        locations.push({ path: args.path });
      }
      break;
    case "write":
    case "writeFile":
      if (typeof args.path === "string") {
        title = `Writing: ${args.path}`;
        locations.push({ path: args.path });
      }
      break;
    case "edit":
    case "applyEdits":
      if (typeof args.path === "string") {
        title = `Editing: ${args.path}`;
        locations.push({ path: args.path });
      }
      break;
  }

  const toolCall: ToolCall = {
    toolCallId: event.toolCallId,
    rawInput: event.args,
    kind: mapToolKind(event.toolName),
    status: "pending",
    title,
    locations: locations.length > 0 ? locations : undefined,
    _meta: {
      [TOOL_NAME_META_KEY]: event.toolName,
    },
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
 * Convert partial result to text content
 */
function extractTextFromPartialResult(partialResult: unknown): string | undefined {
  if (typeof partialResult === "string") {
    return partialResult;
  }

  if (typeof partialResult === "object" && partialResult !== null) {
    const partial = partialResult as Record<string, unknown>;

    // Handle string fields
    const stringFields = ["output", "content", "stdout", "stderr", "result", "message"];
    for (const field of stringFields) {
      if (typeof partial[field] === "string") {
        return partial[field] as string;
      }
    }

    // Handle number fields (e.g., exit codes)
    if (typeof partial.exitCode === "number") {
      return String(partial.exitCode);
    }
  }

  return undefined;
}

/**
 * Convert a tool execution update event to an ACP ToolCallUpdate notification
 */
export function mapToolExecutionUpdate(
  sessionId: string,
  event: { toolCallId: string; partialResult: unknown },
): SessionNotification {
  const text = extractTextFromPartialResult(event.partialResult);

  const toolUpdate: ToolCallUpdate = {
    toolCallId: event.toolCallId,
    status: "in_progress",
    content: text ? [createToolCallContent(text)] : undefined,
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
 * Extract text from tool result
 */
function extractTextFromResult(result: unknown): string | undefined {
  if (typeof result === "string") {
    return result;
  }

  if (typeof result === "object" && result !== null) {
    const r = result as Record<string, unknown>;

    // Various possible result formats
    const fields = ["stdout", "content", "output", "result", "message", "text", "data"];

    for (const field of fields) {
      if (typeof r[field] === "string") {
        return r[field] as string;
      }

      // Handle array results (e.g., grep results)
      if (Array.isArray(r[field])) {
        const items = r[field] as unknown[];
        const textParts: string[] = [];

        for (const item of items) {
          if (typeof item === "string") {
            textParts.push(item);
          } else if (typeof item === "object" && item !== null) {
            // Try to extract text from object
            const obj = item as Record<string, unknown>;
            if (typeof obj.text === "string") {
              textParts.push(obj.text);
            } else if (typeof obj.path === "string") {
              textParts.push(obj.path);
            } else if (typeof obj.match === "string") {
              textParts.push(obj.match);
            } else {
              textParts.push(JSON.stringify(item));
            }
          }
        }

        if (textParts.length > 0) {
          return textParts.join("\n");
        }
      }
    }

    // Handle special fields
    if (typeof r.path === "string" && "written" in r) {
      return `Written to ${r.path}`;
    }
  }

  return undefined;
}

/**
 * Convert a tool execution end event to an ACP ToolCallUpdate notification
 */
export function mapToolExecutionEnd(
  sessionId: string,
  event: { toolCallId: string; result: unknown; isError: boolean },
  lastEditDiff?: { path: string; oldText: string; newText: string },
): SessionNotification {
  const text = extractTextFromResult(event.result);
  let toolStatus: ToolCallStatus = "completed";

  if (event.isError) {
    toolStatus = "failed";
  }

  const content: ToolCallContent[] = [];

  // Use diff content if available (Gemini CLI feature parity)
  if (lastEditDiff) {
    content.push(createDiffContent(lastEditDiff.path, lastEditDiff.newText, lastEditDiff.oldText));
  } else if (text) {
    content.push(createToolCallContent(text));
  } else if (event.isError) {
    // Create error message if no text content
    const errorMsg =
      typeof event.result === "string"
        ? event.result
        : (((event.result as Record<string, unknown>)?.message as string) ??
          "Tool execution failed");
    content.push(createToolCallContent(`Error: ${errorMsg}`));
  }

  const toolUpdate: ToolCallUpdate = {
    toolCallId: event.toolCallId,
    status: toolStatus,
    content: content.length > 0 ? content : undefined,
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
  lastEditDiff?: { path: string; oldText: string; newText: string },
): SessionNotification | undefined {
  // Handle AgentEvent types (from pi-agent-core)
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
        return mapToolExecutionStart(sessionId, toolEvent);
      }

      case "tool_execution_update": {
        const toolEvent = event as {
          type: "tool_execution_update";
          toolCallId: string;
          partialResult: unknown;
        };
        return mapToolExecutionUpdate(sessionId, toolEvent);
      }

      case "tool_execution_end": {
        const toolEvent = event as {
          type: "tool_execution_end";
          toolCallId: string;
          result: unknown;
          isError: boolean;
        };
        return mapToolExecutionEnd(sessionId, toolEvent, lastEditDiff);
      }

      // These are informational, handled by prompt response stopReason
      case "agent_end":
      case "message_end":
      case "turn_end":
        return undefined;

      // These don't map to visible session updates
      case "agent_start":
      case "turn_start":
      case "message_start":
        return undefined;
    }
  }

  // Handle extended AgentSessionEvent types (queue_update, compaction, etc.)
  // These don't map to visible session updates
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
  createToolCallContent,
  createDiffContent,
  createTerminalContent,
} from "./types.js";
