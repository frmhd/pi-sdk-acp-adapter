import { describe, expect, test, vi } from "vite-plus/test";

import { AcpAgent } from "../src/adapter/AcpAgent.ts";
import {
  ACP_TERMINAL_AUTH_FLAG,
  buildTerminalAuthMethodId,
  buildTerminalAuthMethods,
  getProviderIdFromTerminalAuthMethodId,
  parseTerminalAuthCliArgs,
} from "../src/auth/terminalAuth.ts";

function createMockConnection() {
  return {
    sessionUpdate: vi.fn(async () => undefined),
    readTextFile: vi.fn(async () => ({ content: "" })),
  } as any;
}

function createMockRuntime() {
  return async () => ({
    session: {
      state: { messages: [] },
      thinkingLevel: "medium",
      dispose: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      prompt: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    } as any,
    dispose: vi.fn(),
  });
}

function createMockModelRuntime(overrides: any = {}) {
  return {
    getProviders: () => [{ id: "anthropic", name: "Anthropic", auth: { oauth: {} } }],
    getAvailableSnapshot: () => [],
    refresh: vi.fn(async () => ({ aborted: false, errors: new Map() })),
    checkAuth: vi.fn(async () => undefined),
    ...overrides,
  } as any;
}

describe("terminal auth helpers", () => {
  test("parses terminal auth cli args from separate flag and provider", () => {
    expect(parseTerminalAuthCliArgs([ACP_TERMINAL_AUTH_FLAG, "anthropic"])).toEqual({
      isTerminalAuthInvocation: true,
      providerId: "anthropic",
    });
  });

  test("parses terminal auth cli args from equals form", () => {
    expect(parseTerminalAuthCliArgs([`${ACP_TERMINAL_AUTH_FLAG}=openai-codex`])).toEqual({
      isTerminalAuthInvocation: true,
      providerId: "openai-codex",
    });
  });

  test("round-trips terminal auth method ids", () => {
    const methodId = buildTerminalAuthMethodId("github-copilot");
    expect(methodId).toBe("terminal:github-copilot");
    expect(getProviderIdFromTerminalAuthMethodId(methodId)).toBe("github-copilot");
    expect(getProviderIdFromTerminalAuthMethodId("agent")).toBeUndefined();
  });

  test("builds ACP terminal auth methods from oauth providers with spec args and legacy zed meta", () => {
    const methods = buildTerminalAuthMethods(
      {
        getProviders: () => [
          { id: "openai-codex", name: "OpenAI Codex", auth: { oauth: {} } },
          { id: "anthropic", name: "Anthropic", auth: { oauth: {} } },
          { id: "api-key-only", name: "API Key Only", auth: { apiKey: {} } },
        ],
      } as any,
      {
        currentArgv: ["node", "/tmp/pi-acp/dist/cli.mjs", "--stdio"],
      },
    );

    expect(methods.map((method) => method.id)).toEqual([
      "terminal:anthropic",
      "terminal:openai-codex",
    ]);
    expect(methods[0]).toMatchObject({
      id: "terminal:anthropic",
      type: "terminal",
      args: [ACP_TERMINAL_AUTH_FLAG, "anthropic"],
      _meta: {
        "terminal-auth": {
          label: "Anthropic",
          command: "node",
          args: ["/tmp/pi-acp/dist/cli.mjs", "--stdio", ACP_TERMINAL_AUTH_FLAG, "anthropic"],
          env: {},
        },
      },
    });
  });
});

describe("AcpAgent terminal auth", () => {
  test("advertises terminal auth methods for oauth providers", async () => {
    const modelRuntime = createMockModelRuntime();

    const agent = new AcpAgent(createMockConnection(), { modelRuntime }, createMockRuntime());

    const optedIn = await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
        auth: { terminal: true },
      },
    });

    expect(optedIn.authMethods).toMatchObject([
      {
        id: "terminal:anthropic",
        type: "terminal",
        args: [ACP_TERMINAL_AUTH_FLAG, "anthropic"],
      },
    ]);
    expect(agent.getClientCapabilities().supportsTerminalAuth).toBe(true);

    const agentWithoutOptIn = new AcpAgent(
      createMockConnection(),
      { modelRuntime },
      createMockRuntime(),
    );

    const notOptedIn = await agentWithoutOptIn.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    });

    expect(notOptedIn.authMethods).toMatchObject([
      {
        id: "terminal:anthropic",
        type: "terminal",
        args: [ACP_TERMINAL_AUTH_FLAG, "anthropic"],
      },
    ]);
    expect(agentWithoutOptIn.getClientCapabilities().supportsTerminalAuth).toBe(false);
  });

  test("accepts authenticate after terminal auth writes credentials", async () => {
    const modelRuntime = createMockModelRuntime({
      checkAuth: vi.fn(async () => ({ type: "oauth", source: "OAuth" })),
    });

    const agent = new AcpAgent(createMockConnection(), { modelRuntime }, createMockRuntime());
    await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
        auth: { terminal: true },
      },
    });

    await expect(
      agent.authenticate({ methodId: buildTerminalAuthMethodId("anthropic") } as any),
    ).resolves.toEqual({});

    expect(modelRuntime.refresh).toHaveBeenCalledTimes(1);
    expect(modelRuntime.checkAuth).toHaveBeenCalledWith("anthropic");
  });

  test("reloads the model runtime via callback when configured", async () => {
    const initialRuntime = createMockModelRuntime();
    const reloadedRuntime = createMockModelRuntime({
      checkAuth: vi.fn(async () => ({ type: "oauth", source: "OAuth" })),
    });
    const reloadModelRuntime = vi.fn(async () => reloadedRuntime);

    const agent = new AcpAgent(
      createMockConnection(),
      { modelRuntime: initialRuntime, reloadModelRuntime },
      createMockRuntime(),
    );
    await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
        auth: { terminal: true },
      },
    });

    await expect(
      agent.authenticate({ methodId: buildTerminalAuthMethodId("anthropic") } as any),
    ).resolves.toEqual({});

    expect(reloadModelRuntime).toHaveBeenCalledTimes(1);
    expect(initialRuntime.refresh).not.toHaveBeenCalled();
    expect(reloadedRuntime.checkAuth).toHaveBeenCalledWith("anthropic");
  });

  test("rejects authenticate when the terminal auth flow did not persist credentials", async () => {
    const modelRuntime = createMockModelRuntime();

    const agent = new AcpAgent(createMockConnection(), { modelRuntime }, createMockRuntime());
    await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
        auth: { terminal: true },
      },
    });

    await expect(
      agent.authenticate({ methodId: buildTerminalAuthMethodId("anthropic") } as any),
    ).rejects.toThrow(/is not configured/i);
  });
});
