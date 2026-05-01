import { describe, expect, test, vi, beforeEach } from "vite-plus/test";

const readFileMock = vi.hoisted(() => vi.fn());
const writeFileMock = vi.hoisted(() => vi.fn());
const mkdirMock = vi.hoisted(() => vi.fn());
const renameMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", () => ({
  readFile: readFileMock,
  writeFile: writeFileMock,
  mkdir: mkdirMock,
  rename: renameMock,
}));

const SessionManagerMock = vi.hoisted(() => ({
  create: vi.fn(),
  open: vi.fn(),
  list: vi.fn(),
}));

vi.mock("@mariozechner/pi-coding-agent", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@mariozechner/pi-coding-agent");
  return {
    ...actual,
    SessionManager: SessionManagerMock,
  };
});

import {
  createMockConnection,
  createMockSession,
  createTestAgent,
} from "../helpers/testDoubles.ts";
import { resetModelPreferencesCache } from "../../src/adapter/session/modelPreferences.js";

const gpt4ModelId = JSON.stringify({ provider: "openai", id: "gpt-4.1" });

beforeEach(() => {
  vi.clearAllMocks();
  resetModelPreferencesCache();
  SessionManagerMock.create.mockReturnValue({ getSessionId: () => "session-1" });
  SessionManagerMock.open.mockReturnValue({ getSessionId: () => "session-1" });
  SessionManagerMock.list.mockResolvedValue([
    { id: "session-1", path: "/tmp/session-1", modified: new Date() },
  ]);
  readFileMock.mockImplementation(async (path: string) => {
    if (String(path).includes("model-thinking-preferences")) {
      return JSON.stringify({ [gpt4ModelId]: "xhigh" });
    }
    const err = new Error("ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  });
  writeFileMock.mockResolvedValue(undefined);
  mkdirMock.mockResolvedValue(undefined);
  renameMock.mockResolvedValue(undefined);
});

describe("ACP slash commands", () => {
  test("advertises Pi slash commands with available_commands_update on new sessions", async () => {
    vi.useFakeTimers();

    try {
      const connection = createMockConnection();
      const createRuntime = vi.fn(async () => ({
        session: createMockSession(),
        dispose: vi.fn(),
        getSlashCommands: () => [
          {
            name: "review",
            description: undefined,
            source: "extension",
            sourceInfo: {
              path: "/tmp/extensions/review.ts",
              source: "local",
              scope: "project",
              origin: "top-level",
            },
          },
          {
            name: "fix-tests",
            description: "Fix failing tests",
            source: "prompt",
            sourceInfo: {
              path: "/tmp/.pi/prompts/fix-tests.md",
              source: "local",
              scope: "project",
              origin: "top-level",
            },
          },
          {
            name: "skill:brave-search",
            description: "Web search via Brave API",
            source: "skill",
            sourceInfo: {
              path: "/tmp/.pi/skills/brave-search/SKILL.md",
              source: "local",
              scope: "user",
              origin: "top-level",
            },
          },
        ],
      }));
      const agent = createTestAgent(connection, createRuntime);

      await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
      });

      await agent.newSession({ cwd: "/tmp/project" } as any);

      expect(connection.sessionUpdate).not.toHaveBeenCalled();

      await vi.runAllTimersAsync();

      const availableCommandsNotification = connection.sessionUpdate.mock.calls
        .map(([notification]: [any]) => notification)
        .find(
          (notification: any) => notification.update.sessionUpdate === "available_commands_update",
        );

      expect(availableCommandsNotification).toBeDefined();
      expect(availableCommandsNotification).toMatchObject({
        sessionId: expect.any(String),
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [
            {
              name: "review",
              description: "Run /review",
            },
            {
              name: "fix-tests",
              description: "Fix failing tests",
            },
            {
              name: "skill:brave-search",
              description: "Web search via Brave API",
            },
            {
              name: "regenerate-title",
              description: "Regenerate session title based on all user messages",
            },
          ],
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ACP session thinking level preference", () => {
  test("newSession applies saved per-model thinking preference", async () => {
    const setThinkingLevel = vi.fn();
    const connection = createMockConnection();
    const agent = createTestAgent(connection, async () => ({
      session: {
        ...createMockSession(),
        state: { messages: [], model: { provider: "openai", id: "gpt-4.1" } },
        thinkingLevel: "medium",
        setThinkingLevel,
      },
      dispose: vi.fn(),
    }));

    await agent.initialize({ protocolVersion: 1 } as any);
    await agent.newSession({ cwd: "/tmp/project" } as any);

    expect(setThinkingLevel).toHaveBeenCalledWith("xhigh");
    expect(agent.getSession("session-1")?.currentThinkingLevel).toBe("xhigh");
  });

  test("loadSession preserves the session's own persisted thinking level", async () => {
    const setThinkingLevel = vi.fn();
    const connection = createMockConnection();
    const agent = createTestAgent(connection, async () => ({
      session: {
        ...createMockSession(),
        state: { messages: [], model: { provider: "openai", id: "gpt-4.1" } },
        thinkingLevel: "low",
        setThinkingLevel,
      },
      dispose: vi.fn(),
    }));

    await agent.initialize({ protocolVersion: 1 } as any);
    await agent.loadSession({ sessionId: "session-1", cwd: "/tmp/project" } as any);

    expect(setThinkingLevel).not.toHaveBeenCalled();
    expect(agent.getSession("session-1")?.currentThinkingLevel).toBe("low");
  });

  test("resumeSession preserves the session's own persisted thinking level", async () => {
    const setThinkingLevel = vi.fn();
    const connection = createMockConnection();
    const agent = createTestAgent(connection, async () => ({
      session: {
        ...createMockSession(),
        state: { messages: [], model: { provider: "openai", id: "gpt-4.1" } },
        thinkingLevel: "low",
        setThinkingLevel,
      },
      dispose: vi.fn(),
    }));

    await agent.initialize({ protocolVersion: 1 } as any);
    await agent.resumeSession({ sessionId: "session-1", cwd: "/tmp/project" } as any);

    expect(setThinkingLevel).not.toHaveBeenCalled();
    expect(agent.getSession("session-1")?.currentThinkingLevel).toBe("low");
  });
});
