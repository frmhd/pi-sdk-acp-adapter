import type { AgentSideConnection, Implementation } from "@agentclientprotocol/sdk";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";

import type { AcpSessionState } from "../types.js";
import {
  getAvailableModels,
  getCurrentConfigOptions,
  areSessionConfigOptionsEqual,
} from "../AcpSessionConfig.js";
import {
  areAvailableCommandsEqual,
  buildAcpAvailableCommands,
  emitAvailableCommandsUpdate,
  emitConfigOptionsUpdate,
  emitSessionInfoUpdate,
  emitUsageUpdate,
  getCurrentSessionMetadata,
} from "../AcpSessionLifecycle.js";
import { buildSessionUsageSnapshot } from "./usage.js";

export function getSessionConfigOptions(
  sessionState: AcpSessionState,
  modelRegistry: ModelRegistry,
  clientInfo?: Implementation | null,
) {
  const configOptions = getCurrentConfigOptions(
    sessionState,
    getAvailableModels(modelRegistry),
    clientInfo,
  );
  sessionState.lastConfigOptions = configOptions;
  return configOptions;
}

export async function refreshSessionMetadata(
  connection: AgentSideConnection,
  sessionState: AcpSessionState,
  force = false,
): Promise<void> {
  if (!sessionState.session) {
    return;
  }

  const metadata = getCurrentSessionMetadata(sessionState.session);
  const changed =
    force || sessionState.title !== metadata.title || sessionState.updatedAt !== metadata.updatedAt;

  if (!changed) {
    return;
  }

  sessionState.title = metadata.title;
  sessionState.updatedAt = metadata.updatedAt;
  await emitSessionInfoUpdate(connection, sessionState.sessionId, metadata);
}

export async function refreshSessionUsage(
  connection: AgentSideConnection,
  sessionState: AcpSessionState,
  force = false,
): Promise<void> {
  if (!sessionState.session) {
    return;
  }

  const usage = buildSessionUsageSnapshot(sessionState.session);
  if (!usage) {
    return;
  }

  const changed =
    force ||
    sessionState.lastUsageUpdate?.size !== usage.size ||
    sessionState.lastUsageUpdate?.used !== usage.used;

  if (!changed) {
    return;
  }

  sessionState.lastUsageUpdate = usage;
  await emitUsageUpdate(connection, sessionState.sessionId, usage);
}

export async function refreshConfigOptions(
  connection: AgentSideConnection,
  sessionState: AcpSessionState,
  modelRegistry: ModelRegistry,
  clientInfo?: Implementation | null,
  force = false,
): Promise<void> {
  const configOptions = getCurrentConfigOptions(
    sessionState,
    getAvailableModels(modelRegistry),
    clientInfo,
  );

  if (!force && areSessionConfigOptionsEqual(sessionState.lastConfigOptions, configOptions)) {
    return;
  }

  sessionState.lastConfigOptions = configOptions;
  await emitConfigOptionsUpdate(connection, sessionState.sessionId, configOptions);
}

export async function refreshAvailableCommands(
  connection: AgentSideConnection,
  sessionState: AcpSessionState,
  force = false,
): Promise<void> {
  const getSlashCommands = sessionState.getSlashCommands;
  if (!getSlashCommands) {
    return;
  }

  const availableCommands = buildAcpAvailableCommands(getSlashCommands());
  if (!force && areAvailableCommandsEqual(sessionState.availableCommands, availableCommands)) {
    return;
  }

  sessionState.availableCommands = availableCommands;
  await emitAvailableCommandsUpdate(connection, sessionState.sessionId, availableCommands);
}

export function scheduleInitialSessionUpdates(options: {
  sessionState: AcpSessionState;
  refreshSessionMetadata: (sessionState: AcpSessionState, force?: boolean) => Promise<void>;
  refreshSessionUsage: (sessionState: AcpSessionState, force?: boolean) => Promise<void>;
  refreshAvailableCommands: (sessionState: AcpSessionState, force?: boolean) => Promise<void>;
}): void {
  setTimeout(() => {
    void options.refreshSessionMetadata(options.sessionState, true).catch((error) => {
      console.warn(
        `Failed to send initial session metadata for ${options.sessionState.sessionId}:`,
        error,
      );
    });
    void options.refreshSessionUsage(options.sessionState, true).catch((error) => {
      console.warn(
        `Failed to send initial session usage for ${options.sessionState.sessionId}:`,
        error,
      );
    });
    void options.refreshAvailableCommands(options.sessionState, true).catch((error) => {
      console.warn(
        `Failed to send initial slash commands for ${options.sessionState.sessionId}:`,
        error,
      );
    });
  }, 0);
}
