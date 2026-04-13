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

/** ACP diff metadata captured for a single Pi tool call. */
export interface AcpToolCallDiff {
  /** Absolute file path targeted by the mutation. */
  path: string;
  /** Original file contents. Null when the file did not exist yet. */
  oldText: string | null;
  /** Final file contents after the mutation. */
  newText: string;
}

/** Mutable adapter state captured for a single tool call. */
export interface AcpToolCallState {
  /** Pi tool name, e.g. read/write/edit/bash. */
  toolName?: string;
  /** Absolute file path when the tool targets a single file. */
  path?: string;
  /** File diff metadata for edit/write rendering. */
  diff?: AcpToolCallDiff;
  /** First changed line reported by Pi edit details. */
  firstChangedLine?: number;
  /** Raw ACP/Pi input captured at tool start. */
  rawInput?: unknown;
  /** Latest raw Pi output captured during updates/finalization. */
  rawOutput?: unknown;
}

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
  /** Per-tool-call ACP rendering state captured during execution. */
  pendingToolCalls: Map<string, AcpToolCallState>;
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
 * Map Pi tool name to ACP ToolKind.
 *
 * `write` is intentionally mapped to `edit` so ACP clients like Zed render
 * file creation/overwrite using the native diff UI instead of a generic tool card.
 */
export function mapToolKind(toolName: string): ToolKind {
  switch (toolName) {
    case "read":
      return "read";
    case "edit":
    case "write":
      return "edit";
    case "delete":
      return "delete";
    case "move":
      return "move";
    case "bash":
      return "execute";
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

/** Create tool call content from an ACP content block. */
export function createStructuredToolCallContent(content: ContentBlock): ToolCallContent {
  return {
    type: "content",
    content,
  } as ToolCallContent;
}

/** Create tool call content with text */
export function createToolCallContent(text: string): ToolCallContent {
  return createStructuredToolCallContent({ type: "text", text });
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
