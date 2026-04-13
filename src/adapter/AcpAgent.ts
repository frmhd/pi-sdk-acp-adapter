/**
 * ACP Agent Implementation
 *
 * Implements the ACP Agent interface, bridging the Pi Coding Agent SDK
 * with ACP-compatible clients like Zed.
 *
 * This class:
 * - Handles ACP protocol initialization (capabilities, authentication)
 * - Manages Pi AgentSession lifecycle (create, prompt, cancel)
 * - Maps Pi events to ACP session notifications
 * - Handles session configuration (model selection, thinking level)
 */

import type { Agent, AgentSideConnection } from "@agentclientprotocol/sdk";

import type {
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  PromptRequest,
  PromptResponse,
  CancelNotification,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  AuthenticateRequest,
  AuthenticateResponse,
  ContentBlock,
  CloseSessionRequest,
  CloseSessionResponse,
} from "@agentclientprotocol/sdk";

import type { ModelRegistry } from "@mariozechner/pi-coding-agent";

import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

import type { AcpClientCapabilitiesSnapshot, AcpSessionState, AcpToolCallState } from "./types.js";

import { mapAgentEvent, mapStopReason } from "./AcpEventMapper.js";

import {
  captureClientCapabilities,
  createMissingClientCapabilitiesMessage,
  getMissingRequiredClientCapabilities,
} from "./types.js";

import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";

import {
  getAvailableModels,
  getCurrentConfigOptions,
  handleSetSessionConfigOption,
  buildSetSessionConfigOptionResponse,
} from "./AcpSessionConfig.js";

import type { CreateAcpAgentRuntimeOptions } from "../runtime/AcpAgentRuntime.js";
import { ACP_AGENT_NAME, ACP_AGENT_TITLE, ADAPTER_VERSION } from "../packageMetadata.js";

// =============================================================================
// ACP Protocol Version
// =============================================================================

/** Current ACP protocol version supported by this adapter */
const PROTOCOL_VERSION = 1;

// =============================================================================
// Content Extraction Helpers
// =============================================================================

/**
 * Extract text content from ACP ContentBlock array.
 * Combines all text blocks into a single string.
 */
function extractTextFromContent(blocks: ContentBlock[]): string {
  const parts: string[] = [];

  for (const block of blocks) {
    if (block.type === "text") {
      parts.push(block.text);
    } else if (block.type === "resource_link") {
      // Include resource link text as baseline support (Bug 9 fix)
      const resourceBlock = block as { uri?: string; text?: string };
      if (resourceBlock.text) {
        parts.push(resourceBlock.text);
      } else if (resourceBlock.uri) {
        parts.push(`[Resource: ${resourceBlock.uri}]`);
      }
    }
  }

  return parts.join("\n\n");
}

/**
 * Resolve @path patterns in text by reading file contents via ACP.
 *
 * Looks for @path (optionally quoted or in backticks) and replaces it with:
 * --- @path ---
 * <content>
 */
async function resolvePathsInText(
  text: string,
  cwd: string,
  connection: AgentSideConnection,
  sessionId: string,
): Promise<string> {
  const pathRegex = /(?:^|\s)@(?:["']([^"']+)["']|`([^`]+)`|([^\s]+))/g;
  let resolvedText = text;
  const matches = Array.from(text.matchAll(pathRegex));

  // Process matches in reverse order to keep indices valid
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i];
    const path = match[1] || match[2] || match[3];

    try {
      // Resolve path relative to cwd if it's not absolute
      const fullPath = path.startsWith("/") ? path : `${cwd}/${path}`;

      const { content } = await connection.readTextFile({
        path: fullPath,
        sessionId,
      });

      const replacement = `\n\n--- @${path} ---\n${content}\n`;
      resolvedText =
        resolvedText.slice(0, match.index) +
        match[0].replace(`@${path}`, replacement) +
        resolvedText.slice(match.index + match[0].length);
    } catch (error) {
      console.warn(`Failed to resolve path @${path}:`, error);
      // Keep @path as-is if resolution fails
    }
  }

  return resolvedText;
}

function getOrCreateToolCallState(
  sessionState: AcpSessionState,
  toolCallId: string,
): AcpToolCallState {
  const existing = sessionState.pendingToolCalls.get(toolCallId);
  if (existing) {
    return existing;
  }

  const created: AcpToolCallState = {};
  sessionState.pendingToolCalls.set(toolCallId, created);
  return created;
}

function extractFirstChangedLine(result: unknown): number | undefined {
  if (typeof result !== "object" || result === null) {
    return undefined;
  }

  const details = (result as { details?: { firstChangedLine?: unknown } }).details;
  return typeof details?.firstChangedLine === "number" ? details.firstChangedLine : undefined;
}

function mergeCapturedRawOutput(
  toolCallState: AcpToolCallState | undefined,
  nextValue: unknown,
  phase: "update" | "end",
): unknown {
  if (!toolCallState?.rawOutput || typeof toolCallState.rawOutput !== "object") {
    return nextValue;
  }

  if (toolCallState.toolName !== "bash") {
    return nextValue;
  }

  return {
    ...(toolCallState.rawOutput as Record<string, unknown>),
    [phase === "update" ? "piPartialResult" : "piResult"]: nextValue,
  };
}

async function releaseToolCallResources(
  toolCallState: AcpToolCallState | undefined,
): Promise<void> {
  const releaseTerminal = toolCallState?.releaseTerminal;
  if (!releaseTerminal) {
    return;
  }

  delete toolCallState.releaseTerminal;

  await releaseTerminal().catch((error) => {
    console.warn("Failed to release ACP terminal:", error);
  });
}

async function releasePendingToolCallResources(sessionState: AcpSessionState): Promise<void> {
  const pendingToolCalls = Array.from(sessionState.pendingToolCalls.values());
  await Promise.all(
    pendingToolCalls.map((toolCallState) => releaseToolCallResources(toolCallState)),
  );
  sessionState.pendingToolCalls.clear();
}

// =============================================================================
// ACP Adapter Configuration
// =============================================================================

/**
 * Configuration options for the ACP Adapter
 */
export interface AcpAdapterConfig {
  /** Model registry for available models */
  modelRegistry: ModelRegistry;
  /** Default working directory */
  defaultCwd?: string;
  /** Agent directory for Pi configuration */
  agentDir?: string;
  /** Default thinking level if none specified */
  defaultThinkingLevel?: ThinkingLevel;
}

// =============================================================================
// ACP Agent Implementation
// =============================================================================

/**
 * ACP Agent - bridges Pi Coding Agent to ACP protocol
 *
 * Implements the ACP Agent interface, handling:
 * - Protocol initialization and capability negotiation
 * - Session creation and lifecycle
 * - User prompt forwarding to Pi
 * - Event mapping from Pi to ACP notifications
 * - Session configuration (model, thinking level)
 * - Session close (experimental ACP capability)
 */
export class AcpAgent implements Agent {
  private connection: AgentSideConnection;
  private sessions: Map<string, AcpSessionState>;
  private config: AcpAdapterConfig;
  private initialized = false;
  private clientCapabilities: AcpClientCapabilitiesSnapshot = captureClientCapabilities();
  private createRuntime: (options: CreateAcpAgentRuntimeOptions) => Promise<{
    session: import("@mariozechner/pi-coding-agent").AgentSession;
    dispose: () => void;
  }>;

  constructor(
    connection: AgentSideConnection,
    config: AcpAdapterConfig,
    createRuntime: (options: CreateAcpAgentRuntimeOptions) => Promise<{
      session: import("@mariozechner/pi-coding-agent").AgentSession;
      dispose: () => void;
    }>,
  ) {
    this.connection = connection;
    this.sessions = new Map();
    this.config = config;
    this.createRuntime = createRuntime;
  }

  // =============================================================================
  // ACP Agent Interface Implementation
  // =============================================================================

  /**
   * Initialize the agent connection.
   *
   * Called first by the ACP client to negotiate protocol version
   * and exchange capabilities.
   *
   * @returns Agent capabilities, protocol version, and authentication methods
   */
  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.initialized = true;
    this.clientCapabilities = captureClientCapabilities(params.clientCapabilities);

    const missingCapabilities = getMissingRequiredClientCapabilities(this.clientCapabilities);
    if (missingCapabilities.length > 0) {
      throw new Error(createMissingClientCapabilitiesMessage(missingCapabilities));
    }

    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: {
        name: ACP_AGENT_NAME,
        title: ACP_AGENT_TITLE,
        version: ADAPTER_VERSION,
      },
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: {
          image: false,
          audio: false,
          embeddedContext: false,
        },
        sessionCapabilities: {
          list: null,
          fork: null,
          close: {},
          additionalDirectories: null,
          resume: null,
        },
      },
      authMethods: [],
    };
  }

  /**
   * Create a new agent session.
   *
   * Sets up the working directory and initializes a Pi AgentSession.
   *
   * @param params - Session creation parameters (cwd, additionalDirectories, mcpServers)
   * @returns Session ID and initial configuration options
   */
  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    this.assertReadyForSessions();

    const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    // Create session state
    const sessionState: AcpSessionState = {
      sessionId,
      session: null,
      dispose: null,
      cwd: params.cwd,
      additionalDirectories: params.additionalDirectories || [],
      currentModelId: undefined,
      currentThinkingLevel: this.config.defaultThinkingLevel || "medium",
      pendingToolCalls: new Map(),
    };

    // Create Pi AgentSession
    const createSessionRuntimeOptions: CreateAcpAgentRuntimeOptions = {
      cwd: params.cwd,
      agentDir: this.config.agentDir,
      additionalDirectories: params.additionalDirectories || [],
      modelRegistry: this.config.modelRegistry,
      acpConnection: this.connection,
      clientCapabilities: this.clientCapabilities,
      sessionId,
      onToolCallStateCaptured: (toolCallId, update) => {
        Object.assign(getOrCreateToolCallState(sessionState, toolCallId), update);
      },
    };

    try {
      const { session, dispose } = await this.createRuntime(createSessionRuntimeOptions);

      sessionState.session = session;
      sessionState.dispose = dispose;

      // Store session
      this.sessions.set(sessionId, sessionState);

      // Get current model and thinking level from the created session
      const currentModelId = session.state.model?.id;
      const currentThinkingLevel = session.thinkingLevel;

      if (currentModelId) {
        sessionState.currentModelId = currentModelId;
      }

      if (currentThinkingLevel) {
        sessionState.currentThinkingLevel = currentThinkingLevel;
      }

      // Bug 2 fix: Use shared config option builders for consistency
      const availableModels = getAvailableModels(this.config.modelRegistry);
      const configOptions = getCurrentConfigOptions(sessionState, availableModels);

      return {
        sessionId,
        configOptions,
      };
    } catch (error) {
      console.error(`Failed to create session ${sessionId}:`, error);
      throw new Error(
        `Failed to create session: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Load an existing agent session.
   *
   * @param params - Load session request with session ID
   * @returns Session ID and current configuration options
   */
  async loadSession(_params: LoadSessionRequest): Promise<LoadSessionResponse> {
    throw new Error(
      "loadSession is not supported yet. Pi ACP sessions are currently process-local only until Phase 3 session persistence is implemented.",
    );
  }

  /**
   * Send a user prompt to the agent.
   *
   * Forwards the prompt to Pi AgentSession and streams events back
   * to the ACP client via session notifications.
   *
   * @param params - Prompt request with content blocks and session ID
   * @returns Stop reason indicating why the agent stopped
   */
  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const sessionState = this.sessions.get(params.sessionId);

    if (!sessionState?.session) {
      throw new Error(`Session ${params.sessionId} not found or not initialized`);
    }

    const session = sessionState.session;

    // Extract text from content blocks (includes resource_link text)
    const rawUserText = extractTextFromContent(params.prompt);

    if (!rawUserText.trim()) {
      return {
        stopReason: "end_turn",
      };
    }

    // Resolve @path patterns (Gemini CLI feature parity)
    const userText = await resolvePathsInText(
      rawUserText,
      sessionState.cwd,
      this.connection,
      params.sessionId,
    );

    // Subscribe to Pi events and forward to ACP connection
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
        toolCallState = getOrCreateToolCallState(sessionState, toolEvent.toolCallId);
        toolCallState.toolName = toolEvent.toolName;
        toolCallState.rawInput = toolEvent.args;
      } else if (eventType === "tool_execution_update") {
        const toolEvent = event as {
          toolCallId: string;
          toolName?: string;
          partialResult: unknown;
        };
        toolCallState = sessionState.pendingToolCalls.get(toolEvent.toolCallId);
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
        toolCallState = sessionState.pendingToolCalls.get(toolEvent.toolCallId);
        if (toolCallState) {
          toolCallState.toolName ??= toolEvent.toolName;
          toolCallState.rawOutput = mergeCapturedRawOutput(toolCallState, toolEvent.result, "end");
          const firstChangedLine = extractFirstChangedLine(toolEvent.result);
          if (firstChangedLine !== undefined) {
            toolCallState.firstChangedLine = firstChangedLine;
          }
        }
      }

      // Map Pi event to ACP notification and send
      const notification = mapAgentEvent(params.sessionId, event, {
        cwd: sessionState.cwd,
        toolCallState,
      });

      const notificationPromise = notification
        ? this.connection.sessionUpdate(notification).catch((err) => {
            console.error(`Failed to send session update for ${params.sessionId}:`, err);
          })
        : Promise.resolve();

      if (completedToolCallId) {
        const finishedToolCallId = completedToolCallId;
        const finishedToolCallState = toolCallState;
        sessionState.pendingToolCalls.delete(finishedToolCallId);

        void (async () => {
          try {
            await notificationPromise;
          } finally {
            await releaseToolCallResources(finishedToolCallState);
          }
        })();
      }
    });

    try {
      // Forward prompt to Pi
      await session.prompt(userText);

      // Bug 1 fix: Map Pi's stopReason to ACP's StopReason
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
      console.error(`Prompt error for session ${params.sessionId}:`, error);

      // Re-throw so the ACP SDK reports the error as a protocol failure.
      // Returning 'end_turn' would make the client think the agent completed normally.
      throw error;
    } finally {
      unsubscribe();
    }
  }

  /**
   * Cancel an in-progress prompt.
   *
   * Aborts the Pi AgentSession's current operation.
   *
   * @param params - Cancel notification with session ID
   */
  async cancel(params: CancelNotification): Promise<void> {
    const sessionState = this.sessions.get(params.sessionId);

    if (!sessionState?.session) {
      // Session not found - nothing to cancel
      return;
    }

    try {
      await sessionState.session.abort();
    } catch (error) {
      console.error(`Cancel error for session ${params.sessionId}:`, error);
      // Don't throw - cancel is best-effort
    }
  }

  /**
   * Set a session configuration option.
   *
   * Handles model selection and thinking level changes.
   *
   * @param params - Config option request with session ID and new value
   * @returns Updated config options reflecting the change
   */
  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const sessionState = this.sessions.get(params.sessionId);

    if (!sessionState) {
      throw new Error(`Session ${params.sessionId} not found`);
    }

    const availableModels = getAvailableModels(this.config.modelRegistry);

    // Handle the config option change (Bug 4 fix: now async, awaits setModel)
    const result = await handleSetSessionConfigOption(params, sessionState, availableModels);

    if (!result.applied) {
      console.warn(`Config option not applied: ${result.error}`);
    }

    // Return current config state
    return buildSetSessionConfigOptionResponse(sessionState, availableModels);
  }

  /**
   * Authenticate the client.
   *
   * Pi uses its own authentication mechanism, so this is a no-op.
   *
   * @param _params - Authentication request (ignored)
   * @returns Success response
   */
  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
    // Pi handles its own authentication via API keys stored in auth.json
    // ACP authentication is not needed
    return {
      // No auth required
    };
  }

  // =============================================================================
  // Experimental ACP Capabilities
  // =============================================================================

  /**
   * Close a session (experimental ACP capability).
   *
   * Cleans up the session and removes it from the session map.
   * Prevents memory leak from accumulating sessions.
   *
   * MUST be named `unstable_closeSession` — that is the method name the
   * ACP SDK calls when the client sends a session/close request.
   *
   * @param params - Close session request with session ID
   */
  async unstable_closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    await this.closeSession(params.sessionId);
    return {};
  }

  // =============================================================================
  // Session Management Helpers
  // =============================================================================

  /**
   * Get the normalized ACP client capabilities captured during initialize().
   */
  getClientCapabilities(): AcpClientCapabilitiesSnapshot {
    return this.clientCapabilities;
  }

  /**
   * Get a session by ID.
   */
  getSession(sessionId: string): AcpSessionState | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Check if a session exists.
   */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Get all active session IDs.
   */
  getSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Close and remove a session.
   */
  async closeSession(sessionId: string): Promise<void> {
    const sessionState = this.sessions.get(sessionId);

    if (sessionState) {
      sessionState.dispose?.();
      await releasePendingToolCallResources(sessionState);
      sessionState.session = null;
      sessionState.dispose = null;
      this.sessions.delete(sessionId);
    }
  }

  /**
   * Close all sessions and clean up resources.
   */
  async shutdown(): Promise<void> {
    for (const sessionId of this.sessions.keys()) {
      await this.closeSession(sessionId);
    }
  }

  private assertReadyForSessions(): void {
    if (!this.initialized) {
      throw new Error("ACP initialize() must complete before creating Pi sessions.");
    }

    const missingCapabilities = getMissingRequiredClientCapabilities(this.clientCapabilities);
    if (missingCapabilities.length > 0) {
      throw new Error(createMissingClientCapabilitiesMessage(missingCapabilities));
    }
  }
}
