import { mkdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { SessionInfo as PiSessionInfo } from "@mariozechner/pi-coding-agent";

function getDefaultAgentDir(): string {
  return join(homedir(), ".pi", "agent");
}

function getSessionsRoot(agentDir?: string): string {
  const root = join(agentDir ?? getDefaultAgentDir(), "sessions");
  mkdirSync(root, { recursive: true });
  return root;
}

export function getAcpSessionDirectory(cwd: string, agentDir?: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = join(getSessionsRoot(agentDir), safePath);
  mkdirSync(sessionDir, { recursive: true });
  return sessionDir;
}

export async function listPersistedPiSessions(params: {
  cwd?: string | null;
  agentDir?: string;
}): Promise<PiSessionInfo[]> {
  if (params.cwd) {
    const { SessionManager } = await import("@mariozechner/pi-coding-agent");
    return SessionManager.list(params.cwd, getAcpSessionDirectory(params.cwd, params.agentDir));
  }

  const root = getSessionsRoot(params.agentDir);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name));
  const { SessionManager } = await import("@mariozechner/pi-coding-agent");

  const sessions = (
    await Promise.all(dirs.map((dir) => SessionManager.list(process.cwd(), dir).catch(() => [])))
  ).flat();

  sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
  return sessions;
}
