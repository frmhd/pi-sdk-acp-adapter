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

function createTestAgent(
  createRuntime:
    | ((options: any) => Promise<{ session: any; dispose: () => void }>)
    | undefined = undefined,
) {
  return new AcpAgent(
    {} as any,
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

  test("mapToolKind maps bash to execute", () => {
    expect(mapToolKind("bash")).toBe("execute");
  });

  test("mapToolKind keeps non-Pi bridge tools out of the public surface", () => {
    expect(mapToolKind("grep")).toBe("other");
    expect(mapToolKind("find")).toBe("other");
    expect(mapToolKind("ls")).toBe("other");
  });

  test("mapToolKind maps write to other", () => {
    expect(mapToolKind("write")).toBe("other");
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
    expect(response.agentCapabilities?.loadSession).toBe(false);
    expect(response.agentCapabilities?.sessionCapabilities?.list).toBeNull();
    expect(response.agentCapabilities?.sessionCapabilities?.resume).toBeNull();
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
    const agent = createTestAgent(createRuntime);

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

  test("loadSession rejects until real persistence exists", async () => {
    const agent = createTestAgent();

    await expect(agent.loadSession({ sessionId: "session-1" } as any)).rejects.toThrow(
      /loadSession is not supported yet/i,
    );
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
  test("maps tool execution start to tool_call notification", () => {
    const notification = mapToolExecutionStart("session-123", {
      toolCallId: "tool-1",
      toolName: "read",
      args: { path: "/test/file.ts" },
    });

    expect(notification.sessionId).toBe("session-123");
    expect(notification.update.sessionUpdate).toBe("tool_call");
    expect((notification.update as any).toolCallId).toBe("tool-1");
    expect((notification.update as any).title).toBe("Reading: /test/file.ts");
    expect((notification.update as any).locations).toEqual([{ path: "/test/file.ts" }]);
    expect((notification.update as any).kind).toBe("read");
    expect((notification.update as any).status).toBe("pending");
  });

  test("maps bash tool to execute kind", () => {
    const notification = mapToolExecutionStart("session-123", {
      toolCallId: "tool-2",
      toolName: "bash",
      args: { command: "ls -la" },
    });

    expect((notification.update as any).title).toBe("Running: ls -la");
    expect((notification.update as any).kind).toBe("execute");
  });
});

describe("Tool Execution Update Mapping", () => {
  test("maps string partial result to text content", () => {
    const notification = mapToolExecutionUpdate("session-123", {
      toolCallId: "tool-1",
      partialResult: "Partial output...",
    });

    expect(notification.sessionId).toBe("session-123");
    expect(notification.update.sessionUpdate).toBe("tool_call_update");
    expect((notification.update as any).toolCallId).toBe("tool-1");
    expect((notification.update as any).status).toBe("in_progress");
  });

  test("maps object partial result with stdout", () => {
    const notification = mapToolExecutionUpdate("session-123", {
      toolCallId: "tool-1",
      partialResult: { stdout: "Command output" },
    });

    expect(notification.update).toBeDefined();
  });

  test("returns undefined content when no text", () => {
    const notification = mapToolExecutionUpdate("session-123", {
      toolCallId: "tool-1",
      partialResult: null,
    });

    expect(notification).toBeDefined();
  });
});

describe("Tool Execution End Mapping", () => {
  test("maps successful result to completed status", () => {
    const notification = mapToolExecutionEnd("session-123", {
      toolCallId: "tool-1",
      result: { stdout: "Success output" },
      isError: false,
    });

    expect(notification.sessionId).toBe("session-123");
    expect(notification.update.sessionUpdate).toBe("tool_call_update");
    expect((notification.update as any).toolCallId).toBe("tool-1");
    expect((notification.update as any).status).toBe("completed");
  });

  test("maps error result to failed status", () => {
    const notification = mapToolExecutionEnd("session-123", {
      toolCallId: "tool-1",
      result: "File not found",
      isError: true,
    });

    expect((notification.update as any).status).toBe("failed");
  });

  test("creates error message when isError and no content", () => {
    const notification = mapToolExecutionEnd("session-123", {
      toolCallId: "tool-1",
      result: { message: "Permission denied" },
      isError: true,
    });

    expect(notification.update).toBeDefined();
  });

  test("maps bash result with stdout", () => {
    const notification = mapToolExecutionEnd("session-123", {
      toolCallId: "tool-1",
      result: { stdout: "ls output", exitCode: 0 },
      isError: false,
    });

    expect(notification.update).toBeDefined();
  });
});
