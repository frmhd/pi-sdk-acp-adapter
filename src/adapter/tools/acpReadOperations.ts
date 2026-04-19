import type { ReadOperations } from "@mariozechner/pi-coding-agent";

import { normalizeAcpFsError } from "./acpFsErrors.js";
import { assertPathAuthorized, type AcpPathAuthorizationOptions } from "./authorization.js";
import type { AcpClientInterface } from "./terminalOperations.js";

export class AcpReadOperations implements ReadOperations {
  private client: AcpClientInterface;
  private authorizedRoots: string[];

  constructor(client: AcpClientInterface, options: AcpPathAuthorizationOptions = {}) {
    this.client = client;
    this.authorizedRoots = options.authorizedRoots ?? [];
  }

  async readFile(absolutePath: string): Promise<Buffer> {
    assertPathAuthorized(absolutePath, this.authorizedRoots, "read");

    if (!this.client.capabilities.supportsReadTextFile) {
      throw new Error("ACP client does not support fs/read_text_file.");
    }

    try {
      const result = await this.client.readTextFile({
        path: absolutePath,
        sessionId: this.client.sessionId,
      });
      return Buffer.from(result.content, "utf-8");
    } catch (error) {
      throw normalizeAcpFsError(error, absolutePath);
    }
  }

  async access(absolutePath: string): Promise<void> {
    assertPathAuthorized(absolutePath, this.authorizedRoots, "read");

    if (!this.client.capabilities.supportsReadTextFile) {
      throw new Error("ACP client does not support fs/read_text_file.");
    }

    try {
      await this.client.readTextFile({
        path: absolutePath,
        sessionId: this.client.sessionId,
      });
    } catch (error) {
      throw normalizeAcpFsError(error, absolutePath);
    }
  }
}
