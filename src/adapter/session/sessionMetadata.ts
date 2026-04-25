import type { SessionInfo as AcpSessionInfo } from "@agentclientprotocol/sdk";
import type {
  AgentSession,
  SessionInfo as PiSessionInfo,
  SessionEntry,
} from "@mariozechner/pi-coding-agent";
import type { TextContent, UserMessage } from "@mariozechner/pi-ai";

const SESSION_TITLE_MAX_LENGTH = 80;

export function normalizeSessionTitle(title: string | undefined): string | null {
  if (!title) {
    return null;
  }

  const normalized = title.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }

  if (normalized.length <= SESSION_TITLE_MAX_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, SESSION_TITLE_MAX_LENGTH - 1).trimEnd()}…`;
}

function extractUserText(content: UserMessage["content"]): string | undefined {
  if (typeof content === "string") {
    return content;
  }

  const parts = content
    .filter((item): item is TextContent => item.type === "text")
    .map((item) => item.text.trim())
    .filter(Boolean);

  return parts.length > 0 ? parts.join(" ") : undefined;
}

function deriveTitleFromEntries(entries: SessionEntry[]): string | undefined {
  for (const entry of entries) {
    if (entry.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) {
      return entry.name;
    }

    if (entry.type === "message" && entry.message.role === "user") {
      const text = extractUserText(entry.message.content);
      if (text?.trim()) {
        return text;
      }
    }
  }

  return undefined;
}

function deriveTitleFromSession(session: AgentSession): string | null {
  const explicitName = session.sessionManager.getSessionName();
  if (explicitName) {
    return normalizeSessionTitle(explicitName);
  }

  const fromMessages = session.state.messages.find(
    (message): message is UserMessage => message.role === "user",
  );
  const firstUserText = fromMessages ? extractUserText(fromMessages.content) : undefined;
  if (firstUserText) {
    return normalizeSessionTitle(firstUserText);
  }

  return normalizeSessionTitle(deriveTitleFromEntries(session.sessionManager.getEntries()));
}

function deriveUpdatedAtFromSession(session: AgentSession): string | null {
  const lastEntry = session.sessionManager.getEntries().at(-1);
  if (lastEntry?.timestamp) {
    return lastEntry.timestamp;
  }

  const header = session.sessionManager.getHeader();
  if (header?.timestamp) {
    return header.timestamp;
  }

  const lastMessage = session.state.messages.at(-1) as { timestamp?: number } | undefined;
  if (typeof lastMessage?.timestamp === "number") {
    return new Date(lastMessage.timestamp).toISOString();
  }

  return null;
}

export function buildAcpSessionInfo(info: PiSessionInfo): AcpSessionInfo {
  const derivedTitle = normalizeSessionTitle(info.name) ?? normalizeSessionTitle(info.firstMessage);

  return {
    cwd: info.cwd,
    sessionId: info.id,
    title: derivedTitle,
    updatedAt: info.modified.toISOString(),
  };
}

export function getCurrentSessionMetadata(session: AgentSession): {
  title: string | null;
  updatedAt: string | null;
} {
  return {
    title: deriveTitleFromSession(session),
    updatedAt: deriveUpdatedAtFromSession(session),
  };
}
