import { describe, expect, test, vi } from "vite-plus/test";

import {
  createTestAgent,
  createMockConnection,
  createMockSession,
  getPackageVersion,
} from "../helpers/testDoubles.ts";

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

  test("allows initialization when ACP filesystem capabilities are missing", async () => {
    const agent = createTestAgent();

    await expect(
      agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: false },
          terminal: false,
        },
      }),
    ).resolves.toMatchObject({
      protocolVersion: 1,
    });

    expect(agent.getClientCapabilities()).toMatchObject({
      supportsReadTextFile: true,
      supportsWriteTextFile: false,
      supportsTerminal: false,
    });
  });

  test("allows initialization without terminal support", async () => {
    const agent = createTestAgent();

    await expect(
      agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: false,
        },
      }),
    ).resolves.toMatchObject({
      protocolVersion: 1,
    });

    expect(agent.getClientCapabilities()).toMatchObject({
      supportsReadTextFile: true,
      supportsWriteTextFile: true,
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

  test("creates sessions even when ACP fs capabilities are missing", async () => {
    const createRuntime = vi.fn(async (_options: any) => ({
      session: createMockSession(),
      dispose: vi.fn(),
    }));
    const agent = createTestAgent(createMockConnection(), createRuntime);

    await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    });

    await expect(agent.newSession({ cwd: "/tmp/project" } as any)).resolves.toMatchObject({
      sessionId: expect.any(String),
    });
    expect(createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        clientCapabilities: expect.objectContaining({
          supportsReadTextFile: false,
          supportsWriteTextFile: false,
          supportsTerminal: false,
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
