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
  AvailableCommand,
  Implementation,
} from "@agentclientprotocol/sdk";

import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionEventListener,
  SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";

import type { ThinkingLevel, AgentEvent } from "@earendil-works/pi-agent-core";

import type { Model, Provider, AssistantMessageEvent } from "@earendil-works/pi-ai";

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
  /** Whether a tool_call notification was already sent during the generation phase. */
  generationNotified?: boolean;
  /** Raw arguments last sent to the client during generation phase, for deduplication. */
  lastNotifiedRawInput?: unknown;
}

/** Latest ACP usage snapshot emitted for a session. */
export interface AcpSessionUsageSnapshot {
  /** Total context window size in tokens. */
  size: number;
  /** Tokens currently in the active model context. */
  used: number;
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
  /** Latest title emitted to the ACP client. */
  title?: string | null;
  /** Latest updatedAt emitted to the ACP client. */
  updatedAt?: string | null;
  /** Last usage update emitted to the ACP client. */
  lastUsageUpdate?: AcpSessionUsageSnapshot;
  /** Last config options emitted/returned to the ACP client. */
  lastConfigOptions?: SessionConfigOption[];
  /** Per-tool-call ACP rendering state captured during execution. */
  pendingToolCalls: Map<string, AcpToolCallState>;
  /** Callback for reading Pi slash commands available in this session. */
  getSlashCommands?: () => SlashCommandInfo[];
  /** Last slash command list advertised to the ACP client. */
  availableCommands?: AvailableCommand[];
}

// =============================================================================
// Client Capabilities
// =============================================================================

/** Normalized ACP client capabilities used by the adapter layers. */
export interface AcpClientCapabilitiesSnapshot {
  /** Raw client capabilities from initialize(). */
  raw: ClientCapabilities | null;
  /** Client implementation info (name, version, title). */
  clientInfo: Implementation | null;
  /** Whether the client opted into ACP terminal auth methods. */
  supportsTerminalAuth: boolean;
}

function hasLegacyTerminalAuthCapability(capabilities?: ClientCapabilities | null): boolean {
  const meta = capabilities?._meta;
  return Boolean(meta && typeof meta === "object" && meta["terminal-auth"] === true);
}

/** Capture and normalize client capabilities advertised during initialize(). */
export function captureClientCapabilities(
  capabilities?: ClientCapabilities | null,
  clientInfo?: Implementation | null,
): AcpClientCapabilitiesSnapshot {
  return {
    raw: capabilities ?? null,
    clientInfo: clientInfo ?? null,
    supportsTerminalAuth:
      capabilities?.auth?.terminal === true || hasLegacyTerminalAuthCapability(capabilities),
  };
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
  AvailableCommand,
};

export type { AgentSession, AgentSessionEvent, AgentSessionEventListener };

export type { ThinkingLevel, AgentEvent };

export type { Model, Provider, AssistantMessageEvent };
