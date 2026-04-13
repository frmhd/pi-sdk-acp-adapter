/**
 * ACP Agent Runtime Factory
 *
 * Creates Pi AgentSessions configured for ACP protocol usage.
 * Pi's 4 core tools (read, write, edit, bash) are delegated to the ACP client
 * via filesystem and terminal methods instead of local process access.
 */

import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";

import type { AgentSideConnection, EnvVariable, TerminalHandle } from "@agentclientprotocol/sdk";

import type {
  ModelRegistry,
  AgentSession,
  CreateAgentSessionOptions,
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
  type BashOperations,
} from "@mariozechner/pi-coding-agent";

import {
  AcpReadOperations,
  AcpWriteOperations,
  AcpTerminalOperations,
  type AcpClientInterface,
} from "../adapter/AcpToolBridge.js";

import {
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
    cwd?: string;
    env?: EnvVariable[];
    sessionId: string;
  }): Promise<TerminalHandle> {
    if (!this.capabilities.supportsTerminal) {
      throw new Error("ACP client does not support terminal/create.");
    }

    return this.connection.createTerminal({
      command: params.command,
      cwd: params.cwd ?? null,
      env: params.env,
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

// =============================================================================
// Runtime Factory
// =============================================================================

/**
 * Creates a Pi AgentSession configured to use ACP for tool operations.
 */
export async function createAcpAgentRuntime(options: CreateAcpAgentRuntimeOptions): Promise<{
  session: AgentSession;
  dispose: () => void;
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

  const readOps: ReadOperations = new AcpReadOperations(acpClient);
  const baseWriteOps: WriteOperations = new AcpWriteOperations(acpClient);

  const activeMutationToolCalls = new Map<string, string>();
  const editContents = new Map<string, string>();

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
      }

      editContents.delete(path);
      return baseWriteOps.writeFile(path, content);
    },
    access: async (path: string) => readOps.access(path),
  };

  const bashOps: BashOperations = new AcpTerminalOperations(acpClient);

  const readTool = createReadToolDefinition(options.cwd, { operations: readOps });
  const bashTool = createBashToolDefinition(options.cwd, { operations: bashOps });

  const writeToolBase = createWriteToolDefinition(options.cwd, { operations: writeOps });
  const writeTool: typeof writeToolBase = {
    ...writeToolBase,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const absolutePath = resolveToolPath(params.path, options.cwd);

      options.onToolCallStateCaptured?.(toolCallId, {
        toolName: "write",
        path: absolutePath,
      });

      return trackMutationToolCall(activeMutationToolCalls, absolutePath, toolCallId, () =>
        writeToolBase.execute(toolCallId, params, signal, onUpdate, ctx),
      );
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

      return trackMutationToolCall(activeMutationToolCalls, absolutePath, toolCallId, () =>
        editToolBase.execute(toolCallId, params, signal, onUpdate, ctx),
      );
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
  };

  const { session } = await createAgentSession(sessionOptions);

  return {
    session,
    dispose: () => {
      session.dispose();
    },
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
  }> => {
    return createAcpAgentRuntime({
      ...options,
      acpConnection,
      ...(agentDir !== undefined && { agentDir }),
    });
  };
}
