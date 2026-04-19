import { describe, expect, test, vi } from "vite-plus/test";

import {
  createMockConnection,
  createMockSession,
  createTestAgent,
} from "../helpers/testDoubles.ts";

describe("ACP slash commands", () => {
  test("advertises Pi slash commands with available_commands_update on new sessions", async () => {
    vi.useFakeTimers();

    try {
      const connection = createMockConnection();
      const createRuntime = vi.fn(async () => ({
        session: createMockSession(),
        dispose: vi.fn(),
        getSlashCommands: () => [
          {
            name: "review",
            description: undefined,
            source: "extension",
            sourceInfo: {
              path: "/tmp/extensions/review.ts",
              source: "local",
              scope: "project",
              origin: "top-level",
            },
          },
          {
            name: "fix-tests",
            description: "Fix failing tests",
            source: "prompt",
            sourceInfo: {
              path: "/tmp/.pi/prompts/fix-tests.md",
              source: "local",
              scope: "project",
              origin: "top-level",
            },
          },
          {
            name: "skill:brave-search",
            description: "Web search via Brave API",
            source: "skill",
            sourceInfo: {
              path: "/tmp/.pi/skills/brave-search/SKILL.md",
              source: "local",
              scope: "user",
              origin: "top-level",
            },
          },
        ],
      }));
      const agent = createTestAgent(connection, createRuntime);

      await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
      });

      await agent.newSession({ cwd: "/tmp/project" } as any);

      expect(connection.sessionUpdate).not.toHaveBeenCalled();

      await vi.runAllTimersAsync();

      const availableCommandsNotification = connection.sessionUpdate.mock.calls
        .map(([notification]: [any]) => notification)
        .find(
          (notification: any) => notification.update.sessionUpdate === "available_commands_update",
        );

      expect(availableCommandsNotification).toBeDefined();
      expect(availableCommandsNotification).toMatchObject({
        sessionId: expect.any(String),
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [
            {
              name: "review",
              description: "Run /review",
            },
            {
              name: "fix-tests",
              description: "Fix failing tests",
            },
            {
              name: "skill:brave-search",
              description: "Web search via Brave API",
            },
          ],
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
