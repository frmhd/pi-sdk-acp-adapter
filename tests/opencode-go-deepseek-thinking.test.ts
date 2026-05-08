import { describe, expect, test } from "vite-plus/test";
import { getModel } from "../node_modules/@earendil-works/pi-ai/dist/models.js";
import { streamSimpleOpenAICompletions } from "../node_modules/@earendil-works/pi-ai/dist/providers/openai-completions.js";

describe("OpenCode Go DeepSeek compat", () => {
  test("uses DeepSeek thinking controls and xhigh effort mapping", async () => {
    const model = getModel("opencode-go", "deepseek-v4-pro");
    let payload: any;

    const stream = streamSimpleOpenAICompletions(
      model,
      {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "ping" }],
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: "test",
        reasoning: "xhigh",
        onPayload: async (nextPayload) => {
          payload = nextPayload;
          throw new Error("STOP_AFTER_PAYLOAD");
        },
      },
    );

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("STOP_AFTER_PAYLOAD");
    expect(payload).toEqual(
      expect.objectContaining({
        thinking: { type: "enabled" },
        reasoning_effort: "max",
      }),
    );
  });
});
