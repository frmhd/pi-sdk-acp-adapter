/**
 * ACP Agent Runtime Factory
 *
 * Creates Pi AgentSessions configured for ACP protocol usage.
 * Pi's 4 core tools (read, write, edit, bash) are delegated to the ACP client
 * via filesystem and terminal methods instead of local process access.
 */

import type { AgentSideConnection, EnvVariable, TerminalHandle } from "@agentclientprotocol/sdk";

import type {
  ModelRegistry,
  AgentSession,
  CreateAgentSessionOptions,
} from "@mariozechner/pi-coding-agent";

import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

import {
  createReadTool,
  createWriteTool,
  createEditTool,
  createBashTool,
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
  /** Callback for capturing edits for diff support */
  onEditCaptured?: (path: string, oldText: string, newText: string) => void;
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
  const writeOps: WriteOperations = new AcpWriteOperations(acpClient);

  const editContents = new Map<string, string>();

  const editOps: EditOperations = {
    readFile: async (path: string) => {
      const buffer = await readOps.readFile(path);
      editContents.set(path, buffer.toString("utf-8"));
      return buffer;
    },
    writeFile: async (path: string, content: string) => {
      const oldText = editContents.get(path);
      if (oldText !== undefined && options.onEditCaptured) {
        options.onEditCaptured(path, oldText, content);
      }
      editContents.delete(path);
      return writeOps.writeFile(path, content);
    },
    access: async (path: string) => readOps.access(path),
  };

  const bashOps: BashOperations = new AcpTerminalOperations(acpClient);

  const tools = [
    createReadTool(options.cwd, { operations: readOps }),
    createWriteTool(options.cwd, { operations: writeOps }),
    createEditTool(options.cwd, { operations: editOps }),
    createBashTool(options.cwd, { operations: bashOps }),
  ];

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
