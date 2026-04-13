/**
 * Pi SDK ACP Adapter - Type Definitions
 *
 * Core types for bridging the Pi Coding Agent SDK with the
 * Agent Client Protocol (ACP).
 */

import type {
  SessionNotification,
  SessionConfigOption,
  ToolCall,
  ToolCallUpdate,
  AgentCapabilities,
  PromptCapabilities,
  SessionCapabilities,
  TextContent,
  ToolCallContent,
  ToolKind,
  StopReason,
  ContentBlock,
  ClientCapabilities,
} from "@agentclientprotocol/sdk";

import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionEventListener,
} from "@mariozechner/pi-coding-agent";

import type { ThinkingLevel, AgentEvent } from "@mariozechner/pi-agent-core";

import type { Model, Provider, AssistantMessageEvent } from "@mariozechner/pi-ai";

// =============================================================================
// Session State
// =============================================================================

/** ACP session state */
export interface AcpSessionState {
  /** Unique session identifier for ACP protocol */
  sessionId: string;
  /** Underlying Pi AgentSession instance */
  session: AgentSession | null;
  /** Cleanup hook for the Pi runtime backing this session */
  dispose: (() => void) | null;
  /** Working directory for this session */
  cwd: string;
  /** Additional workspace directories beyond cwd */
  additionalDirectories: string[];
  /** Current model ID in use */
  currentModelId?: string;
  /** Current thinking level in use */
  currentThinkingLevel?: ThinkingLevel;
  /** Last captured edit diff for use in tool_execution_end */
  lastEditDiff?: {
    path: string;
    oldText: string;
    newText: string;
  };
}

// =============================================================================
// Client Capabilities
// =============================================================================

/** Normalized ACP client capabilities used by the adapter/runtime layers. */
export interface AcpClientCapabilitiesSnapshot {
  /** Raw client capabilities from initialize(). */
  raw: ClientCapabilities | null;
  /** Whether the client can service fs/read_text_file. */
  supportsReadTextFile: boolean;
  /** Whether the client can service fs/write_text_file. */
  supportsWriteTextFile: boolean;
  /** Whether the client can service terminal methods. */
  supportsTerminal: boolean;
}

/** Capture and normalize client capabilities advertised during initialize(). */
export function captureClientCapabilities(
  capabilities?: ClientCapabilities | null,
): AcpClientCapabilitiesSnapshot {
  return {
    raw: capabilities ?? null,
    supportsReadTextFile: capabilities?.fs?.readTextFile === true,
    supportsWriteTextFile: capabilities?.fs?.writeTextFile === true,
    supportsTerminal: capabilities?.terminal === true,
  };
}

/** Get the list of ACP client capabilities required for Pi's 4-tool surface. */
export function getMissingRequiredClientCapabilities(
  capabilities: AcpClientCapabilitiesSnapshot,
): string[] {
  const missing: string[] = [];

  if (!capabilities.supportsReadTextFile) {
    missing.push("fs.readTextFile");
  }

  if (!capabilities.supportsWriteTextFile) {
    missing.push("fs.writeTextFile");
  }

  if (!capabilities.supportsTerminal) {
    missing.push("terminal");
  }

  return missing;
}

/** Create a user-facing incompatibility message for missing ACP client capabilities. */
export function createMissingClientCapabilitiesMessage(missing: string[]): string {
  return `Pi Coding Agent requires ACP client capabilities: ${missing.join(", ")}. This client is not compatible with Pi's read/write/edit/bash tool surface.`;
}

// =============================================================================
// Configuration Options
// =============================================================================

/** Model info for configuration display */
export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
}

/** Session config options for model list and thinking level */
export interface SessionConfigOptions {
  modelList: ModelInfo[];
  thinkingLevels: ThinkingLevel[];
}

/** Map ACP config option category to Pi setting */
export type ConfigCategory = "model" | "thought_level" | "mode";

// =============================================================================
// Event Mapping
// =============================================================================

/** Result from mapping a Pi event to ACP notification */
export interface MappedNotification {
  notification: SessionNotification;
  isFinal: boolean;
}

// =============================================================================
// Tool Bridge
// =============================================================================

/**
 * Map Pi tool name to ACP ToolKind
 * Note: ACP's ToolKind doesn't include "write", so we map it to "other"
 */
export function mapToolKind(toolName: string): ToolKind {
  switch (toolName) {
    case "read":
      return "read";
    case "edit":
      return "edit";
    case "delete":
      return "delete";
    case "move":
      return "move";
    case "bash":
      return "execute";
    case "write":
    default:
      return "other";
  }
}

// =============================================================================
// Stop Reason Mapping
// =============================================================================

/**
 * Map Pi stop reasons to ACP StopReason
 */
export function mapStopReason(reason: string | undefined): StopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "end_turn";
    case "error":
      return "end_turn";
    case "aborted":
      return "cancelled";
    case "refusal":
      return "refusal";
    default:
      return "end_turn";
  }
}

// =============================================================================
// Meta Constants
// =============================================================================

/** Key for storing tool name in _meta (Zed compatibility) */
export const TOOL_NAME_META_KEY = "tool_name";

// =============================================================================
// Content Helpers
// =============================================================================

/** Create a text content block for session updates */
export function createTextContent(text: string): ContentBlock {
  return { type: "text", text };
}

/** Create tool call content with text */
export function createToolCallContent(text: string): ToolCallContent {
  // ToolCallContent is (Content & { type: "content" }) | (Diff & { type: "diff" }) | (Terminal & { type: "terminal" })
  // Content = { _meta?, content: ContentBlock }
  // So we need: { type: "content", content: ContentBlock, _meta? }
  return {
    type: "content",
    content: { type: "text", text },
  } as ToolCallContent;
}

/** Create tool call content with diff */
export function createDiffContent(
  path: string,
  newText: string,
  oldText?: string,
): ToolCallContent {
  return {
    type: "diff",
    path,
    newText,
    oldText: oldText ?? null,
    _meta: {
      kind: !oldText ? "add" : "edit",
    },
  } as ToolCallContent;
}

/** Create tool call content with terminal */
export function createTerminalContent(terminalId: string): ToolCallContent {
  return {
    type: "terminal",
    terminalId,
  } as ToolCallContent;
}

// =============================================================================
// Re-exports
// =============================================================================

export type {
  SessionNotification,
  SessionConfigOption,
  ToolCall,
  ToolCallUpdate,
  AgentCapabilities,
  PromptCapabilities,
  SessionCapabilities,
  TextContent,
  ToolCallContent,
  ToolKind,
  StopReason,
  ContentBlock,
  ClientCapabilities,
};

export type { AgentSession, AgentSessionEvent, AgentSessionEventListener };

export type { ThinkingLevel, AgentEvent };

export type { Model, Provider, AssistantMessageEvent };
