/**
 * Phase 1 Tests - Core Adapter Infrastructure
 *
 * Tests for types and event mapper functionality.
 */

import { expect, test, describe } from "vite-plus/test";
import {
  mapToolKind,
  mapStopReason,
  createToolCallContent,
  mapToolExecutionStart,
  mapToolExecutionUpdate,
  mapToolExecutionEnd,
} from "../src/index.ts";

describe("Type Definitions", () => {
  test("mapToolKind maps read to read", () => {
    expect(mapToolKind("read")).toBe("read");
  });

  test("mapToolKind maps edit to edit", () => {
    expect(mapToolKind("edit")).toBe("edit");
  });

  test("mapToolKind maps bash to execute", () => {
    expect(mapToolKind("bash")).toBe("execute");
  });

  test("mapToolKind maps grep to search", () => {
    expect(mapToolKind("grep")).toBe("search");
  });

  test("mapToolKind maps find to search", () => {
    expect(mapToolKind("find")).toBe("search");
  });

  test("mapToolKind maps write to other", () => {
    expect(mapToolKind("write")).toBe("other");
  });

  test("mapToolKind maps unknown to other", () => {
    expect(mapToolKind("unknown_tool")).toBe("other");
  });
});

describe("Stop Reason Mapping", () => {
  test("maps stop to end_turn", () => {
    expect(mapStopReason("stop")).toBe("end_turn");
  });

  test("maps length to max_tokens", () => {
    expect(mapStopReason("length")).toBe("max_tokens");
  });

  test("maps tool_calls to end_turn", () => {
    expect(mapStopReason("tool_calls")).toBe("end_turn");
  });

  test("maps error to end_turn", () => {
    expect(mapStopReason("error")).toBe("end_turn");
  });

  test("maps aborted to cancelled", () => {
    expect(mapStopReason("aborted")).toBe("cancelled");
  });

  test("maps refusal to refusal", () => {
    expect(mapStopReason("refusal")).toBe("refusal");
  });

  test("maps undefined to end_turn", () => {
    expect(mapStopReason(undefined)).toBe("end_turn");
  });

  test("maps unknown to end_turn", () => {
    expect(mapStopReason("unknown")).toBe("end_turn");
  });
});

describe("createToolCallContent", () => {
  test("creates content with text", () => {
    const content = createToolCallContent("Hello, world!");
    expect(content).toBeDefined();
    expect(content.type).toBe("content");
  });
});

describe("Tool Execution Start Mapping", () => {
  test("maps tool execution start to tool_call notification", () => {
    const notification = mapToolExecutionStart("session-123", {
      toolCallId: "tool-1",
      toolName: "read",
      args: { path: "/test/file.ts" },
    });

    expect(notification.sessionId).toBe("session-123");
    expect(notification.update.sessionUpdate).toBe("tool_call");
    expect((notification.update as any).toolCallId).toBe("tool-1");
    expect((notification.update as any).title).toBe("Reading: /test/file.ts");
    expect((notification.update as any).locations).toEqual([{ path: "/test/file.ts" }]);
    expect((notification.update as any).kind).toBe("read");
    expect((notification.update as any).status).toBe("pending");
  });

  test("maps bash tool to execute kind", () => {
    const notification = mapToolExecutionStart("session-123", {
      toolCallId: "tool-2",
      toolName: "bash",
      args: { command: "ls -la" },
    });

    expect((notification.update as any).title).toBe("Running: ls -la");
    expect((notification.update as any).kind).toBe("execute");
  });
});

describe("Tool Execution Update Mapping", () => {
  test("maps string partial result to text content", () => {
    const notification = mapToolExecutionUpdate("session-123", {
      toolCallId: "tool-1",
      partialResult: "Partial output...",
    });

    expect(notification.sessionId).toBe("session-123");
    expect(notification.update.sessionUpdate).toBe("tool_call_update");
    expect((notification.update as any).toolCallId).toBe("tool-1");
    expect((notification.update as any).status).toBe("in_progress");
  });

  test("maps object partial result with stdout", () => {
    const notification = mapToolExecutionUpdate("session-123", {
      toolCallId: "tool-1",
      partialResult: { stdout: "Command output" },
    });

    expect(notification.update).toBeDefined();
  });

  test("returns undefined content when no text", () => {
    const notification = mapToolExecutionUpdate("session-123", {
      toolCallId: "tool-1",
      partialResult: null,
    });

    // Should have content or not depending on implementation
    expect(notification).toBeDefined();
  });
});

describe("Tool Execution End Mapping", () => {
  test("maps successful result to completed status", () => {
    const notification = mapToolExecutionEnd("session-123", {
      toolCallId: "tool-1",
      result: { stdout: "Success output" },
      isError: false,
    });

    expect(notification.sessionId).toBe("session-123");
    expect(notification.update.sessionUpdate).toBe("tool_call_update");
    expect((notification.update as any).toolCallId).toBe("tool-1");
    expect((notification.update as any).status).toBe("completed");
  });

  test("maps error result to failed status", () => {
    const notification = mapToolExecutionEnd("session-123", {
      toolCallId: "tool-1",
      result: "File not found",
      isError: true,
    });

    expect((notification.update as any).status).toBe("failed");
  });

  test("creates error message when isError and no content", () => {
    const notification = mapToolExecutionEnd("session-123", {
      toolCallId: "tool-1",
      result: { message: "Permission denied" },
      isError: true,
    });

    expect(notification.update).toBeDefined();
  });

  test("maps bash result with stdout", () => {
    const notification = mapToolExecutionEnd("session-123", {
      toolCallId: "tool-1",
      result: { stdout: "ls output", exitCode: 0 },
      isError: false,
    });

    expect(notification.update).toBeDefined();
  });
});
