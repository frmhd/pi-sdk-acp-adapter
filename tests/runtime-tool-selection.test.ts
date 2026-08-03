import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

const createAgentSessionMock = vi.hoisted(() => vi.fn());

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@earendil-works/pi-coding-agent");
  return {
    ...actual,
    createAgentSession: createAgentSessionMock,
  };
});

import { createAcpAgentRuntime } from "../src/runtime/AcpAgentRuntime.ts";

function createMockSession(overrides: Record<string, unknown> = {}) {
  const extensionHooks = {
    beforeToolCall: vi.fn(async () => undefined),
    afterToolCall: vi.fn(async () => undefined),
  };

  return {
    agent: extensionHooks,
    getActiveToolNames: vi.fn(() => ["read", "bash", "edit", "write"]),
    dispose: vi.fn(),
    ...overrides,
  } as any;
}

describe("ACP runtime native Pi tools", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    createAgentSessionMock.mockReset();
  });

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  test("createAgentSession receives no adapter same-name customTools", async () => {
    let capturedSessionOptions: any;
    createAgentSessionMock.mockImplementation(async (sessionOptions: any) => {
      capturedSessionOptions = sessionOptions;
      return { session: createMockSession() };
    });

    await createAcpAgentRuntime({
      cwd: "/workspace/project",
      modelRuntime: { getAvailableSnapshot: () => [], getModel: () => undefined } as any,
      sessionManager: {} as any,
    });

    expect(capturedSessionOptions.customTools).toBeUndefined();
    expect(capturedSessionOptions.baseToolsOverride).toBeUndefined();
    expect(capturedSessionOptions.cwd).toBe("/workspace/project");
  });

  test("resulting active tools are Pi's native read/edit/write/bash tools", async () => {
    const session = createMockSession();
    createAgentSessionMock.mockImplementation(async () => ({ session }));

    const { session: runtimeSession } = await createAcpAgentRuntime({
      cwd: "/workspace/project",
      modelRuntime: { getAvailableSnapshot: () => [], getModel: () => undefined } as any,
      sessionManager: {} as any,
    });

    expect(runtimeSession.getActiveToolNames()).toEqual(["read", "bash", "edit", "write"]);
    expect(session.getActiveToolNames).toHaveBeenCalled();
  });

  test("no ACP filesystem/terminal client surface is passed into runtime creation", async () => {
    createAgentSessionMock.mockImplementation(async () => ({ session: createMockSession() }));

    await createAcpAgentRuntime({
      cwd: "/workspace/project",
      modelRuntime: { getAvailableSnapshot: () => [], getModel: () => undefined } as any,
      sessionManager: {} as any,
    });

    const sessionOptions = createAgentSessionMock.mock.calls[0]?.[0];
    expect(sessionOptions).not.toHaveProperty("acpConnection");
    expect(sessionOptions).not.toHaveProperty("clientCapabilities");
    expect(sessionOptions).not.toHaveProperty("additionalDirectories");
  });

  test("absolute edit/write paths outside cwd are tracked without adapter authorization", async () => {
    const capturedState = vi.fn();
    const session = createMockSession();
    const extensionBefore = session.agent.beforeToolCall;

    createAgentSessionMock.mockImplementation(async () => ({ session }));

    await createAcpAgentRuntime({
      cwd: "/workspace/project",
      modelRuntime: { getAvailableSnapshot: () => [], getModel: () => undefined } as any,
      sessionManager: {} as any,
      onToolCallStateCaptured: capturedState,
    });

    const wrappedBefore = session.agent.beforeToolCall;
    expect(wrappedBefore).not.toBe(extensionBefore);

    await wrappedBefore(
      {
        toolCall: { id: "tool-1", name: "edit", arguments: { path: "/elsewhere/file.ts" } },
        args: { path: "/elsewhere/file.ts", edits: [{ oldText: "a", newText: "b" }] },
      },
      undefined,
    );

    // The tracker chains Pi's extension hook and records the absolute path
    // without consulting any authorized-root list.
    expect(extensionBefore).toHaveBeenCalledTimes(1);
    expect(capturedState).toHaveBeenCalledWith(
      "tool-1",
      expect.objectContaining({
        toolName: "edit",
        path: "/elsewhere/file.ts",
        rawInput: expect.objectContaining({ path: "/elsewhere/file.ts" }),
      }),
    );
  });

  test("display tracker chains Pi extension hooks and restores them on dispose", async () => {
    const session = createMockSession();
    const beforeHook = session.agent.beforeToolCall;
    const afterHook = session.agent.afterToolCall;

    createAgentSessionMock.mockImplementation(async () => ({ session }));

    const { dispose } = await createAcpAgentRuntime({
      cwd: "/workspace/project",
      modelRuntime: { getAvailableSnapshot: () => [], getModel: () => undefined } as any,
      sessionManager: {} as any,
    });

    expect(session.agent.beforeToolCall).not.toBe(beforeHook);
    expect(session.agent.afterToolCall).not.toBe(afterHook);

    dispose();

    expect(session.agent.beforeToolCall).toBe(beforeHook);
    expect(session.agent.afterToolCall).toBe(afterHook);
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  test("display tracker reads real file content for diff display on native write", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-acp-native-tools-"));
    tempDirs.push(root);

    const cwd = join(root, "project");
    await mkdir(cwd, { recursive: true });
    const filePath = join(cwd, "file.txt");
    await writeFile(filePath, "before-content", "utf-8");

    const capturedState = vi.fn();
    const session = createMockSession();

    createAgentSessionMock.mockImplementation(async () => ({ session }));

    await createAcpAgentRuntime({
      cwd,
      modelRuntime: { getAvailableSnapshot: () => [], getModel: () => undefined } as any,
      sessionManager: {} as any,
      onToolCallStateCaptured: capturedState,
    });

    const wrappedBefore = session.agent.beforeToolCall;
    const wrappedAfter = session.agent.afterToolCall;

    await wrappedBefore(
      {
        toolCall: {
          id: "tool-write",
          name: "write",
          arguments: { path: "file.txt", content: "after-content" },
        },
        args: { path: "file.txt", content: "after-content" },
      },
      undefined,
    );

    expect(capturedState).toHaveBeenCalledWith(
      "tool-write",
      expect.objectContaining({
        toolName: "write",
        path: filePath,
      }),
    );

    // Simulate the native write completing by updating the file, then run the
    // after hook as the agent loop would after finalization.
    await writeFile(filePath, "after-content", "utf-8");
    await wrappedAfter(
      {
        toolCall: {
          id: "tool-write",
          name: "write",
          arguments: { path: "file.txt", content: "after-content" },
        },
        args: { path: "file.txt", content: "after-content" },
        result: { content: [{ type: "text", text: "wrote" }], details: {} },
        isError: false,
      },
      undefined,
    );

    expect(capturedState).toHaveBeenCalledWith(
      "tool-write",
      expect.objectContaining({
        diff: {
          path: filePath,
          oldText: "before-content",
          newText: "after-content",
        },
      }),
    );
  });

  test("native bash is not replaced and no terminal client calls are made", async () => {
    const capturedState = vi.fn();
    const session = createMockSession();

    createAgentSessionMock.mockImplementation(async () => ({ session }));

    await createAcpAgentRuntime({
      cwd: "/workspace/project",
      modelRuntime: { getAvailableSnapshot: () => [], getModel: () => undefined } as any,
      sessionManager: {} as any,
      onToolCallStateCaptured: capturedState,
    });

    // The adapter installs no custom bash tool and no bash operations; the
    // session's native tool registry is untouched by the runtime.
    const sessionOptions = createAgentSessionMock.mock.calls[0]?.[0];
    expect(sessionOptions.customTools).toBeUndefined();
    expect(sessionOptions.baseToolsOverride).toBeUndefined();

    // Bash calls are tracked for presentation only, with plain Pi payloads.
    const wrappedBefore = session.agent.beforeToolCall;
    await wrappedBefore(
      {
        toolCall: { id: "tool-bash", name: "bash", arguments: { command: "echo hi" } },
        args: { command: "echo hi" },
      },
      undefined,
    );

    expect(capturedState).toHaveBeenCalledWith(
      "tool-bash",
      expect.objectContaining({
        toolName: "bash",
        rawInput: { command: "echo hi" },
      }),
    );
    expect(capturedState.mock.calls[0][1]).not.toHaveProperty("terminalId");
    expect(capturedState.mock.calls[0][1]).not.toHaveProperty("releaseTerminal");
  });
});
