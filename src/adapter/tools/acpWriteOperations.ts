import { mkdir as fsMkdir } from "node:fs/promises";

import type { WriteOperations } from "@mariozechner/pi-coding-agent";

import { normalizeAcpFsError } from "./acpFsErrors.js";
import { assertPathAuthorized, type AcpPathAuthorizationOptions } from "./authorization.js";
import { AcpReadOperations } from "./acpReadOperations.js";
import { createMkdirTerminalRequest } from "./terminalRequests.js";
import type { AcpClientInterface } from "./terminalOperations.js";
import { waitForTerminalCompletion } from "./terminalOperations.js";

export interface AcpWriteOperationsOptions extends AcpPathAuthorizationOptions {
  mkdirStrategy?: "local" | "terminal";
}

export class AcpWriteOperations implements WriteOperations {
  private client: AcpClientInterface;
  private authorizedRoots: string[];
  private mkdirStrategy: "local" | "terminal";

  constructor(client: AcpClientInterface, options: AcpWriteOperationsOptions = {}) {
    this.client = client;
    this.authorizedRoots = options.authorizedRoots ?? [];
    this.mkdirStrategy = options.mkdirStrategy ?? "terminal";
  }

  async writeFile(absolutePath: string, content: string): Promise<void> {
    assertPathAuthorized(absolutePath, this.authorizedRoots, "write");
    if (!this.client.capabilities.supportsWriteTextFile) {
      throw new Error("ACP client does not support fs/write_text_file.");
    }

    try {
      await this.client.writeTextFile({
        path: absolutePath,
        content,
        sessionId: this.client.sessionId,
      });
    } catch (error) {
      throw normalizeAcpFsError(error, absolutePath);
    }
  }

  async mkdir(dir: string): Promise<void> {
    assertPathAuthorized(dir, this.authorizedRoots, "create directory");

    if (this.mkdirStrategy === "local") {
      await fsMkdir(dir, { recursive: true });
      return;
    }

    if (!this.client.capabilities.supportsTerminal) {
      throw new Error("ACP client does not support terminal/create.");
    }

    const mkdirRequest = createMkdirTerminalRequest(dir);
    const terminal = await this.client.createTerminal({
      command: mkdirRequest.command,
      args: mkdirRequest.args,
      cwd: dir,
      sessionId: this.client.sessionId,
    });

    try {
      await waitForTerminalCompletion(terminal);
    } finally {
      terminal.release().catch(() => {});
    }
  }
}

export class AcpEditOperations {
  private readOps: AcpReadOperations;
  private writeOps: AcpWriteOperations;

  constructor(client: AcpClientInterface, options: AcpWriteOperationsOptions = {}) {
    this.readOps = new AcpReadOperations(client, options);
    this.writeOps = new AcpWriteOperations(client, options);
  }

  async readFile(path: string): Promise<string> {
    const buffer = await this.readOps.readFile(path);
    return buffer.toString("utf-8");
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.writeOps.writeFile(path, content);
  }

  async applyEdits(path: string, edits: { oldText: string; newText: string }[]): Promise<string> {
    let content = await this.readFile(path);

    for (const edit of edits) {
      content = content.replace(edit.oldText, edit.newText);
    }

    await this.writeFile(path, content);
    return content;
  }
}
