import { describe, expect, test } from "vite-plus/test";
import { convertMessages } from "../node_modules/@earendil-works/pi-ai/dist/providers/openai-completions.js";

const deepseekModel = {
  api: "openai-completions",
  provider: "deepseek",
  id: "deepseek-v4-pro",
  reasoning: true,
  thinkingLevelMap: { high: "high", xhigh: "max" },
  input: ["text"],
} as any;

const deepseekCompat = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: true,
  supportsUsageInStreaming: true,
  maxTokensField: "max_completion_tokens",
  requiresToolResultName: false,
  requiresAssistantAfterToolResult: false,
  requiresThinkingAsText: false,
  requiresReasoningContentOnAssistantMessages: true,
  thinkingFormat: "deepseek",
  openRouterRouting: {},
  vercelGatewayRouting: {},
  zaiToolStream: false,
  supportsStrictMode: true,
  cacheControlFormat: undefined,
  sendSessionAffinityHeaders: false,
  supportsLongCacheRetention: true,
} as any;

function buildContext(assistantContent: any[]) {
  return {
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "seed" }],
        timestamp: Date.now(),
      },
      {
        role: "assistant",
        api: "openai-completions",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        stopReason: "toolUse",
        timestamp: Date.now(),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        content: assistantContent,
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        isError: false,
        timestamp: Date.now(),
        content: [{ type: "text", text: "ok" }],
      },
    ],
  } as any;
}

describe("DeepSeek reasoning_content replay", () => {
  test("replays tool-call-only assistant turns with empty reasoning_content", () => {
    const messages = convertMessages(
      deepseekModel,
      buildContext([
        {
          type: "toolCall",
          id: "call_1",
          name: "read",
          arguments: { path: "/tmp/x", offset: 1, limit: 1 },
        },
      ]),
      deepseekCompat,
    );

    expect(messages[1]).toEqual(
      expect.objectContaining({
        role: "assistant",
        content: "",
        reasoning_content: "",
        tool_calls: [
          expect.objectContaining({
            id: "call_1",
            type: "function",
            function: expect.objectContaining({
              name: "read",
              arguments: '{"path":"/tmp/x","offset":1,"limit":1}',
            }),
          }),
        ],
      }),
    );
  });

  test("preserves reasoning_content when the assistant turn already has thinking", () => {
    const messages = convertMessages(
      deepseekModel,
      buildContext([
        {
          type: "thinking",
          thinking: "I will call a tool.",
          thinkingSignature: "reasoning_content",
        },
        {
          type: "toolCall",
          id: "call_1",
          name: "read",
          arguments: { path: "/tmp/x", offset: 1, limit: 1 },
        },
      ]),
      deepseekCompat,
    );

    expect(messages[1]).toEqual(
      expect.objectContaining({
        role: "assistant",
        content: "",
        reasoning_content: "I will call a tool.",
        tool_calls: [
          expect.objectContaining({
            id: "call_1",
            type: "function",
            function: expect.objectContaining({
              name: "read",
            }),
          }),
        ],
      }),
    );
  });
});
