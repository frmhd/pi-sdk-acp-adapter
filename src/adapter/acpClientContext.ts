import {
  methods,
  type AgentContext,
  type CreateTerminalRequest,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type SessionNotification,
  type TerminalHandle,
  type WriteTextFileRequest,
} from "@agentclientprotocol/sdk";

/** Client-side ACP surface used by the Pi adapter for outbound client calls. */
export interface AcpAgentClientContext {
  sessionUpdate(params: SessionNotification): Promise<void>;
  readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse>;
  writeTextFile(params: WriteTextFileRequest): Promise<void>;
  createTerminal(params: CreateTerminalRequest): Promise<TerminalHandle>;
}

class AcpTerminalHandle {
  readonly id: string;

  constructor(
    private readonly client: AgentContext,
    private readonly sessionId: string,
    terminalId: string,
  ) {
    this.id = terminalId;
  }

  currentOutput() {
    return this.client.request(methods.client.terminal.output, {
      sessionId: this.sessionId,
      terminalId: this.id,
    });
  }

  waitForExit() {
    return this.client.request(methods.client.terminal.waitForExit, {
      sessionId: this.sessionId,
      terminalId: this.id,
    });
  }

  kill() {
    return this.client.request(methods.client.terminal.kill, {
      sessionId: this.sessionId,
      terminalId: this.id,
    });
  }

  release() {
    return this.client.request(methods.client.terminal.release, {
      sessionId: this.sessionId,
      terminalId: this.id,
    });
  }

  async [Symbol.asyncDispose]() {
    await this.release();
  }
}

/** Adapts the new ACP agent handler context to the client-call surface used by the adapter. */
export function createAcpAgentClientContext(client: AgentContext): AcpAgentClientContext {
  return {
    sessionUpdate(params) {
      return client.notify(methods.client.session.update, params);
    },
    readTextFile(params) {
      return client.request(methods.client.fs.readTextFile, params);
    },
    async writeTextFile(params) {
      await client.request(methods.client.fs.writeTextFile, params);
    },
    async createTerminal(params) {
      const response = await client.request(methods.client.terminal.create, params);
      return new AcpTerminalHandle(
        client,
        params.sessionId,
        response.terminalId,
      ) as unknown as TerminalHandle;
    },
  };
}
