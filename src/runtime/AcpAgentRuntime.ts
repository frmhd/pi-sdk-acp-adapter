import {
  createAgentSession,
  type AgentSession,
  type CreateAgentSessionOptions,
  type ModelRuntime,
  type SessionManager,
  type SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

import type { AcpToolCallState } from "../adapter/types.js";
import { installToolDisplayTracking } from "./installToolDisplayTracking.js";

export interface CreateAcpAgentRuntimeOptions {
  cwd: string;
  agentDir?: string;
  modelRuntime: ModelRuntime;
  sessionManager: SessionManager;
  thinkingLevel?: ThinkingLevel;
  onToolCallStateCaptured?: (toolCallId: string, update: Partial<AcpToolCallState>) => void;
}

export async function createAcpAgentRuntime(options: CreateAcpAgentRuntimeOptions): Promise<{
  session: AgentSession;
  dispose: () => void;
  getSlashCommands: () => SlashCommandInfo[];
}> {
  const sessionOptions: CreateAgentSessionOptions = {
    cwd: options.cwd,
    agentDir: options.agentDir,
    modelRuntime: options.modelRuntime,
    thinkingLevel: options.thinkingLevel || "medium",
    sessionManager: options.sessionManager,
  };

  const { session, extensionsResult } = await createAgentSession(sessionOptions);

  // Observation-only display tracking: Pi's native read/edit/write/bash tools
  // execute untouched; the tracker only snapshots state for ACP presentation.
  const stopDisplayTracking = installToolDisplayTracking({
    agent: session.agent,
    cwd: options.cwd,
    onToolCallStateCaptured: options.onToolCallStateCaptured,
  });

  return {
    session,
    dispose: () => {
      stopDisplayTracking();
      session.dispose();
    },
    getSlashCommands: () => extensionsResult?.runtime?.getCommands?.() ?? [],
  };
}

export function createAcpAgentRuntimeFactory(agentDir?: string) {
  return async (
    options: Omit<CreateAcpAgentRuntimeOptions, "agentDir">,
  ): Promise<{
    session: AgentSession;
    dispose: () => void;
    getSlashCommands: () => SlashCommandInfo[];
  }> => {
    return createAcpAgentRuntime({
      ...options,
      ...(agentDir !== undefined && { agentDir }),
    });
  };
}
