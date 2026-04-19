import { describe, expect, test, vi } from "vite-plus/test";

import {
  createMockConnection,
  createMockSession,
  createTestAgent,
} from "../helpers/testDoubles.ts";

describe("AcpAgent prompt tool state tracking", () => {
  test("releases terminal-backed bash tool calls after the final ACP update", async () => {
    const connection = createMockConnection();
    const mockSession = createMockSession();
    const releaseTerminal = vi.fn(async () => undefined);
    let onEvent: ((event: any) => void) | undefined;
    let runtimeOptions: any;

    mockSession.subscribe = vi.fn((callback: (event: any) => void) => {
      onEvent = callback;
      return () => {};
    });

    mockSession.prompt = vi.fn(async () => {
      onEvent?.({
        type: "tool_execution_start",
        toolCallId: "tool-bash",
        toolName: "bash",
        args: { command: "echo hi" },
      });

      runtimeOptions.onToolCallStateCaptured("tool-bash", {
        toolName: "bash",
        terminalId: "term-1",
        releaseTerminal,
        rawOutput: {
          type: "acp_terminal",
          terminalId: "term-1",
          input: { command: "echo hi", timeout: null },
          execution: {
            command: "echo hi",
            args: [],
            cwd: "/tmp/project",
            outputByteLimit: 51200,
          },
          output: "hi\n",
          truncated: false,
        },
      });

      onEvent?.({
        type: "tool_execution_update",
        toolCallId: "tool-bash",
        toolName: "bash",
        partialResult: { content: [], details: undefined },
      });

      runtimeOptions.onToolCallStateCaptured("tool-bash", {
        rawOutput: {
          type: "acp_terminal",
          terminalId: "term-1",
          input: { command: "echo hi", timeout: null },
          execution: {
            command: "echo hi",
            args: [],
            cwd: "/tmp/project",
            outputByteLimit: 51200,
          },
          output: "hi\n",
          truncated: false,
          exitCode: 0,
          signal: null,
        },
      });

      onEvent?.({
        type: "tool_execution_end",
        toolCallId: "tool-bash",
        toolName: "bash",
        result: { content: [{ type: "text", text: "hi" }] },
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
      prompt: [{ type: "text", text: "Run a command" }],
    } as any);

    await Promise.resolve();
    await Promise.resolve();

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

    expect(inProgress.content).toEqual([{ type: "terminal", terminalId: "term-1" }]);
    expect(completed.content).toEqual([{ type: "terminal", terminalId: "term-1" }]);
    expect(completed.rawOutput).toMatchObject({
      terminalId: "term-1",
      exitCode: 0,
      piResult: { content: [{ type: "text", text: "hi" }] },
    });
    expect(releaseTerminal).toHaveBeenCalledTimes(1);
    expect(agent.getSession(sessionId)?.pendingToolCalls.size).toBe(0);
  });

  test("keeps local-fallback bash raw output as plain Pi payloads when no ACP terminal is present", async () => {
    const connection = createMockConnection();
    const mockSession = createMockSession();
    let onEvent: ((event: any) => void) | undefined;

    mockSession.subscribe = vi.fn((callback: (event: any) => void) => {
      onEvent = callback;
      return () => {};
    });

    const partialResult = {
      content: [{ type: "text", text: "partial output" }],
      details: undefined,
    };
    const finalResult = {
      content: [{ type: "text", text: "final output" }],
      details: undefined,
    };

    mockSession.prompt = vi.fn(async () => {
      onEvent?.({
        type: "tool_execution_start",
        toolCallId: "tool-bash-local",
        toolName: "bash",
        args: { command: "echo hi" },
      });

      onEvent?.({
        type: "tool_execution_update",
        toolCallId: "tool-bash-local",
        toolName: "bash",
        partialResult,
      });

      onEvent?.({
        type: "tool_execution_end",
        toolCallId: "tool-bash-local",
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
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      },
    });

    const { sessionId } = await agent.newSession({ cwd: "/tmp/project" } as any);

    await agent.prompt({
      sessionId,
      prompt: [{ type: "text", text: "Run a local fallback command" }],
    } as any);

    const updates = connection.sessionUpdate.mock.calls.map(
      ([notification]: [any]) => notification.update,
    );

    const inProgress = updates.find(
      (update: any) =>
        update.sessionUpdate === "tool_call_update" &&
        update.toolCallId === "tool-bash-local" &&
        update.status === "in_progress",
    );
    const completed = updates.find(
      (update: any) =>
        update.sessionUpdate === "tool_call_update" &&
        update.toolCallId === "tool-bash-local" &&
        update.status === "completed",
    );

    expect(inProgress.rawOutput).toEqual(partialResult);
    expect(completed.rawOutput).toEqual(finalResult);
    expect(completed.rawOutput).not.toHaveProperty("piPartialResult");
    expect(completed.rawOutput).not.toHaveProperty("piResult");
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
