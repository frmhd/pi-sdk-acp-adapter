/**
 * ACP Agent Runtime Factory
 *
 * Creates Pi AgentSessions configured for ACP protocol usage.
 * Tool backends are selected per session from the connected client's advertised
 * capabilities: ACP-backed where available, local Pi tool backends otherwise.
 */

import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";

import type { AgentSideConnection, EnvVariable, TerminalHandle } from "@agentclientprotocol/sdk";

import type {
  ModelRegistry,
  AgentSession,
  CreateAgentSessionOptions,
  SessionManager,
} from "@mariozechner/pi-coding-agent";

import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

import {
  createReadToolDefinition,
  createWriteToolDefinition,
  createEditToolDefinition,
  createBashToolDefinition,
  type ReadOperations,
  type WriteOperations,
  type EditOperations,
} from "@mariozechner/pi-coding-agent";

import {
  AcpTerminalOperations,
  AcpWriteOperations,
  HybridReadOperations,
  createLocalBashFallbackOperations,
  createLocalEditOperations,
  createLocalReadOperations,
  createLocalWriteOperations,
  getAuthorizedRoots,
  type AcpClientInterface,
} from "../adapter/AcpToolBridge.js";

import {
  type AcpBashTerminalRawOutput,
  type AcpClientCapabilitiesSnapshot,
  type AcpToolCallState,
} from "../adapter/types.js";

// =============================================================================
// ACP Client Adapter
// =============================================================================

/**
 * Adapts an ACP connection to the tool bridge interface used by Pi tools.
 */
class AcpConnectionAdapter implements AcpClientInterface {
  private connection: AgentSideConnection;
  public readonly sessionId: string;
  public readonly capabilities: AcpClientCapabilitiesSnapshot;

  constructor(
    connection: AgentSideConnection,
    sessionId: string,
    capabilities: AcpClientCapabilitiesSnapshot,
  ) {
    this.connection = connection;
    this.sessionId = sessionId;
    this.capabilities = capabilities;
  }

  createTerminal(params: {
    command: string;
    args?: string[];
    cwd?: string;
    env?: EnvVariable[];
    outputByteLimit?: number | null;
    sessionId: string;
  }): Promise<TerminalHandle> {
    if (!this.capabilities.supportsTerminal) {
      throw new Error("ACP client does not support terminal/create.");
    }

    return this.connection.createTerminal({
      command: params.command,
      args: params.args,
      cwd: params.cwd ?? null,
      env: params.env,
      outputByteLimit: params.outputByteLimit ?? null,
      sessionId: params.sessionId,
    });
  }

  async readTextFile(params: { path: string; sessionId: string }): Promise<{ content: string }> {
    if (!this.capabilities.supportsReadTextFile) {
      throw new Error("ACP client does not support fs/read_text_file.");
    }

    return this.connection.readTextFile({
      path: params.path,
      sessionId: this.sessionId,
    });
  }

  async writeTextFile(params: { path: string; content: string; sessionId: string }): Promise<void> {
    if (!this.capabilities.supportsWriteTextFile) {
      throw new Error("ACP client does not support fs/write_text_file.");
    }

    await this.connection.writeTextFile({
      path: params.path,
      content: params.content,
      sessionId: this.sessionId,
    });
  }
}

// =============================================================================
// Runtime Options
// =============================================================================

/**
 * Options for creating an ACP Agent Runtime
 */
export interface CreateAcpAgentRuntimeOptions {
  /** Working directory for the session */
  cwd: string;
  /** Agent configuration directory */
  agentDir?: string;
  /** Additional workspace directories */
  additionalDirectories?: string[];
  /** Model registry for API key resolution */
  modelRegistry: ModelRegistry;
  /** ACP connection for tool delegation */
  acpConnection: AgentSideConnection;
  /** Normalized client capabilities captured during initialize() */
  clientCapabilities: AcpClientCapabilitiesSnapshot;
  /** Pi session manager backing this ACP session. */
  sessionManager: SessionManager;
  /** Session ID for terminal requests (required for ACP protocol) */
  sessionId?: string;
  /** Default thinking level */
  thinkingLevel?: ThinkingLevel;
  /** Callback for capturing per-tool-call ACP rendering state. */
  onToolCallStateCaptured?: (toolCallId: string, update: Partial<AcpToolCallState>) => void;
}

type ToolBackend = "acp" | "local" | "hybrid";

interface MutationToolTracking {
  activeMutationToolCalls: Map<string, string>;
  mutationToolProgressUpdates: Map<string, () => void>;
  editContents: Map<string, string>;
  emitMutationToolProgressUpdate: (toolCallId: string | undefined) => void;
}

interface BuildAcpSessionToolsOptions {
  cwd: string;
  additionalDirectories: string[];
  acpClient: AcpClientInterface;
  clientCapabilities: AcpClientCapabilitiesSnapshot;
  onToolCallStateCaptured?: (toolCallId: string, update: Partial<AcpToolCallState>) => void;
}

// =============================================================================
// Path Helpers
// =============================================================================

function expandToolPath(filePath: string): string {
  if (filePath === "~") {
    return homedir();
  }

  if (filePath.startsWith("~/")) {
    return `${homedir()}${filePath.slice(1)}`;
  }

  return filePath.startsWith("@") ? filePath.slice(1) : filePath;
}

function resolveToolPath(filePath: string, cwd: string): string {
  const expanded = expandToolPath(filePath);
  return isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded);
}

function trackMutationToolCall<T>(
  activeMutationToolCalls: Map<string, string>,
  absolutePath: string,
  toolCallId: string,
  execute: () => Promise<T>,
): Promise<T> {
  activeMutationToolCalls.set(absolutePath, toolCallId);

  return execute().finally(() => {
    if (activeMutationToolCalls.get(absolutePath) === toolCallId) {
      activeMutationToolCalls.delete(absolutePath);
    }
  });
}

function createMutationToolTracking(): MutationToolTracking {
  const activeMutationToolCalls = new Map<string, string>();
  const mutationToolProgressUpdates = new Map<string, () => void>();
  const editContents = new Map<string, string>();

  return {
    activeMutationToolCalls,
    mutationToolProgressUpdates,
    editContents,
    emitMutationToolProgressUpdate(toolCallId) {
      if (!toolCallId) {
        return;
      }

      const emit = mutationToolProgressUpdates.get(toolCallId);
      if (!emit) {
        return;
      }

      mutationToolProgressUpdates.delete(toolCallId);
      emit();
    },
  };
}

function buildBashRawOutput(
  input: { command: string; timeout?: number },
  terminal: {
    terminalId: string;
    command: string;
    args: string[];
    cwd: string;
    outputByteLimit: number | null;
  },
  update?: Partial<Pick<AcpBashTerminalRawOutput, "output" | "truncated" | "exitCode" | "signal">>,
): AcpBashTerminalRawOutput {
  return {
    type: "acp_terminal",
    input: {
      command: input.command,
      timeout: input.timeout ?? null,
    },
    execution: {
      command: terminal.command,
      args: terminal.args,
      cwd: terminal.cwd,
      outputByteLimit: terminal.outputByteLimit,
    },
    terminalId: terminal.terminalId,
    fullOutputPath: null,
    ...update,
  };
}

function markToolBackend<T extends object>(
  tool: T,
  backend: ToolBackend,
): T & {
  acpBackend: ToolBackend;
} {
  return Object.assign(tool, { acpBackend: backend });
}

// =============================================================================
// Base Tool Factories
// =============================================================================

function createAcpReadBaseTool(cwd: string, operations: ReadOperations) {
  return markToolBackend(createReadToolDefinition(cwd, { operations }), "hybrid");
}

function createLocalReadBaseTool(cwd: string, operations: ReadOperations) {
  return markToolBackend(createReadToolDefinition(cwd, { operations }), "local");
}

function createAcpWriteBaseTool(cwd: string, operations: WriteOperations) {
  return markToolBackend(createWriteToolDefinition(cwd, { operations }), "acp");
}

function createLocalWriteBaseTool(cwd: string, operations: WriteOperations) {
  return markToolBackend(createWriteToolDefinition(cwd, { operations }), "local");
}

function createAcpEditBaseTool(cwd: string, operations: EditOperations) {
  return markToolBackend(createEditToolDefinition(cwd, { operations }), "acp");
}

function createLocalEditBaseTool(cwd: string, operations: EditOperations) {
  return markToolBackend(createEditToolDefinition(cwd, { operations }), "local");
}

function createAcpBashBaseTool(cwd: string, operations: AcpTerminalOperations) {
  return markToolBackend(createBashToolDefinition(cwd, { operations }), "acp");
}

function createLocalBashBaseTool(cwd: string) {
  return markToolBackend(
    createBashToolDefinition(cwd, { operations: createLocalBashFallbackOperations() }),
    "local",
  );
}

// =============================================================================
// ACP Wrapper Factories
// =============================================================================

function wrapWriteForAcp(options: {
  cwd: string;
  backend: Extract<ToolBackend, "acp" | "local">;
  readOps: ReadOperations;
  baseWriteOps: WriteOperations;
  tracking: MutationToolTracking;
  onToolCallStateCaptured?: (toolCallId: string, update: Partial<AcpToolCallState>) => void;
}) {
  const trackedWriteOps: WriteOperations = {
    writeFile: async (path: string, content: string) => {
      const toolCallId = options.tracking.activeMutationToolCalls.get(path);
      let oldText: string | null = null;

      try {
        const existing = await options.readOps.readFile(path);
        oldText = existing.toString("utf-8");
      } catch {
        oldText = null;
      }

      if (toolCallId) {
        options.onToolCallStateCaptured?.(toolCallId, {
          toolName: "write",
          path,
          diff: { path, oldText, newText: content },
        });
        options.tracking.emitMutationToolProgressUpdate(toolCallId);
      }

      return options.baseWriteOps.writeFile(path, content);
    },
    mkdir: async (dir: string) => options.baseWriteOps.mkdir(dir),
  };

  const baseTool =
    options.backend === "acp"
      ? createAcpWriteBaseTool(options.cwd, trackedWriteOps)
      : createLocalWriteBaseTool(options.cwd, trackedWriteOps);

  return markToolBackend(
    {
      ...baseTool,
      async execute(...args: Parameters<typeof baseTool.execute>) {
        const [toolCallId, params, signal, onUpdate, ctx] = args;
        const absolutePath = resolveToolPath(params.path, options.cwd);

        options.onToolCallStateCaptured?.(toolCallId, {
          toolName: "write",
          path: absolutePath,
        });

        if (onUpdate) {
          onUpdate({ content: [], details: undefined });
          options.tracking.mutationToolProgressUpdates.set(toolCallId, () => {
            onUpdate({ content: [], details: undefined });
          });
        } else {
          options.tracking.mutationToolProgressUpdates.delete(toolCallId);
        }

        return trackMutationToolCall(
          options.tracking.activeMutationToolCalls,
          absolutePath,
          toolCallId,
          async () => {
            try {
              return await baseTool.execute(toolCallId, params, signal, onUpdate, ctx);
            } finally {
              options.tracking.mutationToolProgressUpdates.delete(toolCallId);
            }
          },
        );
      },
    },
    options.backend,
  );
}

function wrapEditForAcp(options: {
  cwd: string;
  backend: Extract<ToolBackend, "acp" | "local">;
  baseEditOps: EditOperations;
  tracking: MutationToolTracking;
  onToolCallStateCaptured?: (toolCallId: string, update: Partial<AcpToolCallState>) => void;
}) {
  const trackedEditOps: EditOperations = {
    readFile: async (path: string) => {
      const buffer = await options.baseEditOps.readFile(path);
      options.tracking.editContents.set(path, buffer.toString("utf-8"));
      return buffer;
    },
    writeFile: async (path: string, content: string) => {
      const oldText = options.tracking.editContents.get(path);
      const toolCallId = options.tracking.activeMutationToolCalls.get(path);

      if (oldText !== undefined && toolCallId) {
        options.onToolCallStateCaptured?.(toolCallId, {
          toolName: "edit",
          path,
          diff: { path, oldText, newText: content },
        });
        options.tracking.emitMutationToolProgressUpdate(toolCallId);
      }

      options.tracking.editContents.delete(path);
      return options.baseEditOps.writeFile(path, content);
    },
    access: async (path: string) => options.baseEditOps.access(path),
  };

  const baseTool =
    options.backend === "acp"
      ? createAcpEditBaseTool(options.cwd, trackedEditOps)
      : createLocalEditBaseTool(options.cwd, trackedEditOps);

  return markToolBackend(
    {
      ...baseTool,
      async execute(...args: Parameters<typeof baseTool.execute>) {
        const [toolCallId, params, signal, onUpdate, ctx] = args;
        const absolutePath = resolveToolPath(params.path, options.cwd);

        options.onToolCallStateCaptured?.(toolCallId, {
          toolName: "edit",
          path: absolutePath,
        });

        if (onUpdate) {
          onUpdate({ content: [], details: undefined });
          options.tracking.mutationToolProgressUpdates.set(toolCallId, () => {
            onUpdate({ content: [], details: undefined });
          });
        } else {
          options.tracking.mutationToolProgressUpdates.delete(toolCallId);
        }

        return trackMutationToolCall(
          options.tracking.activeMutationToolCalls,
          absolutePath,
          toolCallId,
          async () => {
            try {
              return await baseTool.execute(toolCallId, params, signal, onUpdate, ctx);
            } finally {
              options.tracking.mutationToolProgressUpdates.delete(toolCallId);
              options.tracking.editContents.delete(absolutePath);
            }
          },
        );
      },
    },
    options.backend,
  );
}

function wrapBashForAcp(options: {
  cwd: string;
  backend: Extract<ToolBackend, "acp" | "local">;
  acpClient: AcpClientInterface;
  onToolCallStateCaptured?: (toolCallId: string, update: Partial<AcpToolCallState>) => void;
}) {
  const localBashTool = createLocalBashBaseTool(options.cwd);
  const toolTemplate =
    options.backend === "local"
      ? localBashTool
      : createAcpBashBaseTool(options.cwd, new AcpTerminalOperations(options.acpClient));

  return markToolBackend(
    {
      ...toolTemplate,
      async execute(...args: Parameters<typeof toolTemplate.execute>) {
        const [toolCallId, params, signal, onUpdate, ctx] = args;

        options.onToolCallStateCaptured?.(toolCallId, {
          toolName: "bash",
          rawInput: params,
        });

        if (options.backend === "local") {
          return localBashTool.execute(toolCallId, params, signal, onUpdate, ctx);
        }

        let emittedTerminalUpdate = false;
        let terminalSnapshot:
          | {
              terminalId: string;
              command: string;
              args: string[];
              cwd: string;
              outputByteLimit: number | null;
            }
          | undefined;

        const trackedBashOps = new AcpTerminalOperations(options.acpClient, {
          onTerminalCreated: (terminal) => {
            terminalSnapshot = {
              terminalId: terminal.terminalId,
              command: terminal.command,
              args: terminal.args,
              cwd: terminal.cwd,
              outputByteLimit: terminal.outputByteLimit,
            };

            options.onToolCallStateCaptured?.(toolCallId, {
              toolName: "bash",
              terminalId: terminal.terminalId,
              releaseTerminal: terminal.release,
              rawOutput: buildBashRawOutput(params, terminalSnapshot),
            });

            if (!emittedTerminalUpdate) {
              emittedTerminalUpdate = true;
              onUpdate?.({ content: [], details: undefined });
            }
          },
          onTerminalOutput: (output) => {
            if (!terminalSnapshot) {
              return;
            }

            options.onToolCallStateCaptured?.(toolCallId, {
              rawOutput: buildBashRawOutput(params, terminalSnapshot, {
                output: output.output,
                truncated: output.truncated,
              }),
            });
          },
          onTerminalExit: (result) => {
            if (!terminalSnapshot) {
              return;
            }

            options.onToolCallStateCaptured?.(toolCallId, {
              rawOutput: buildBashRawOutput(params, terminalSnapshot, {
                output: result.output,
                truncated: result.truncated,
                exitCode: result.exitCode,
                signal: result.signal,
              }),
            });
          },
        });

        return createAcpBashBaseTool(options.cwd, trackedBashOps).execute(
          toolCallId,
          params,
          signal,
          onUpdate,
          ctx,
        );
      },
    },
    options.backend,
  );
}

// =============================================================================
// Tool Selection
// =============================================================================

function buildAcpSessionTools(options: BuildAcpSessionToolsOptions) {
  const authorizedRoots = getAuthorizedRoots(options.cwd, options.additionalDirectories);
  const acpReadRoots = getAuthorizedRoots(options.cwd);
  const tracking = createMutationToolTracking();

  const localReadOps = createLocalReadOperations({ authorizedRoots });
  const localWriteOps = createLocalWriteOperations({ authorizedRoots });
  const localEditOps = createLocalEditOperations({ authorizedRoots });

  const selectedReadOps: ReadOperations = options.clientCapabilities.supportsReadTextFile
    ? new HybridReadOperations(
        options.acpClient,
        {
          authorizedRoots,
          acpReadRoots,
        },
        localReadOps,
      )
    : localReadOps;

  const selectedWriteOps: WriteOperations = options.clientCapabilities.supportsWriteTextFile
    ? new AcpWriteOperations(options.acpClient, {
        authorizedRoots,
        mkdirStrategy: options.clientCapabilities.supportsTerminal ? "terminal" : "local",
      })
    : localWriteOps;

  const selectedEditOps: EditOperations =
    options.clientCapabilities.supportsReadTextFile &&
    options.clientCapabilities.supportsWriteTextFile
      ? {
          readFile: (absolutePath: string) => selectedReadOps.readFile(absolutePath),
          writeFile: (absolutePath: string, content: string) =>
            selectedWriteOps.writeFile(absolutePath, content),
          access: (absolutePath: string) => selectedReadOps.access(absolutePath),
        }
      : localEditOps;

  const readTool = options.clientCapabilities.supportsReadTextFile
    ? createAcpReadBaseTool(options.cwd, selectedReadOps)
    : createLocalReadBaseTool(options.cwd, selectedReadOps);

  const writeTool = wrapWriteForAcp({
    cwd: options.cwd,
    backend: options.clientCapabilities.supportsWriteTextFile ? "acp" : "local",
    readOps: selectedReadOps,
    baseWriteOps: selectedWriteOps,
    tracking,
    onToolCallStateCaptured: options.onToolCallStateCaptured,
  });

  const editTool = wrapEditForAcp({
    cwd: options.cwd,
    backend:
      options.clientCapabilities.supportsReadTextFile &&
      options.clientCapabilities.supportsWriteTextFile
        ? "acp"
        : "local",
    baseEditOps: selectedEditOps,
    tracking,
    onToolCallStateCaptured: options.onToolCallStateCaptured,
  });

  const bashTool = wrapBashForAcp({
    cwd: options.cwd,
    backend: options.clientCapabilities.supportsTerminal ? "acp" : "local",
    acpClient: options.acpClient,
    onToolCallStateCaptured: options.onToolCallStateCaptured,
  });

  return {
    readTool,
    writeTool,
    editTool,
    bashTool,
  };
}

// =============================================================================
// Runtime Factory
// =============================================================================

/**
 * Creates a Pi AgentSession configured to use ACP for tool operations.
 */
export async function createAcpAgentRuntime(options: CreateAcpAgentRuntimeOptions): Promise<{
  session: AgentSession;
  dispose: () => void;
  getSlashCommands: () => import("@mariozechner/pi-coding-agent").SlashCommandInfo[];
}> {
  const { createAgentSession } = await import("@mariozechner/pi-coding-agent");

  const acpClient = new AcpConnectionAdapter(
    options.acpConnection,
    options.sessionId || "default",
    options.clientCapabilities,
  );

  const { readTool, writeTool, editTool, bashTool } = buildAcpSessionTools({
    cwd: options.cwd,
    additionalDirectories: options.additionalDirectories ?? [],
    acpClient,
    clientCapabilities: options.clientCapabilities,
    onToolCallStateCaptured: options.onToolCallStateCaptured,
  });

  const tools = [readTool, writeTool, editTool, bashTool] as unknown as NonNullable<
    CreateAgentSessionOptions["customTools"]
  >;

  const sessionOptions: CreateAgentSessionOptions = {
    cwd: options.cwd,
    agentDir: options.agentDir,
    modelRegistry: options.modelRegistry,
    thinkingLevel: options.thinkingLevel || "medium",
    tools: [],
    customTools: tools,
    sessionManager: options.sessionManager,
  };

  const { session, extensionsResult } = await createAgentSession(sessionOptions);

  return {
    session,
    dispose: () => {
      session.dispose();
    },
    getSlashCommands: () => extensionsResult?.runtime?.getCommands?.() ?? [],
  };
}

// =============================================================================
// Runtime Factory Creator
// =============================================================================

/**
 * Creates a runtime factory function for use with AcpAgent.
 */
export function createAcpAgentRuntimeFactory(
  acpConnection: AgentSideConnection,
  agentDir?: string,
) {
  return async (
    options: Omit<CreateAcpAgentRuntimeOptions, "acpConnection" | "agentDir">,
  ): Promise<{
    session: AgentSession;
    dispose: () => void;
    getSlashCommands: () => import("@mariozechner/pi-coding-agent").SlashCommandInfo[];
  }> => {
    return createAcpAgentRuntime({
      ...options,
      acpConnection,
      ...(agentDir !== undefined && { agentDir }),
    });
  };
}
