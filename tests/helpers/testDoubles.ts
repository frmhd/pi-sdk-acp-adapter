import { readFile } from "node:fs/promises";

import { vi } from "vite-plus/test";

import { AcpAgent } from "../../src/index.ts";

export function createMockSession() {
  return {
    sessionId: undefined,
    sessionName: undefined,
    sessionManager: {
      getSessionName: vi.fn(() => undefined),
      getEntries: vi.fn(() => []),
      getHeader: vi.fn(() => ({ timestamp: new Date(0).toISOString() })),
    },
    state: {
      messages: [],
      model: undefined,
    },
    thinkingLevel: "medium",
    dispose: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    prompt: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
  } as any;
}

export function createMockConnection() {
  return {
    sessionUpdate: vi.fn(async () => undefined),
    readTextFile: vi.fn(async () => ({ content: "" })),
  } as any;
}

export function createTestAgent(
  connection: any = createMockConnection(),
  createRuntime:
    | ((options: any) => Promise<{ session: any; dispose: () => void }>)
    | undefined = undefined,
) {
  return new AcpAgent(
    connection,
    {
      modelRegistry: {
        getAvailable: () => [],
        refresh: vi.fn(() => undefined),
        authStorage: {
          getOAuthProviders: () => [],
          reload: vi.fn(() => undefined),
          hasAuth: vi.fn(() => false),
        },
      } as any,
    },
    createRuntime ??
      (async () => ({
        session: createMockSession(),
        dispose: vi.fn(),
      })),
  );
}

export async function getPackageVersion(): Promise<string> {
  const packageJson = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf-8"),
  ) as { version: string };

  return packageJson.version;
}
