import { describe, expect, test } from "vite-plus/test";

import { createToolCallContent, mapStopReason, mapToolKind } from "../../src/index.ts";

describe("Type Definitions", () => {
  test("mapToolKind maps read to read", () => {
    expect(mapToolKind("read")).toBe("read");
  });

  test("mapToolKind maps edit to edit", () => {
    expect(mapToolKind("edit")).toBe("edit");
  });

  test("mapToolKind maps write to edit for Zed diff rendering", () => {
    expect(mapToolKind("write")).toBe("edit");
  });

  test("mapToolKind maps bash to execute", () => {
    expect(mapToolKind("bash")).toBe("execute");
  });

  test("mapToolKind keeps non-Pi bridge tools out of the public surface", () => {
    expect(mapToolKind("grep")).toBe("other");
    expect(mapToolKind("find")).toBe("other");
    expect(mapToolKind("ls")).toBe("other");
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
