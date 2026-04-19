import type { AgentSideConnection, EnvVariable, TerminalHandle } from "@agentclientprotocol/sdk";

import type { AcpClientCapabilitiesSnapshot } from "../adapter/types.js";
import type { AcpClientInterface } from "../adapter/AcpToolBridge.js";

/** Adapts an ACP connection to the tool bridge client interface used by Pi tools. */
export class AcpConnectionAdapter implements AcpClientInterface {
  private connection: AgentSideConnection;
  public readonly sessionId: string;
  public readonly capabilities: AcpClientCapabilitiesSnapshot;

  constructor(
    connection: AgentSideConnection,
    sessionId: string,
    capabilities: AcpClientCapabilitiesSnapshot,
  ) {
    this.connection = connection;
    this.sessionId = sessionId;
    this.capabilities = capabilities;
  }

  createTerminal(params: {
    command: string;
    args?: string[];
    cwd?: string;
    env?: EnvVariable[];
    outputByteLimit?: number | null;
    sessionId: string;
  }): Promise<TerminalHandle> {
    if (!this.capabilities.supportsTerminal) {
      throw new Error("ACP client does not support terminal/create.");
    }

    return this.connection.createTerminal({
      command: params.command,
      args: params.args,
      cwd: params.cwd ?? null,
      env: params.env,
      outputByteLimit: params.outputByteLimit ?? null,
      sessionId: params.sessionId,
    });
  }

  async readTextFile(params: { path: string; sessionId: string }): Promise<{ content: string }> {
    if (!this.capabilities.supportsReadTextFile) {
      throw new Error("ACP client does not support fs/read_text_file.");
    }

    return this.connection.readTextFile({
      path: params.path,
      sessionId: this.sessionId,
    });
  }

  async writeTextFile(params: { path: string; content: string; sessionId: string }): Promise<void> {
    if (!this.capabilities.supportsWriteTextFile) {
      throw new Error("ACP client does not support fs/write_text_file.");
    }

    await this.connection.writeTextFile({
      path: params.path,
      content: params.content,
      sessionId: this.sessionId,
    });
  }
}
