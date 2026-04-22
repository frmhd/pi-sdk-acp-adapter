import type {
  Agent,
  AgentSideConnection,
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
  CloseSessionRequest,
  CloseSessionResponse,
  InitializeRequest,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { SessionManager, type ModelRegistry } from "@mariozechner/pi-coding-agent";

import type { AcpClientCapabilitiesSnapshot, AcpSessionState } from "./types.js";
import { captureClientCapabilities } from "./types.js";
import {
  buildSetSessionConfigOptionResponse,
  getAvailableModels,
  getModelOptionValue,
  handleSetSessionConfigOption,
} from "./AcpSessionConfig.js";
import {
  buildAcpSessionInfo,
  getAcpSessionDirectory,
  listPersistedPiSessions,
  replaySessionHistory,
} from "./AcpSessionLifecycle.js";
import { executePrompt } from "./agent/promptExecution.js";
import {
  getSessionConfigOptions,
  refreshAvailableCommands as refreshAvailableCommandsForSession,
  refreshConfigOptions as refreshConfigOptionsForSession,
  refreshSessionMetadata as refreshSessionMetadataForSession,
  refreshSessionUsage as refreshSessionUsageForSession,
  scheduleInitialSessionUpdates as scheduleInitialUpdates,
} from "./agent/sessionRefresh.js";
import {
  getOrCreateToolCallState,
  releasePendingToolCallResources,
} from "./agent/toolCallState.js";
import type { CreateAcpAgentRuntimeOptions } from "../runtime/AcpAgentRuntime.js";
import {
  buildTerminalAuthMethods,
  getProviderIdFromTerminalAuthMethodId,
} from "../auth/terminalAuth.js";
import { ACP_AGENT_NAME, ACP_AGENT_TITLE, ADAPTER_VERSION } from "../packageMetadata.js";

const PROTOCOL_VERSION = 1;

export interface AcpAdapterConfig {
  modelRegistry: ModelRegistry;
  defaultCwd?: string;
  agentDir?: string;
  defaultThinkingLevel?: ThinkingLevel;
}

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
      authMethods: buildTerminalAuthMethods(this.config.modelRegistry.authStorage),
    };
  }

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

    this.scheduleInitialSessionUpdates(sessionState);

    return {
      sessionId: sessionState.sessionId,
      configOptions: this.getConfigOptions(sessionState),
    };
  }

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

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const sessionState = this.sessions.get(params.sessionId);

    if (!sessionState) {
      throw new Error(`Session ${params.sessionId} not found or not initialized`);
    }

    return executePrompt({
      connection: this.connection,
      request: params,
      sessionState,
      clientCapabilities: this.clientCapabilities,
      refreshSessionUsage: (state, force) => this.refreshSessionUsage(state, force),
      refreshConfigOptions: (state, force) => this.refreshConfigOptions(state, force),
      refreshSessionMetadata: (state, force) => this.refreshSessionMetadata(state, force),
      refreshAvailableCommands: (state, force) => this.refreshAvailableCommands(state, force),
    });
  }

  async cancel(params: CancelNotification): Promise<void> {
    const sessionState = this.sessions.get(params.sessionId);

    if (!sessionState?.session) {
      return;
    }

    try {
      await sessionState.session.abort();
    } catch (error) {
      console.error(`Cancel error for session ${params.sessionId}:`, error);
    }
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const sessionState = this.sessions.get(params.sessionId);

    if (!sessionState) {
      throw new Error(`Session ${params.sessionId} not found`);
    }

    const availableModels = getAvailableModels(this.config.modelRegistry);
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

  async unstable_closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    await this.closeSession(params.sessionId);
    return {};
  }

  getClientCapabilities(): AcpClientCapabilitiesSnapshot {
    return this.clientCapabilities;
  }

  getSession(sessionId: string): AcpSessionState | undefined {
    return this.sessions.get(sessionId);
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  getSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  private getConfigOptions(sessionState: AcpSessionState) {
    return getSessionConfigOptions(
      sessionState,
      this.config.modelRegistry,
      this.clientCapabilities.clientInfo,
    );
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
    return refreshSessionMetadataForSession(this.connection, sessionState, force);
  }

  private async refreshSessionUsage(sessionState: AcpSessionState, force = false): Promise<void> {
    return refreshSessionUsageForSession(this.connection, sessionState, force);
  }

  private async refreshConfigOptions(sessionState: AcpSessionState, force = false): Promise<void> {
    return refreshConfigOptionsForSession(
      this.connection,
      sessionState,
      this.config.modelRegistry,
      this.clientCapabilities.clientInfo,
      force,
    );
  }

  private scheduleInitialSessionUpdates(sessionState: AcpSessionState): void {
    scheduleInitialUpdates({
      sessionState,
      refreshSessionMetadata: (state, force) => this.refreshSessionMetadata(state, force),
      refreshSessionUsage: (state, force) => this.refreshSessionUsage(state, force),
      refreshAvailableCommands: (state, force) => this.refreshAvailableCommands(state, force),
    });
  }

  private async refreshAvailableCommands(
    sessionState: AcpSessionState,
    force = false,
  ): Promise<void> {
    return refreshAvailableCommandsForSession(this.connection, sessionState, force);
  }

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
