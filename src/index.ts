/**
 * Pi SDK ACP Adapter
 *
 * Bridges the Pi Coding Agent SDK with the Agent Client Protocol (ACP).
 * Enables ACP-compatible clients like Zed to use Pi as their backend coding agent.
 */

// Re-export types
export type {
  AcpSessionState,
  ModelInfo,
  SessionConfigOptions,
  MappedNotification,
  ConfigCategory,
} from "./adapter/types.js";

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
} from "./adapter/types.js";

export type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionEventListener,
} from "./adapter/types.js";

export type { ThinkingLevel, AgentEvent } from "./adapter/types.js";

export type { Model, Provider, AssistantMessageEvent } from "./adapter/types.js";

// Re-export session config functions
export {
  ALL_THINKING_LEVELS,
  getAvailableModels,
  createModelConfigOption,
  createThinkingConfigOption,
  getCurrentConfigOptions,
  findModelById,
  handleSetSessionConfigOption,
  buildSetSessionConfigOptionResponse,
  type SetConfigResult,
} from "./adapter/AcpSessionConfig.js";

// Re-export mapper functions
export {
  mapAgentEvent,
  mapToolExecutionStart,
  mapToolExecutionUpdate,
  mapToolExecutionEnd,
  mapMessageUpdate,
  getStopReasonFromEnd,
  isFinalEvent,
  mapToolKind,
  mapStopReason,
  createToolCallContent,
} from "./adapter/AcpEventMapper.js";

// Re-export AcpAgent
export { AcpAgent, type AcpAdapterConfig } from "./adapter/AcpAgent.js";

// Re-export runtime functions
export {
  createAcpAgentRuntime,
  createAcpAgentRuntimeFactory,
  type CreateAcpAgentRuntimeOptions,
} from "./runtime/index.js";
