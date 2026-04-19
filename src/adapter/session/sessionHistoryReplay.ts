import type { AgentSideConnection, ContentBlock } from "@agentclientprotocol/sdk";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type {
  AssistantMessage,
  ImageContent,
  TextContent,
  ThinkingContent,
  ToolCall as PiToolCall,
  ToolResultMessage,
} from "@mariozechner/pi-ai";

import { mapToolExecutionEnd, mapToolExecutionStart } from "../AcpEventMapper.js";
import { resolveToolPath } from "../../shared/paths.js";
import { emitSessionNotification } from "./sessionNotifications.js";

type HistoricalToolCall = {
  toolName: string;
  args: Record<string, unknown>;
};

function mapMessageContentBlock(content: TextContent | ImageContent): ContentBlock {
  if (content.type === "text") {
    return { type: "text", text: content.text };
  }

  return {
    type: "image",
    data: content.data,
    mimeType: content.mimeType,
  };
}

function getHistoricalPathArg(args: Record<string, unknown>): string | undefined {
  return typeof args.path === "string"
    ? args.path
    : typeof args.file_path === "string"
      ? args.file_path
      : undefined;
}

function resolveHistoricalToolPath(args: Record<string, unknown>, cwd: string): string | undefined {
  const path = getHistoricalPathArg(args);
  return path ? resolveToolPath(path, cwd) : undefined;
}

function extractHistoricalFirstChangedLine(result: unknown): number | undefined {
  if (typeof result !== "object" || result === null) {
    return undefined;
  }

  const details = (result as { details?: { firstChangedLine?: unknown } }).details;
  return typeof details?.firstChangedLine === "number" ? details.firstChangedLine : undefined;
}

function buildHistoricalToolContext(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
  rawOutput?: unknown,
): {
  cwd: string;
  toolCallState: {
    toolName: string;
    path?: string;
    firstChangedLine?: number;
    rawInput: Record<string, unknown>;
    rawOutput?: unknown;
  };
} {
  return {
    cwd,
    toolCallState: {
      toolName,
      path: resolveHistoricalToolPath(args, cwd),
      firstChangedLine: extractHistoricalFirstChangedLine(rawOutput),
      rawInput: args,
      rawOutput,
    },
  };
}

async function replayContentChunks(
  connection: AgentSideConnection,
  sessionId: string,
  sessionUpdate: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk",
  blocks: ContentBlock[],
): Promise<void> {
  for (const block of blocks) {
    await emitSessionNotification(connection, {
      sessionId,
      update: {
        sessionUpdate,
        content: block,
      },
    });
  }
}

function buildHistoricalToolResult(message: ToolResultMessage): {
  content: ToolResultMessage["content"];
} {
  return {
    content: message.content,
  };
}

async function replayAssistantMessage(
  connection: AgentSideConnection,
  sessionId: string,
  cwd: string,
  message: AssistantMessage,
  historicalToolCalls: Map<string, HistoricalToolCall>,
): Promise<void> {
  for (const part of message.content) {
    if (part.type === "text") {
      await replayContentChunks(connection, sessionId, "agent_message_chunk", [
        mapMessageContentBlock(part),
      ]);
      continue;
    }

    if (part.type === "thinking") {
      const thinkingPart = part as ThinkingContent;
      await replayContentChunks(connection, sessionId, "agent_thought_chunk", [
        { type: "text", text: thinkingPart.thinking },
      ]);
      continue;
    }

    if (part.type === "toolCall") {
      const toolCallPart = part as PiToolCall;
      historicalToolCalls.set(toolCallPart.id, {
        toolName: toolCallPart.name,
        args: toolCallPart.arguments,
      });

      await emitSessionNotification(
        connection,
        mapToolExecutionStart(
          sessionId,
          {
            toolCallId: toolCallPart.id,
            toolName: toolCallPart.name,
            args: toolCallPart.arguments,
          },
          buildHistoricalToolContext(toolCallPart.name, toolCallPart.arguments, cwd),
        ),
      );
    }
  }
}

async function replayHistoricalToolResult(
  connection: AgentSideConnection,
  sessionId: string,
  cwd: string,
  message: ToolResultMessage,
  historicalToolCalls: Map<string, HistoricalToolCall>,
): Promise<void> {
  const existing = historicalToolCalls.get(message.toolCallId);

  if (!existing) {
    await emitSessionNotification(
      connection,
      mapToolExecutionStart(
        sessionId,
        {
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          args: {},
        },
        buildHistoricalToolContext(message.toolName, {}, cwd),
      ),
    );
  }

  const result = buildHistoricalToolResult(message);

  await emitSessionNotification(
    connection,
    mapToolExecutionEnd(
      sessionId,
      {
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        args: existing?.args,
        result,
        isError: message.isError,
      },
      buildHistoricalToolContext(
        existing?.toolName ?? message.toolName,
        existing?.args ?? {},
        cwd,
        result,
      ),
    ),
  );

  historicalToolCalls.delete(message.toolCallId);
}

async function replayHistoricalBashExecution(
  connection: AgentSideConnection,
  sessionId: string,
  cwd: string,
  index: number,
  message: {
    command: string;
    output: string;
    exitCode?: number;
    cancelled: boolean;
    truncated: boolean;
    fullOutputPath?: string;
  },
): Promise<void> {
  const toolCallId = `history-bash-${index}`;
  const args = { command: message.command };

  await emitSessionNotification(
    connection,
    mapToolExecutionStart(
      sessionId,
      {
        toolCallId,
        toolName: "bash",
        args,
      },
      buildHistoricalToolContext("bash", args, cwd),
    ),
  );

  const result = {
    output: message.output,
    exitCode: message.exitCode ?? null,
    truncated: message.truncated,
    fullOutputPath: message.fullOutputPath ?? null,
    cancelled: message.cancelled,
  };

  await emitSessionNotification(
    connection,
    mapToolExecutionEnd(
      sessionId,
      {
        toolCallId,
        toolName: "bash",
        args,
        result,
        isError:
          message.cancelled || (typeof message.exitCode === "number" && message.exitCode !== 0),
      },
      buildHistoricalToolContext("bash", args, cwd, result),
    ),
  );
}

export async function replaySessionHistory(
  connection: AgentSideConnection,
  sessionId: string,
  session: AgentSession,
  cwd: string,
): Promise<void> {
  const historicalToolCalls = new Map<string, HistoricalToolCall>();

  for (const [index, message] of session.state.messages.entries()) {
    if (message.role === "user") {
      const blocks =
        typeof message.content === "string"
          ? ([{ type: "text", text: message.content }] satisfies ContentBlock[])
          : message.content.map(mapMessageContentBlock);
      await replayContentChunks(connection, sessionId, "user_message_chunk", blocks);
      continue;
    }

    if (message.role === "assistant") {
      await replayAssistantMessage(connection, sessionId, cwd, message, historicalToolCalls);
      continue;
    }

    if (message.role === "toolResult") {
      await replayHistoricalToolResult(connection, sessionId, cwd, message, historicalToolCalls);
      continue;
    }

    if (message.role === "bashExecution") {
      await replayHistoricalBashExecution(connection, sessionId, cwd, index, message);
    }
  }
}
