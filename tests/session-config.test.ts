import { describe, expect, test, vi } from "vite-plus/test";

import {
  USAGE_CONFIG_OPTION_ID,
  createModelConfigOption,
  findModelById,
  getCurrentConfigOptions,
  getModelOptionValue,
  handleSetSessionConfigOption,
} from "../src/adapter/AcpSessionConfig.ts";

describe("ACP session config model values", () => {
  const models = [
    {
      id: "gpt-4.1",
      name: "GPT-4.1",
      provider: "openai",
      reasoning: true,
    },
    {
      id: "gpt-4.1",
      name: "GPT-4.1",
      provider: "azure",
      reasoning: true,
    },
  ] as any[];

  test("uses provider-qualified select values so duplicate model ids stay distinct", () => {
    const option = createModelConfigOption(models, getModelOptionValue(models[1]), "azure") as any;
    const values = option.options.flatMap((group: any) =>
      group.options.map((entry: any) => entry.value),
    );

    expect(values).toEqual([getModelOptionValue(models[0]), getModelOptionValue(models[1])]);
    expect(new Set(values).size).toBe(2);
    expect(option.currentValue).toBe(getModelOptionValue(models[1]));
  });

  test("findModelById resolves provider-qualified ACP values exactly", () => {
    expect(findModelById(getModelOptionValue(models[0]), models)).toBe(models[0]);
    expect(findModelById(getModelOptionValue(models[1]), models)).toBe(models[1]);
  });

  test("findModelById still supports legacy raw ids using current provider for fallback", () => {
    expect(findModelById("gpt-4.1", models, "azure")).toBe(models[1]);
    expect(findModelById("gpt-4.1", models, "openai")).toBe(models[0]);
  });

  test("includes a read-only usage display config option", () => {
    const options = getCurrentConfigOptions(
      {
        currentModelId: getModelOptionValue(models[0]),
        currentThinkingLevel: "medium",
        session: {
          state: {
            model: {
              provider: "openai",
              contextWindow: 200_000,
            },
          },
          getContextUsage: () => ({
            tokens: 17_400,
            contextWindow: 200_000,
            percent: 8.7,
          }),
          getSessionStats: () => ({
            tokens: {
              input: 14_000,
              output: 3_400,
              cacheRead: 114_000,
              cacheWrite: 0,
              total: 17_400,
            },
            cost: 0.015,
          }),
        },
      } as any,
      models,
    );

    const usageOption = options.find((option) => option.id === USAGE_CONFIG_OPTION_ID) as any;

    expect(usageOption).toBeDefined();
    expect(usageOption.name).toBe("Usage");
    expect(usageOption.currentValue).toBe("current");
    expect(usageOption.options).toEqual([
      expect.objectContaining({
        value: "current",
        name: "17k/200k · 8.7%",
      }),
    ]);
    expect(usageOption.description).toContain("↑14k");
    expect(usageOption.description).toContain("↓3.4k");
    expect(usageOption.description).toContain("R114k");
    expect(usageOption.description).toContain("$0.015");
  });

  test("setSessionConfigOption canonicalizes the stored model value after selection", async () => {
    const session = {
      currentModelId: undefined,
      session: {
        state: {
          model: {
            provider: "azure",
          },
        },
        setModel: vi.fn(async () => undefined),
      },
    } as any;

    const result = await handleSetSessionConfigOption(
      {
        sessionId: "session-1",
        configId: "model",
        value: "gpt-4.1",
      } as any,
      session,
      models,
    );

    expect(result).toEqual({ applied: true });
    expect(session.session.setModel).toHaveBeenCalledWith(models[1]);
    expect(session.currentModelId).toBe(getModelOptionValue(models[1]));
  });

  test("setSessionConfigOption treats usage display option as a no-op", async () => {
    const result = await handleSetSessionConfigOption(
      {
        sessionId: "session-1",
        configId: USAGE_CONFIG_OPTION_ID,
        value: "current",
      } as any,
      {
        session: null,
      } as any,
      models,
    );

    expect(result).toEqual({ applied: true });
  });
});
