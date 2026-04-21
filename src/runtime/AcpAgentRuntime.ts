import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import type {
  AgentSession,
  CreateAgentSessionOptions,
  ModelRegistry,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

import type { AcpClientCapabilitiesSnapshot, AcpToolCallState } from "../adapter/types.js";
import { AcpConnectionAdapter } from "./acpConnectionAdapter.js";
import { buildAcpSessionTools } from "./toolSelection.js";

export interface CreateAcpAgentRuntimeOptions {
  cwd: string;
  agentDir?: string;
  additionalDirectories?: string[];
  modelRegistry: ModelRegistry;
  acpConnection: AgentSideConnection;
  clientCapabilities: AcpClientCapabilitiesSnapshot;
  sessionManager: SessionManager;
  sessionId?: string;
  thinkingLevel?: ThinkingLevel;
  onToolCallStateCaptured?: (toolCallId: string, update: Partial<AcpToolCallState>) => void;
}

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
    tools: ["read", "bash", "edit", "write"],
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
