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

  test("builds ACP terminal auth methods with spec args and legacy zed meta", () => {
    const methods = buildTerminalAuthMethods(
      {
        getOAuthProviders: () => [
          { id: "openai-codex", name: "OpenAI Codex" },
          { id: "anthropic", name: "Anthropic" },
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
  test("advertises terminal auth methods only when the client opts in", async () => {
    const authStorage = {
      getOAuthProviders: () => [{ id: "anthropic", name: "Anthropic" }],
      reload: vi.fn(() => undefined),
      hasAuth: vi.fn(() => false),
    };
    const modelRegistry = {
      getAvailable: () => [],
      refresh: vi.fn(() => undefined),
      authStorage,
    } as any;

    const agent = new AcpAgent(createMockConnection(), { modelRegistry }, createMockRuntime());

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
      { modelRegistry },
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
    const authStorage = {
      getOAuthProviders: () => [{ id: "anthropic", name: "Anthropic" }],
      reload: vi.fn(() => undefined),
      hasAuth: vi.fn(() => true),
    };
    const modelRegistry = {
      getAvailable: () => [],
      refresh: vi.fn(() => undefined),
      authStorage,
    } as any;

    const agent = new AcpAgent(createMockConnection(), { modelRegistry }, createMockRuntime());
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

    expect(authStorage.reload).toHaveBeenCalledTimes(1);
    expect(authStorage.hasAuth).toHaveBeenCalledWith("anthropic");
    expect(modelRegistry.refresh).toHaveBeenCalledTimes(1);
  });

  test("rejects authenticate when the terminal auth flow did not persist credentials", async () => {
    const authStorage = {
      getOAuthProviders: () => [{ id: "anthropic", name: "Anthropic" }],
      reload: vi.fn(() => undefined),
      hasAuth: vi.fn(() => false),
    };
    const modelRegistry = {
      getAvailable: () => [],
      refresh: vi.fn(() => undefined),
      authStorage,
    } as any;

    const agent = new AcpAgent(createMockConnection(), { modelRegistry }, createMockRuntime());
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
