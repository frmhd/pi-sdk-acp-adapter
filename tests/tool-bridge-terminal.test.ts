import { describe, expect, test, vi } from "vite-plus/test";

import { AcpTerminalOperations } from "../src/adapter/AcpToolBridge.ts";

describe("ACP terminal-backed bash execution", () => {
  test("passes the raw shell command through to the ACP client", async () => {
    const terminal = {
      id: "term-1",
      currentOutput: vi.fn(async () => ({
        output: "done\n",
        truncated: false,
        exitStatus: { exitCode: 0, signal: null },
      })),
      waitForExit: vi.fn(async () => ({ exitCode: 0, signal: null })),
      release: vi.fn(async () => undefined),
      kill: vi.fn(async () => undefined),
    };

    const client = {
      sessionId: "session-1",
      capabilities: {
        raw: null,
        supportsReadTextFile: true,
        supportsWriteTextFile: true,
        supportsTerminal: true,
      },
      createTerminal: vi.fn(async () => terminal),
    } as any;

    const ops = new AcpTerminalOperations(client);
    const chunks: string[] = [];

    const result = await ops.exec("sleep 5 & ls", "/workspace/project", {
      onData: (data) => chunks.push(data.toString("utf-8")),
    });

    expect(result).toEqual({ exitCode: 0 });
    expect(client.createTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "sleep 5 & ls",
        args: [],
        cwd: "/workspace/project",
        sessionId: "session-1",
      }),
    );
    expect(chunks).toEqual(["done\n"]);
    expect(terminal.release).toHaveBeenCalledTimes(1);
  });

  test("does not treat ACP exitStatus: null as process completion", async () => {
    let outputCalls = 0;
    const terminal = {
      id: "term-1",
      currentOutput: vi.fn(async () => {
        outputCalls += 1;
        if (outputCalls === 1) {
          return {
            output: "\n\n\n\n\n",
            truncated: false,
            exitStatus: null,
          };
        }

        return {
          output: "src\nREADME.md\n",
          truncated: false,
          exitStatus: { exitCode: 0, signal: null },
        };
      }),
      waitForExit: vi.fn(async () => ({ exitCode: 0, signal: null })),
      release: vi.fn(async () => undefined),
      kill: vi.fn(async () => undefined),
    };

    const client = {
      sessionId: "session-1",
      capabilities: {
        raw: null,
        supportsReadTextFile: true,
        supportsWriteTextFile: true,
        supportsTerminal: true,
      },
      createTerminal: vi.fn(async () => terminal),
    } as any;

    const ops = new AcpTerminalOperations(client);

    const result = await ops.exec("sleep 5 && ls", "/workspace/project", {
      onData: () => {},
    });

    // Should complete only when exitStatus is present (on second currentOutput call)
    expect(result).toEqual({ exitCode: 0 });
    expect(terminal.currentOutput).toHaveBeenCalledTimes(2);
    expect(terminal.release).toHaveBeenCalledTimes(1);
  });

  test("forwards final terminal output to Pi instead of stale intermediate snapshots", async () => {
    let outputCalls = 0;
    const terminal = {
      id: "term-1",
      currentOutput: vi.fn(async () => {
        outputCalls += 1;
        if (outputCalls < 3) {
          return {
            output: "\n\n\n",
            truncated: false,
            exitStatus: null,
          };
        }

        return {
          output: "AGENTS.md\nREADME.md\nsrc\n",
          truncated: false,
          exitStatus: { exitCode: 0, signal: null },
        };
      }),
      waitForExit: vi.fn(async () => ({ exitCode: 0, signal: null })),
      release: vi.fn(async () => undefined),
      kill: vi.fn(async () => undefined),
    };

    const client = {
      sessionId: "session-1",
      capabilities: {
        raw: null,
        supportsReadTextFile: true,
        supportsWriteTextFile: true,
        supportsTerminal: true,
      },
      createTerminal: vi.fn(async () => terminal),
    } as any;

    const ops = new AcpTerminalOperations(client);
    const chunks: string[] = [];

    const result = await ops.exec("sleep 5 && ls", "/workspace/project", {
      onData: (data) => chunks.push(data.toString("utf-8")),
    });

    // Should only forward final output (from third call when exitStatus is present)
    // not the intermediate "\n\n\n" snapshots
    expect(result).toEqual({ exitCode: 0 });
    expect(chunks).toEqual(["AGENTS.md\nREADME.md\nsrc\n"]);
    expect(terminal.currentOutput).toHaveBeenCalledTimes(3);
  });
});
