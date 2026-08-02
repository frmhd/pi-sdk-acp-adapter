import { describe, expect, test } from "vite-plus/test";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";

describe("OpenCode Go DeepSeek compat", () => {
  test("uses DeepSeek thinking controls and max effort mapping", async () => {
    const provider = opencodeGoProvider();
    const model = getBuiltinModel("opencode-go", "deepseek-v4-pro");
    let payload: any;

    const stream = provider.stream(
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
        reasoningEffort: "max",
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
