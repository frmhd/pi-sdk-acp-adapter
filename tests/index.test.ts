/**
 * Core adapter tests.
 */

import { readFile } from "node:fs/promises";

import { expect, test, describe, vi } from "vite-plus/test";

import {
  AcpAgent,
  mapToolKind,
  mapStopReason,
  createToolCallContent,
  mapToolExecutionStart,
  mapToolExecutionUpdate,
  mapToolExecutionEnd,
} from "../src/index.ts";

function createMockSession() {
  return {
    sessionId: undefined,
    sessionName: undefined,
    sessionManager: {
      getSessionName: vi.fn(() => undefined),
      getEntries: vi.fn(() => []),
      getHeader: vi.fn(() => ({ timestamp: new Date(0).toISOString() })),
    },
    state: {
      messages: [],
      model: undefined,
    },
    thinkingLevel: "medium",
    dispose: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    prompt: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
  } as any;
}

function createMockConnection() {
  return {
    sessionUpdate: vi.fn(async () => undefined),
    readTextFile: vi.fn(async () => ({ content: "" })),
  } as any;
}

function createTestAgent(
  connection: any = createMockConnection(),
  createRuntime:
    | ((options: any) => Promise<{ session: any; dispose: () => void }>)
    | undefined = undefined,
) {
  return new AcpAgent(
    connection,
    {
      modelRegistry: {
        getAvailable: () => [],
      } as any,
    },
    createRuntime ??
      (async () => ({
        session: createMockSession(),
        dispose: vi.fn(),
      })),
  );
}

async function getPackageVersion(): Promise<string> {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf-8"),
  ) as {
    version: string;
  };

  return packageJson.version;
}

describe("Type Definitions", () => {
  test("mapToolKind maps read to read", () => {
    expect(mapToolKind("read")).toBe("read");
  });

  test("mapToolKind maps edit to edit", () => {
    expect(mapToolKind("edit")).toBe("edit");
  });

  test("mapToolKind maps write to edit for Zed diff rendering", () => {
    expect(mapToolKind("write")).toBe("edit");
  });

  test("mapToolKind maps bash to execute", () => {
    expect(mapToolKind("bash")).toBe("execute");
  });

  test("mapToolKind keeps non-Pi bridge tools out of the public surface", () => {
    expect(mapToolKind("grep")).toBe("other");
    expect(mapToolKind("find")).toBe("other");
    expect(mapToolKind("ls")).toBe("other");
  });

  test("mapToolKind maps unknown to other", () => {
    expect(mapToolKind("unknown_tool")).toBe("other");
  });
});

describe("AcpAgent initialize", () => {
  test("returns Pi identity, package version, and honest capabilities", async () => {
    const agent = createTestAgent();

    const response = await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    });

    expect(response.protocolVersion).toBe(1);
    expect(response.agentInfo).toEqual({
      name: "pi",
      title: "Pi Coding Agent",
      version: await getPackageVersion(),
    });
    expect(response.agentCapabilities?.loadSession).toBe(true);
    expect(response.agentCapabilities?.sessionCapabilities?.list).toEqual({});
    expect(response.agentCapabilities?.sessionCapabilities?.resume).toEqual({});
    expect(response.agentCapabilities?.sessionCapabilities?.close).toEqual({});
    expect(agent.getClientCapabilities()).toMatchObject({
      supportsReadTextFile: true,
      supportsWriteTextFile: true,
      supportsTerminal: true,
    });
  });

  test("fails early when required client capabilities are missing", async () => {
    const agent = createTestAgent();

    await expect(
      agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: false },
          terminal: false,
        },
      }),
    ).rejects.toThrow(/requires ACP client capabilities: fs.writeTextFile, terminal/i);

    expect(agent.getClientCapabilities()).toMatchObject({
      supportsReadTextFile: true,
      supportsWriteTextFile: false,
      supportsTerminal: false,
    });
  });

  test("passes captured client capabilities through to runtime creation", async () => {
    const createRuntime = vi.fn(async (_options: any) => ({
      session: createMockSession(),
      dispose: vi.fn(),
    }));
    const agent = createTestAgent(createMockConnection(), createRuntime);

    await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    });

    await agent.newSession({
      cwd: "/tmp/project",
    } as any);

    expect(createRuntime).toHaveBeenCalledTimes(1);
    expect(createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        clientCapabilities: expect.objectContaining({
          supportsReadTextFile: true,
          supportsWriteTextFile: true,
          supportsTerminal: true,
        }),
      }),
    );
  });

  test("session lifecycle methods still require initialize before use", async () => {
    const agent = createTestAgent();

    await expect(
      agent.loadSession({ sessionId: "session-1", cwd: "/tmp/project", mcpServers: [] } as any),
    ).rejects.toThrow(/initialize\(\) must complete/i);
  });
});

describe("Stop Reason Mapping", () => {
  test("maps stop to end_turn", () => {
    expect(mapStopReason("stop")).toBe("end_turn");
  });

  test("maps length to max_tokens", () => {
    expect(mapStopReason("length")).toBe("max_tokens");
  });

  test("maps tool_calls to end_turn", () => {
    expect(mapStopReason("tool_calls")).toBe("end_turn");
  });

  test("maps error to end_turn", () => {
    expect(mapStopReason("error")).toBe("end_turn");
  });

  test("maps aborted to cancelled", () => {
    expect(mapStopReason("aborted")).toBe("cancelled");
  });

  test("maps refusal to refusal", () => {
    expect(mapStopReason("refusal")).toBe("refusal");
  });

  test("maps undefined to end_turn", () => {
    expect(mapStopReason(undefined)).toBe("end_turn");
  });

  test("maps unknown to end_turn", () => {
    expect(mapStopReason("unknown")).toBe("end_turn");
  });
});

describe("createToolCallContent", () => {
  test("creates content with text", () => {
    const content = createToolCallContent("Hello, world!");
    expect(content).toBeDefined();
    expect(content.type).toBe("content");
  });
});

describe("Tool Execution Start Mapping", () => {
  test("maps read to a file-targeting tool call with title, location, and _meta", () => {
    const notification = mapToolExecutionStart(
      "session-123",
      {
        toolCallId: "tool-1",
        toolName: "read",
        args: { path: "/test/file.ts" },
      },
      { cwd: "/workspace" },
    );

    expect(notification.sessionId).toBe("session-123");
    expect(notification.update.sessionUpdate).toBe("tool_call");
    expect((notification.update as any).toolCallId).toBe("tool-1");
    expect((notification.update as any).title).toBe("Read /test/file.ts");
    expect((notification.update as any).locations).toEqual([{ path: "/test/file.ts" }]);
    expect((notification.update as any).kind).toBe("read");
    expect((notification.update as any).status).toBe("pending");
    expect((notification.update as any)._meta).toEqual({ tool_name: "read" });
  });

  test("maps bash tool to execute kind with clean run title", () => {
    const notification = mapToolExecutionStart("session-123", {
      toolCallId: "tool-2",
      toolName: "bash",
      args: { command: "ls -la" },
    });

    expect((notification.update as any).title).toBe("Run: ls -la");
    expect((notification.update as any).kind).toBe("execute");
  });

  test("maps write to edit kind and preserves an absolute file location", () => {
    const notification = mapToolExecutionStart(
      "session-123",
      {
        toolCallId: "tool-3",
        toolName: "write",
        args: { path: "src/new.ts", content: "hello" },
      },
      { cwd: "/workspace/project" },
    );

    expect((notification.update as any).title).toBe("Write /workspace/project/src/new.ts");
    expect((notification.update as any).kind).toBe("edit");
    expect((notification.update as any).locations).toEqual([
      { path: "/workspace/project/src/new.ts" },
    ]);
  });
});

describe("Tool Execution Update Mapping", () => {
  test("preserves structured partial Pi content and raw output", () => {
    const partialResult = {
      content: [{ type: "text", text: "Partial output..." }],
      details: { truncated: false },
    };

    const notification = mapToolExecutionUpdate("session-123", {
      toolCallId: "tool-1",
      toolName: "bash",
      partialResult,
    });

    expect(notification.sessionId).toBe("session-123");
    expect(notification.update.sessionUpdate).toBe("tool_call_update");
    expect((notification.update as any).toolCallId).toBe("tool-1");
    expect((notification.update as any).status).toBe("in_progress");
    expect((notification.update as any).content).toEqual([
      {
        type: "content",
        content: { type: "text", text: "Partial output..." },
      },
    ]);
    expect((notification.update as any).rawOutput).toEqual(partialResult);
  });

  test("maps terminal-backed bash updates to ACP terminal content", () => {
    const rawOutput = {
      type: "acp_terminal",
      terminalId: "term-123",
      input: { command: "echo hi", timeout: null },
      execution: {
        command: "echo hi",
        args: [],
        cwd: "/workspace/project",
        outputByteLimit: 51200,
      },
      output: "hi\n",
      truncated: false,
    };

    const notification = mapToolExecutionUpdate(
      "session-123",
      {
        toolCallId: "tool-1",
        toolName: "bash",
        partialResult: { content: [], details: undefined },
      },
      {
        toolCallState: {
          toolName: "bash",
          terminalId: "term-123",
          rawInput: { command: "echo hi" },
          rawOutput,
        },
      },
    );

    expect((notification.update as any).status).toBe("in_progress");
    expect((notification.update as any).title).toBe("Run: echo hi");
    expect((notification.update as any).content).toEqual([
      { type: "terminal", terminalId: "term-123" },
    ]);
    expect((notification.update as any).rawOutput).toEqual(rawOutput);
  });

  test("keeps notification shape when partial output has no visible content", () => {
    const notification = mapToolExecutionUpdate("session-123", {
      toolCallId: "tool-1",
      partialResult: null,
    });

    expect(notification).toBeDefined();
    expect((notification.update as any).status).toBe("in_progress");
  });
});

describe("Tool Execution End Mapping", () => {
  test("maps write completion to ACP diff content with create semantics", () => {
    const result = {
      content: [{ type: "text", text: "Successfully wrote 5 bytes to src/new.ts" }],
      details: undefined,
    };

    const notification = mapToolExecutionEnd(
      "session-123",
      {
        toolCallId: "tool-1",
        toolName: "write",
        result,
        isError: false,
      },
      {
        cwd: "/workspace/project",
        toolCallState: {
          toolName: "write",
          path: "/workspace/project/src/new.ts",
          diff: {
            path: "/workspace/project/src/new.ts",
            oldText: null,
            newText: "hello",
          },
          rawOutput: result,
        },
      },
    );

    expect(notification.sessionId).toBe("session-123");
    expect(notification.update.sessionUpdate).toBe("tool_call_update");
    expect((notification.update as any).toolCallId).toBe("tool-1");
    expect((notification.update as any).status).toBe("completed");
    expect((notification.update as any).kind).toBe("edit");
    expect((notification.update as any).title).toBe("Create /workspace/project/src/new.ts");
    expect((notification.update as any).locations).toEqual([
      { path: "/workspace/project/src/new.ts" },
    ]);
    expect((notification.update as any).content).toEqual([
      {
        type: "diff",
        path: "/workspace/project/src/new.ts",
        oldText: null,
        newText: "hello",
        _meta: { kind: "add" },
      },
    ]);
    expect((notification.update as any).rawOutput).toEqual(result);
  });

  test("adds firstChangedLine to edit locations", () => {
    const result = {
      content: [{ type: "text", text: "Successfully replaced 1 block(s) in src/file.ts." }],
      details: { firstChangedLine: 7 },
    };

    const notification = mapToolExecutionEnd(
      "session-123",
      {
        toolCallId: "tool-2",
        toolName: "edit",
        result,
        isError: false,
      },
      {
        cwd: "/workspace/project",
        toolCallState: {
          toolName: "edit",
          path: "/workspace/project/src/file.ts",
          diff: {
            path: "/workspace/project/src/file.ts",
            oldText: "before",
            newText: "after",
          },
          firstChangedLine: 7,
        },
      },
    );

    expect((notification.update as any).title).toBe("Edit /workspace/project/src/file.ts");
    expect((notification.update as any).locations).toEqual([
      { path: "/workspace/project/src/file.ts", line: 7 },
    ]);
  });

  test("preserves structured Pi read content instead of collapsing to plain text", () => {
    const result = {
      content: [
        { type: "text", text: "Read image file [image/png]" },
        { type: "image", data: "abc123", mimeType: "image/png" },
      ],
      details: { truncation: undefined },
    };

    const notification = mapToolExecutionEnd("session-123", {
      toolCallId: "tool-3",
      toolName: "read",
      result,
      isError: false,
    });

    expect((notification.update as any).content).toEqual([
      {
        type: "content",
        content: { type: "text", text: "Read image file [image/png]" },
      },
      {
        type: "content",
        content: { type: "image", data: "abc123", mimeType: "image/png" },
      },
    ]);
    expect((notification.update as any).rawOutput).toEqual(result);
  });

  test("preserves resource links and embedded resources returned by tool results", () => {
    const result = {
      content: [
        {
          type: "resource_link",
          name: "Screenshot",
          uri: "file:///tmp/screenshot.png",
          mimeType: "image/png",
        },
        {
          type: "resource",
          resource: {
            uri: "file:///tmp/notes.txt",
            text: "hello from a resource",
            mimeType: "text/plain",
          },
        },
      ],
    };

    const notification = mapToolExecutionEnd("session-123", {
      toolCallId: "tool-3b",
      toolName: "read",
      result,
      isError: false,
    });

    expect((notification.update as any).content).toEqual([
      {
        type: "content",
        content: {
          type: "resource_link",
          name: "Screenshot",
          uri: "file:///tmp/screenshot.png",
          mimeType: "image/png",
        },
      },
      {
        type: "content",
        content: {
          type: "resource",
          resource: {
            uri: "file:///tmp/notes.txt",
            text: "hello from a resource",
            mimeType: "text/plain",
          },
        },
      },
    ]);
    expect((notification.update as any).rawOutput).toEqual(result);
  });

  test("keeps bash completion terminal-backed and preserves raw terminal metadata", () => {
    const rawOutput = {
      type: "acp_terminal",
      terminalId: "term-123",
      input: { command: "echo hi", timeout: null },
      execution: {
        command: "echo hi",
        args: [],
        cwd: "/workspace/project",
        outputByteLimit: 51200,
      },
      output: "hi\n",
      truncated: false,
      exitCode: 0,
      signal: null,
    };

    const notification = mapToolExecutionEnd(
      "session-123",
      {
        toolCallId: "tool-4",
        toolName: "bash",
        result: { content: [{ type: "text", text: "hi" }] },
        isError: false,
      },
      {
        toolCallState: {
          toolName: "bash",
          terminalId: "term-123",
          rawInput: { command: "echo hi" },
          rawOutput,
        },
      },
    );

    expect((notification.update as any).status).toBe("completed");
    expect((notification.update as any).kind).toBe("execute");
    expect((notification.update as any).title).toBe("Run: echo hi");
    expect((notification.update as any).content).toEqual([
      { type: "terminal", terminalId: "term-123" },
    ]);
    expect((notification.update as any).rawOutput).toEqual(rawOutput);
  });

  test("maps error result to failed status", () => {
    const notification = mapToolExecutionEnd("session-123", {
      toolCallId: "tool-5",
      result: "File not found",
      isError: true,
    });

    expect((notification.update as any).status).toBe("failed");
  });
});

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
