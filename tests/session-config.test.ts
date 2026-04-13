import { describe, expect, test, vi } from "vite-plus/test";

import {
  createModelConfigOption,
  findModelById,
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
