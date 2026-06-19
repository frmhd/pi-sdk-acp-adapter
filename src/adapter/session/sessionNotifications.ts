import type {
  AvailableCommand,
  SessionConfigOption,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import type { AcpAgentClientContext } from "../acpClientContext.js";

export async function emitSessionNotification(
  connection: AcpAgentClientContext,
  notification: SessionNotification,
): Promise<void> {
  await connection.sessionUpdate(notification);
}

export async function emitSessionInfoUpdate(
  connection: AcpAgentClientContext,
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
  connection: AcpAgentClientContext,
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
  connection: AcpAgentClientContext,
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
  connection: AcpAgentClientContext,
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
