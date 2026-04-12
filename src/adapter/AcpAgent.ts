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

import type { AcpSessionState } from "./types.js";

import { mapAgentEvent, mapStopReason } from "./AcpEventMapper.js";

import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";

import {
  getAvailableModels,
  getCurrentConfigOptions,
  handleSetSessionConfigOption,
  buildSetSessionConfigOptionResponse,
} from "./AcpSessionConfig.js";

import type { CreateAcpAgentRuntimeOptions } from "../runtime/AcpAgentRuntime.js";

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
  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: {
        name: "pi-acp-adapter",
        title: "Pi Coding Agent (ACP Adapter)",
        version: "0.1.0",
      },
      agentCapabilities: {
        // LoadSession is not supported in V1
        loadSession: false,

        // Prompt capabilities - text only for now (Bug 3 fix: images not implemented)
        promptCapabilities: {
          image: false,
          audio: false,
          embeddedContext: false,
        },

        // Session capabilities
        sessionCapabilities: {
          list: null, // No session listing in V1
          fork: null, // No session fork in V1
          close: {}, // Bug 5 fix: implement session close
          additionalDirectories: null, // Additional directories not supported in V1
          resume: null, // No session resume in V1
        },
      },

      // No authentication needed - Pi handles its own auth
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
    const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    // Create session state
    const sessionState: AcpSessionState = {
      sessionId,
      session: null,
      cwd: params.cwd,
      additionalDirectories: params.additionalDirectories || [],
      currentModelId: undefined,
      currentThinkingLevel: this.config.defaultThinkingLevel || "medium",
    };

    // Create Pi AgentSession
    const createSessionRuntimeOptions: CreateAcpAgentRuntimeOptions = {
      cwd: params.cwd,
      agentDir: this.config.agentDir,
      additionalDirectories: params.additionalDirectories || [],
      modelRegistry: this.config.modelRegistry,
      acpConnection: this.connection,
      sessionId, // Pass sessionId for terminal requests
    };

    try {
      const { session } = await this.createRuntime(createSessionRuntimeOptions);

      sessionState.session = session;

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
    const userText = extractTextFromContent(params.prompt);

    if (!userText.trim()) {
      return {
        stopReason: "end_turn",
      };
    }

    // Subscribe to Pi events and forward to ACP connection
    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      // Map Pi event to ACP notification and send
      const notification = mapAgentEvent(params.sessionId, event);

      if (notification) {
        // Bug 7 fix: handle errors from sessionUpdate
        this.connection.sessionUpdate(notification).catch((err) => {
          console.error(`Failed to send session update for ${params.sessionId}:`, err);
        });
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

      // Return error stop reason
      return {
        stopReason: "end_turn",
      };
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
   * Bug 5 fix: Prevents memory leak from accumulating sessions.
   *
   * @param params - Close session request with session ID
   */
  async close(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    const sessionState = this.sessions.get(params.sessionId);

    if (sessionState) {
      // Dispose the Pi session if it exists
      if (sessionState.session) {
        sessionState.session.dispose();
      }

      this.sessions.delete(params.sessionId);
    }

    return {};
  }

  // =============================================================================
  // Session Management Helpers
  // =============================================================================

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
      // Dispose the Pi session if it exists
      if (sessionState.session) {
        sessionState.session.dispose();
      }

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
}
