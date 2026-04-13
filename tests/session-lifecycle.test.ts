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
          title: "Read src/index.ts",
          _meta: { tool_name: "read" },
        }),
        expect.objectContaining({
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-read-1",
          status: "completed",
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
