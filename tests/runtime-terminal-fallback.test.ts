import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

const createAgentSessionMock = vi.hoisted(() => vi.fn());

vi.mock("@mariozechner/pi-coding-agent", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@mariozechner/pi-coding-agent");
  return {
    ...actual,
    createAgentSession: createAgentSessionMock,
  };
});

import { createAcpAgentRuntime } from "../src/runtime/AcpAgentRuntime.ts";

function createMockConnection() {
  return {
    readTextFile: vi.fn(async () => ({ content: "" })),
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

describe("ACP runtime terminal fallback", () => {
  beforeEach(() => {
    createAgentSessionMock.mockReset();
  });

  test("creates a runtime without terminal support and executes bash locally", async () => {
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

    await createAcpAgentRuntime({
      cwd: process.cwd(),
      modelRegistry: { getAvailable: () => [] } as any,
      acpConnection: connection,
      clientCapabilities: {
        raw: null,
        clientInfo: null,
        supportsReadTextFile: true,
        supportsWriteTextFile: true,
        supportsTerminal: false,
        supportsTerminalAuth: false,
      },
      sessionManager: {} as any,
      sessionId: "session-1",
    });

    const bashTool = capturedSessionOptions.customTools.find((tool: any) => tool.name === "bash");
    const onUpdate = vi.fn();

    const result = await bashTool.execute(
      "tool-bash",
      { command: "printf 'terminal-fallback-ok\\n'" },
      undefined,
      onUpdate,
      undefined,
    );

    expect(result.content[0].text).toContain("terminal-fallback-ok");
    expect(onUpdate).toHaveBeenCalled();
    expect(connection.createTerminal).not.toHaveBeenCalled();
  });
});
