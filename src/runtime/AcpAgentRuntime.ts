/**
 * ACP Agent Runtime Factory
 *
 * Creates Pi AgentSessions configured for ACP protocol usage.
 */

import type { AgentSideConnection } from "@agentclientprotocol/sdk";

import type {
  ModelRegistry,
  AgentSession,
  CreateAgentSessionOptions,
} from "@mariozechner/pi-coding-agent";

import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

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
  /** Default thinking level */
  thinkingLevel?: ThinkingLevel;
}

// =============================================================================
// Runtime Factory
// =============================================================================

/**
 * Creates a Pi AgentSession configured to use ACP for tool operations.
 *
 * This factory creates a Pi AgentSession with standard local filesystem tools.
 * ACP tool delegation (read/write/terminal via ACP connection) is planned for
 * a future version when the Pi SDK's baseToolsOverride API is stable.
 *
 * @param options - Runtime creation options
 * @returns Created AgentSession and dispose function
 */
export async function createAcpAgentRuntime(options: CreateAcpAgentRuntimeOptions): Promise<{
  session: AgentSession;
  dispose: () => void;
}> {
  const { createAgentSession } = await import("@mariozechner/pi-coding-agent");

  // Create session with standard tools (ACP tool delegation to be added)
  const sessionOptions: CreateAgentSessionOptions = {
    cwd: options.cwd,
    agentDir: options.agentDir,
    modelRegistry: options.modelRegistry,
    thinkingLevel: options.thinkingLevel || "medium",
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
