import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Message } from "@earendil-works/pi-ai";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

const createAgentSessionMock = vi.hoisted(() => vi.fn());

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@earendil-works/pi-coding-agent");
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
      modelRuntime: { getAvailableSnapshot: () => [], getModel: () => undefined } as any,
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
    expect(toolsByName.subagent.acpBackend).toBe("acp");
  });

  test("subagent tool discovers agents via explicit agentDir without PI_CODING_AGENT_DIR", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-acp-subagent-"));
    tempDirs.push(root);

    const cwd = join(root, "project");
    const agentDir = join(root, "agent-home");
    await mkdir(join(agentDir, "agents"), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(
      join(agentDir, "agents", "tester.md"),
      [
        "---",
        "name: tester",
        "description: Test subagent",
        "tools: read, bash",
        "---",
        "",
        "You are a test worker.",
        "",
      ].join("\n"),
      "utf-8",
    );

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    delete process.env.PI_CODING_AGENT_DIR;

    let parentSessionOptions: any;
    let childSessionOptions: any;
    const childPrompt = vi.fn(async () => undefined);
    const childSubscribe = vi.fn(() => () => {});
    const childMessages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: "child-done" }],
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        stopReason: "stop",
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: { total: 0.001 },
        },
      } as any,
    ];

    createAgentSessionMock
      .mockImplementationOnce(async (sessionOptions: any) => {
        parentSessionOptions = sessionOptions;
        return {
          session: { dispose: vi.fn() },
        };
      })
      .mockImplementationOnce(async (sessionOptions: any) => {
        childSessionOptions = sessionOptions;
        return {
          session: {
            state: { messages: childMessages },
            subscribe: childSubscribe,
            prompt: childPrompt,
            abort: vi.fn(async () => undefined),
            dispose: vi.fn(),
          },
        };
      });

    try {
      await createAcpAgentRuntime({
        cwd,
        agentDir,
        modelRuntime: { getAvailableSnapshot: () => [], getModel: () => undefined } as any,
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
        parentSessionOptions.customTools.map((tool: any) => [tool.name, tool]),
      );

      const result = await toolsByName.subagent.execute(
        "tool-subagent",
        { agent: "tester", task: "inspect the project" },
        undefined,
        undefined,
        {
          cwd,
          modelRuntime: { getAvailableSnapshot: () => [], getModel: () => undefined },
          model: undefined,
          hasUI: false,
        },
      );

      expect(result.content[0].text).toBe("child-done");
      expect(childPrompt).toHaveBeenCalledWith("Task: inspect the project");
      expect(childSessionOptions.tools).toEqual(["read", "bash"]);
      expect(childSessionOptions.customTools.map((tool: any) => tool.name)).toEqual([
        "read",
        "write",
        "edit",
        "bash",
      ]);
      expect(childSessionOptions.thinkingLevel).toBeUndefined();
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });

  test("subagent forwards thinkingLevel from frontmatter to child session", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-acp-subagent-thinking-level-"));
    tempDirs.push(root);

    const cwd = join(root, "project");
    const agentDir = join(root, "agent-home");
    await mkdir(join(agentDir, "agents"), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(
      join(agentDir, "agents", "thinker.md"),
      [
        "---",
        "name: thinker",
        "description: Agent with thinking level",
        "tools: read",
        "thinkingLevel: high",
        "---",
        "",
        "You are a thinking worker.",
        "",
      ].join("\n"),
      "utf-8",
    );

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    delete process.env.PI_CODING_AGENT_DIR;

    let parentSessionOptions: any;
    let childSessionOptions: any;

    createAgentSessionMock
      .mockImplementationOnce(async (sessionOptions: any) => {
        parentSessionOptions = sessionOptions;
        return {
          session: { dispose: vi.fn() },
        };
      })
      .mockImplementationOnce(async (sessionOptions: any) => {
        childSessionOptions = sessionOptions;
        return {
          session: {
            state: {
              messages: [
                {
                  role: "assistant",
                  content: [{ type: "text", text: "done" }],
                  stopReason: "stop",
                },
              ],
            },
            subscribe: vi.fn(() => () => {}),
            prompt: vi.fn(async () => undefined),
            abort: vi.fn(async () => undefined),
            dispose: vi.fn(),
          },
        };
      });

    try {
      await createAcpAgentRuntime({
        cwd,
        agentDir,
        modelRuntime: { getAvailableSnapshot: () => [], getModel: () => undefined } as any,
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
        parentSessionOptions.customTools.map((tool: any) => [tool.name, tool]),
      );

      await toolsByName.subagent.execute(
        "tool-subagent",
        { agent: "thinker", task: "think deeply" },
        undefined,
        undefined,
        {
          cwd,
          modelRuntime: { getAvailableSnapshot: () => [], getModel: () => undefined },
          model: undefined,
          hasUI: false,
        },
      );

      expect(childSessionOptions.thinkingLevel).toBe("high");
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });

  test("subagent excludes host-local grep/find/ls from child session tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-acp-subagent-safe-tools-"));
    tempDirs.push(root);

    const cwd = join(root, "project");
    const agentDir = join(root, "agent-home");
    await mkdir(join(agentDir, "agents"), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(
      join(agentDir, "agents", "scoutish.md"),
      [
        "---",
        "name: scoutish",
        "description: Scout-style agent",
        "tools: read, bash, grep, find, ls",
        "---",
        "",
        "You are a scout worker.",
        "",
      ].join("\n"),
      "utf-8",
    );

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    delete process.env.PI_CODING_AGENT_DIR;

    let parentSessionOptions: any;
    let childSessionOptions: any;

    createAgentSessionMock
      .mockImplementationOnce(async (sessionOptions: any) => {
        parentSessionOptions = sessionOptions;
        return {
          session: { dispose: vi.fn() },
        };
      })
      .mockImplementationOnce(async (sessionOptions: any) => {
        childSessionOptions = sessionOptions;
        return {
          session: {
            state: {
              messages: [
                {
                  role: "assistant",
                  content: [{ type: "text", text: "done" }],
                  stopReason: "stop",
                },
              ],
            },
            subscribe: vi.fn(() => () => {}),
            prompt: vi.fn(async () => undefined),
            abort: vi.fn(async () => undefined),
            dispose: vi.fn(),
          },
        };
      });

    try {
      await createAcpAgentRuntime({
        cwd,
        agentDir,
        modelRuntime: { getAvailableSnapshot: () => [], getModel: () => undefined } as any,
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
        parentSessionOptions.customTools.map((tool: any) => [tool.name, tool]),
      );

      await toolsByName.subagent.execute(
        "tool-subagent",
        { agent: "scoutish", task: "scan the repo" },
        undefined,
        undefined,
        {
          cwd,
          modelRuntime: { getAvailableSnapshot: () => [], getModel: () => undefined },
          model: undefined,
          hasUI: false,
        },
      );

      expect(childSessionOptions.tools).toEqual(["read", "bash"]);
      expect(childSessionOptions.customTools.map((tool: any) => tool.name)).toEqual([
        "read",
        "write",
        "edit",
        "bash",
      ]);
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
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
      modelRuntime: { getAvailableSnapshot: () => [], getModel: () => undefined } as any,
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
      modelRuntime: { getAvailableSnapshot: () => [], getModel: () => undefined } as any,
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
      modelRuntime: { getAvailableSnapshot: () => [], getModel: () => undefined } as any,
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
