import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { AcpAgent } from "../src/index.ts";

function createUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function createMockConnection() {
  return {
    sessionUpdate: vi.fn(async () => undefined),
    readTextFile: vi.fn(async () => ({ content: "" })),
  } as any;
}

function createPersistentMockRuntime() {
  const sessions = new Map<string, any>();
  const createRuntime = vi.fn(async (options: any) => {
    const buildMessages = () => [...options.sessionManager.buildSessionContext().messages];

    const session = {
      sessionId: options.sessionManager.getSessionId(),
      sessionFile: options.sessionManager.getSessionFile(),
      sessionName: options.sessionManager.getSessionName(),
      sessionManager: options.sessionManager,
      state: {
        messages: buildMessages(),
        model: undefined,
      },
      thinkingLevel: options.sessionManager.buildSessionContext().thinkingLevel,
      dispose: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      prompt: vi.fn(async (text: string) => {
        const now = Date.now();
        options.sessionManager.appendMessage({
          role: "user",
          content: text,
          timestamp: now,
        });
        options.sessionManager.appendMessage({
          role: "assistant",
          content: [{ type: "text", text: `Echo: ${text}` }],
          api: "openai-responses",
          provider: "openai",
          model: "test-model",
          usage: createUsage(),
          stopReason: "stop",
          timestamp: now + 1,
        });
        session.state.messages = buildMessages();
        session.sessionName = options.sessionManager.getSessionName();
      }),
      abort: vi.fn(async () => undefined),
    } as any;

    sessions.set(session.sessionId, session);

    return {
      session,
      dispose: vi.fn(() => session.dispose()),
    };
  });

  return {
    createRuntime,
    sessions,
  };
}

function createAssistantMessage(parts: Array<any>, timestamp: number) {
  return {
    role: "assistant",
    content: parts,
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage: createUsage(),
    stopReason: "stop",
    timestamp,
  } as any;
}

function createUsageAwareMockRuntime(options?: {
  initialTokens?: number;
  promptTokens?: number;
  contextWindow?: number;
}) {
  const initialTokens = options?.initialTokens ?? 1024;
  const promptTokens = options?.promptTokens ?? 4096;
  const contextWindow = options?.contextWindow ?? 200_000;

  const createRuntime = vi.fn(async (runtimeOptions: any) => {
    let currentTokens = initialTokens;

    const session = {
      sessionId: runtimeOptions.sessionManager.getSessionId(),
      sessionFile: runtimeOptions.sessionManager.getSessionFile(),
      sessionName: runtimeOptions.sessionManager.getSessionName(),
      sessionManager: runtimeOptions.sessionManager,
      state: {
        messages: [],
        model: {
          provider: "openai",
          contextWindow,
        },
      },
      thinkingLevel: runtimeOptions.sessionManager.buildSessionContext().thinkingLevel,
      dispose: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      prompt: vi.fn(async () => {
        currentTokens = promptTokens;
      }),
      abort: vi.fn(async () => undefined),
      getContextUsage: vi.fn(() => ({
        tokens: currentTokens,
        contextWindow,
        percent: (currentTokens / contextWindow) * 100,
      })),
      getSessionStats: vi.fn(() => ({
        tokens: {
          input: Math.round(currentTokens * 0.8),
          output: Math.round(currentTokens * 0.2),
          cacheRead: Math.round(currentTokens * 0.5),
          cacheWrite: 0,
          total: currentTokens,
        },
        cost: currentTokens / 1_000_000,
        contextUsage: {
          tokens: currentTokens,
          contextWindow,
          percent: (currentTokens / contextWindow) * 100,
        },
      })),
    } as any;

    return {
      session,
      dispose: vi.fn(() => session.dispose()),
    };
  });

  return { createRuntime };
}

describe("AcpAgent session lifecycle", () => {
  let sandboxDir: string;
  let projectDir: string;
  let agentDir: string;

  beforeEach(async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "pi-acp-phase3-"));
    projectDir = join(sandboxDir, "project");
    agentDir = join(sandboxDir, "agent");
    await mkdir(projectDir, { recursive: true });
    await mkdir(agentDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(sandboxDir, { recursive: true, force: true });
  });

  test("emits session_info_update after prompt title/updatedAt changes", async () => {
    const connection = createMockConnection();
    const runtime = createPersistentMockRuntime();
    const agent = new AcpAgent(
      connection,
      {
        agentDir,
        modelRegistry: {
          getAvailable: () => [],
        } as any,
      },
      runtime.createRuntime,
    );

    await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    });

    const { sessionId } = await agent.newSession({
      cwd: projectDir,
      mcpServers: [],
    } as any);

    connection.sessionUpdate.mockClear();

    await agent.prompt({
      sessionId,
      prompt: [{ type: "text", text: "Summarize the repository" }],
    } as any);

    expect(connection.sessionUpdate.mock.calls).toEqual([
      [
        expect.objectContaining({
          sessionId,
          update: expect.objectContaining({
            sessionUpdate: "session_info_update",
            title: "Summarize the repository",
            updatedAt: expect.any(String),
          }),
        }),
      ],
    ]);
  });

  test("emits usage_update after prompt with current context usage", async () => {
    vi.useFakeTimers();

    try {
      const connection = createMockConnection();
      const runtime = createUsageAwareMockRuntime({
        initialTokens: 1536,
        promptTokens: 8192,
        contextWindow: 200_000,
      });
      const agent = new AcpAgent(
        connection,
        {
          agentDir,
          modelRegistry: {
            getAvailable: () => [],
          } as any,
        },
        runtime.createRuntime,
      );

      await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
      });

      const created = await agent.newSession({
        cwd: projectDir,
        mcpServers: [],
      } as any);
      const { sessionId } = created;

      expect(created.configOptions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "_usage",
            name: "Usage",
          }),
        ]),
      );

      await vi.runAllTimersAsync();
      connection.sessionUpdate.mockClear();

      await agent.prompt({
        sessionId,
        prompt: [{ type: "text", text: "How full is the context?" }],
      } as any);

      expect(connection.sessionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId,
          update: expect.objectContaining({
            sessionUpdate: "usage_update",
            size: 200_000,
            used: 8192,
          }),
        }),
      );

      expect(connection.sessionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId,
          update: expect.objectContaining({
            sessionUpdate: "config_option_update",
            configOptions: expect.arrayContaining([
              expect.objectContaining({
                id: "_usage",
                options: [
                  expect.objectContaining({
                    value: "current",
                    name: "8.2k/200k · 4.1%",
                  }),
                ],
              }),
            ]),
          }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("emits initial usage_update for new sessions when context usage is known", async () => {
    vi.useFakeTimers();

    try {
      const connection = createMockConnection();
      const runtime = createUsageAwareMockRuntime({
        initialTokens: 2048,
        contextWindow: 128_000,
      });
      const agent = new AcpAgent(
        connection,
        {
          agentDir,
          modelRegistry: {
            getAvailable: () => [],
          } as any,
        },
        runtime.createRuntime,
      );

      await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
      });

      const { sessionId } = await agent.newSession({
        cwd: projectDir,
        mcpServers: [],
      } as any);

      expect(connection.sessionUpdate).not.toHaveBeenCalled();

      await vi.runAllTimersAsync();

      const usageNotification = connection.sessionUpdate.mock.calls
        .map(([notification]: [any]) => notification)
        .find((notification: any) => notification.update.sessionUpdate === "usage_update");

      expect(usageNotification).toMatchObject({
        sessionId,
        update: {
          sessionUpdate: "usage_update",
          size: 128_000,
          used: 2048,
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("refreshes usage display after tool completion before the prompt finishes", async () => {
    const connection = createMockConnection();
    let currentTokens = 1536;
    let onEvent: ((event: any) => void) | undefined;
    let releasePrompt!: () => void;
    const promptGate = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });

    const createRuntime = vi.fn(async (runtimeOptions: any) => {
      const session = {
        sessionId: runtimeOptions.sessionManager.getSessionId(),
        sessionFile: runtimeOptions.sessionManager.getSessionFile(),
        sessionName: runtimeOptions.sessionManager.getSessionName(),
        sessionManager: runtimeOptions.sessionManager,
        state: {
          messages: [],
          model: {
            provider: "openai",
            contextWindow: 200_000,
          },
        },
        thinkingLevel: runtimeOptions.sessionManager.buildSessionContext().thinkingLevel,
        dispose: vi.fn(),
        subscribe: vi.fn((callback: (event: any) => void) => {
          onEvent = callback;
          return () => {};
        }),
        prompt: vi.fn(async () => {
          onEvent?.({
            type: "tool_execution_start",
            toolCallId: "tool-read-1",
            toolName: "read",
            args: { path: "README.md" },
          });

          currentTokens = 8192;
          onEvent?.({
            type: "tool_execution_end",
            toolCallId: "tool-read-1",
            toolName: "read",
            result: { content: [{ type: "text", text: "done" }] },
            isError: false,
          });

          await promptGate;
        }),
        abort: vi.fn(async () => undefined),
        getContextUsage: vi.fn(() => ({
          tokens: currentTokens,
          contextWindow: 200_000,
          percent: (currentTokens / 200_000) * 100,
        })),
        getSessionStats: vi.fn(() => ({
          tokens: {
            input: Math.round(currentTokens * 0.75),
            output: Math.round(currentTokens * 0.25),
            cacheRead: Math.round(currentTokens * 0.5),
            cacheWrite: 0,
            total: currentTokens,
          },
          cost: currentTokens / 1_000_000,
          contextUsage: {
            tokens: currentTokens,
            contextWindow: 200_000,
            percent: (currentTokens / 200_000) * 100,
          },
        })),
      } as any;

      return {
        session,
        dispose: vi.fn(() => session.dispose()),
      };
    });

    const agent = new AcpAgent(
      connection,
      {
        agentDir,
        modelRegistry: {
          getAvailable: () => [],
        } as any,
      },
      createRuntime,
    );

    await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    });

    const { sessionId } = await agent.newSession({
      cwd: projectDir,
      mcpServers: [],
    } as any);

    connection.sessionUpdate.mockClear();

    const flushNotifications = () => new Promise((resolve) => setTimeout(resolve, 0));

    let settled = false;
    const promptPromise = agent
      .prompt({
        sessionId,
        prompt: [{ type: "text", text: "Inspect README" }],
      } as any)
      .then(() => {
        settled = true;
      });

    await flushNotifications();
    await flushNotifications();

    expect(settled).toBe(false);
    expect(connection.sessionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        update: expect.objectContaining({
          sessionUpdate: "usage_update",
          size: 200_000,
          used: 8192,
        }),
      }),
    );
    expect(connection.sessionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        update: expect.objectContaining({
          sessionUpdate: "config_option_update",
          configOptions: expect.arrayContaining([
            expect.objectContaining({
              id: "_usage",
              options: [expect.objectContaining({ name: "8.2k/200k · 4.1%" })],
            }),
          ]),
        }),
      }),
    );

    releasePrompt();
    await promptPromise;
    expect(settled).toBe(true);
  });

  test("creates stable persisted sessions, lists them, loads history, resumes, and closes cleanly", async () => {
    const connection = createMockConnection();
    const runtime = createPersistentMockRuntime();
    const agent = new AcpAgent(
      connection,
      {
        agentDir,
        modelRegistry: {
          getAvailable: () => [],
        } as any,
      },
      runtime.createRuntime,
    );

    await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    });

    const { sessionId } = await agent.newSession({
      cwd: projectDir,
      mcpServers: [],
    } as any);

    const session = agent.getSession(sessionId)?.session as any;
    expect(sessionId).toBe(session.sessionId);

    session.sessionManager.appendMessage({
      role: "user",
      content: "Inspect the project status",
      timestamp: 1,
    });
    session.sessionManager.appendMessage(
      createAssistantMessage(
        [
          { type: "thinking", thinking: "Looking at the repository state." },
          { type: "text", text: "I am going to inspect src/index.ts." },
          {
            type: "toolCall",
            id: "tool-read-1",
            name: "read",
            arguments: { path: "src/index.ts" },
          },
        ],
        2,
      ),
    );
    session.sessionManager.appendMessage({
      role: "toolResult",
      toolCallId: "tool-read-1",
      toolName: "read",
      content: [{ type: "text", text: "export const loaded = true;" }],
      isError: false,
      timestamp: 3,
    });
    session.sessionManager.appendSessionInfo("Loaded session title");
    session.state.messages = [...session.sessionManager.buildSessionContext().messages];
    session.sessionName = session.sessionManager.getSessionName();

    await agent.closeSession(sessionId);

    const listedForCwd = await agent.unstable_listSessions({ cwd: projectDir } as any);
    expect(listedForCwd.nextCursor).toBeNull();
    expect(listedForCwd.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId,
          cwd: projectDir,
          title: "Loaded session title",
          updatedAt: expect.any(String),
        }),
      ]),
    );

    const listedAll = await agent.unstable_listSessions({} as any);
    expect(listedAll.sessions.map((item: any) => item.sessionId)).toContain(sessionId);

    connection.sessionUpdate.mockClear();

    const loaded = await agent.loadSession({
      sessionId,
      cwd: projectDir,
      mcpServers: [],
    } as any);

    expect(loaded.configOptions).toBeDefined();
    expect(agent.hasSession(sessionId)).toBe(true);

    const loadUpdates = connection.sessionUpdate.mock.calls.map(
      ([notification]: [any]) => notification.update,
    );
    expect(loadUpdates[0]).toMatchObject({
      sessionUpdate: "session_info_update",
      title: "Loaded session title",
      updatedAt: expect.any(String),
    });
    expect(loadUpdates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "Inspect the project status" },
        }),
        expect.objectContaining({
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "Looking at the repository state." },
        }),
        expect.objectContaining({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "I am going to inspect src/index.ts." },
        }),
        expect.objectContaining({
          sessionUpdate: "tool_call",
          toolCallId: "tool-read-1",
          title: `Read ${join(projectDir, "src/index.ts")}`,
          locations: [{ path: join(projectDir, "src/index.ts") }],
          rawInput: { path: "src/index.ts" },
          _meta: { tool_name: "read" },
        }),
        expect.objectContaining({
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-read-1",
          status: "completed",
          locations: [{ path: join(projectDir, "src/index.ts") }],
          rawOutput: { content: [{ type: "text", text: "export const loaded = true;" }] },
          _meta: { tool_name: "read" },
        }),
      ]),
    );

    connection.sessionUpdate.mockClear();

    const resumed = await agent.unstable_resumeSession({
      sessionId,
      cwd: projectDir,
      mcpServers: [],
    } as any);

    expect(resumed.configOptions).toBeDefined();

    const resumeUpdates = connection.sessionUpdate.mock.calls.map(
      ([notification]: [any]) => notification.update,
    );
    expect(resumeUpdates).toEqual([
      expect.objectContaining({
        sessionUpdate: "session_info_update",
        title: "Loaded session title",
        updatedAt: expect.any(String),
      }),
    ]);

    const resumedSession = runtime.sessions.get(sessionId);
    await agent.unstable_closeSession({ sessionId } as any);

    expect(resumedSession.abort).toHaveBeenCalledTimes(1);
    expect(agent.hasSession(sessionId)).toBe(false);
  });
});
