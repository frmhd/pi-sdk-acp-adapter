import type { PromptRequest, PromptResponse, StopReason } from "@agentclientprotocol/sdk";
import type { AcpAgentClientContext } from "../acpClientContext.js";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";

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
import { extractUserText } from "../session/sessionMetadata.js";
import {
  generateSessionTitle,
  generateSessionTitleFromMessages,
  getSmallModelSpec,
} from "./titleGeneration.js";

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return msg.includes("abort") || msg.includes("cancelled") || error.name === "AbortError";
}

function enqueueErrorChunk(
  enqueue: (work: () => Promise<void>) => void,
  connection: AcpAgentClientContext,
  sessionId: string,
  text: string,
  label: string,
): void {
  enqueue(async () => {
    try {
      await connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        },
      });
    } catch (sendErr) {
      console.error(`Failed to send ${label} for session ${sessionId}:`, sendErr);
    }
  });
}

export async function executePrompt(options: {
  connection: AcpAgentClientContext;
  request: PromptRequest;
  sessionState: AcpSessionState;
  clientCapabilities: AcpClientCapabilitiesSnapshot;
  refreshSessionUsage: (sessionState: AcpSessionState, force?: boolean) => Promise<void>;
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

  const trimmedText = userText.trim();
  if (trimmedText === "/regenerate-title") {
    // Skip if no small model is configured
    if (!getSmallModelSpec()) {
      return { stopReason: "end_turn" };
    }

    // Collect all user messages (excluding assistant responses, tool calls, etc.)
    const userMessages = session.state.messages
      .filter((message): message is UserMessage => message.role === "user")
      .map((message) => extractUserText(message.content))
      .filter((text): text is string => !!text);

    if (userMessages.length === 0) {
      return { stopReason: "end_turn" };
    }

    const title = await generateSessionTitleFromMessages(userMessages, session.modelRuntime);
    if (title) {
      session.setSessionName(title);
      await options.refreshSessionMetadata(options.sessionState, true).catch((error) => {
        console.warn(
          `Failed to refresh session metadata after title regeneration for ${options.request.sessionId}:`,
          error,
        );
      });
    }

    return { stopReason: "end_turn" };
  }

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

  // Kick off title generation in parallel with the main prompt — it only
  // needs the user's text and has no dependency on the assistant's response.
  if (shouldGenerateTitle) {
    void (async () => {
      // Title generation is a best-effort side effect of the first prompt.
      // Swallow failures here so that a model/auth error does not disrupt
      // the user's primary prompt workflow.
      try {
        const title = await generateSessionTitle(userText, session.modelRuntime);
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

  try {
    await session.prompt(userText, images.length > 0 ? { images } : undefined);

    const lastMessage = session.state.messages[session.state.messages.length - 1];
    let stopReason: StopReason = "end_turn";

    if (lastMessage && lastMessage.role === "assistant") {
      const assistantMsg = lastMessage as AssistantMessage;
      stopReason = mapStopReason(assistantMsg.stopReason);

      // Stream ended with an error (e.g., API failure mid-generation). Inject the
      // error text as a message chunk so the user sees what happened in chat.
      if (assistantMsg.stopReason === "error" && assistantMsg.errorMessage) {
        enqueueErrorChunk(
          enqueueSessionUpdate,
          options.connection,
          options.request.sessionId,
          assistantMsg.errorMessage,
          "stream-error message",
        );
      }
    }

    return {
      stopReason,
    };
  } catch (error) {
    if (isAbortError(error)) {
      return { stopReason: "cancelled" };
    }

    const errorText = error instanceof Error ? error.message : String(error);
    console.error(`Prompt error for session ${options.request.sessionId}:`, error);

    // Send the error as an assistant message chunk so the user sees it in the
    // ACP client chat history instead of getting a silent JSON-RPC failure.
    enqueueErrorChunk(
      enqueueSessionUpdate,
      options.connection,
      options.request.sessionId,
      `Error: ${errorText}`,
      "error message",
    );

    return { stopReason: "end_turn" };
  } finally {
    unsubscribe();
    await sessionUpdateQueue;
    await options.refreshSessionUsage(options.sessionState).catch((error) => {
      console.warn(`Failed to refresh session usage for ${options.request.sessionId}:`, error);
    });
    await options.refreshSessionMetadata(options.sessionState).catch((error) => {
      console.warn(`Failed to refresh session metadata for ${options.request.sessionId}:`, error);
    });
    await options.refreshAvailableCommands(options.sessionState).catch((error) => {
      console.warn(`Failed to refresh slash commands for ${options.request.sessionId}:`, error);
    });
  }
}
