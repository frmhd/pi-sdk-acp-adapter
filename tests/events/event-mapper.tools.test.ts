import { describe, expect, test } from "vite-plus/test";

import {
  mapToolExecutionEnd,
  mapToolExecutionStart,
  mapToolExecutionUpdate,
} from "../../src/index.ts";

describe("Tool Execution Start Mapping", () => {
  test("maps read to a file-targeting tool call with title, location, and _meta", () => {
    const notification = mapToolExecutionStart(
      "session-123",
      {
        toolCallId: "tool-1",
        toolName: "read",
        args: { path: "/test/file.ts" },
      },
      { cwd: "/workspace" },
    );

    expect(notification.sessionId).toBe("session-123");
    expect(notification.update.sessionUpdate).toBe("tool_call");
    expect((notification.update as any).toolCallId).toBe("tool-1");
    expect((notification.update as any).title).toBe("Read /test/file.ts");
    expect((notification.update as any).locations).toEqual([{ path: "/test/file.ts" }]);
    expect((notification.update as any).kind).toBe("read");
    expect((notification.update as any).status).toBe("pending");
    expect((notification.update as any)._meta).toEqual({ tool_name: "read" });
  });

  test("maps bash tool to execute kind with clean run title", () => {
    const notification = mapToolExecutionStart("session-123", {
      toolCallId: "tool-2",
      toolName: "bash",
      args: { command: "ls -la" },
    });

    expect((notification.update as any).title).toBe("Run: ls -la");
    expect((notification.update as any).kind).toBe("execute");
  });

  test("maps write to edit kind and preserves an absolute file location", () => {
    const notification = mapToolExecutionStart(
      "session-123",
      {
        toolCallId: "tool-3",
        toolName: "write",
        args: { path: "src/new.ts", content: "hello" },
      },
      { cwd: "/workspace/project" },
    );

    expect((notification.update as any).title).toBe("Write src/new.ts");
    expect((notification.update as any).kind).toBe("edit");
    expect((notification.update as any).locations).toEqual([
      { path: "/workspace/project/src/new.ts" },
    ]);
  });
});

describe("Tool Execution Update Mapping", () => {
  test("preserves structured partial Pi content and raw output", () => {
    const partialResult = {
      content: [{ type: "text", text: "Partial output..." }],
      details: { truncated: false },
    };

    const notification = mapToolExecutionUpdate("session-123", {
      toolCallId: "tool-1",
      toolName: "bash",
      partialResult,
    });

    expect(notification.sessionId).toBe("session-123");
    expect(notification.update.sessionUpdate).toBe("tool_call_update");
    expect((notification.update as any).toolCallId).toBe("tool-1");
    expect((notification.update as any).status).toBe("in_progress");
    expect((notification.update as any).content).toEqual([
      {
        type: "content",
        content: { type: "text", text: "Partial output..." },
      },
    ]);
    expect((notification.update as any).rawOutput).toEqual(partialResult);
  });

  test("maps terminal-backed bash updates to ACP terminal content", () => {
    const rawOutput = {
      type: "acp_terminal",
      terminalId: "term-123",
      input: { command: "echo hi", timeout: null },
      execution: {
        command: "echo hi",
        args: [],
        cwd: "/workspace/project",
        outputByteLimit: 51200,
      },
      output: "hi\n",
      truncated: false,
    };

    const notification = mapToolExecutionUpdate(
      "session-123",
      {
        toolCallId: "tool-1",
        toolName: "bash",
        partialResult: { content: [], details: undefined },
      },
      {
        toolCallState: {
          toolName: "bash",
          terminalId: "term-123",
          rawInput: { command: "echo hi" },
          rawOutput,
        },
      },
    );

    expect((notification.update as any).status).toBe("in_progress");
    expect((notification.update as any).title).toBe("Run: echo hi");
    expect((notification.update as any).content).toEqual([
      { type: "terminal", terminalId: "term-123" },
    ]);
    expect((notification.update as any).rawOutput).toEqual(rawOutput);
  });

  test("keeps notification shape when partial output has no visible content", () => {
    const notification = mapToolExecutionUpdate("session-123", {
      toolCallId: "tool-1",
      partialResult: null,
    });

    expect(notification).toBeDefined();
    expect((notification.update as any).status).toBe("in_progress");
  });
});

describe("Tool Execution End Mapping", () => {
  test("maps write completion to ACP diff content with create semantics", () => {
    const result = {
      content: [{ type: "text", text: "Successfully wrote 5 bytes to src/new.ts" }],
      details: undefined,
    };

    const notification = mapToolExecutionEnd(
      "session-123",
      {
        toolCallId: "tool-1",
        toolName: "write",
        result,
        isError: false,
      },
      {
        cwd: "/workspace/project",
        toolCallState: {
          toolName: "write",
          path: "/workspace/project/src/new.ts",
          diff: {
            path: "/workspace/project/src/new.ts",
            oldText: null,
            newText: "hello",
          },
          rawOutput: result,
        },
      },
    );

    expect(notification.sessionId).toBe("session-123");
    expect(notification.update.sessionUpdate).toBe("tool_call_update");
    expect((notification.update as any).toolCallId).toBe("tool-1");
    expect((notification.update as any).status).toBe("completed");
    expect((notification.update as any).kind).toBe("edit");
    expect((notification.update as any).title).toBe("Create src/new.ts");
    expect((notification.update as any).locations).toEqual([
      { path: "/workspace/project/src/new.ts" },
    ]);
    expect((notification.update as any).content).toEqual([
      {
        type: "diff",
        path: "/workspace/project/src/new.ts",
        oldText: null,
        newText: "hello",
        _meta: { kind: "add" },
      },
    ]);
    expect((notification.update as any).rawOutput).toEqual(result);
  });

  test("adds firstChangedLine to edit locations", () => {
    const result = {
      content: [{ type: "text", text: "Successfully replaced 1 block(s) in src/file.ts." }],
      details: { firstChangedLine: 7 },
    };

    const notification = mapToolExecutionEnd(
      "session-123",
      {
        toolCallId: "tool-2",
        toolName: "edit",
        result,
        isError: false,
      },
      {
        cwd: "/workspace/project",
        toolCallState: {
          toolName: "edit",
          path: "/workspace/project/src/file.ts",
          diff: {
            path: "/workspace/project/src/file.ts",
            oldText: "before",
            newText: "after",
          },
          firstChangedLine: 7,
        },
      },
    );

    expect((notification.update as any).title).toBe("Edit src/file.ts");
    expect((notification.update as any).locations).toEqual([
      { path: "/workspace/project/src/file.ts", line: 7 },
    ]);
  });

  test("preserves structured Pi read content instead of collapsing to plain text", () => {
    const result = {
      content: [
        { type: "text", text: "Read image file [image/png]" },
        { type: "image", data: "abc123", mimeType: "image/png" },
      ],
      details: { truncation: undefined },
    };

    const notification = mapToolExecutionEnd("session-123", {
      toolCallId: "tool-3",
      toolName: "read",
      result,
      isError: false,
    });

    expect((notification.update as any).content).toEqual([
      {
        type: "content",
        content: { type: "text", text: "Read image file [image/png]" },
      },
      {
        type: "content",
        content: { type: "image", data: "abc123", mimeType: "image/png" },
      },
    ]);
    expect((notification.update as any).rawOutput).toEqual(result);
  });

  test("preserves resource links and embedded resources returned by tool results", () => {
    const result = {
      content: [
        {
          type: "resource_link",
          name: "Screenshot",
          uri: "file:///tmp/screenshot.png",
          mimeType: "image/png",
        },
        {
          type: "resource",
          resource: {
            uri: "file:///tmp/notes.txt",
            text: "hello from a resource",
            mimeType: "text/plain",
          },
        },
      ],
    };

    const notification = mapToolExecutionEnd("session-123", {
      toolCallId: "tool-3b",
      toolName: "read",
      result,
      isError: false,
    });

    expect((notification.update as any).content).toEqual([
      {
        type: "content",
        content: {
          type: "resource_link",
          name: "Screenshot",
          uri: "file:///tmp/screenshot.png",
          mimeType: "image/png",
        },
      },
      {
        type: "content",
        content: {
          type: "resource",
          resource: {
            uri: "file:///tmp/notes.txt",
            text: "hello from a resource",
            mimeType: "text/plain",
          },
        },
      },
    ]);
    expect((notification.update as any).rawOutput).toEqual(result);
  });

  test("keeps bash completion terminal-backed and preserves raw terminal metadata", () => {
    const rawOutput = {
      type: "acp_terminal",
      terminalId: "term-123",
      input: { command: "echo hi", timeout: null },
      execution: {
        command: "echo hi",
        args: [],
        cwd: "/workspace/project",
        outputByteLimit: 51200,
      },
      output: "hi\n",
      truncated: false,
      exitCode: 0,
      signal: null,
    };

    const notification = mapToolExecutionEnd(
      "session-123",
      {
        toolCallId: "tool-4",
        toolName: "bash",
        result: { content: [{ type: "text", text: "hi" }] },
        isError: false,
      },
      {
        toolCallState: {
          toolName: "bash",
          terminalId: "term-123",
          rawInput: { command: "echo hi" },
          rawOutput,
        },
      },
    );

    expect((notification.update as any).status).toBe("completed");
    expect((notification.update as any).kind).toBe("execute");
    expect((notification.update as any).title).toBe("Run: echo hi");
    expect((notification.update as any).content).toEqual([
      { type: "terminal", terminalId: "term-123" },
    ]);
    expect((notification.update as any).rawOutput).toEqual(rawOutput);
  });

  test("maps error result to failed status", () => {
    const notification = mapToolExecutionEnd("session-123", {
      toolCallId: "tool-5",
      result: "File not found",
      isError: true,
    });

    expect((notification.update as any).status).toBe("failed");
  });
});
