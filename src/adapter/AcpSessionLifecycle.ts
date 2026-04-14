import { mkdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";

import type {
  AgentSideConnection,
  AvailableCommand,
  ContentBlock,
  SessionInfo as AcpSessionInfo,
  SessionNotification,
} from "@agentclientprotocol/sdk";

import type {
  AgentSession,
  SessionInfo as PiSessionInfo,
  SessionEntry,
  SlashCommandInfo,
} from "@mariozechner/pi-coding-agent";

import type {
  TextContent,
  ImageContent,
  ThinkingContent,
  ToolCall as PiToolCall,
  ToolResultMessage,
  UserMessage,
  AssistantMessage,
} from "@mariozechner/pi-ai";

import { mapToolExecutionEnd, mapToolExecutionStart } from "./AcpEventMapper.js";

const SESSION_TITLE_MAX_LENGTH = 80;

type HistoricalToolCall = {
  toolName: string;
  args: Record<string, unknown>;
};

function getDefaultAgentDir(): string {
  return join(homedir(), ".pi", "agent");
}

function getSessionsRoot(agentDir?: string): string {
  const root = join(agentDir ?? getDefaultAgentDir(), "sessions");
  mkdirSync(root, { recursive: true });
  return root;
}

export function getAcpSessionDirectory(cwd: string, agentDir?: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = join(getSessionsRoot(agentDir), safePath);
  mkdirSync(sessionDir, { recursive: true });
  return sessionDir;
}

export async function listPersistedPiSessions(params: {
  cwd?: string | null;
  agentDir?: string;
}): Promise<PiSessionInfo[]> {
  if (params.cwd) {
    const { SessionManager } = await import("@mariozechner/pi-coding-agent");
    return SessionManager.list(params.cwd, getAcpSessionDirectory(params.cwd, params.agentDir));
  }

  const root = getSessionsRoot(params.agentDir);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name));
  const { SessionManager } = await import("@mariozechner/pi-coding-agent");

  const sessions = (
    await Promise.all(dirs.map((dir) => SessionManager.list(process.cwd(), dir).catch(() => [])))
  ).flat();

  sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
  return sessions;
}

function normalizeSessionTitle(title: string | undefined): string | null {
  if (!title) {
    return null;
  }

  const normalized = title.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }

  if (normalized.length <= SESSION_TITLE_MAX_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, SESSION_TITLE_MAX_LENGTH - 1).trimEnd()}…`;
}

function extractUserText(content: UserMessage["content"]): string | undefined {
  if (typeof content === "string") {
    return content;
  }

  const parts = content
    .filter((item): item is TextContent => item.type === "text")
    .map((item) => item.text.trim())
    .filter(Boolean);

  return parts.length > 0 ? parts.join(" ") : undefined;
}

function deriveTitleFromEntries(entries: SessionEntry[]): string | undefined {
  for (const entry of entries) {
    if (entry.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) {
      return entry.name;
    }

    if (entry.type === "message" && entry.message.role === "user") {
      const text = extractUserText(entry.message.content);
      if (text?.trim()) {
        return text;
      }
    }
  }

  return undefined;
}

function deriveTitleFromSession(session: AgentSession): string | null {
  const explicitName = session.sessionManager.getSessionName();
  if (explicitName) {
    return normalizeSessionTitle(explicitName);
  }

  const fromMessages = session.state.messages.find(
    (message): message is UserMessage => message.role === "user",
  );
  const firstUserText = fromMessages ? extractUserText(fromMessages.content) : undefined;
  if (firstUserText) {
    return normalizeSessionTitle(firstUserText);
  }

  return normalizeSessionTitle(deriveTitleFromEntries(session.sessionManager.getEntries()));
}

function deriveUpdatedAtFromSession(session: AgentSession): string | null {
  const lastEntry = session.sessionManager.getEntries().at(-1);
  if (lastEntry?.timestamp) {
    return lastEntry.timestamp;
  }

  const header = session.sessionManager.getHeader();
  if (header?.timestamp) {
    return header.timestamp;
  }

  const lastMessage = session.state.messages.at(-1) as { timestamp?: number } | undefined;
  if (typeof lastMessage?.timestamp === "number") {
    return new Date(lastMessage.timestamp).toISOString();
  }

  return null;
}

export function buildAcpSessionInfo(info: PiSessionInfo): AcpSessionInfo {
  const derivedTitle = normalizeSessionTitle(info.name) ?? normalizeSessionTitle(info.firstMessage);

  return {
    cwd: info.cwd,
    sessionId: info.id,
    title: derivedTitle,
    updatedAt: info.modified.toISOString(),
  };
}

export function getCurrentSessionMetadata(session: AgentSession): {
  title: string | null;
  updatedAt: string | null;
} {
  return {
    title: deriveTitleFromSession(session),
    updatedAt: deriveUpdatedAtFromSession(session),
  };
}

export async function emitSessionNotification(
  connection: AgentSideConnection,
  notification: SessionNotification,
): Promise<void> {
  await connection.sessionUpdate(notification);
}

export async function emitSessionInfoUpdate(
  connection: AgentSideConnection,
  sessionId: string,
  metadata: { title: string | null; updatedAt: string | null },
): Promise<void> {
  await emitSessionNotification(connection, {
    sessionId,
    update: {
      sessionUpdate: "session_info_update",
      title: metadata.title,
      updatedAt: metadata.updatedAt,
    },
  });
}

function fallbackCommandDescription(command: SlashCommandInfo): string {
  return `Run /${command.name}`;
}

export function buildAcpAvailableCommands(commands: SlashCommandInfo[]): AvailableCommand[] {
  return commands.map((command) => ({
    name: command.name,
    description: command.description?.trim() || fallbackCommandDescription(command),
  }));
}

export function areAvailableCommandsEqual(
  left: AvailableCommand[] | undefined,
  right: AvailableCommand[],
): boolean {
  if (!left || left.length !== right.length) {
    return false;
  }

  return left.every((command, index) => {
    const other = right[index];
    return (
      command.name === other.name &&
      command.description === other.description &&
      JSON.stringify(command.input ?? null) === JSON.stringify(other.input ?? null)
    );
  });
}

export async function emitAvailableCommandsUpdate(
  connection: AgentSideConnection,
  sessionId: string,
  availableCommands: AvailableCommand[],
): Promise<void> {
  await emitSessionNotification(connection, {
    sessionId,
    update: {
      sessionUpdate: "available_commands_update",
      availableCommands,
    },
  });
}

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

function expandToolPath(filePath: string): string {
  if (filePath === "~") {
    return homedir();
  }

  if (filePath.startsWith("~/")) {
    return `${homedir()}${filePath.slice(1)}`;
  }

  return filePath.startsWith("@") ? filePath.slice(1) : filePath;
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
  if (!path) {
    return undefined;
  }

  const expanded = expandToolPath(path);
  return isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded);
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
