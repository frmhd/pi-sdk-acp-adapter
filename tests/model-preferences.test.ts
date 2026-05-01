import { describe, expect, test, vi, beforeEach } from "vite-plus/test";

import {
  getModelOptionValue,
  handleSetSessionConfigOption,
} from "../src/adapter/AcpSessionConfig.ts";

// ---------------------------------------------------------------------------
// Mock fs/promises so the preferences store never touches the real filesystem.
// Inline factory — no top-level variable references (vitest hoists vi.mock).
// ---------------------------------------------------------------------------
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  rename: vi.fn(),
}));

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import {
  loadModelPreferences,
  getModelThinkingPreference,
  setModelThinkingPreference,
  cleanupModelPreferences,
  resetModelPreferencesCache,
} from "../src/adapter/session/modelPreferences.js";

const PREFERENCES_FILE = `${homedir()}/.pi/agent/model-thinking-preferences.json`;

// ---- Model fixtures --------------------------------------------------------
const gpt4Model = {
  id: "gpt-4.1",
  name: "GPT-4.1",
  provider: "openai",
  reasoning: true,
} as any;

const claudeModel = {
  id: "claude-sonnet-4-5",
  name: "Claude Sonnet 4.5",
  provider: "anthropic",
  reasoning: true,
} as any;

const deepseekModel = {
  id: "deepseek-chat",
  name: "DeepSeek Chat",
  provider: "deepseek",
  reasoning: true,
} as any;

const gpt4ModelId = getModelOptionValue(gpt4Model);
const claudeModelId = getModelOptionValue(claudeModel);
const deepseekModelId = getModelOptionValue(deepseekModel);

const availableModels = [gpt4Model, claudeModel, deepseekModel];

/** Fully reset the in-memory cache + filesystem store between tests. */
function resetStore(fsStore: Record<string, string>) {
  Object.keys(fsStore).forEach((key) => delete fsStore[key]);
  resetModelPreferencesCache();
}

/**
 * Configure mocks for the filesystem-based preference store.
 * Shared between both describe blocks.
 */
function setupFsMocks(fsStore: Record<string, string>) {
  resetStore(fsStore);

  (vi.mocked(readFile) as any).mockImplementation(async (path: string) => {
    const content = fsStore[path];
    if (content === undefined) {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }
    return content;
  });

  (vi.mocked(writeFile) as any).mockImplementation(async (path: string, data: string) => {
    fsStore[path] = data;
  });

  vi.mocked(mkdir).mockImplementation(async () => undefined);

  (vi.mocked(rename) as any).mockImplementation(async (oldPath: string, newPath: string) => {
    fsStore[newPath] = fsStore[oldPath];
    delete fsStore[oldPath];
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("modelPreferences store", () => {
  const fsStore: Record<string, string> = {};

  beforeEach(() => {
    setupFsMocks(fsStore);
  });

  test("loadModelPreferences returns empty object when file does not exist", async () => {
    const prefs = await loadModelPreferences();
    expect(prefs).toEqual({});
  });

  test("loadModelPreferences parses valid preferences from file", async () => {
    fsStore[PREFERENCES_FILE] = JSON.stringify({
      [gpt4ModelId]: "high",
      [claudeModelId]: "xhigh",
    });

    resetModelPreferencesCache();

    const prefs = await loadModelPreferences();
    expect(prefs).toEqual({
      [gpt4ModelId]: "high",
      [claudeModelId]: "xhigh",
    });
  });

  test("loadModelPreferences filters out invalid thinking levels", async () => {
    fsStore[PREFERENCES_FILE] = JSON.stringify({
      [gpt4ModelId]: "high",
      [claudeModelId]: "nonexistent_level",
      [deepseekModelId]: 123,
    });

    resetModelPreferencesCache();

    const prefs = await loadModelPreferences();
    expect(prefs).toEqual({
      [gpt4ModelId]: "high",
    });
  });

  test("loadModelPreferences returns empty object on malformed JSON", async () => {
    fsStore[PREFERENCES_FILE] = "not valid json {{{";

    resetModelPreferencesCache();

    const prefs = await loadModelPreferences();
    expect(prefs).toEqual({});
  });

  test("getModelThinkingPreference returns undefined for unknown model", async () => {
    const level = await getModelThinkingPreference(gpt4ModelId);
    expect(level).toBeUndefined();
  });

  test("setModelThinkingPreference saves and can be retrieved", async () => {
    await setModelThinkingPreference(gpt4ModelId, "xhigh");

    resetModelPreferencesCache();

    const level = await getModelThinkingPreference(gpt4ModelId);
    expect(level).toBe("xhigh");
  });

  test("setModelThinkingPreference persists valid JSON to the file", async () => {
    await setModelThinkingPreference(claudeModelId, "low");

    const written = fsStore[PREFERENCES_FILE];
    expect(written).toBeDefined();

    const parsed = JSON.parse(written!);
    expect(parsed[claudeModelId]).toBe("low");
  });

  test("concurrent setModelThinkingPreference calls do not lose data", async () => {
    await Promise.all([
      setModelThinkingPreference(gpt4ModelId, "high"),
      setModelThinkingPreference(claudeModelId, "xhigh"),
      setModelThinkingPreference(deepseekModelId, "off"),
    ]);

    resetModelPreferencesCache();

    expect(await getModelThinkingPreference(gpt4ModelId)).toBe("high");
    expect(await getModelThinkingPreference(claudeModelId)).toBe("xhigh");
    expect(await getModelThinkingPreference(deepseekModelId)).toBe("off");
  });

  test("loadModelPreferences warns and disables writes on non-ENOENT errors", async () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const err = new Error("EACCES") as NodeJS.ErrnoException;
    err.code = "EACCES";

    (vi.mocked(readFile) as any).mockRejectedValueOnce(err);

    const prefs = await loadModelPreferences();
    expect(prefs).toEqual({});
    expect(consoleSpy).toHaveBeenCalledWith("Failed to load model thinking preferences:", err);

    // Subsequent write should be skipped
    await setModelThinkingPreference(gpt4ModelId, "high");
    expect(fsStore[PREFERENCES_FILE]).toBeUndefined();

    consoleSpy.mockRestore();
  });

  test("cleanupModelPreferences removes entries not in available set", async () => {
    await setModelThinkingPreference(gpt4ModelId, "medium");
    await setModelThinkingPreference(claudeModelId, "xhigh");
    await setModelThinkingPreference(deepseekModelId, "off");

    const available = new Set([gpt4ModelId, claudeModelId]);
    await cleanupModelPreferences(available);

    resetModelPreferencesCache();

    expect(await getModelThinkingPreference(deepseekModelId)).toBeUndefined();
    expect(await getModelThinkingPreference(gpt4ModelId)).toBe("medium");
    expect(await getModelThinkingPreference(claudeModelId)).toBe("xhigh");
  });

  test("cleanupModelPreferences keeps all entries when all are available", async () => {
    await setModelThinkingPreference(gpt4ModelId, "medium");
    await setModelThinkingPreference(claudeModelId, "high");

    const available = new Set([gpt4ModelId, claudeModelId]);
    await cleanupModelPreferences(available);

    resetModelPreferencesCache();

    expect(await getModelThinkingPreference(gpt4ModelId)).toBe("medium");
    expect(await getModelThinkingPreference(claudeModelId)).toBe("high");
  });
});

describe("modelPreferences integration with configHandlers", () => {
  const fsStore: Record<string, string> = {};

  beforeEach(() => {
    setupFsMocks(fsStore);
  });

  test("applyModelConfigChange restores saved thinking level for new model", async () => {
    await setModelThinkingPreference(deepseekModelId, "xhigh");

    const session = {
      currentModelId: gpt4ModelId,
      currentThinkingLevel: "medium",
      session: {
        state: { model: { provider: "openai" } },
        setModel: vi.fn(async () => undefined),
        setThinkingLevel: vi.fn(),
      },
    } as any;

    const result = await handleSetSessionConfigOption(
      { sessionId: "s1", configId: "model", value: deepseekModelId } as any,
      session,
      availableModels,
    );

    expect(result).toEqual({ applied: true });
    expect(session.currentModelId).toBe(deepseekModelId);
    expect(session.session.setThinkingLevel).toHaveBeenCalledWith("xhigh");
    expect(session.currentThinkingLevel).toBe("xhigh");
  });

  test("applyModelConfigChange does not change thinking level when no preference saved", async () => {
    const session = {
      currentModelId: gpt4ModelId,
      currentThinkingLevel: "medium",
      session: {
        state: { model: { provider: "openai" } },
        setModel: vi.fn(async () => undefined),
        setThinkingLevel: vi.fn(),
      },
    } as any;

    const result = await handleSetSessionConfigOption(
      { sessionId: "s1", configId: "model", value: claudeModelId } as any,
      session,
      availableModels,
    );

    expect(result).toEqual({ applied: true });
    expect(session.currentModelId).toBe(claudeModelId);
    expect(session.session.setThinkingLevel).not.toHaveBeenCalled();
  });

  test("applyThinkingLevelConfigChange saves preference for current model", async () => {
    const session = {
      currentModelId: deepseekModelId,
      session: {
        setThinkingLevel: vi.fn(),
      },
    } as any;

    const result = await handleSetSessionConfigOption(
      { sessionId: "s1", configId: "thinking_level", value: "xhigh" } as any,
      session,
      availableModels,
    );

    expect(result).toEqual({ applied: true });
    expect(session.currentThinkingLevel).toBe("xhigh");
    expect(session.session.setThinkingLevel).toHaveBeenCalledWith("xhigh");

    resetModelPreferencesCache();
    const saved = await getModelThinkingPreference(deepseekModelId);
    expect(saved).toBe("xhigh");
  });

  test("applyThinkingLevelConfigChange does not save preference when no model selected", async () => {
    const session = {
      currentModelId: undefined,
      session: {
        setThinkingLevel: vi.fn(),
      },
    } as any;

    await handleSetSessionConfigOption(
      { sessionId: "s1", configId: "thinking_level", value: "low" } as any,
      session,
      availableModels,
    );

    const content = Object.values(fsStore).join();
    expect(content).toBe("");
  });

  test("applyModelConfigChange does not clean up stale model preferences", async () => {
    const staleModelId = JSON.stringify({ provider: "old-provider", id: "old-model" });
    await setModelThinkingPreference(gpt4ModelId, "high");
    await setModelThinkingPreference(staleModelId, "xhigh");

    const session = {
      currentModelId: undefined,
      currentThinkingLevel: "medium",
      session: {
        state: { model: { provider: "openai" } },
        setModel: vi.fn(async () => undefined),
        setThinkingLevel: vi.fn(),
      },
    } as any;

    await handleSetSessionConfigOption(
      { sessionId: "s1", configId: "model", value: gpt4ModelId } as any,
      session,
      availableModels,
    );

    resetModelPreferencesCache();
    // Preferences should NOT be cleaned up on model change to avoid losing
    // data for temporarily unavailable providers.
    expect(await getModelThinkingPreference(staleModelId)).toBe("xhigh");
    expect(await getModelThinkingPreference(gpt4ModelId)).toBe("high");
  });
});
