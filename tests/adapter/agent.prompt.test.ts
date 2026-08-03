import { describe, expect, test, vi } from "vite-plus/test";

import {
  createMockConnection,
  createMockSession,
  createTestAgent,
} from "../helpers/testDoubles.ts";

describe("AcpAgent prompt error handling", () => {
  test("sends API error as agent_message_chunk when session.prompt() throws", async () => {
    const connection = createMockConnection();
    const mockSession = createMockSession();

    mockSession.prompt = vi.fn(async () => {
      throw new Error("529 overloaded_error: Overloaded");
    });

    const createRuntime = vi.fn(async () => ({
      session: mockSession,
      dispose: vi.fn(),
    }));

    const agent = createTestAgent(connection, createRuntime);

    await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    });

    const { sessionId } = await agent.newSession({ cwd: "/tmp/project" } as any);

    const response = await agent.prompt({
      sessionId,
      prompt: [{ type: "text", text: "Hello" }],
    } as any);

    expect(response.stopReason).toBe("end_turn");

    const updates = connection.sessionUpdate.mock.calls.map(
      ([notification]: [any]) => notification.update,
    );
    const errorChunk = updates.find(
      (update: any) =>
        update.sessionUpdate === "agent_message_chunk" &&
        update.content?.type === "text" &&
        update.content.text.includes("529 overloaded_error"),
    );
    expect(errorChunk).toBeDefined();
  });

  test("returns cancelled stop reason for abort errors without sending an error chunk", async () => {
    const connection = createMockConnection();
    const mockSession = createMockSession();

    mockSession.prompt = vi.fn(async () => {
      const err = new Error("Request was aborted");
      err.name = "AbortError";
      throw err;
    });

    const createRuntime = vi.fn(async () => ({
      session: mockSession,
      dispose: vi.fn(),
    }));

    const agent = createTestAgent(connection, createRuntime);

    await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    });

    const { sessionId } = await agent.newSession({ cwd: "/tmp/project" } as any);

    const response = await agent.prompt({
      sessionId,
      prompt: [{ type: "text", text: "Hello" }],
    } as any);

    expect(response.stopReason).toBe("cancelled");

    const updates = connection.sessionUpdate.mock.calls.map(
      ([notification]: [any]) => notification.update,
    );
    const errorChunk = updates.find(
      (update: any) =>
        update.sessionUpdate === "agent_message_chunk" &&
        update.content?.type === "text" &&
        update.content.text.includes("Error:"),
    );
    expect(errorChunk).toBeUndefined();
  });

  test("sends stream error as agent_message_chunk when last message has stopReason error", async () => {
    const connection = createMockConnection();
    const mockSession = createMockSession();

    mockSession.prompt = vi.fn(async () => {
      mockSession.state.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "Partial response..." }],
        stopReason: "error",
        errorMessage: "Context window exceeded",
      });
    });

    const createRuntime = vi.fn(async () => ({
      session: mockSession,
      dispose: vi.fn(),
    }));

    const agent = createTestAgent(connection, createRuntime);

    await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    });

    const { sessionId } = await agent.newSession({ cwd: "/tmp/project" } as any);

    const response = await agent.prompt({
      sessionId,
      prompt: [{ type: "text", text: "Hello" }],
    } as any);

    expect(response.stopReason).toBe("end_turn");

    const updates = connection.sessionUpdate.mock.calls.map(
      ([notification]: [any]) => notification.update,
    );
    const errorChunk = updates.find(
      (update: any) =>
        update.sessionUpdate === "agent_message_chunk" &&
        update.content?.type === "text" &&
        update.content.text === "Context window exceeded",
    );
    expect(errorChunk).toBeDefined();
  });
});

describe("AcpAgent prompt text passthrough", () => {
  test("passes prompt text to Pi unchanged without @path preprocessing", async () => {
    const connection = createMockConnection();
    const mockSession = createMockSession();

    mockSession.prompt = vi.fn(async () => undefined);

    const createRuntime = vi.fn(async () => ({
      session: mockSession,
      dispose: vi.fn(),
    }));

    const agent = createTestAgent(connection, createRuntime);

    await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
    });

    const { sessionId } = await agent.newSession({ cwd: "/tmp/project" } as any);

    const promptText = "Explain @src/main.ts and run ls";
    await agent.prompt({
      sessionId,
      prompt: [{ type: "text", text: promptText }],
    } as any);

    expect(mockSession.prompt).toHaveBeenCalledWith(promptText, undefined);
    expect(connection.sessionUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          sessionUpdate: "agent_message_chunk",
          content: expect.objectContaining({
            text: expect.stringContaining("--- @src/main.ts ---"),
          }),
        }),
      }),
    );
  });
});

describe("AcpAgent prompt tool state tracking", () => {
  test("maps bash updates and completion to plain ACP content", async () => {
    const connection = createMockConnection();
    const mockSession = createMockSession();
    let onEvent: ((event: any) => void) | undefined;

    mockSession.subscribe = vi.fn((callback: (event: any) => void) => {
      onEvent = callback;
      return () => {};
    });

    const partialResult = {
      content: [{ type: "text", text: "hi\n" }],
      details: { truncated: false },
    };
    const finalResult = {
      content: [{ type: "text", text: "hi\n" }],
      details: { truncated: false, exitCode: 0 },
    };

    mockSession.prompt = vi.fn(async () => {
      onEvent?.({
        type: "tool_execution_start",
        toolCallId: "tool-bash",
        toolName: "bash",
        args: { command: "echo hi" },
      });

      onEvent?.({
        type: "tool_execution_update",
        toolCallId: "tool-bash",
        toolName: "bash",
        partialResult,
      });

      onEvent?.({
        type: "tool_execution_end",
        toolCallId: "tool-bash",
        toolName: "bash",
        result: finalResult,
        isError: false,
      });
    });

    const createRuntime = vi.fn(async () => ({
      session: mockSession,
      dispose: vi.fn(),
    }));

    const agent = createTestAgent(connection, createRuntime);

    await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
    });

    const { sessionId } = await agent.newSession({ cwd: "/tmp/project" } as any);

    await agent.prompt({
      sessionId,
      prompt: [{ type: "text", text: "Run a command" }],
    } as any);

    const updates = connection.sessionUpdate.mock.calls.map(
      ([notification]: [any]) => notification.update,
    );

    const inProgress = updates.find(
      (update: any) =>
        update.sessionUpdate === "tool_call_update" &&
        update.toolCallId === "tool-bash" &&
        update.status === "in_progress",
    );
    const completed = updates.find(
      (update: any) =>
        update.sessionUpdate === "tool_call_update" &&
        update.toolCallId === "tool-bash" &&
        update.status === "completed",
    );

    expect(inProgress.content).toEqual([
      { type: "content", content: { type: "text", text: "hi\n" } },
    ]);
    expect(inProgress.rawOutput).toEqual(partialResult);
    expect(completed.content).toEqual([
      { type: "content", content: { type: "text", text: "hi\n" } },
    ]);
    expect(completed.rawOutput).toEqual(finalResult);
    expect(completed.content).not.toEqual([{ type: "terminal", terminalId: expect.any(String) }]);
    expect(agent.getSession(sessionId)?.pendingToolCalls.size).toBe(0);
  });

  test("serializes edit tool updates so in_progress reaches ACP before completion", async () => {
    const connection = createMockConnection();
    const mockSession = createMockSession();
    let onEvent: ((event: any) => void) | undefined;
    let runtimeOptions: any;
    const sessionUpdateResolvers: Array<() => void> = [];
    let queuedToolUpdateCount = 0;

    connection.sessionUpdate = vi.fn((notification: any) => {
      const sessionUpdate = notification?.update?.sessionUpdate;
      if (sessionUpdate === "tool_call" || sessionUpdate === "tool_call_update") {
        queuedToolUpdateCount += 1;
        if (queuedToolUpdateCount <= 3) {
          return new Promise<void>((resolve) => sessionUpdateResolvers.push(resolve));
        }
      }
      return Promise.resolve();
    });

    mockSession.subscribe = vi.fn((callback: (event: any) => void) => {
      onEvent = callback;
      return () => {};
    });

    mockSession.prompt = vi.fn(async () => {
      onEvent?.({
        type: "tool_execution_start",
        toolCallId: "tool-edit",
        toolName: "edit",
        args: { path: "file.ts", edits: [{ oldText: "before", newText: "after" }] },
      });

      runtimeOptions.onToolCallStateCaptured("tool-edit", {
        toolName: "edit",
        path: "/tmp/project/file.ts",
        diff: {
          path: "/tmp/project/file.ts",
          oldText: "before",
          newText: "after",
        },
      });

      onEvent?.({
        type: "tool_execution_update",
        toolCallId: "tool-edit",
        toolName: "edit",
        partialResult: { content: [], details: undefined },
      });

      onEvent?.({
        type: "tool_execution_end",
        toolCallId: "tool-edit",
        toolName: "edit",
        result: {
          content: [{ type: "text", text: "done" }],
          details: { firstChangedLine: 3 },
        },
        isError: false,
      });
    });

    const createRuntime = vi.fn(async (options: any) => {
      runtimeOptions = options;
      return {
        session: mockSession,
        dispose: vi.fn(),
      };
    });

    const agent = createTestAgent(connection, createRuntime);

    await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    });

    const flushNotifications = () => new Promise((resolve) => setTimeout(resolve, 0));

    const { sessionId } = await agent.newSession({ cwd: "/tmp/project" } as any);
    await flushNotifications();
    connection.sessionUpdate.mockClear();

    let settled = false;
    const promptPromise = agent
      .prompt({
        sessionId,
        prompt: [{ type: "text", text: "Edit the file" }],
      } as any)
      .then(() => {
        settled = true;
      });

    await flushNotifications();

    expect(connection.sessionUpdate).toHaveBeenCalledTimes(1);
    expect(connection.sessionUpdate.mock.calls[0]?.[0].update).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "tool-edit",
      status: "pending",
    });
    expect(settled).toBe(false);

    sessionUpdateResolvers.shift()?.();
    await flushNotifications();

    expect(connection.sessionUpdate).toHaveBeenCalledTimes(2);
    expect(connection.sessionUpdate.mock.calls[1]?.[0].update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-edit",
      status: "in_progress",
      content: [
        {
          type: "diff",
          path: "/tmp/project/file.ts",
          oldText: "before",
          newText: "after",
        },
      ],
    });
    expect(settled).toBe(false);

    sessionUpdateResolvers.shift()?.();
    await flushNotifications();

    expect(connection.sessionUpdate).toHaveBeenCalledTimes(3);
    expect(connection.sessionUpdate.mock.calls[2]?.[0].update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-edit",
      status: "completed",
    });
    expect(settled).toBe(false);

    sessionUpdateResolvers.shift()?.();
    await promptPromise;
    expect(settled).toBe(true);
  });

  test("keeps per-tool-call diffs isolated across overlapping tool executions", async () => {
    const connection = createMockConnection();
    const mockSession = createMockSession();
    let onEvent: ((event: any) => void) | undefined;
    let runtimeOptions: any;

    mockSession.subscribe = vi.fn((callback: (event: any) => void) => {
      onEvent = callback;
      return () => {};
    });

    mockSession.prompt = vi.fn(async () => {
      onEvent?.({
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "edit",
        args: { path: "a.ts", edits: [{ oldText: "old-a", newText: "new-a" }] },
      });
      runtimeOptions.onToolCallStateCaptured("tool-1", {
        toolName: "edit",
        path: "/tmp/project/a.ts",
        diff: {
          path: "/tmp/project/a.ts",
          oldText: "old-a",
          newText: "new-a",
        },
      });

      onEvent?.({
        type: "tool_execution_start",
        toolCallId: "tool-2",
        toolName: "edit",
        args: { path: "b.ts", edits: [{ oldText: "old-b", newText: "new-b" }] },
      });
      runtimeOptions.onToolCallStateCaptured("tool-2", {
        toolName: "edit",
        path: "/tmp/project/b.ts",
        diff: {
          path: "/tmp/project/b.ts",
          oldText: "old-b",
          newText: "new-b",
        },
      });

      onEvent?.({
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "edit",
        result: {
          content: [{ type: "text", text: "done a" }],
          details: { firstChangedLine: 4 },
        },
        isError: false,
      });

      onEvent?.({
        type: "tool_execution_end",
        toolCallId: "tool-2",
        toolName: "edit",
        result: {
          content: [{ type: "text", text: "done b" }],
          details: { firstChangedLine: 9 },
        },
        isError: false,
      });
    });

    const createRuntime = vi.fn(async (options: any) => {
      runtimeOptions = options;
      return {
        session: mockSession,
        dispose: vi.fn(),
      };
    });

    const agent = createTestAgent(connection, createRuntime);

    await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    });

    const { sessionId } = await agent.newSession({ cwd: "/tmp/project" } as any);

    await agent.prompt({
      sessionId,
      prompt: [{ type: "text", text: "Apply both edits" }],
    } as any);

    const updates = connection.sessionUpdate.mock.calls.map(
      ([notification]: [any]) => notification.update,
    );

    const tool1End = updates.find(
      (update: any) =>
        update.sessionUpdate === "tool_call_update" &&
        update.toolCallId === "tool-1" &&
        update.status === "completed",
    );
    const tool2End = updates.find(
      (update: any) =>
        update.sessionUpdate === "tool_call_update" &&
        update.toolCallId === "tool-2" &&
        update.status === "completed",
    );

    expect(tool1End.content[0]).toMatchObject({
      type: "diff",
      path: "/tmp/project/a.ts",
      oldText: "old-a",
      newText: "new-a",
    });
    expect(tool1End.locations).toEqual([{ path: "/tmp/project/a.ts", line: 4 }]);

    expect(tool2End.content[0]).toMatchObject({
      type: "diff",
      path: "/tmp/project/b.ts",
      oldText: "old-b",
      newText: "new-b",
    });
    expect(tool2End.locations).toEqual([{ path: "/tmp/project/b.ts", line: 9 }]);

    expect(agent.getSession(sessionId)?.pendingToolCalls.size).toBe(0);
  });
});
