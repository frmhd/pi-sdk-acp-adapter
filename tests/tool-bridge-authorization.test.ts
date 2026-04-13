import { describe, expect, test, vi } from "vite-plus/test";

import {
  AcpReadOperations,
  AcpWriteOperations,
  getAuthorizedRoots,
} from "../src/adapter/AcpToolBridge.ts";

function createMockClient() {
  return {
    sessionId: "session-1",
    capabilities: {
      raw: null,
      supportsReadTextFile: true,
      supportsWriteTextFile: true,
      supportsTerminal: true,
    },
    readTextFile: vi.fn(async ({ path }: { path: string }) => ({ content: `read:${path}` })),
    writeTextFile: vi.fn(async () => undefined),
    createTerminal: vi.fn(async () => ({
      id: "term-1",
      currentOutput: vi.fn(async () => ({
        output: "",
        truncated: false,
        exitStatus: { exitCode: 0, signal: null },
      })),
      waitForExit: vi.fn(async () => ({ exitCode: 0, signal: null })),
      release: vi.fn(async () => undefined),
      kill: vi.fn(async () => undefined),
    })),
  } as any;
}

describe("ACP tool bridge path authorization", () => {
  test("allows reads in cwd and additionalDirectories only", async () => {
    const client = createMockClient();
    const authorizedRoots = getAuthorizedRoots("/workspace/project", ["/workspace/shared"]);
    const readOps = new AcpReadOperations(client, { authorizedRoots });

    await expect(readOps.readFile("/workspace/project/src/index.ts")).resolves.toEqual(
      Buffer.from("read:/workspace/project/src/index.ts", "utf-8"),
    );
    await expect(readOps.readFile("/workspace/shared/notes.txt")).resolves.toEqual(
      Buffer.from("read:/workspace/shared/notes.txt", "utf-8"),
    );

    await expect(readOps.readFile("/tmp/outside.txt")).rejects.toThrow(
      /Allowed workspace roots: \/workspace\/project, \/workspace\/shared/i,
    );
    expect(client.readTextFile).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: "/tmp/outside.txt" }),
    );
  });

  test("allows writes in cwd and additionalDirectories only", async () => {
    const client = createMockClient();
    const authorizedRoots = getAuthorizedRoots("/workspace/project", ["/workspace/shared"]);
    const writeOps = new AcpWriteOperations(client, { authorizedRoots });

    await expect(
      writeOps.writeFile("/workspace/project/src/index.ts", "project"),
    ).resolves.toBeUndefined();
    await expect(
      writeOps.writeFile("/workspace/shared/notes.txt", "shared"),
    ).resolves.toBeUndefined();

    await expect(writeOps.writeFile("/tmp/outside.txt", "outside")).rejects.toThrow(
      /Filesystem access is limited to the session cwd and additionalDirectories/i,
    );
    expect(client.writeTextFile).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: "/tmp/outside.txt" }),
    );
  });

  test("applies the same scope checks when creating directories", async () => {
    const client = createMockClient();
    const authorizedRoots = getAuthorizedRoots("/workspace/project", ["/workspace/shared"]);
    const writeOps = new AcpWriteOperations(client, { authorizedRoots });

    await expect(writeOps.mkdir("/workspace/shared/generated")).resolves.toBeUndefined();
    await expect(writeOps.mkdir("/tmp/generated")).rejects.toThrow(/ACP create directory denied/i);
  });
});
