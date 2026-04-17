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
  ListSessionsRequest,
  ListSessionsResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
} from "@agentclientprotocol/sdk";

import type { ImageContent as PiImageContent } from "@mariozechner/pi-ai";

import { SessionManager, type ModelRegistry } from "@mariozechner/pi-coding-agent";

import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

import type {
  AcpBashTerminalRawOutput,
  AcpClientCapabilitiesSnapshot,
  AcpSessionState,
  AcpSessionUsageSnapshot,
  AcpToolCallState,
} from "./types.js";

import { mapAgentEvent, mapStopReason } from "./AcpEventMapper.js";

import {
  areAvailableCommandsEqual,
  buildAcpAvailableCommands,
  buildAcpSessionInfo,
  emitAvailableCommandsUpdate,
  emitConfigOptionsUpdate,
  emitSessionInfoUpdate,
  emitUsageUpdate,
  getAcpSessionDirectory,
  getCurrentSessionMetadata,
  listPersistedPiSessions,
  replaySessionHistory,
} from "./AcpSessionLifecycle.js";

import { captureClientCapabilities } from "./types.js";

import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";

import {
  areSessionConfigOptionsEqual,
  getAvailableModels,
  getCurrentConfigOptions,
  getModelOptionValue,
  handleSetSessionConfigOption,
  buildSetSessionConfigOptionResponse,
} from "./AcpSessionConfig.js";
import { resolvePromptPathsInText } from "./resolvePromptPaths.js";

import type { CreateAcpAgentRuntimeOptions } from "../runtime/AcpAgentRuntime.js";
import { ACP_AGENT_NAME, ACP_AGENT_TITLE, ADAPTER_VERSION } from "../packageMetadata.js";
import {
  buildTerminalAuthMethods,
  getProviderIdFromTerminalAuthMethodId,
} from "../auth/terminalAuth.js";

// =============================================================================
// ACP Protocol Version
// =============================================================================

/** Current ACP protocol version supported by this adapter */
const PROTOCOL_VERSION = 1;

// =============================================================================
// Content Extraction Helpers
// =============================================================================

/** Result of extracting content from ACP ContentBlock array. */
interface ExtractedContent {
  /** Combined text from all text blocks. */
  text: string;
  /** Image content blocks for Pi SDK. */
  images: PiImageContent[];
}

/**
 * Extract text and images from ACP ContentBlock array.
 * Combines all text blocks into a single string and collects image blocks.
 */
function extractContentFromBlocks(blocks: ContentBlock[]): ExtractedContent {
  const textParts: string[] = [];
  const images: PiImageContent[] = [];

  for (const block of blocks) {
    if (block.type === "text") {
      textParts.push(block.text);
    } else if (block.type === "image") {
      images.push({
        type: "image",
        data: block.data,
        mimeType: block.mimeType,
      });
    } else if (block.type === "resource_link") {
      // Include resource link text as baseline support (Bug 9 fix)
      const resourceBlock = block as { uri?: string; text?: string };
      if (resourceBlock.text) {
        textParts.push(resourceBlock.text);
      } else if (resourceBlock.uri) {
        textParts.push(`[Resource: ${resourceBlock.uri}]`);
      }
    }
    // Note: audio and embeddedResource blocks are currently ignored
  }

  return {
    text: textParts.join("\n\n"),
    images,
  };
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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeTokenCount(value: number): number {
  return Math.max(0, Math.round(value));
}

function buildSessionUsageSnapshot(
  session: NonNullable<AcpSessionState["session"]>,
): AcpSessionUsageSnapshot | undefined {
  const contextUsage = session.getContextUsage?.();
  const stats = session.getSessionStats?.();

  const size =
    contextUsage?.contextWindow ??
    stats?.contextUsage?.contextWindow ??
    session.state.model?.contextWindow;

  // Note: Pi's getContextUsage() can return { tokens: null, ... } when tokens
  // are unknown (for example right after compaction). Prefer that value when it
  // is numeric, otherwise fall back to stats.contextUsage.tokens.
  const rawUsed = contextUsage?.tokens != null ? contextUsage.tokens : stats?.contextUsage?.tokens;

  if (!isFiniteNumber(size) || size <= 0 || rawUsed === null || rawUsed === undefined) {
    return undefined;
  }

  const used = rawUsed;

  return {
    size: normalizeTokenCount(size),
    used: normalizeTokenCount(used),
  };
}

function extractFirstChangedLine(result: unknown): number | undefined {
  if (typeof result !== "object" || result === null) {
    return undefined;
  }

  const details = (result as { details?: { firstChangedLine?: unknown } }).details;
  return typeof details?.firstChangedLine === "number" ? details.firstChangedLine : undefined;
}

function isAcpTerminalRawOutput(value: unknown): value is AcpBashTerminalRawOutput {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "acp_terminal"
  );
}

function mergeCapturedRawOutput(
  toolCallState: AcpToolCallState | undefined,
  nextValue: unknown,
  phase: "update" | "end",
): unknown {
  if (toolCallState?.toolName !== "bash" || !isAcpTerminalRawOutput(toolCallState?.rawOutput)) {
    return nextValue;
  }

  const rawOutputRecord = toolCallState.rawOutput;

  // For ACP-terminal-backed bash commands, when the command ends, populate
  // piPartialResult.content with the actual terminal output from rawOutput.output.
  if (phase === "end") {
    const terminalOutput = typeof rawOutputRecord.output === "string" ? rawOutputRecord.output : "";
    const piPartialResult = {
      content: [{ type: "text", text: terminalOutput }],
      details: {},
    };

    return {
      ...rawOutputRecord,
      piPartialResult,
      piResult: nextValue,
    };
  }

  return {
    ...rawOutputRecord,
    piPartialResult: nextValue,
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
    getSlashCommands?: () => import("@mariozechner/pi-coding-agent").SlashCommandInfo[];
  }>;

  constructor(
    connection: AgentSideConnection,
    config: AcpAdapterConfig,
    createRuntime: (options: CreateAcpAgentRuntimeOptions) => Promise<{
      session: import("@mariozechner/pi-coding-agent").AgentSession;
      dispose: () => void;
      getSlashCommands?: () => import("@mariozechner/pi-coding-agent").SlashCommandInfo[];
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
    this.clientCapabilities = captureClientCapabilities(
      params.clientCapabilities,
      params.clientInfo,
    );

    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: {
        name: ACP_AGENT_NAME,
        title: ACP_AGENT_TITLE,
        version: ADAPTER_VERSION,
      },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: false,
        },
        sessionCapabilities: {
          list: {},
          fork: null,
          close: {},
          additionalDirectories: null,
          resume: {},
        },
      },
      authMethods: buildTerminalAuthMethods(this.config.modelRegistry.authStorage, {
        enabled: this.clientCapabilities.supportsTerminalAuth,
      }),
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

    const sessionManager = SessionManager.create(
      params.cwd,
      getAcpSessionDirectory(params.cwd, this.config.agentDir),
    );

    const sessionState = await this.createSessionState({
      cwd: params.cwd,
      additionalDirectories: params.additionalDirectories || [],
      sessionManager,
    });

    // Important: delay initial session/update notifications until after the
    // session/new response is sent. ACP clients like Zed do not know the new
    // session id until the response arrives, so notifications sent before then
    // can be dropped as "unknown session" updates.
    this.scheduleInitialSessionUpdates(sessionState);

    return {
      sessionId: sessionState.sessionId,
      configOptions: this.getConfigOptions(sessionState),
    };
  }

  /**
   * Load an existing agent session.
   *
   * @param params - Load session request with session ID
   * @returns Session ID and current configuration options
   */
  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    this.assertReadyForSessions();

    const sessionInfo = await this.findPersistedSessionInfo(params.sessionId, params.cwd);
    const sessionState = await this.createSessionState({
      cwd: params.cwd,
      additionalDirectories: params.additionalDirectories || [],
      sessionManager: SessionManager.open(
        sessionInfo.path,
        getAcpSessionDirectory(params.cwd, this.config.agentDir),
        params.cwd,
      ),
    });

    await this.refreshSessionMetadata(sessionState, true);
    await this.refreshSessionUsage(sessionState, true);
    await this.refreshAvailableCommands(sessionState, true);
    await replaySessionHistory(
      this.connection,
      sessionState.sessionId,
      sessionState.session!,
      sessionState.cwd,
    );

    return {
      configOptions: this.getConfigOptions(sessionState),
    };
  }

  /**
   * List persisted Pi-backed sessions.
   */
  async unstable_listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    if (!this.initialized) {
      throw new Error("ACP initialize() must complete before listing sessions.");
    }

    if (params.cursor) {
      return {
        sessions: [],
        nextCursor: null,
      };
    }

    const sessions = await listPersistedPiSessions({
      cwd: params.cwd,
      agentDir: this.config.agentDir,
    });

    return {
      sessions: sessions.map((session) => buildAcpSessionInfo(session)),
      nextCursor: null,
    };
  }

  /**
   * Resume an existing session without replaying its history.
   */
  async unstable_resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    this.assertReadyForSessions();

    const sessionInfo = await this.findPersistedSessionInfo(params.sessionId, params.cwd);
    const sessionState = await this.createSessionState({
      cwd: params.cwd,
      additionalDirectories: params.additionalDirectories || [],
      sessionManager: SessionManager.open(
        sessionInfo.path,
        getAcpSessionDirectory(params.cwd, this.config.agentDir),
        params.cwd,
      ),
    });

    await this.refreshSessionMetadata(sessionState, true);
    await this.refreshSessionUsage(sessionState, true);
    await this.refreshAvailableCommands(sessionState, true);

    return {
      configOptions: this.getConfigOptions(sessionState),
    };
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

    // Extract text and images from content blocks
    const { text: rawUserText, images } = extractContentFromBlocks(params.prompt);

    if (!rawUserText.trim() && images.length === 0) {
      return {
        stopReason: "end_turn",
      };
    }

    // Resolve @path patterns (Gemini CLI feature parity)
    const userText = await resolvePromptPathsInText({
      text: rawUserText,
      cwd: sessionState.cwd,
      additionalDirectories: sessionState.additionalDirectories,
      connection: this.connection,
      sessionId: params.sessionId,
      clientCapabilities: this.clientCapabilities,
    });

    // Subscribe to Pi events and forward to ACP connection.
    // AgentSession listeners are synchronous, so we serialize ACP notifications
    // ourselves to preserve start -> in_progress -> completed ordering.
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

      // Map Pi event to ACP notification and send.
      const notification = mapAgentEvent(params.sessionId, event, {
        cwd: sessionState.cwd,
        toolCallState,
      });

      const finishedToolCallId = completedToolCallId;
      const finishedToolCallState = toolCallState;
      const shouldRefreshUsageAfterEvent = eventType === "tool_execution_end";
      if (finishedToolCallId) {
        sessionState.pendingToolCalls.delete(finishedToolCallId);
      }

      enqueueSessionUpdate(async () => {
        try {
          if (notification) {
            await this.connection.sessionUpdate(notification);
          }

          if (shouldRefreshUsageAfterEvent) {
            await this.refreshSessionUsage(sessionState).catch((error) => {
              console.warn(`Failed to refresh session usage for ${params.sessionId}:`, error);
            });
            await this.refreshConfigOptions(sessionState).catch((error) => {
              console.warn(
                `Failed to refresh session config options for ${params.sessionId}:`,
                error,
              );
            });
          }
        } catch (err) {
          console.error(`Failed to send session update for ${params.sessionId}:`, err);
        } finally {
          if (finishedToolCallState && finishedToolCallId) {
            await releaseToolCallResources(finishedToolCallState);
          }
        }
      });
    });

    try {
      // Forward prompt to Pi with images if present
      await session.prompt(userText, images.length > 0 ? { images } : undefined);

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
      await sessionUpdateQueue;
      await this.refreshSessionUsage(sessionState).catch((error) => {
        console.warn(`Failed to refresh session usage for ${params.sessionId}:`, error);
      });
      await this.refreshConfigOptions(sessionState).catch((error) => {
        console.warn(`Failed to refresh session config options for ${params.sessionId}:`, error);
      });
      await this.refreshSessionMetadata(sessionState).catch((error) => {
        console.warn(`Failed to refresh session metadata for ${params.sessionId}:`, error);
      });
      await this.refreshAvailableCommands(sessionState).catch((error) => {
        console.warn(`Failed to refresh slash commands for ${params.sessionId}:`, error);
      });
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

    const response = buildSetSessionConfigOptionResponse(
      sessionState,
      availableModels,
      this.clientCapabilities.clientInfo,
    );
    sessionState.lastConfigOptions = response.configOptions;
    await this.refreshSessionUsage(sessionState).catch((error) => {
      console.warn(`Failed to refresh session usage for ${params.sessionId}:`, error);
    });
    await this.refreshSessionMetadata(sessionState).catch((error) => {
      console.warn(`Failed to refresh session metadata for ${params.sessionId}:`, error);
    });

    return response;
  }

  /**
   * Acknowledge completion of a client-run authentication flow.
   *
   * For ACP terminal auth, the client launches this same binary in a separate
   * interactive terminal. That child process updates Pi's auth.json. The ACP
   * client then calls authenticate(methodId) on the long-lived ACP connection so
   * we can reload credentials and refresh session model lists.
   */
  async authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse> {
    const providerId = getProviderIdFromTerminalAuthMethodId(params.methodId);
    if (!providerId) {
      throw new Error(`Unknown ACP auth method: ${params.methodId}`);
    }

    this.config.modelRegistry.authStorage.reload();
    this.config.modelRegistry.refresh();

    if (!this.config.modelRegistry.authStorage.hasAuth(providerId)) {
      throw new Error(
        `Authentication for provider ${JSON.stringify(providerId)} is not configured. Complete the terminal auth flow and try again.`,
      );
    }

    await Promise.all(
      Array.from(this.sessions.values()).map((sessionState) =>
        this.refreshConfigOptions(sessionState, true).catch((error) => {
          console.warn(
            `Failed to refresh session config options after authenticating ${providerId}:`,
            error,
          );
        }),
      ),
    );

    return {};
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

  private getConfigOptions(sessionState: AcpSessionState) {
    const configOptions = getCurrentConfigOptions(
      sessionState,
      getAvailableModels(this.config.modelRegistry),
      this.clientCapabilities.clientInfo,
    );
    sessionState.lastConfigOptions = configOptions;
    return configOptions;
  }

  private async createSessionState(options: {
    cwd: string;
    additionalDirectories: string[];
    sessionManager: SessionManager;
  }): Promise<AcpSessionState> {
    const sessionId = options.sessionManager.getSessionId();
    await this.closeSession(sessionId);

    const sessionState: AcpSessionState = {
      sessionId,
      session: null,
      dispose: null,
      cwd: options.cwd,
      additionalDirectories: options.additionalDirectories,
      currentModelId: undefined,
      currentThinkingLevel: this.config.defaultThinkingLevel || "medium",
      title: undefined,
      updatedAt: undefined,
      lastUsageUpdate: undefined,
      lastConfigOptions: undefined,
      pendingToolCalls: new Map(),
      getSlashCommands: undefined,
      availableCommands: undefined,
    };

    const createSessionRuntimeOptions: CreateAcpAgentRuntimeOptions = {
      cwd: options.cwd,
      agentDir: this.config.agentDir,
      additionalDirectories: options.additionalDirectories,
      modelRegistry: this.config.modelRegistry,
      acpConnection: this.connection,
      clientCapabilities: this.clientCapabilities,
      sessionManager: options.sessionManager,
      sessionId,
      onToolCallStateCaptured: (toolCallId, update) => {
        Object.assign(getOrCreateToolCallState(sessionState, toolCallId), update);
      },
    };

    try {
      const { session, dispose, getSlashCommands } = await this.createRuntime(
        createSessionRuntimeOptions,
      );

      if (session.sessionId && session.sessionId !== sessionId) {
        throw new Error(
          `Pi session id mismatch: expected ${sessionId}, received ${session.sessionId}`,
        );
      }

      sessionState.session = session;
      sessionState.dispose = dispose;
      sessionState.getSlashCommands = getSlashCommands;
      sessionState.currentModelId = session.state.model
        ? getModelOptionValue(session.state.model)
        : undefined;
      sessionState.currentThinkingLevel = session.thinkingLevel;
      this.sessions.set(sessionId, sessionState);
      return sessionState;
    } catch (error) {
      await releasePendingToolCallResources(sessionState);
      throw new Error(
        `Failed to initialize session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async findPersistedSessionInfo(sessionId: string, cwd: string) {
    const sessions = await listPersistedPiSessions({
      cwd,
      agentDir: this.config.agentDir,
    });

    const sessionInfo = sessions.find((session) => session.id === sessionId);
    if (!sessionInfo) {
      throw new Error(`Session ${sessionId} not found for cwd ${cwd}`);
    }

    return sessionInfo;
  }

  private async refreshSessionMetadata(
    sessionState: AcpSessionState,
    force = false,
  ): Promise<void> {
    if (!sessionState.session) {
      return;
    }

    const metadata = getCurrentSessionMetadata(sessionState.session);
    const changed =
      force ||
      sessionState.title !== metadata.title ||
      sessionState.updatedAt !== metadata.updatedAt;

    if (!changed) {
      return;
    }

    sessionState.title = metadata.title;
    sessionState.updatedAt = metadata.updatedAt;
    await emitSessionInfoUpdate(this.connection, sessionState.sessionId, metadata);
  }

  private async refreshSessionUsage(sessionState: AcpSessionState, force = false): Promise<void> {
    if (!sessionState.session) {
      return;
    }

    const usage = buildSessionUsageSnapshot(sessionState.session);
    if (!usage) {
      return;
    }

    const changed =
      force ||
      sessionState.lastUsageUpdate?.size !== usage.size ||
      sessionState.lastUsageUpdate?.used !== usage.used;

    if (!changed) {
      return;
    }

    sessionState.lastUsageUpdate = usage;
    await emitUsageUpdate(this.connection, sessionState.sessionId, usage);
  }

  private async refreshConfigOptions(sessionState: AcpSessionState, force = false): Promise<void> {
    const configOptions = getCurrentConfigOptions(
      sessionState,
      getAvailableModels(this.config.modelRegistry),
      this.clientCapabilities.clientInfo,
    );

    if (!force && areSessionConfigOptionsEqual(sessionState.lastConfigOptions, configOptions)) {
      return;
    }

    sessionState.lastConfigOptions = configOptions;
    await emitConfigOptionsUpdate(this.connection, sessionState.sessionId, configOptions);
  }

  private scheduleInitialSessionUpdates(sessionState: AcpSessionState): void {
    setTimeout(() => {
      void this.refreshSessionMetadata(sessionState, true).catch((error) => {
        console.warn(
          `Failed to send initial session metadata for ${sessionState.sessionId}:`,
          error,
        );
      });
      void this.refreshSessionUsage(sessionState, true).catch((error) => {
        console.warn(`Failed to send initial session usage for ${sessionState.sessionId}:`, error);
      });
      void this.refreshAvailableCommands(sessionState, true).catch((error) => {
        console.warn(`Failed to send initial slash commands for ${sessionState.sessionId}:`, error);
      });
    }, 0);
  }

  private async refreshAvailableCommands(
    sessionState: AcpSessionState,
    force = false,
  ): Promise<void> {
    const getSlashCommands = sessionState.getSlashCommands;
    if (!getSlashCommands) {
      return;
    }

    const availableCommands = buildAcpAvailableCommands(getSlashCommands());
    if (!force && areAvailableCommandsEqual(sessionState.availableCommands, availableCommands)) {
      return;
    }

    sessionState.availableCommands = availableCommands;
    await emitAvailableCommandsUpdate(this.connection, sessionState.sessionId, availableCommands);
  }

  /**
   * Close and remove a session.
   */
  async closeSession(sessionId: string): Promise<void> {
    const sessionState = this.sessions.get(sessionId);

    if (sessionState) {
      try {
        await sessionState.session?.abort();
      } catch (error) {
        console.warn(`Failed to abort session ${sessionId} during close:`, error);
      }

      sessionState.dispose?.();
      await releasePendingToolCallResources(sessionState);
      sessionState.session = null;
      sessionState.dispose = null;
      sessionState.getSlashCommands = undefined;
      sessionState.availableCommands = undefined;
      this.sessions.delete(sessionId);
    }
  }

  /**
   * Close all sessions and clean up resources.
   */
  async shutdown(): Promise<void> {
    for (const sessionId of Array.from(this.sessions.keys())) {
      await this.closeSession(sessionId);
    }
  }

  private assertReadyForSessions(): void {
    if (!this.initialized) {
      throw new Error("ACP initialize() must complete before creating Pi sessions.");
    }
  }
}
