/**
 * ACP Agent Runtime Factory
 *
 * Creates Pi AgentSessions configured for ACP protocol usage.
 * Tools (read, write, edit, bash, grep, find, ls) are delegated to the ACP client
 * via terminal/fs operations instead of local filesystem/child_process.
 */

import type { AgentSideConnection } from "@agentclientprotocol/sdk";

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
  createGrepTool,
  createFindTool,
  createLsTool,
  type ReadOperations,
  type WriteOperations,
  type EditOperations,
  type BashOperations,
  type GrepOperations,
  type FindOperations,
  type LsOperations,
} from "@mariozechner/pi-coding-agent";

import {
  AcpReadOperations,
  AcpWriteOperations,
  AcpGrepOperations,
  AcpFindOperations,
  AcpLsOperations,
  AcpTerminalOperations,
  type AcpClientInterface,
} from "../adapter/AcpToolBridge.js";

// =============================================================================
// ACP Client Adapter
// =============================================================================

/**
 * Adapts ACP connection to AcpClientInterface for tool operations.
 *
 * The ACP protocol requires specific params for terminal creation:
 * - `sessionId` is mandatory
 * - `env` must be `EnvVariable[]` format: `{name: string, value: string}[]`
 * - No `terminalId` or `size` fields in the request
 */
class AcpConnectionAdapter implements AcpClientInterface {
  private connection: AgentSideConnection;
  public readonly sessionId: string;

  constructor(connection: AgentSideConnection, sessionId: string) {
    this.connection = connection;
    this.sessionId = sessionId;
  }

  createTerminal(params: {
    command: string;
    cwd?: string;
    env?: import("@agentclientprotocol/sdk").EnvVariable[];
    sessionId: string;
  }): Promise<import("@agentclientprotocol/sdk").TerminalHandle> {
    // Transform params to ACP CreateTerminalRequest format
    return this.connection.createTerminal({
      command: params.command,
      cwd: params.cwd ?? null,
      env: params.env,
      sessionId: params.sessionId,
    });
  }

  async readTextFile(params: { path: string }): Promise<{ content: string }> {
    return this.connection.readTextFile(params);
  }

  async writeTextFile(params: { path: string; content: string }): Promise<void> {
    return this.connection.writeTextFile(params);
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
  /** Session ID for terminal requests (required for ACP protocol) */
  sessionId?: string;
  /** Default thinking level */
  thinkingLevel?: ThinkingLevel;
}

// =============================================================================
// Runtime Factory
// =============================================================================

/**
 * Creates a Pi AgentSession configured to use ACP for tool operations.
 *
 * This factory creates a Pi AgentSession where all tool operations are
 * delegated to the ACP client instead of local filesystem/child_process:
 * - read → ACP fs.readTextFile
 * - write → ACP fs.writeTextFile
 * - edit → ACP fs.readTextFile + writeTextFile
 * - bash → ACP terminal
 * - grep → ACP terminal (grep command)
 * - find → ACP terminal (find command)
 * - ls → ACP terminal (ls command)
 *
 * @param options - Runtime creation options
 * @returns Created AgentSession and dispose function
 */
export async function createAcpAgentRuntime(options: CreateAcpAgentRuntimeOptions): Promise<{
  session: AgentSession;
  dispose: () => void;
}> {
  const { createAgentSession } = await import("@mariozechner/pi-coding-agent");

  // Create ACP client adapter with session ID
  const acpClient = new AcpConnectionAdapter(options.acpConnection, options.sessionId || "default");

  // Create ACP operation bridges
  const readOps: ReadOperations = new AcpReadOperations(acpClient);
  const writeOps: WriteOperations = new AcpWriteOperations(acpClient);
  const editOps: EditOperations = {
    readFile: async (path: string) => readOps.readFile(path),
    writeFile: async (path: string, content: string) => writeOps.writeFile(path, content),
    access: async (path: string) => readOps.access(path),
  };
  const bashOps: BashOperations = new AcpTerminalOperations(acpClient);
  const grepOps: GrepOperations = new AcpGrepOperations(acpClient);
  const findOps: FindOperations = new AcpFindOperations(acpClient);
  const lsOps: LsOperations = new AcpLsOperations(acpClient);

  // Create tools with ACP delegation
  const tools = [
    createReadTool(options.cwd, { operations: readOps }),
    createWriteTool(options.cwd, { operations: writeOps }),
    createEditTool(options.cwd, { operations: editOps }),
    createBashTool(options.cwd, { operations: bashOps }),
    createGrepTool(options.cwd, { operations: grepOps }),
    createFindTool(options.cwd, { operations: findOps }),
    createLsTool(options.cwd, { operations: lsOps }),
  ];

  // Create session with custom tools
  const sessionOptions: CreateAgentSessionOptions = {
    cwd: options.cwd,
    agentDir: options.agentDir,
    modelRegistry: options.modelRegistry,
    thinkingLevel: options.thinkingLevel || "medium",
    tools, // Override default tools with ACP-delegated ones
  };

  // Create the session
  const { session } = await createAgentSession(sessionOptions);

  // Return session with dispose function
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
 *
 * This allows AcpAgent to create sessions on demand without
 * importing the runtime module directly.
 *
 * @param acpConnection - ACP connection for tool delegation
 * @param agentDir - Agent configuration directory
 * @returns Factory function for creating sessions
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
