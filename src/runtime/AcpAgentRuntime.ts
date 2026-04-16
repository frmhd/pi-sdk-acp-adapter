/**
 * ACP Agent Runtime Factory
 *
 * Creates Pi AgentSessions configured for ACP protocol usage.
 * Read/write/edit are delegated through ACP filesystem methods. Bash prefers
 * ACP terminals when available, but falls back to local process execution when
 * the client does not advertise terminal support.
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
  AcpReadOperations,
  AcpWriteOperations,
  AcpTerminalOperations,
  createLocalBashFallbackOperations,
  getAuthorizedRoots,
  type AcpClientInterface,
} from "../adapter/AcpToolBridge.js";

import {
  type AcpBashTerminalRawOutput,
  type AcpClientCapabilitiesSnapshot,
  type AcpToolCallState,
  createMissingClientCapabilitiesMessage,
  getMissingRequiredClientCapabilities,
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
  const missingCapabilities = getMissingRequiredClientCapabilities(options.clientCapabilities);
  if (missingCapabilities.length > 0) {
    throw new Error(createMissingClientCapabilitiesMessage(missingCapabilities));
  }

  const { createAgentSession } = await import("@mariozechner/pi-coding-agent");

  const acpClient = new AcpConnectionAdapter(
    options.acpConnection,
    options.sessionId || "default",
    options.clientCapabilities,
  );

  const authorizedRoots = getAuthorizedRoots(options.cwd, options.additionalDirectories ?? []);
  const acpReadRoots = getAuthorizedRoots(options.cwd);
  const readOps: ReadOperations = new AcpReadOperations(acpClient, {
    authorizedRoots,
    acpReadRoots,
    enableLocalReadFallback: true,
  });
  const baseWriteOps: WriteOperations = new AcpWriteOperations(acpClient, { authorizedRoots });

  const activeMutationToolCalls = new Map<string, string>();
  const mutationToolProgressUpdates = new Map<string, () => void>();
  const editContents = new Map<string, string>();

  const emitMutationToolProgressUpdate = (toolCallId: string | undefined) => {
    if (!toolCallId) {
      return;
    }

    const emit = mutationToolProgressUpdates.get(toolCallId);
    if (!emit) {
      return;
    }

    // Emit at most one in-progress update per mutation tool call.
    mutationToolProgressUpdates.delete(toolCallId);
    emit();
  };

  const writeOps: WriteOperations = {
    writeFile: async (path: string, content: string) => {
      const toolCallId = activeMutationToolCalls.get(path);
      let oldText: string | null = null;

      try {
        const existing = await readOps.readFile(path);
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
        emitMutationToolProgressUpdate(toolCallId);
      }

      return baseWriteOps.writeFile(path, content);
    },
    mkdir: async (dir: string) => baseWriteOps.mkdir(dir),
  };

  const editOps: EditOperations = {
    readFile: async (path: string) => {
      const buffer = await readOps.readFile(path);
      editContents.set(path, buffer.toString("utf-8"));
      return buffer;
    },
    writeFile: async (path: string, content: string) => {
      const oldText = editContents.get(path);
      const toolCallId = activeMutationToolCalls.get(path);

      if (oldText !== undefined && toolCallId) {
        options.onToolCallStateCaptured?.(toolCallId, {
          toolName: "edit",
          path,
          diff: { path, oldText, newText: content },
        });
        emitMutationToolProgressUpdate(toolCallId);
      }

      editContents.delete(path);
      return baseWriteOps.writeFile(path, content);
    },
    access: async (path: string) => readOps.access(path),
  };

  const readTool = createReadToolDefinition(options.cwd, { operations: readOps });

  const bashToolBase = createBashToolDefinition(options.cwd);
  const localBashToolDefinition = createBashToolDefinition(options.cwd, {
    operations: createLocalBashFallbackOperations(),
  });
  const bashTool: typeof bashToolBase = {
    ...bashToolBase,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      options.onToolCallStateCaptured?.(toolCallId, {
        toolName: "bash",
        rawInput: params,
      });

      if (!options.clientCapabilities.supportsTerminal) {
        return localBashToolDefinition.execute(toolCallId, params, signal, onUpdate, ctx);
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

      const trackedBashOps = new AcpTerminalOperations(acpClient, {
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

      return createBashToolDefinition(options.cwd, { operations: trackedBashOps }).execute(
        toolCallId,
        params,
        signal,
        onUpdate,
        ctx,
      );
    },
  };

  const writeToolBase = createWriteToolDefinition(options.cwd, { operations: writeOps });
  const writeTool: typeof writeToolBase = {
    ...writeToolBase,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const absolutePath = resolveToolPath(params.path, options.cwd);

      options.onToolCallStateCaptured?.(toolCallId, {
        toolName: "write",
        path: absolutePath,
      });

      if (onUpdate) {
        // Emit an immediate progress update so ACP clients can flip the tool
        // card out of "pending" even before the write diff is available.
        onUpdate({ content: [], details: undefined });
        mutationToolProgressUpdates.set(toolCallId, () => {
          onUpdate({ content: [], details: undefined });
        });
      } else {
        mutationToolProgressUpdates.delete(toolCallId);
      }

      return trackMutationToolCall(activeMutationToolCalls, absolutePath, toolCallId, async () => {
        try {
          return await writeToolBase.execute(toolCallId, params, signal, onUpdate, ctx);
        } finally {
          mutationToolProgressUpdates.delete(toolCallId);
        }
      });
    },
  };

  const editToolBase = createEditToolDefinition(options.cwd, { operations: editOps });
  const editTool: typeof editToolBase = {
    ...editToolBase,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const absolutePath = resolveToolPath(params.path, options.cwd);

      options.onToolCallStateCaptured?.(toolCallId, {
        toolName: "edit",
        path: absolutePath,
      });

      if (onUpdate) {
        // Emit an immediate progress update so ACP clients can flip the tool
        // card out of "pending" even before the edit diff is available.
        onUpdate({ content: [], details: undefined });
        mutationToolProgressUpdates.set(toolCallId, () => {
          onUpdate({ content: [], details: undefined });
        });
      } else {
        mutationToolProgressUpdates.delete(toolCallId);
      }

      return trackMutationToolCall(activeMutationToolCalls, absolutePath, toolCallId, async () => {
        try {
          return await editToolBase.execute(toolCallId, params, signal, onUpdate, ctx);
        } finally {
          mutationToolProgressUpdates.delete(toolCallId);
        }
      });
    },
  };

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
    getSlashCommands: () => extensionsResult.runtime.getCommands(),
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
