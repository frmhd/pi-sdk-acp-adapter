import { describe, expect, test } from "vite-plus/test";

import { buildAcpSessionInfo } from "../src/adapter/session/sessionMetadata.ts";

function createPiSessionInfo() {
  return {
    path: "/tmp/session.jsonl",
    id: "session-1",
    cwd: "/workspace/project",
    created: new Date("2026-01-01T00:00:00.000Z"),
    modified: new Date("2026-01-02T00:00:00.000Z"),
    messageCount: 1,
    firstMessage: "Hello",
    allMessagesText: "Hello",
  };
}

describe("buildAcpSessionInfo", () => {
  test("omits additionalDirectories when none are known", () => {
    expect(buildAcpSessionInfo(createPiSessionInfo())).toEqual({
      cwd: "/workspace/project",
      sessionId: "session-1",
      title: "Hello",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
  });

  test("includes additionalDirectories for active sessions", () => {
    expect(
      buildAcpSessionInfo(createPiSessionInfo(), {
        additionalDirectories: ["/workspace/shared", ""],
      }),
    ).toEqual({
      cwd: "/workspace/project",
      sessionId: "session-1",
      title: "Hello",
      updatedAt: "2026-01-02T00:00:00.000Z",
      additionalDirectories: ["/workspace/shared"],
    });
  });
});
