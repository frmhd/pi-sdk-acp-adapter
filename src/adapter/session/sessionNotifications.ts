import type {
  AgentSideConnection,
  AvailableCommand,
  SessionConfigOption,
  SessionNotification,
} from "@agentclientprotocol/sdk";

export async function emitSessionNotification(
  connection: AgentSideConnection,
  notification: SessionNotification,
): Promise<void> {
  await connection.sessionUpdate(notification);
}

export async function emitSessionInfoUpdate(
  connection: AgentSideConnection,
  sessionId: string,
  metadata: { title: string | null; updatedAt: string | null },
): Promise<void> {
  await emitSessionNotification(connection, {
    sessionId,
    update: {
      sessionUpdate: "session_info_update",
      title: metadata.title,
      updatedAt: metadata.updatedAt,
    },
  });
}

export async function emitUsageUpdate(
  connection: AgentSideConnection,
  sessionId: string,
  usage: {
    size: number;
    used: number;
  },
): Promise<void> {
  await emitSessionNotification(connection, {
    sessionId,
    update: {
      sessionUpdate: "usage_update",
      size: usage.size,
      used: usage.used,
    },
  });
}

export async function emitConfigOptionsUpdate(
  connection: AgentSideConnection,
  sessionId: string,
  configOptions: SessionConfigOption[],
): Promise<void> {
  await emitSessionNotification(connection, {
    sessionId,
    update: {
      sessionUpdate: "config_option_update",
      configOptions,
    },
  });
}

export async function emitAvailableCommandsUpdate(
  connection: AgentSideConnection,
  sessionId: string,
  availableCommands: AvailableCommand[],
): Promise<void> {
  await emitSessionNotification(connection, {
    sessionId,
    update: {
      sessionUpdate: "available_commands_update",
      availableCommands,
    },
  });
}
