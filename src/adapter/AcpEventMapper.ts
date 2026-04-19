import type {
  ContentChunk,
  SessionNotification,
  StopReason,
  ToolCall,
  ToolCallContent,
  ToolCallStatus,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { AssistantMessageEvent } from "@mariozechner/pi-ai";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";

import { createDiffContent, createToolCallContent, mapStopReason, mapToolKind } from "./types.js";
import {
  extractTextFromUnknown,
  mapTerminalToolContent,
  mapToolResultContent,
} from "./events/toolContent.js";
import {
  buildToolLocations,
  buildToolMeta,
  buildToolTitle,
  getToolArgs,
  getToolName,
  type ToolEventMappingContext,
} from "./events/toolPresentation.js";

export type { ToolEventMappingContext } from "./events/toolPresentation.js";

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

export function mapToolExecutionUpdate(
  sessionId: string,
  event: { toolCallId: string; toolName?: string; args?: unknown; partialResult: unknown },
  context?: ToolEventMappingContext,
): SessionNotification {
  const args = getToolArgs(event.args ?? context?.toolCallState?.rawInput);
  const toolName = getToolName(context, event.toolName);

  const mutationDiffContent: ToolCallContent[] | undefined =
    (toolName === "edit" || toolName === "write") && context?.toolCallState?.diff
      ? [
          createDiffContent(
            context.toolCallState.diff.path,
            context.toolCallState.diff.newText,
            context.toolCallState.diff.oldText ?? undefined,
          ),
        ]
      : undefined;

  const toolUpdate: ToolCallUpdate = {
    toolCallId: event.toolCallId,
    status: "in_progress",
    content:
      (toolName === "bash" ? mapTerminalToolContent(context) : undefined) ??
      mutationDiffContent ??
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
      case "agent_start":
      case "turn_start":
      case "message_start":
        return undefined;
    }
  }

  return undefined;
}

export function getStopReasonFromEnd(event: AgentEvent & { type: "agent_end" }): StopReason {
  const lastMessage = event.messages[event.messages.length - 1];
  if (lastMessage && "stopReason" in lastMessage) {
    return mapStopReason((lastMessage as { stopReason?: string }).stopReason);
  }
  return "end_turn";
}

export function isFinalEvent(event: AgentSessionEvent): boolean {
  return (event as { type: string }).type === "agent_end";
}

export {
  mapToolKind,
  mapStopReason,
  createStructuredToolCallContent,
  createToolCallContent,
  createDiffContent,
  createTerminalContent,
} from "./types.js";
