import { describe, expect, test, vi } from "vite-plus/test";

import {
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

  test("uses provider-qualified select values so duplicate model ids stay distinct (flat format)", () => {
    // By default (no clientInfo), we use flat format
    const option = createModelConfigOption(models, getModelOptionValue(models[1]), "azure") as any;
    const values = option.options.map((entry: any) => entry.value);

    expect(values).toEqual([getModelOptionValue(models[0]), getModelOptionValue(models[1])]);
    expect(new Set(values).size).toBe(2);
    expect(option.currentValue).toBe(getModelOptionValue(models[1]));
  });

  test("uses grouped format for Zed client", () => {
    const zedClientInfo = { name: "zed", version: "1.0.0" };
    const option = createModelConfigOption(
      models,
      getModelOptionValue(models[1]),
      "azure",
      zedClientInfo,
    ) as any;
    // Zed gets grouped options
    expect(option.options[0]).toHaveProperty("group");
    expect(option.options[0]).toHaveProperty("options");
    const values = option.options.flatMap((group: any) =>
      group.options.map((entry: any) => entry.value),
    );
    expect(values).toContain(getModelOptionValue(models[0]));
    expect(values).toContain(getModelOptionValue(models[1]));
  });

  test("findModelById resolves provider-qualified ACP values exactly", () => {
    expect(findModelById(getModelOptionValue(models[0]), models)).toBe(models[0]);
    expect(findModelById(getModelOptionValue(models[1]), models)).toBe(models[1]);
  });

  test("findModelById still supports legacy raw ids using current provider for fallback", () => {
    expect(findModelById("gpt-4.1", models, "azure")).toBe(models[1]);
    expect(findModelById("gpt-4.1", models, "openai")).toBe(models[0]);
  });

  test("filters thinking levels using model thinkingLevelMap", () => {
    const thinkingModel = {
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      provider: "deepseek",
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: null,
        medium: null,
        high: "high",
        xhigh: "max",
      },
    } as any;

    const options = getCurrentConfigOptions(
      {
        currentModelId: getModelOptionValue(thinkingModel),
        currentThinkingLevel: "medium",
        session: { state: { model: { provider: "deepseek" } } },
      } as any,
      [thinkingModel],
    );

    const thinkingOption = options.find((option) => option.id === "thinking_level") as any;
    expect(thinkingOption.currentValue).toBe("high");
    expect(thinkingOption.options.map((option: any) => option.value)).toEqual([
      "high",
      "xhigh",
      "max",
    ]);
  });

  test("setSessionConfigOption rejects thinking levels unsupported by current model", async () => {
    const thinkingModel = {
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      provider: "deepseek",
      reasoning: true,
      thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: "max" },
    } as any;
    const session = {
      currentModelId: getModelOptionValue(thinkingModel),
      session: {
        state: { model: { provider: "deepseek" } },
        setThinkingLevel: vi.fn(),
      },
    } as any;

    const result = await handleSetSessionConfigOption(
      { sessionId: "session-1", configId: "thinking_level", value: "medium" } as any,
      session,
      [thinkingModel],
    );

    expect(result).toEqual({
      applied: false,
      error: "Thinking level not supported by current model: medium",
    });
    expect(session.session.setThinkingLevel).not.toHaveBeenCalled();
  });

  test("setSessionConfigOption clamps thinking level after changing to a model with fewer levels", async () => {
    const currentModel = {
      id: "gpt-5",
      name: "GPT-5",
      provider: "openai",
      reasoning: true,
    } as any;
    const nextModel = {
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      provider: "deepseek",
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: null,
        medium: null,
        high: "high",
        xhigh: "max",
      },
    } as any;
    const session = {
      currentModelId: getModelOptionValue(currentModel),
      currentThinkingLevel: "medium",
      session: {
        state: { model: { provider: "openai" } },
        setModel: vi.fn(async () => undefined),
        setThinkingLevel: vi.fn(),
      },
    } as any;

    const result = await handleSetSessionConfigOption(
      {
        sessionId: "session-1",
        configId: "model",
        value: getModelOptionValue(nextModel),
      } as any,
      session,
      [currentModel, nextModel],
    );

    expect(result).toEqual({ applied: true });
    expect(session.session.setModel).toHaveBeenCalledWith(nextModel);
    expect(session.session.setThinkingLevel).toHaveBeenCalledWith("high");
    expect(session.currentThinkingLevel).toBe("high");
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
});
