import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

describe("ACP runtime read fallback", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    createAgentSessionMock.mockReset();
  });

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  test("uses ACP for cwd reads and local fs for additionalDirectories reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-acp-runtime-read-"));
    tempDirs.push(root);

    const cwd = join(root, "project");
    const shared = join(root, "shared");
    await mkdir(cwd, { recursive: true });
    await mkdir(shared, { recursive: true });

    const cwdFile = join(cwd, "inside.txt");
    const sharedFile = join(shared, "outside.txt");
    await writeFile(cwdFile, "inside-local", "utf-8");
    await writeFile(sharedFile, "outside-local", "utf-8");

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
      cwd,
      additionalDirectories: [shared],
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
    });

    const readTool = capturedSessionOptions.customTools.find((tool: any) => tool.name === "read");

    const cwdResult = await readTool.execute(
      "tool-cwd",
      { path: cwdFile },
      undefined,
      undefined,
      undefined,
    );
    const sharedResult = await readTool.execute(
      "tool-shared",
      { path: sharedFile },
      undefined,
      undefined,
      undefined,
    );

    expect(cwdResult.content[0].text).toBe(`acp:${cwdFile}`);
    expect(sharedResult.content[0].text).toBe("outside-local");
    expect(connection.readTextFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: cwdFile, sessionId: "session-1" }),
    );
    expect(connection.readTextFile).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: sharedFile }),
    );
  });
});
