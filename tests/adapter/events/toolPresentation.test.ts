import { describe, expect, test } from "vite-plus/test";

import {
  buildToolTitle,
  type ToolEventMappingContext,
} from "../../../src/adapter/events/toolPresentation.js";

function makeContext(overrides?: Partial<ToolEventMappingContext>): ToolEventMappingContext {
  return {
    cwd: "/tmp/project",
    ...overrides,
  };
}

function makeToolCallState(
  rawOutput?: unknown,
): NonNullable<ToolEventMappingContext["toolCallState"]> {
  return {
    rawOutput,
  };
}

function makeSubagentResult(overrides: {
  agent: string;
  exitCode: number;
  lastProgress?: string;
  step?: number;
}) {
  return overrides;
}

function makeSubagentRawOutput(
  mode: "single" | "parallel" | "chain",
  results: ReturnType<typeof makeSubagentResult>[],
) {
  return {
    content: [{ type: "text" as const, text: "" }],
    details: {
      mode,
      agentScope: "user",
      projectAgentsDir: null,
      results,
    },
  };
}

// ============================================================================
// buildToolTitle — subagent
// ============================================================================

describe("buildToolTitle — subagent", () => {
  // ---------------------------------------------------------------------------
  // Single mode
  // ---------------------------------------------------------------------------
  test("single mode start", () => {
    const title = buildToolTitle("subagent", { agent: "brave-search", task: "find docs" });
    expect(title).toBe("Subagent: brave-search");
  });

  test("single mode with progress update", () => {
    const title = buildToolTitle(
      "subagent",
      { agent: "brave-search", task: "find docs" },
      makeContext({
        toolCallState: makeToolCallState(
          makeSubagentRawOutput("single", [
            makeSubagentResult({ agent: "brave-search", exitCode: -1, lastProgress: "→ read" }),
          ]),
        ),
      }),
    );
    expect(title).toBe("Subagent: brave-search — → read");
  });

  test("single mode truncates long progress", () => {
    const longProgress = "a".repeat(100);
    const title = buildToolTitle(
      "subagent",
      { agent: "code-review", task: "review PR" },
      makeContext({
        toolCallState: makeToolCallState(
          makeSubagentRawOutput("single", [
            makeSubagentResult({
              agent: "code-review",
              exitCode: -1,
              lastProgress: longProgress,
            }),
          ]),
        ),
      }),
    );
    expect(title).toBe(`Subagent: code-review — ${longProgress.slice(0, 40)}…`);
  });

  test("single mode falls back when no agent in args", () => {
    const title = buildToolTitle("subagent", { task: "find docs" });
    expect(title).toBe("Subagent");
  });

  // ---------------------------------------------------------------------------
  // Parallel mode
  // ---------------------------------------------------------------------------
  test("parallel mode start", () => {
    const title = buildToolTitle("subagent", {
      tasks: [
        { agent: "brave-search", task: "t1" },
        { agent: "code-review", task: "t2" },
        { agent: "gh-cli", task: "t3" },
      ],
    });
    expect(title).toBe("Subagents (3): brave-search, code-review, gh-cli");
  });

  test("parallel mode truncates agent list when >3", () => {
    const title = buildToolTitle("subagent", {
      tasks: [
        { agent: "a", task: "t1" },
        { agent: "b", task: "t2" },
        { agent: "c", task: "t3" },
        { agent: "d", task: "t4" },
      ],
    });
    expect(title).toBe("Subagents (4): a, b, c +1");
  });

  test("parallel mode skips non-object elements in tasks", () => {
    const title = buildToolTitle("subagent", {
      tasks: [
        { agent: "a", task: "t1" },
        null,
        undefined,
        42,
        "string",
        { agent: "b", task: "t2" },
      ],
    });
    expect(title).toBe("Subagents (2): a, b");
  });

  test("parallel mode skips elements without string agent", () => {
    const title = buildToolTitle("subagent", {
      tasks: [
        { agent: "a", task: "t1" },
        { task: "no-agent" },
        { agent: 123, task: "bad-agent" },
        { agent: "b", task: "t2" },
      ],
    });
    expect(title).toBe("Subagents (2): a, b");
  });

  test("parallel mode during execution", () => {
    const title = buildToolTitle(
      "subagent",
      {
        tasks: [
          { agent: "a", task: "t1" },
          { agent: "b", task: "t2" },
          { agent: "c", task: "t3" },
        ],
      },
      makeContext({
        toolCallState: makeToolCallState(
          makeSubagentRawOutput("parallel", [
            makeSubagentResult({ agent: "a", exitCode: 0 }),
            makeSubagentResult({ agent: "b", exitCode: -1 }),
            makeSubagentResult({ agent: "c", exitCode: -1 }),
          ]),
        ),
      }),
    );
    expect(title).toBe("Subagents (3): 1/3 done");
  });

  test("parallel mode all succeeded", () => {
    const title = buildToolTitle(
      "subagent",
      {
        tasks: [
          { agent: "a", task: "t1" },
          { agent: "b", task: "t2" },
        ],
      },
      makeContext({
        toolCallState: makeToolCallState(
          makeSubagentRawOutput("parallel", [
            makeSubagentResult({ agent: "a", exitCode: 0 }),
            makeSubagentResult({ agent: "b", exitCode: 0 }),
          ]),
        ),
      }),
    );
    expect(title).toBe("Subagents (2): all succeeded");
  });

  test("parallel mode some failed", () => {
    const title = buildToolTitle(
      "subagent",
      {
        tasks: [
          { agent: "a", task: "t1" },
          { agent: "b", task: "t2" },
          { agent: "c", task: "t3" },
        ],
      },
      makeContext({
        toolCallState: makeToolCallState(
          makeSubagentRawOutput("parallel", [
            makeSubagentResult({ agent: "a", exitCode: 0 }),
            makeSubagentResult({ agent: "b", exitCode: 1 }),
            makeSubagentResult({ agent: "c", exitCode: 0 }),
          ]),
        ),
      }),
    );
    expect(title).toBe("Subagents (3): 2/3 succeeded");
  });

  test("parallel mode empty tasks array", () => {
    const title = buildToolTitle("subagent", { tasks: [] });
    expect(title).toBe("Subagents (0): ");
  });

  test("parallel mode with no tasks falls back", () => {
    const title = buildToolTitle("subagent", {});
    expect(title).toBe("Subagent");
  });

  // ---------------------------------------------------------------------------
  // Chain mode
  // ---------------------------------------------------------------------------
  test("chain mode start", () => {
    const title = buildToolTitle("subagent", {
      chain: [
        { agent: "brave-search", task: "t1" },
        { agent: "code-review", task: "t2" },
      ],
    });
    expect(title).toBe("Chain (2): brave-search → code-review");
  });

  test("chain mode truncates agent list when >3", () => {
    const title = buildToolTitle("subagent", {
      chain: [
        { agent: "a", task: "t1" },
        { agent: "b", task: "t2" },
        { agent: "c", task: "t3" },
        { agent: "d", task: "t4" },
      ],
    });
    expect(title).toBe("Chain (4): a → b → c → +1");
  });

  test("chain mode skips non-object elements in chain", () => {
    const title = buildToolTitle("subagent", {
      chain: [{ agent: "a", task: "t1" }, null, undefined, 42, { agent: "b", task: "t2" }],
    });
    expect(title).toBe("Chain (2): a → b");
  });

  test("chain mode skips elements without string agent", () => {
    const title = buildToolTitle("subagent", {
      chain: [
        { agent: "a", task: "t1" },
        { task: "no-agent" },
        { agent: true, task: "bad-agent" },
        { agent: "b", task: "t2" },
      ],
    });
    expect(title).toBe("Chain (2): a → b");
  });

  test("chain mode during execution", () => {
    const title = buildToolTitle(
      "subagent",
      {
        chain: [
          { agent: "a", task: "t1" },
          { agent: "b", task: "t2" },
          { agent: "c", task: "t3" },
        ],
      },
      makeContext({
        toolCallState: makeToolCallState(
          makeSubagentRawOutput("chain", [
            makeSubagentResult({ agent: "a", exitCode: 0, step: 1 }),
            makeSubagentResult({
              agent: "b",
              exitCode: -1,
              step: 2,
              lastProgress: "→ read",
            }),
          ]),
        ),
      }),
    );
    expect(title).toBe("Chain (2/3): b — → read");
  });

  test("chain mode truncates long progress", () => {
    const longProgress = "x".repeat(50);
    const title = buildToolTitle(
      "subagent",
      {
        chain: [{ agent: "a", task: "t1" }],
      },
      makeContext({
        toolCallState: makeToolCallState(
          makeSubagentRawOutput("chain", [
            makeSubagentResult({
              agent: "a",
              exitCode: -1,
              step: 1,
              lastProgress: longProgress,
            }),
          ]),
        ),
      }),
    );
    expect(title).toBe(`Chain (1/1): a — ${longProgress.slice(0, 30)}…`);
  });

  test("chain mode completed", () => {
    const title = buildToolTitle(
      "subagent",
      {
        chain: [
          { agent: "a", task: "t1" },
          { agent: "b", task: "t2" },
        ],
      },
      makeContext({
        toolCallState: makeToolCallState(
          makeSubagentRawOutput("chain", [
            makeSubagentResult({ agent: "a", exitCode: 0, step: 1 }),
            makeSubagentResult({ agent: "b", exitCode: 0, step: 2 }),
          ]),
        ),
      }),
    );
    expect(title).toBe("Chain (2): completed");
  });

  test("chain mode failed at step", () => {
    const title = buildToolTitle(
      "subagent",
      {
        chain: [
          { agent: "a", task: "t1" },
          { agent: "b", task: "t2" },
        ],
      },
      makeContext({
        toolCallState: makeToolCallState(
          makeSubagentRawOutput("chain", [
            makeSubagentResult({ agent: "a", exitCode: 0, step: 1 }),
            makeSubagentResult({ agent: "b", exitCode: 1, step: 2 }),
          ]),
        ),
      }),
    );
    expect(title).toBe("Chain: failed at step 2 (b)");
  });

  test("chain mode preserves step 0", () => {
    const title = buildToolTitle(
      "subagent",
      {
        chain: [{ agent: "a", task: "t1" }],
      },
      makeContext({
        toolCallState: makeToolCallState(
          makeSubagentRawOutput("chain", [
            makeSubagentResult({ agent: "a", exitCode: -1, step: 0 }),
          ]),
        ),
      }),
    );
    expect(title).toBe("Chain (0/1): a");
  });

  test("chain mode empty chain array", () => {
    const title = buildToolTitle("subagent", { chain: [] });
    expect(title).toBe("Chain (0): ");
  });

  test("chain mode with no chain falls back", () => {
    const title = buildToolTitle("subagent", {});
    expect(title).toBe("Subagent");
  });

  // ---------------------------------------------------------------------------
  // Malformed input resilience
  // ---------------------------------------------------------------------------
  test("malformed rawOutput does not crash", () => {
    const title = buildToolTitle(
      "subagent",
      { agent: "foo", task: "bar" },
      makeContext({
        toolCallState: makeToolCallState({ garbage: true }),
      }),
    );
    expect(title).toBe("Subagent: foo");
  });

  test("malformed details does not crash", () => {
    const title = buildToolTitle(
      "subagent",
      { agent: "foo", task: "bar" },
      makeContext({
        toolCallState: makeToolCallState({
          content: [],
          details: { mode: "unknown", results: "bad" },
        }),
      }),
    );
    expect(title).toBe("Subagent: foo");
  });

  test("parallel with empty results and details", () => {
    const title = buildToolTitle(
      "subagent",
      {
        tasks: [{ agent: "a", task: "t1" }],
      },
      makeContext({
        toolCallState: makeToolCallState({
          content: [],
          details: { mode: "parallel", results: [] },
        }),
      }),
    );
    expect(title).toBe("Subagents (1): 0/1 done");
  });
});
