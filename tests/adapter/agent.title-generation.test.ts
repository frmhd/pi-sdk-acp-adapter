import { describe, expect, test, vi, beforeEach, afterEach } from "vite-plus/test";

import {
  createMockConnection,
  createMockSession,
  createTestAgent,
} from "../helpers/testDoubles.ts";

vi.mock("@mariozechner/pi-ai", () => ({
  completeSimple: vi.fn(),
  getEnvApiKey: vi.fn(),
}));

import { completeSimple, getEnvApiKey } from "@mariozechner/pi-ai";
import {
  generateSessionTitle,
  getSmallModelSpec,
} from "../../src/adapter/agent/titleGeneration.js";

describe("getSmallModelSpec", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.PI_ACP_SMALL_MODEL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test("returns null when env var is not set", () => {
    delete process.env.PI_ACP_SMALL_MODEL;
    expect(getSmallModelSpec()).toBeNull();
  });

  test("returns null when env var is empty", () => {
    process.env.PI_ACP_SMALL_MODEL = "";
    expect(getSmallModelSpec()).toBeNull();
  });

  test("parses provider and model id", () => {
    process.env.PI_ACP_SMALL_MODEL = "opencode-go/minimax-m2.7";
    expect(getSmallModelSpec()).toEqual({
      provider: "opencode-go",
      modelId: "minimax-m2.7",
    });
  });

  test("returns null for invalid format without slash", () => {
    process.env.PI_ACP_SMALL_MODEL = "invalid-model";
    expect(getSmallModelSpec()).toBeNull();
  });

  test("returns null for slash at start", () => {
    process.env.PI_ACP_SMALL_MODEL = "/model";
    expect(getSmallModelSpec()).toBeNull();
  });

  test("returns null for slash at end", () => {
    process.env.PI_ACP_SMALL_MODEL = "provider/";
    expect(getSmallModelSpec()).toBeNull();
  });
});

describe("generateSessionTitle", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.resetAllMocks();
    vi.mocked(getEnvApiKey).mockReturnValue(undefined);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  function createMockModelRegistry(overrides: Partial<any> = {}) {
    return {
      find: vi.fn(() => ({ id: "test-model", provider: "test-provider" })),
      hasConfiguredAuth: vi.fn(() => true),
      getApiKeyAndHeaders: vi.fn(() => Promise.resolve({ ok: true, apiKey: "test-key" })),
      ...overrides,
    } as any;
  }

  test("returns null when env var is not set", async () => {
    delete process.env.PI_ACP_SMALL_MODEL;
    const registry = createMockModelRegistry();
    const title = await generateSessionTitle("Hello world", registry);
    expect(title).toBeNull();
    expect(completeSimple).not.toHaveBeenCalled();
  });

  test("returns null when model is not found", async () => {
    process.env.PI_ACP_SMALL_MODEL = "unknown/model";
    const registry = createMockModelRegistry({ find: vi.fn(() => undefined) });
    const title = await generateSessionTitle("Hello world", registry);
    expect(title).toBeNull();
    expect(completeSimple).not.toHaveBeenCalled();
  });

  test("returns null when auth is not configured", async () => {
    process.env.PI_ACP_SMALL_MODEL = "test/model";
    const registry = createMockModelRegistry({
      hasConfiguredAuth: vi.fn(() => false),
    });
    const title = await generateSessionTitle("Hello world", registry);
    expect(title).toBeNull();
    expect(completeSimple).not.toHaveBeenCalled();
  });

  test("returns null when auth lookup fails", async () => {
    process.env.PI_ACP_SMALL_MODEL = "test/model";
    const registry = createMockModelRegistry({
      getApiKeyAndHeaders: vi.fn(() => Promise.resolve({ ok: false, error: "no key" })),
    });
    const title = await generateSessionTitle("Hello world", registry);
    expect(title).toBeNull();
    expect(completeSimple).not.toHaveBeenCalled();
  });

  test("returns normalized title on success", async () => {
    process.env.PI_ACP_SMALL_MODEL = "test/model";
    vi.mocked(completeSimple).mockResolvedValue({
      content: [{ type: "text", text: "  Rust Binary Search Tree  " }],
    } as any);

    const registry = createMockModelRegistry();
    const title = await generateSessionTitle(
      "How do I implement a binary search tree in Rust?",
      registry,
    );

    expect(title).toBe("Rust Binary Search Tree");
    expect(completeSimple).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        systemPrompt: expect.stringContaining("concise, descriptive titles"),
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: "How do I implement a binary search tree in Rust?",
          }),
        ]),
      }),
      expect.objectContaining({
        temperature: 0.3,
      }),
    );
  });

  test("returns null when response has no text content", async () => {
    process.env.PI_ACP_SMALL_MODEL = "test/model";
    vi.mocked(completeSimple).mockResolvedValue({
      content: [{ type: "thinking", thinking: "hmm" }],
    } as any);

    const registry = createMockModelRegistry();
    const title = await generateSessionTitle("Hello", registry);
    expect(title).toBeNull();
  });

  test("returns null and logs warning on API error", async () => {
    process.env.PI_ACP_SMALL_MODEL = "test/model";
    vi.mocked(completeSimple).mockRejectedValue(new Error("API error"));

    const registry = createMockModelRegistry();
    const title = await generateSessionTitle("Hello", registry);
    expect(title).toBeNull();
  });
});

describe("AcpAgent prompt title generation integration", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.resetAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

  test("generates title on first prompt when PI_ACP_SMALL_MODEL is set", async () => {
    process.env.PI_ACP_SMALL_MODEL = "test/tiny-model";
    const connection = createMockConnection();
    const mockSession = createMockSession();
    mockSession.subscribe = vi.fn(() => () => {});

    mockSession.prompt = vi.fn(async () => {
      mockSession.state.messages.push({ role: "user", content: "How do I sort an array?" });
    });

    mockSession.sessionManager.getSessionName = vi.fn(() => undefined);
    mockSession.setSessionName = vi.fn((name: string) => {
      mockSession.sessionManager.getSessionName = vi.fn(() => name);
    });

    mockSession.modelRegistry = {
      find: vi.fn(() => ({ id: "tiny-model", provider: "test" })),
      hasConfiguredAuth: vi.fn(() => true),
      getApiKeyAndHeaders: vi.fn(() => Promise.resolve({ ok: true, apiKey: "key" })),
    };

    vi.mocked(completeSimple).mockResolvedValue({
      content: [{ type: "text", text: "Array Sorting Guide" }],
    } as any);

    const createRuntime = vi.fn(async () => ({
      session: mockSession,
      dispose: vi.fn(),
    }));

    const agent = createTestAgent(connection, createRuntime);

    await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
    });

    const { sessionId } = await agent.newSession({ cwd: "/tmp/project" } as any);

    await agent.prompt({
      sessionId,
      prompt: [{ type: "text", text: "How do I sort an array?" }],
    } as any);

    await flushAsync();

    expect(mockSession.setSessionName).toHaveBeenCalledWith("Array Sorting Guide");

    const updates = connection.sessionUpdate.mock.calls.map(
      ([notification]: [any]) => notification.update,
    );
    const titleUpdate = updates.find(
      (update: any) =>
        update.sessionUpdate === "session_info_update" && update.title === "Array Sorting Guide",
    );
    expect(titleUpdate).toBeDefined();
  });

  test("does not generate title on subsequent prompts", async () => {
    process.env.PI_ACP_SMALL_MODEL = "test/tiny-model";
    const connection = createMockConnection();
    const mockSession = createMockSession();
    mockSession.subscribe = vi.fn(() => () => {});

    mockSession.prompt = vi.fn(async () => {
      mockSession.state.messages.push({ role: "user", content: "Another question" });
    });

    mockSession.sessionManager.getSessionName = vi.fn(() => undefined);
    mockSession.setSessionName = vi.fn();

    const createRuntime = vi.fn(async () => ({
      session: mockSession,
      dispose: vi.fn(),
    }));

    const agent = createTestAgent(connection, createRuntime);

    await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
    });

    const { sessionId } = await agent.newSession({ cwd: "/tmp/project" } as any);

    // Pre-populate with a user message so this is not the first prompt
    mockSession.state.messages.push({ role: "user", content: "First question" });

    await agent.prompt({
      sessionId,
      prompt: [{ type: "text", text: "Another question" }],
    } as any);

    await flushAsync();

    expect(completeSimple).not.toHaveBeenCalled();
    expect(mockSession.setSessionName).not.toHaveBeenCalled();
  });

  test("does not generate title when session already has explicit name", async () => {
    process.env.PI_ACP_SMALL_MODEL = "test/tiny-model";
    const connection = createMockConnection();
    const mockSession = createMockSession();
    mockSession.subscribe = vi.fn(() => () => {});

    mockSession.prompt = vi.fn(async () => {
      mockSession.state.messages.push({ role: "user", content: "How do I sort an array?" });
    });

    mockSession.sessionManager.getSessionName = vi.fn(() => "Existing Name");
    mockSession.setSessionName = vi.fn();

    const createRuntime = vi.fn(async () => ({
      session: mockSession,
      dispose: vi.fn(),
    }));

    const agent = createTestAgent(connection, createRuntime);

    await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
    });

    const { sessionId } = await agent.newSession({ cwd: "/tmp/project" } as any);

    await agent.prompt({
      sessionId,
      prompt: [{ type: "text", text: "How do I sort an array?" }],
    } as any);

    await flushAsync();

    expect(completeSimple).not.toHaveBeenCalled();
    expect(mockSession.setSessionName).not.toHaveBeenCalled();
  });

  test("does not generate title when PI_ACP_SMALL_MODEL is not set", async () => {
    delete process.env.PI_ACP_SMALL_MODEL;
    const connection = createMockConnection();
    const mockSession = createMockSession();
    mockSession.subscribe = vi.fn(() => () => {});

    mockSession.prompt = vi.fn(async () => {
      mockSession.state.messages.push({ role: "user", content: "How do I sort an array?" });
    });

    mockSession.sessionManager.getSessionName = vi.fn(() => undefined);
    mockSession.setSessionName = vi.fn();

    const createRuntime = vi.fn(async () => ({
      session: mockSession,
      dispose: vi.fn(),
    }));

    const agent = createTestAgent(connection, createRuntime);

    await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
    });

    const { sessionId } = await agent.newSession({ cwd: "/tmp/project" } as any);

    await agent.prompt({
      sessionId,
      prompt: [{ type: "text", text: "How do I sort an array?" }],
    } as any);

    await flushAsync();

    expect(completeSimple).not.toHaveBeenCalled();
    expect(mockSession.setSessionName).not.toHaveBeenCalled();
  });
});
