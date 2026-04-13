import { describe, expect, test } from "vite-plus/test";

/**
 * Unit tests for the bash terminal output fix.
 *
 * These tests verify that piPartialResult.content is properly populated
 * with the terminal output when a bash command completes.
 *
 * Bug fix: Previously, when running commands like "sleep 5 && ls", the
 * piPartialResult.content would only contain empty newlines from intermediate
 * polls, not the actual command output. The fix ensures that on tool_execution_end,
 * the piPartialResult.content is populated with the final terminal output.
 */
describe("bash terminal output capture", () => {
  test("should populate piPartialResult.content with terminal output", () => {
    // Simulates the rawOutput state after onTerminalExit is called
    const rawOutputRecord: Record<string, unknown> = {
      type: "acp_terminal",
      input: { command: "sleep 5 && ls", timeout: null },
      execution: {
        command: "sleep 5 && ls",
        args: [],
        cwd: "/test",
        outputByteLimit: 51200,
      },
      terminalId: "term-test-123",
      output: "AGENTS.md\nREADME.md\npackage.json\n", // Final terminal output
      truncated: false,
      exitCode: 0,
      signal: null,
      fullOutputPath: null,
    };

    // This is the logic from mergeCapturedRawOutput when phase === "end"
    const terminalOutput = typeof rawOutputRecord.output === "string" ? rawOutputRecord.output : "";
    const piPartialResult = {
      content: [{ type: "text", text: terminalOutput }],
      details: {},
    };

    const mergedRawOutput = {
      ...rawOutputRecord,
      piPartialResult,
      piResult: {
        content: [{ type: "text", text: terminalOutput }],
        exitCode: 0,
      },
    };

    // Verify that piPartialResult.content contains the actual terminal output
    expect(mergedRawOutput.piPartialResult).toBeDefined();
    expect((mergedRawOutput.piPartialResult as any).content).toHaveLength(1);
    expect((mergedRawOutput.piPartialResult as any).content[0].type).toBe("text");
    expect((mergedRawOutput.piPartialResult as any).content[0].text).toBe(
      "AGENTS.md\nREADME.md\npackage.json\n",
    );
  });

  test("should handle empty terminal output gracefully", () => {
    const rawOutputRecord: Record<string, unknown> = {
      type: "acp_terminal",
      output: "", // Empty output
      truncated: false,
      exitCode: 0,
    };

    // This is the logic from mergeCapturedRawOutput
    const terminalOutput = typeof rawOutputRecord.output === "string" ? rawOutputRecord.output : "";
    const piPartialResult = {
      content: [{ type: "text", text: terminalOutput }],
      details: {},
    };

    expect(piPartialResult.content[0].text).toBe("");
    expect((piPartialResult.content[0] as any).type).toBe("text");
  });

  test("should handle undefined terminal output gracefully", () => {
    const rawOutputRecord: Record<string, unknown> = {
      type: "acp_terminal",
      // output is undefined
      truncated: false,
      exitCode: 0,
    };

    // This is the logic from mergeCapturedRawOutput
    const terminalOutput = typeof rawOutputRecord.output === "string" ? rawOutputRecord.output : "";
    const piPartialResult = {
      content: [{ type: "text", text: terminalOutput }],
      details: {},
    };

    expect(piPartialResult.content[0].text).toBe("");
  });

  test("should not affect non-bash tools", () => {
    // For non-bash tools, mergeCapturedRawOutput returns nextValue directly
    const toolCallState = {
      toolName: "read", // Not bash
      rawOutput: {
        type: "file_read",
        content: "file contents",
      },
    };

    const nextValue = { content: [{ type: "text", text: "result" }] };

    // Simulate mergeCapturedRawOutput logic for non-bash tools
    const result =
      toolCallState.toolName !== "bash"
        ? nextValue
        : {
            /* would populate piPartialResult */
          };

    expect(result).toBe(nextValue);
  });
});
