import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { mapToolExecutionUpdate } from "../src/adapter/AcpEventMapper.ts";
import { installToolDisplayTracking } from "../src/runtime/installToolDisplayTracking.ts";

// Wrap readFile in a call-through spy so snapshot-read behavior is observable.
// Inline factory — no top-level variable references (vitest hoists vi.mock).
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("node:fs/promises");
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

function createFakeAgent(overrides: Record<string, unknown> = {}) {
  return {
    beforeToolCall: vi.fn(async () => undefined),
    afterToolCall: vi.fn(async () => undefined),
    ...overrides,
  } as any;
}

describe("ACP display tracking", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function createTempProject() {
    const root = await mkdtemp(join(tmpdir(), "pi-acp-edit-progress-"));
    tempDirs.push(root);

    const cwd = join(root, "project");
    await mkdir(cwd, { recursive: true });

    return { root, cwd };
  }

  function beforeContext(toolCallId: string, toolName: string, args: Record<string, unknown>) {
    return {
      toolCall: { id: toolCallId, name: toolName, arguments: args },
      args,
    } as any;
  }

  function afterContext(
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
    result: unknown,
    isError = false,
  ) {
    return {
      toolCall: { id: toolCallId, name: toolName, arguments: args },
      args,
      result,
      isError,
    } as any;
  }

  test("write captures creation diff when the file does not exist", async () => {
    const { cwd } = await createTempProject();
    const filePath = join(cwd, "new-file.ts");
    const capturedState = vi.fn();
    const agent = createFakeAgent();

    installToolDisplayTracking({ agent, cwd, onToolCallStateCaptured: capturedState });

    await agent.beforeToolCall(
      beforeContext("tool-1", "write", { path: "new-file.ts", content: "hello" }),
      undefined,
    );

    await writeFile(filePath, "hello", "utf-8");
    await agent.afterToolCall(
      afterContext(
        "tool-1",
        "write",
        { path: "new-file.ts", content: "hello" },
        {
          content: [{ type: "text", text: "wrote" }],
          details: {},
        },
      ),
      undefined,
    );

    expect(capturedState).toHaveBeenCalledWith(
      "tool-1",
      expect.objectContaining({
        diff: { path: filePath, oldText: null, newText: "hello" },
      }),
    );
  });

  test("write captures replace diff with before/after file state", async () => {
    const { cwd } = await createTempProject();
    const filePath = join(cwd, "file.ts");
    await writeFile(filePath, "old-content", "utf-8");

    const capturedState = vi.fn();
    const agent = createFakeAgent();

    installToolDisplayTracking({ agent, cwd, onToolCallStateCaptured: capturedState });

    await agent.beforeToolCall(
      beforeContext("tool-1", "write", { path: "file.ts", content: "new-content" }),
      undefined,
    );

    await writeFile(filePath, "new-content", "utf-8");
    await agent.afterToolCall(
      afterContext(
        "tool-1",
        "write",
        { path: "file.ts", content: "new-content" },
        {
          content: [{ type: "text", text: "wrote" }],
          details: {},
        },
      ),
      undefined,
    );

    expect(capturedState).toHaveBeenCalledWith(
      "tool-1",
      expect.objectContaining({
        diff: { path: filePath, oldText: "old-content", newText: "new-content" },
      }),
    );
  });

  test("edit captures full-file before/after state and firstChangedLine", async () => {
    const { cwd } = await createTempProject();
    const filePath = join(cwd, "file.ts");
    await writeFile(filePath, "before\nline2\nline3\n", "utf-8");

    const capturedState = vi.fn();
    const agent = createFakeAgent();

    installToolDisplayTracking({ agent, cwd, onToolCallStateCaptured: capturedState });

    await agent.beforeToolCall(
      beforeContext("tool-1", "edit", {
        path: "file.ts",
        edits: [{ oldText: "before", newText: "after" }],
      }),
      undefined,
    );

    await writeFile(filePath, "after\nline2\nline3\n", "utf-8");
    await agent.afterToolCall(
      afterContext(
        "tool-1",
        "edit",
        { path: "file.ts" },
        {
          content: [{ type: "text", text: "edited" }],
          details: { firstChangedLine: 1 },
        },
      ),
      undefined,
    );

    expect(capturedState).toHaveBeenCalledWith(
      "tool-1",
      expect.objectContaining({
        diff: {
          path: filePath,
          oldText: "before\nline2\nline3\n",
          newText: "after\nline2\nline3\n",
        },
        firstChangedLine: 1,
      }),
    );
  });

  test("failed mutations do not emit successful diffs", async () => {
    const { cwd } = await createTempProject();
    const filePath = join(cwd, "file.ts");
    await writeFile(filePath, "before", "utf-8");

    const capturedState = vi.fn();
    const agent = createFakeAgent();

    installToolDisplayTracking({ agent, cwd, onToolCallStateCaptured: capturedState });

    await agent.beforeToolCall(
      beforeContext("tool-1", "edit", { path: "file.ts", edits: [{ oldText: "x", newText: "y" }] }),
      undefined,
    );

    await agent.afterToolCall(
      afterContext(
        "tool-1",
        "edit",
        { path: "file.ts" },
        {
          content: [{ type: "text", text: "no match" }],
          details: {},
        },
        true,
      ),
      undefined,
    );

    const diffCalls = capturedState.mock.calls.filter((call: any[]) => call[1]?.diff !== undefined);
    expect(diffCalls).toEqual([]);
  });

  test("snapshot read failures do not fail or alter Pi tool execution", async () => {
    const { cwd } = await createTempProject();
    const filePath = join(cwd, "file.ts");
    await writeFile(filePath, "before", "utf-8");

    const capturedState = vi.fn();
    const agent = createFakeAgent();

    installToolDisplayTracking({ agent, cwd, onToolCallStateCaptured: capturedState });

    // The before-hook read succeeds, but the after-hook read fails (file
    // removed by the "tool"). The tracker must not throw and must not emit a diff.
    await agent.beforeToolCall(
      beforeContext("tool-1", "edit", { path: "file.ts", edits: [{ oldText: "a", newText: "b" }] }),
      undefined,
    );

    await rm(filePath);
    await expect(
      agent.afterToolCall(
        afterContext(
          "tool-1",
          "edit",
          { path: "file.ts" },
          {
            content: [{ type: "text", text: "edited" }],
            details: { firstChangedLine: 1 },
          },
        ),
        undefined,
      ),
    ).resolves.toBeUndefined();

    const diffCalls = capturedState.mock.calls.filter((call: any[]) => call[1]?.diff !== undefined);
    expect(diffCalls).toEqual([]);
  });

  test("write falls back to input content when the post-read fails", async () => {
    const { cwd } = await createTempProject();
    const filePath = join(cwd, "file.ts");
    await writeFile(filePath, "before", "utf-8");

    const capturedState = vi.fn();
    const agent = createFakeAgent();

    installToolDisplayTracking({ agent, cwd, onToolCallStateCaptured: capturedState });

    await agent.beforeToolCall(
      beforeContext("tool-1", "write", { path: "file.ts", content: "new-content" }),
      undefined,
    );

    await rm(filePath);
    await agent.afterToolCall(
      afterContext(
        "tool-1",
        "write",
        { path: "file.ts", content: "new-content" },
        {
          content: [{ type: "text", text: "wrote" }],
          details: {},
        },
      ),
      undefined,
    );

    expect(capturedState).toHaveBeenCalledWith(
      "tool-1",
      expect.objectContaining({
        diff: { path: filePath, oldText: "before", newText: "new-content" },
      }),
    );
  });

  test("non-mutation path-bearing tools do not trigger snapshot reads", async () => {
    const { cwd } = await createTempProject();
    const filePath = join(cwd, "file.ts");
    await writeFile(filePath, "before", "utf-8");

    const capturedState = vi.fn();
    const agent = createFakeAgent();

    installToolDisplayTracking({ agent, cwd, onToolCallStateCaptured: capturedState });

    const readFileMock = vi.mocked(readFile);
    readFileMock.mockClear();

    // Path-bearing non-mutation tools (read) record display state only; they
    // must not trigger adapter filesystem snapshot reads.
    await agent.beforeToolCall(
      beforeContext("tool-1", "read", { file_path: "file.ts" }),
      undefined,
    );

    expect(readFileMock).not.toHaveBeenCalled();
    expect(capturedState).toHaveBeenCalledWith(
      "tool-1",
      expect.objectContaining({ toolName: "read", path: filePath }),
    );

    // Edit/write still snapshot the target before execution.
    await agent.beforeToolCall(
      beforeContext("tool-2", "edit", { path: "file.ts", edits: [{ oldText: "a", newText: "b" }] }),
      undefined,
    );
    expect(readFileMock).toHaveBeenCalledTimes(1);

    await agent.beforeToolCall(
      beforeContext("tool-3", "write", { path: "file.ts", content: "new" }),
      undefined,
    );
    expect(readFileMock).toHaveBeenCalledTimes(2);
  });

  test("concurrent tool-call IDs keep independent state", async () => {
    const { cwd } = await createTempProject();
    const fileA = join(cwd, "a.ts");
    const fileB = join(cwd, "b.ts");
    await writeFile(fileA, "old-a", "utf-8");
    await writeFile(fileB, "old-b", "utf-8");

    const capturedState = vi.fn();
    const agent = createFakeAgent();

    installToolDisplayTracking({ agent, cwd, onToolCallStateCaptured: capturedState });

    await agent.beforeToolCall(
      beforeContext("tool-1", "edit", { path: "a.ts", edits: [{ oldText: "x", newText: "y" }] }),
      undefined,
    );
    await agent.beforeToolCall(
      beforeContext("tool-2", "edit", { path: "b.ts", edits: [{ oldText: "x", newText: "y" }] }),
      undefined,
    );

    await writeFile(fileA, "new-a", "utf-8");
    await writeFile(fileB, "new-b", "utf-8");

    await agent.afterToolCall(
      afterContext(
        "tool-1",
        "edit",
        { path: "a.ts" },
        {
          content: [{ type: "text", text: "done a" }],
          details: { firstChangedLine: 4 },
        },
      ),
      undefined,
    );
    await agent.afterToolCall(
      afterContext(
        "tool-2",
        "edit",
        { path: "b.ts" },
        {
          content: [{ type: "text", text: "done b" }],
          details: { firstChangedLine: 9 },
        },
      ),
      undefined,
    );

    expect(capturedState).toHaveBeenCalledWith(
      "tool-1",
      expect.objectContaining({
        diff: { path: fileA, oldText: "old-a", newText: "new-a" },
        firstChangedLine: 4,
      }),
    );
    expect(capturedState).toHaveBeenCalledWith(
      "tool-2",
      expect.objectContaining({
        diff: { path: fileB, oldText: "old-b", newText: "new-b" },
        firstChangedLine: 9,
      }),
    );
  });

  test("pre-existing Pi extension hooks are invoked and blocking behavior is preserved", async () => {
    const { cwd } = await createTempProject();
    const filePath = join(cwd, "file.ts");
    await writeFile(filePath, "before", "utf-8");

    const capturedState = vi.fn();
    const extensionBefore = vi.fn(async (_ctx: any): Promise<any> => undefined);
    const extensionAfter = vi.fn(async () => ({ content: [{ type: "text", text: "rewritten" }] }));
    const agent = createFakeAgent({
      beforeToolCall: extensionBefore,
      afterToolCall: extensionAfter,
    });

    installToolDisplayTracking({ agent, cwd, onToolCallStateCaptured: capturedState });

    // Blocked before hooks must prevent tracker state capture and execution.
    extensionBefore.mockResolvedValueOnce({ block: true, reason: "denied by extension" });
    const beforeResult = await agent.beforeToolCall(
      beforeContext("tool-1", "edit", { path: "file.ts", edits: [{ oldText: "a", newText: "b" }] }),
      undefined,
    );

    expect(beforeResult).toEqual({ block: true, reason: "denied by extension" });
    expect(extensionBefore).toHaveBeenCalledTimes(1);
    expect(capturedState).not.toHaveBeenCalled();

    // Non-blocking before hooks still capture state.
    extensionBefore.mockResolvedValueOnce(undefined);
    await agent.beforeToolCall(
      beforeContext("tool-2", "edit", { path: "file.ts", edits: [{ oldText: "a", newText: "b" }] }),
      undefined,
    );

    expect(capturedState).toHaveBeenCalledWith(
      "tool-2",
      expect.objectContaining({ toolName: "edit", path: filePath }),
    );

    // After hooks run first and their result rewrites are preserved.
    await writeFile(filePath, "after", "utf-8");
    const afterResult = await agent.afterToolCall(
      afterContext(
        "tool-2",
        "edit",
        { path: "file.ts" },
        {
          content: [{ type: "text", text: "executed" }],
          details: { firstChangedLine: 2 },
        },
      ),
      undefined,
    );

    expect(afterResult).toEqual({ content: [{ type: "text", text: "rewritten" }] });
    expect(extensionAfter).toHaveBeenCalledTimes(1);
    expect(capturedState).toHaveBeenCalledWith(
      "tool-2",
      expect.objectContaining({
        diff: { path: filePath, oldText: "before", newText: "after" },
        firstChangedLine: 2,
      }),
    );
  });

  test("extension isError overrides drive diff capture", async () => {
    const { cwd } = await createTempProject();
    const filePath = join(cwd, "file.ts");
    await writeFile(filePath, "before", "utf-8");

    const capturedState = vi.fn();
    const extensionAfter = vi.fn(async () => ({ isError: false }));
    const agent = createFakeAgent({ afterToolCall: extensionAfter });

    installToolDisplayTracking({ agent, cwd, onToolCallStateCaptured: capturedState });

    await agent.beforeToolCall(
      beforeContext("tool-1", "edit", { path: "file.ts", edits: [{ oldText: "a", newText: "b" }] }),
      undefined,
    );

    await writeFile(filePath, "after", "utf-8");
    await agent.afterToolCall(
      afterContext(
        "tool-1",
        "edit",
        { path: "file.ts" },
        {
          content: [{ type: "text", text: "failed" }],
          details: {},
        },
        true, // executed result errored...
      ),
      undefined,
    );

    // ...but the extension rewrote it as success, so the diff must render.
    expect(capturedState).toHaveBeenCalledWith(
      "tool-1",
      expect.objectContaining({
        diff: { path: filePath, oldText: "before", newText: "after" },
      }),
    );
  });

  test("extension isError overrides suppress diffs on executed successes", async () => {
    const { cwd } = await createTempProject();
    const filePath = join(cwd, "file.ts");
    await writeFile(filePath, "before", "utf-8");

    const capturedState = vi.fn();
    const extensionAfter = vi.fn(async () => ({ isError: true }));
    const agent = createFakeAgent({ afterToolCall: extensionAfter });

    installToolDisplayTracking({ agent, cwd, onToolCallStateCaptured: capturedState });

    await agent.beforeToolCall(
      beforeContext("tool-1", "edit", { path: "file.ts", edits: [{ oldText: "a", newText: "b" }] }),
      undefined,
    );

    await writeFile(filePath, "after", "utf-8");
    await agent.afterToolCall(
      afterContext(
        "tool-1",
        "edit",
        { path: "file.ts" },
        {
          content: [{ type: "text", text: "ok" }],
          details: { firstChangedLine: 1 },
        },
      ),
      undefined,
    );

    const diffCalls = capturedState.mock.calls.filter((call: any[]) => call[1]?.diff !== undefined);
    expect(diffCalls).toEqual([]);
  });

  test("extension details overrides drive firstChangedLine capture", async () => {
    const { cwd } = await createTempProject();
    const filePath = join(cwd, "file.ts");
    await writeFile(filePath, "before", "utf-8");

    const capturedState = vi.fn();
    const extensionAfter = vi.fn(async () => ({ details: { firstChangedLine: 7 } }));
    const agent = createFakeAgent({ afterToolCall: extensionAfter });

    installToolDisplayTracking({ agent, cwd, onToolCallStateCaptured: capturedState });

    await agent.beforeToolCall(
      beforeContext("tool-1", "edit", { path: "file.ts", edits: [{ oldText: "a", newText: "b" }] }),
      undefined,
    );

    await writeFile(filePath, "after", "utf-8");
    await agent.afterToolCall(
      afterContext(
        "tool-1",
        "edit",
        { path: "file.ts" },
        {
          content: [{ type: "text", text: "ok" }],
          details: { firstChangedLine: 2 },
        },
      ),
      undefined,
    );

    // The extension's details replace the executed result details in full.
    expect(capturedState).toHaveBeenCalledWith(
      "tool-1",
      expect.objectContaining({
        diff: { path: filePath, oldText: "before", newText: "after" },
        firstChangedLine: 7,
      }),
    );
  });

  test("tracker cleanup restores prior hooks", async () => {
    const { cwd } = await createTempProject();
    const beforeHook = vi.fn(async () => undefined);
    const afterHook = vi.fn(async () => undefined);
    const agent = createFakeAgent({
      beforeToolCall: beforeHook,
      afterToolCall: afterHook,
    });

    const stop = installToolDisplayTracking({ agent, cwd });

    expect(agent.beforeToolCall).not.toBe(beforeHook);
    expect(agent.afterToolCall).not.toBe(afterHook);

    stop();

    expect(agent.beforeToolCall).toBe(beforeHook);
    expect(agent.afterToolCall).toBe(afterHook);
  });
});

describe("edit progress mapping", () => {
  test("maps edit progress updates to in_progress diff content", () => {
    const notification = mapToolExecutionUpdate(
      "session-1",
      {
        toolCallId: "tool-1",
        toolName: "edit",
        partialResult: { content: [], details: undefined },
      },
      {
        toolCallState: {
          toolName: "edit",
          diff: {
            path: "/workspace/project/src/file.ts",
            oldText: "before",
            newText: "after",
          },
        },
      },
    );

    expect((notification.update as any).status).toBe("in_progress");
    expect((notification.update as any).content).toEqual([
      {
        type: "diff",
        path: "/workspace/project/src/file.ts",
        oldText: "before",
        newText: "after",
        _meta: { kind: "edit" },
      },
    ]);
  });
});
