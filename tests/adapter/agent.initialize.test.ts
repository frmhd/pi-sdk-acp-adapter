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
    expect(response.agentCapabilities?.sessionCapabilities?.additionalDirectories).toEqual({});
    // Filesystem/terminal execution capabilities are no longer surfaced; only
    // terminal auth and client identity remain.
    expect(agent.getClientCapabilities()).toEqual({
      raw: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo: null,
      supportsTerminalAuth: false,
    });
  });

  test("retains clientInfo and terminal auth opt-in from initialize", async () => {
    const agent = createTestAgent();

    await agent.initialize({
      protocolVersion: 1,
      clientInfo: { name: "zed", title: "Zed", version: "1.0" },
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
        auth: { terminal: true },
      },
    });

    expect(agent.getClientCapabilities()).toMatchObject({
      clientInfo: { name: "zed", title: "Zed", version: "1.0" },
      supportsTerminalAuth: true,
    });
  });

  test("does not pass filesystem/terminal execution surface into runtime creation", async () => {
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
        cwd: "/tmp/project",
        onToolCallStateCaptured: expect.any(Function),
      }),
    );
    expect(createRuntime.mock.calls[0][0]).not.toHaveProperty("acpConnection");
    expect(createRuntime.mock.calls[0][0]).not.toHaveProperty("clientCapabilities");
    expect(createRuntime.mock.calls[0][0]).not.toHaveProperty("sessionId");
  });

  test("creates sessions without any ACP client capability requirements", async () => {
    const createRuntime = vi.fn(async (_options: any) => ({
      session: createMockSession(),
      dispose: vi.fn(),
    }));
    const agent = createTestAgent(createMockConnection(), createRuntime);

    await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
    });

    await expect(agent.newSession({ cwd: "/tmp/project" } as any)).resolves.toMatchObject({
      sessionId: expect.any(String),
    });
    expect(createRuntime).toHaveBeenCalledTimes(1);
  });

  test("session lifecycle methods still require initialize before use", async () => {
    const agent = createTestAgent();

    await expect(
      agent.loadSession({ sessionId: "session-1", cwd: "/tmp/project", mcpServers: [] } as any),
    ).rejects.toThrow(/initialize\(\) must complete/i);
  });
});
