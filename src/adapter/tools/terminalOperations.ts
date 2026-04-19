import type { EnvVariable, TerminalHandle } from "@agentclientprotocol/sdk";
import { DEFAULT_MAX_BYTES, type BashOperations } from "@mariozechner/pi-coding-agent";

import type { AcpClientCapabilitiesSnapshot } from "../types.js";
import { buildNonInteractiveShellEnv } from "./localOperations.js";
import { createShellTerminalRequest } from "./terminalRequests.js";

const TERMINAL_POLL_INTERVAL = 100;

export interface AcpClientInterface {
  sessionId: string;
  capabilities: AcpClientCapabilitiesSnapshot;
  createTerminal(params: {
    command: string;
    args?: string[];
    cwd?: string;
    env?: EnvVariable[];
    outputByteLimit?: number | null;
    sessionId: string;
  }): Promise<TerminalHandle>;
  readTextFile(params: { path: string; sessionId: string }): Promise<{ content: string }>;
  writeTextFile(params: { path: string; content: string; sessionId: string }): Promise<void>;
}

interface TerminalPollResult {
  output: string;
  truncated: boolean;
  exitCode: number | null;
  signal: string | null;
}

function hasTerminalExited(output: {
  exitStatus?: { exitCode?: number | null; signal?: string | null } | null;
}): boolean {
  return output.exitStatus != null;
}

export async function waitForTerminalCompletion(
  terminal: TerminalHandle,
  options?: { signal?: AbortSignal },
): Promise<TerminalPollResult> {
  const exitResponse = await terminal.waitForExit();

  if (options?.signal?.aborted) {
    throw new Error("Terminal operation aborted");
  }

  const finalOutput = await terminal.currentOutput();

  return {
    output: finalOutput.output,
    truncated: finalOutput.truncated,
    exitCode: exitResponse.exitCode ?? null,
    signal: exitResponse.signal ?? null,
  };
}

export interface AcpTerminalLifecycleHooks {
  onTerminalCreated?: (terminal: {
    terminalId: string;
    command: string;
    args: string[];
    cwd: string;
    outputByteLimit: number | null;
    release: () => Promise<void>;
  }) => void;
  onTerminalOutput?: (output: { output: string; truncated: boolean }) => void;
  onTerminalExit?: (result: {
    output: string;
    truncated: boolean;
    exitCode: number | null;
    signal: string | null;
  }) => void;
}

export class AcpTerminalOperations implements BashOperations {
  private client: AcpClientInterface;
  private hooks: AcpTerminalLifecycleHooks;

  constructor(client: AcpClientInterface, hooks: AcpTerminalLifecycleHooks = {}) {
    this.client = client;
    this.hooks = hooks;
  }

  async exec(
    command: string,
    cwd: string,
    options: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    },
  ): Promise<{ exitCode: number | null }> {
    const { onData, signal, timeout } = options;

    if (!this.client.capabilities.supportsTerminal) {
      throw new Error("ACP client does not support terminal/create.");
    }

    const mergedEnv = buildNonInteractiveShellEnv(options.env);
    const env: EnvVariable[] | undefined = Object.entries(mergedEnv)
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => ({ name, value: value as string }));

    const shellRequest = createShellTerminalRequest(command);
    const outputByteLimit = DEFAULT_MAX_BYTES;

    const terminal = await this.client.createTerminal({
      command: shellRequest.command,
      args: shellRequest.args,
      cwd,
      env,
      outputByteLimit,
      sessionId: this.client.sessionId,
    });

    let released = false;
    const release = async () => {
      if (released) {
        return;
      }
      released = true;
      await terminal.release();
    };

    this.hooks.onTerminalCreated?.({
      terminalId: terminal.id,
      command: shellRequest.command,
      args: shellRequest.args,
      cwd,
      outputByteLimit,
      release,
    });
    const releaseOnFinally = !this.hooks.onTerminalCreated;

    let killed = false;
    let pollResolved = false;

    const shouldStop = () => killed || signal?.aborted || pollResolved;

    const abortHandler = () => {
      killed = true;
      void terminal.kill();
    };

    if (signal) {
      signal.addEventListener("abort", abortHandler);
    }

    const timeoutHandle =
      timeout && timeout > 0
        ? setTimeout(() => {
            killed = true;
            void terminal.kill();
          }, timeout * 1000)
        : undefined;

    const terminalResult = await new Promise<TerminalPollResult>((resolve, reject) => {
      const poll = async () => {
        if (shouldStop()) {
          return;
        }

        try {
          const output = await terminal.currentOutput();
          this.hooks.onTerminalOutput?.({ output: output.output, truncated: output.truncated });

          if (hasTerminalExited(output)) {
            pollResolved = true;
            resolve({
              output: output.output,
              truncated: output.truncated,
              exitCode: output.exitStatus?.exitCode ?? null,
              signal: output.exitStatus?.signal ?? null,
            });
            return;
          }

          setTimeout(poll, TERMINAL_POLL_INTERVAL);
        } catch (err) {
          reject(err);
        }
      };

      void poll();
    });

    try {
      if (terminalResult.output.length > 0) {
        onData(Buffer.from(terminalResult.output, "utf-8"));
      }

      this.hooks.onTerminalExit?.(terminalResult);
      return { exitCode: terminalResult.exitCode };
    } finally {
      if (signal) {
        signal.removeEventListener("abort", abortHandler);
      }
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (releaseOnFinally) {
        await release().catch(() => {
          // Ignore terminal release errors during best-effort cleanup.
        });
      }
    }
  }
}
