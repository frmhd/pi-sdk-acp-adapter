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
    let resolveExit!: (value: { exitCode: number | null; signal: string | null }) => void;
    const waitForExit = new Promise<{ exitCode: number | null; signal: string | null }>(
      (resolve) => {
        resolveExit = resolve;
      },
    );

    let outputCalls = 0;
    const terminal = {
      id: "term-1",
      currentOutput: vi.fn(async () => {
        outputCalls += 1;
        return {
          output: outputCalls === 1 ? "\n\n\n\n\n" : "src\nREADME.md\n",
          truncated: false,
          exitStatus: null,
        };
      }),
      waitForExit: vi.fn(async () => waitForExit),
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
    let settled = false;

    const resultPromise = ops.exec("sleep 5 && ls", "/workspace/project", {
      onData: () => {},
    });
    void resultPromise.then(() => {
      settled = true;
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(terminal.release).not.toHaveBeenCalled();

    resolveExit({ exitCode: 0, signal: null });

    await expect(resultPromise).resolves.toEqual({ exitCode: 0 });
    expect(terminal.waitForExit).toHaveBeenCalledTimes(1);
    expect(terminal.release).toHaveBeenCalledTimes(1);
  });
});
