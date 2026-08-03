import type { AcpAgentClientContext } from "../adapter/acpClientContext.js";
import {
  createAgentSession,
  type AgentSession,
  type CreateAgentSessionOptions,
  type ModelRuntime,
  type SessionManager,
  type SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

import type { AcpClientCapabilitiesSnapshot, AcpToolCallState } from "../adapter/types.js";
import { AcpConnectionAdapter } from "./acpConnectionAdapter.js";
import { buildAcpSessionTools } from "./toolSelection.js";

export interface CreateAcpAgentRuntimeOptions {
  cwd: string;
  agentDir?: string;
  additionalDirectories?: string[];
  modelRuntime: ModelRuntime;
  acpConnection: AcpAgentClientContext;
  clientCapabilities: AcpClientCapabilitiesSnapshot;
  sessionManager: SessionManager;
  sessionId?: string;
  thinkingLevel?: ThinkingLevel;
  onToolCallStateCaptured?: (toolCallId: string, update: Partial<AcpToolCallState>) => void;
}

export async function createAcpAgentRuntime(options: CreateAcpAgentRuntimeOptions): Promise<{
  session: AgentSession;
  dispose: () => void;
  getSlashCommands: () => SlashCommandInfo[];
}> {
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
    modelRuntime: options.modelRuntime,
    thinkingLevel: options.thinkingLevel || "medium",
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
  acpConnection: AcpAgentClientContext,
  agentDir?: string,
) {
  return async (
    options: Omit<CreateAcpAgentRuntimeOptions, "acpConnection" | "agentDir">,
  ): Promise<{
    session: AgentSession;
    dispose: () => void;
    getSlashCommands: () => SlashCommandInfo[];
  }> => {
    return createAcpAgentRuntime({
      ...options,
      acpConnection,
      ...(agentDir !== undefined && { agentDir }),
    });
  };
}
