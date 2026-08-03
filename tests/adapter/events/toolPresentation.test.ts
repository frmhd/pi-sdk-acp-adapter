import { describe, expect, test } from "vite-plus/test";

import { buildToolTitle } from "../../../src/adapter/events/toolPresentation.js";

// ============================================================================
// buildToolTitle — unknown / extension-provided tools
// ============================================================================

describe("buildToolTitle — extension tools", () => {
  test("unknown tool name falls back to the registered tool name", () => {
    expect(buildToolTitle("Agent", { task: "find docs" })).toBe("Agent");
  });

  test("unknown tool name ignores foreign tool-shaped args", () => {
    expect(
      buildToolTitle("Agent", { agent: "brave-search", task: "find docs" }, { cwd: "/tmp" }),
    ).toBe("Agent");
  });

  test("no tool name falls back to Tool", () => {
    expect(buildToolTitle(undefined, {})).toBe("Tool");
  });
});
