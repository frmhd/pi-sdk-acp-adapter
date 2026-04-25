import type { AgentSideConnection, PromptRequest, PromptResponse } from "@agentclientprotocol/sdk";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";

import type { AcpClientCapabilitiesSnapshot, AcpSessionState, AcpToolCallState } from "../types.js";
import { mapAgentEvent, mapStopReason } from "../AcpEventMapper.js";
import { resolvePromptPathsInText } from "../resolvePromptPaths.js";
import { extractContentFromBlocks } from "./promptContent.js";
import {
  extractFirstChangedLine,
  getOrCreateToolCallState,
  mergeCapturedRawOutput,
  releaseToolCallResources,
} from "./toolCallState.js";
import { generateSessionTitle, getSmallModelSpec } from "./titleGeneration.js";

export async function executePrompt(options: {
  connection: AgentSideConnection;
  request: PromptRequest;
  sessionState: AcpSessionState;
  clientCapabilities: AcpClientCapabilitiesSnapshot;
  refreshSessionUsage: (sessionState: AcpSessionState, force?: boolean) => Promise<void>;
  refreshConfigOptions: (sessionState: AcpSessionState, force?: boolean) => Promise<void>;
  refreshSessionMetadata: (sessionState: AcpSessionState, force?: boolean) => Promise<void>;
  refreshAvailableCommands: (sessionState: AcpSessionState, force?: boolean) => Promise<void>;
}): Promise<PromptResponse> {
  if (!options.sessionState.session) {
    throw new Error(`Session ${options.request.sessionId} not found or not initialized`);
  }

  const session = options.sessionState.session;
  const { text: rawUserText, images } = extractContentFromBlocks(options.request.prompt);

  if (!rawUserText.trim() && images.length === 0) {
    return {
      stopReason: "end_turn",
    };
  }

  const userText = await resolvePromptPathsInText({
    text: rawUserText,
    cwd: options.sessionState.cwd,
    additionalDirectories: options.sessionState.additionalDirectories,
    connection: options.connection,
    sessionId: options.request.sessionId,
    clientCapabilities: options.clientCapabilities,
  });

  let sessionUpdateQueue: Promise<void> = Promise.resolve();
  const enqueueSessionUpdate = (work: () => Promise<void>) => {
    sessionUpdateQueue = sessionUpdateQueue.then(work, work);
  };

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    const eventType = (event as { type?: string }).type;
    let toolCallState: AcpToolCallState | undefined;
    let completedToolCallId: string | undefined;

    if (eventType === "tool_execution_start") {
      const toolEvent = event as {
        toolCallId: string;
        toolName: string;
        args: unknown;
      };
      toolCallState = getOrCreateToolCallState(options.sessionState, toolEvent.toolCallId);
      toolCallState.toolName = toolEvent.toolName;
      toolCallState.rawInput = toolEvent.args;
    } else if (eventType === "tool_execution_update") {
      const toolEvent = event as {
        toolCallId: string;
        toolName?: string;
        partialResult: unknown;
      };
      toolCallState = options.sessionState.pendingToolCalls.get(toolEvent.toolCallId);
      if (toolCallState) {
        toolCallState.toolName ??= toolEvent.toolName;
        toolCallState.rawOutput = mergeCapturedRawOutput(
          toolCallState,
          toolEvent.partialResult,
          "update",
        );
      }
    } else if (eventType === "tool_execution_end") {
      const toolEvent = event as {
        toolCallId: string;
        toolName?: string;
        result: unknown;
      };
      completedToolCallId = toolEvent.toolCallId;
      toolCallState = options.sessionState.pendingToolCalls.get(toolEvent.toolCallId);
      if (toolCallState) {
        toolCallState.toolName ??= toolEvent.toolName;
        toolCallState.rawOutput = mergeCapturedRawOutput(toolCallState, toolEvent.result, "end");
        const firstChangedLine = extractFirstChangedLine(toolEvent.result);
        if (firstChangedLine !== undefined) {
          toolCallState.firstChangedLine = firstChangedLine;
        }
      }
    } else if (eventType === "message_update") {
      const msgEvent = event as {
        type: "message_update";
        assistantMessageEvent: {
          type: string;
          contentIndex: number;
          partial: { content: unknown[] };
        };
      };
      const ame = msgEvent.assistantMessageEvent;
      if (
        ame.type === "toolcall_start" ||
        ame.type === "toolcall_delta" ||
        ame.type === "toolcall_end"
      ) {
        const content = ame.partial.content[ame.contentIndex];
        if (
          content &&
          typeof content === "object" &&
          (content as { type?: string }).type === "toolCall"
        ) {
          const toolCallContent = content as {
            id: string;
            name: string;
            arguments: Record<string, unknown>;
          };
          toolCallState = getOrCreateToolCallState(options.sessionState, toolCallContent.id);
          toolCallState.toolName = toolCallContent.name;
          toolCallState.rawInput = toolCallContent.arguments;
          if (ame.type === "toolcall_start") {
            toolCallState.generationNotified = true;
          }
        }
      }
    }

    const notification = mapAgentEvent(options.request.sessionId, event, {
      cwd: options.sessionState.cwd,
      toolCallState,
    });

    if (notification && toolCallState && eventType === "message_update") {
      const ame = (event as { assistantMessageEvent?: { type?: string } }).assistantMessageEvent;
      if (
        ame?.type === "toolcall_start" ||
        ame?.type === "toolcall_delta" ||
        ame?.type === "toolcall_end"
      ) {
        toolCallState.lastNotifiedRawInput = toolCallState.rawInput;
      }
    }

    const finishedToolCallId = completedToolCallId;
    const finishedToolCallState = toolCallState;
    const shouldRefreshUsageAfterEvent = eventType === "tool_execution_end";
    if (finishedToolCallId) {
      options.sessionState.pendingToolCalls.delete(finishedToolCallId);
    }

    enqueueSessionUpdate(async () => {
      try {
        if (notification) {
          await options.connection.sessionUpdate(notification);
        }

        if (shouldRefreshUsageAfterEvent) {
          await options.refreshSessionUsage(options.sessionState).catch((error) => {
            console.warn(
              `Failed to refresh session usage for ${options.request.sessionId}:`,
              error,
            );
          });
          await options.refreshConfigOptions(options.sessionState).catch((error) => {
            console.warn(
              `Failed to refresh session config options for ${options.request.sessionId}:`,
              error,
            );
          });
        }
      } catch (err) {
        console.error(`Failed to send session update for ${options.request.sessionId}:`, err);
      } finally {
        if (finishedToolCallState && finishedToolCallId) {
          await releaseToolCallResources(finishedToolCallState);
        }
      }
    });
  });

  const willBeFirstUserMessage =
    session.state.messages.filter((m) => m.role === "user").length === 0;
  const hasExplicitName = session.sessionManager.getSessionName() !== undefined;
  const shouldGenerateTitle =
    willBeFirstUserMessage && !hasExplicitName && getSmallModelSpec() !== null;

  try {
    await session.prompt(userText, images.length > 0 ? { images } : undefined);

    if (shouldGenerateTitle) {
      void (async () => {
        try {
          const title = await generateSessionTitle(userText, session.modelRegistry);
          if (title && options.sessionState.session) {
            options.sessionState.session.setSessionName(title);
            await options.refreshSessionMetadata(options.sessionState, true).catch((error) => {
              console.warn(
                `Failed to refresh session metadata after title generation for ${options.request.sessionId}:`,
                error,
              );
            });
          }
        } catch (error) {
          console.warn(`Title generation failed for ${options.request.sessionId}:`, error);
        }
      })();
    }

    const lastMessage = session.state.messages[session.state.messages.length - 1];
    let stopReason: import("@agentclientprotocol/sdk").StopReason = "end_turn";

    if (lastMessage && lastMessage.role === "assistant") {
      const assistantMsg = lastMessage as { stopReason?: string };
      stopReason = mapStopReason(assistantMsg.stopReason);
    }

    return {
      stopReason,
    };
  } catch (error) {
    console.error(`Prompt error for session ${options.request.sessionId}:`, error);
    throw error;
  } finally {
    unsubscribe();
    await sessionUpdateQueue;
    await options.refreshSessionUsage(options.sessionState).catch((error) => {
      console.warn(`Failed to refresh session usage for ${options.request.sessionId}:`, error);
    });
    await options.refreshConfigOptions(options.sessionState).catch((error) => {
      console.warn(
        `Failed to refresh session config options for ${options.request.sessionId}:`,
        error,
      );
    });
    await options.refreshSessionMetadata(options.sessionState).catch((error) => {
      console.warn(`Failed to refresh session metadata for ${options.request.sessionId}:`, error);
    });
    await options.refreshAvailableCommands(options.sessionState).catch((error) => {
      console.warn(`Failed to refresh slash commands for ${options.request.sessionId}:`, error);
    });
  }
}
