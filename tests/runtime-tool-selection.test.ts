import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

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
    readTextFile: vi.fn(async ({ path }: { path: string }) => ({ content: `acp:${path}` })),
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

describe("ACP runtime tool selection", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    createAgentSessionMock.mockReset();
  });

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  test("full ACP clients get ACP-native backends", async () => {
    let capturedSessionOptions: any;
    createAgentSessionMock.mockImplementation(async (sessionOptions: any) => {
      capturedSessionOptions = sessionOptions;
      return {
        session: { dispose: vi.fn() },
      };
    });

    await createAcpAgentRuntime({
      cwd: "/workspace/project",
      modelRegistry: { getAvailable: () => [] } as any,
      acpConnection: createMockConnection(),
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
    });

    const toolsByName = Object.fromEntries(
      capturedSessionOptions.customTools.map((tool: any) => [tool.name, tool]),
    );

    expect(toolsByName.read.acpBackend).toBe("hybrid");
    expect(toolsByName.write.acpBackend).toBe("acp");
    expect(toolsByName.edit.acpBackend).toBe("acp");
    expect(toolsByName.bash.acpBackend).toBe("acp");
  });

  test("missing read capability selects local read and local edit", async () => {
    let capturedSessionOptions: any;
    createAgentSessionMock.mockImplementation(async (sessionOptions: any) => {
      capturedSessionOptions = sessionOptions;
      return {
        session: { dispose: vi.fn() },
      };
    });

    await createAcpAgentRuntime({
      cwd: "/workspace/project",
      modelRegistry: { getAvailable: () => [] } as any,
      acpConnection: createMockConnection(),
      clientCapabilities: {
        raw: null,
        clientInfo: null,
        supportsReadTextFile: false,
        supportsWriteTextFile: true,
        supportsTerminal: true,
        supportsTerminalAuth: false,
      },
      sessionManager: {} as any,
      sessionId: "session-1",
    });

    const toolsByName = Object.fromEntries(
      capturedSessionOptions.customTools.map((tool: any) => [tool.name, tool]),
    );

    expect(toolsByName.read.acpBackend).toBe("local");
    expect(toolsByName.write.acpBackend).toBe("acp");
    expect(toolsByName.edit.acpBackend).toBe("local");
    expect(toolsByName.bash.acpBackend).toBe("acp");
  });

  test("missing write capability selects local write and local edit", async () => {
    let capturedSessionOptions: any;
    createAgentSessionMock.mockImplementation(async (sessionOptions: any) => {
      capturedSessionOptions = sessionOptions;
      return {
        session: { dispose: vi.fn() },
      };
    });

    await createAcpAgentRuntime({
      cwd: "/workspace/project",
      modelRegistry: { getAvailable: () => [] } as any,
      acpConnection: createMockConnection(),
      clientCapabilities: {
        raw: null,
        clientInfo: null,
        supportsReadTextFile: true,
        supportsWriteTextFile: false,
        supportsTerminal: true,
        supportsTerminalAuth: false,
      },
      sessionManager: {} as any,
      sessionId: "session-1",
    });

    const toolsByName = Object.fromEntries(
      capturedSessionOptions.customTools.map((tool: any) => [tool.name, tool]),
    );

    expect(toolsByName.read.acpBackend).toBe("hybrid");
    expect(toolsByName.write.acpBackend).toBe("local");
    expect(toolsByName.edit.acpBackend).toBe("local");
    expect(toolsByName.bash.acpBackend).toBe("acp");
  });

  test("no ACP fs support still creates a runtime and uses local Pi file tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-acp-runtime-tools-"));
    tempDirs.push(root);

    const cwd = join(root, "project");
    await mkdir(cwd, { recursive: true });
    const filePath = join(cwd, "file.txt");
    await writeFile(filePath, "local-before", "utf-8");

    let capturedSessionOptions: any;
    createAgentSessionMock.mockImplementation(async (sessionOptions: any) => {
      capturedSessionOptions = sessionOptions;
      return {
        session: { dispose: vi.fn() },
      };
    });

    const connection = createMockConnection();

    await createAcpAgentRuntime({
      cwd,
      modelRegistry: { getAvailable: () => [] } as any,
      acpConnection: connection,
      clientCapabilities: {
        raw: null,
        clientInfo: null,
        supportsReadTextFile: false,
        supportsWriteTextFile: false,
        supportsTerminal: false,
        supportsTerminalAuth: false,
      },
      sessionManager: {} as any,
      sessionId: "session-1",
    });

    const toolsByName = Object.fromEntries(
      capturedSessionOptions.customTools.map((tool: any) => [tool.name, tool]),
    );

    expect(toolsByName.read.acpBackend).toBe("local");
    expect(toolsByName.write.acpBackend).toBe("local");
    expect(toolsByName.edit.acpBackend).toBe("local");
    expect(toolsByName.bash.acpBackend).toBe("local");

    const readResult = await toolsByName.read.execute(
      "tool-read",
      { path: filePath },
      undefined,
      undefined,
      undefined,
    );
    await toolsByName.write.execute(
      "tool-write",
      { path: filePath, content: "local-after" },
      undefined,
      undefined,
      undefined,
    );

    expect(readResult.content[0].text).toContain("local-before");
    expect(await readFile(filePath, "utf-8")).toBe("local-after");
    expect(connection.readTextFile).not.toHaveBeenCalled();
    expect(connection.writeTextFile).not.toHaveBeenCalled();
  });
});
