import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

const createAgentSessionMock = vi.hoisted(() => vi.fn());

vi.mock("@mariozechner/pi-coding-agent", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@mariozechner/pi-coding-agent");
  return {
    ...actual,
    createAgentSession: createAgentSessionMock,
  };
});

import { mapToolExecutionUpdate } from "../src/adapter/AcpEventMapper.ts";
import { createAcpAgentRuntime } from "../src/runtime/AcpAgentRuntime.ts";

function createMockConnection() {
  return {
    readTextFile: vi.fn(async () => ({ content: "before" })),
    writeTextFile: vi.fn(async () => undefined),
    createTerminal: vi.fn(async () => ({
      id: "term-1",
      currentOutput: vi.fn(async () => ({
        output: "",
        truncated: false,
        exitStatus: { exitCode: 0, signal: null },
      })),
      waitForExit: vi.fn(async () => ({ exitCode: 0, signal: null })),
      release: vi.fn(async () => undefined),
      kill: vi.fn(async () => undefined),
    })),
  } as any;
}

describe("ACP runtime edit progress", () => {
  beforeEach(() => {
    createAgentSessionMock.mockReset();
  });

  test("emits an edit tool update before completion", async () => {
    let capturedSessionOptions: any;

    createAgentSessionMock.mockImplementation(async (sessionOptions: any) => {
      capturedSessionOptions = sessionOptions;
      return {
        session: {
          dispose: vi.fn(),
        },
      };
    });

    const connection = createMockConnection();
    const capturedState = vi.fn();

    await createAcpAgentRuntime({
      cwd: "/workspace/project",
      additionalDirectories: ["/workspace/shared"],
      modelRegistry: { getAvailable: () => [] } as any,
      acpConnection: connection,
      clientCapabilities: {
        raw: null,
        clientInfo: null,
        supportsReadTextFile: true,
        supportsWriteTextFile: true,
        supportsTerminal: true,
        supportsTerminalAuth: false,
      },
      sessionManager: {} as any,
      sessionId: "session-1",
      onToolCallStateCaptured: capturedState,
    });

    const editTool = capturedSessionOptions.customTools.find((tool: any) => tool.name === "edit");
    const onUpdate = vi.fn();

    const result = await editTool.execute(
      "tool-1",
      {
        path: "src/file.ts",
        edits: [{ oldText: "before", newText: "after" }],
      },
      undefined,
      onUpdate,
      undefined,
    );

    expect(result.content[0].text).toMatch(/Successfully replaced 1 block/i);
    expect(onUpdate.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(capturedState).toHaveBeenCalledWith(
      "tool-1",
      expect.objectContaining({
        toolName: "edit",
        diff: {
          path: "/workspace/project/src/file.ts",
          oldText: "before",
          newText: "after",
        },
      }),
    );
  });

  test("maps edit progress updates to in_progress diff content", () => {
    const notification = mapToolExecutionUpdate(
      "session-1",
      {
        toolCallId: "tool-1",
        toolName: "edit",
        partialResult: { content: [], details: undefined },
      },
      {
        toolCallState: {
          toolName: "edit",
          diff: {
            path: "/workspace/project/src/file.ts",
            oldText: "before",
            newText: "after",
          },
        },
      },
    );

    expect((notification.update as any).status).toBe("in_progress");
    expect((notification.update as any).content).toEqual([
      {
        type: "diff",
        path: "/workspace/project/src/file.ts",
        oldText: "before",
        newText: "after",
        _meta: { kind: "edit" },
      },
    ]);
  });
});
