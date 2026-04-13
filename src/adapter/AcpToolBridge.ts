/**
 * ACP Tool Bridge
 *
 * Bridges Pi's 4 core tools (read, write, edit, bash) to ACP client methods.
 * File operations are delegated through ACP filesystem requests and command
 * execution is delegated through ACP terminals.
 */

import type {
  ToolCallContent,
  ToolKind,
  TerminalHandle,
  EnvVariable,
} from "@agentclientprotocol/sdk";

import type {
  BashOperations,
  ReadOperations,
  WriteOperations,
} from "@mariozechner/pi-coding-agent";

import { createToolCallContent, mapToolKind, type AcpClientCapabilitiesSnapshot } from "./types.js";

// =============================================================================
// Utils
// =============================================================================

/** Escape a string for use in a bash command */
function escapeBash(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`;
}

// =============================================================================
// ACP Terminal Polling Interval (ms)
// =============================================================================

const TERMINAL_POLL_INTERVAL = 100;

// =============================================================================
// Tool Input/Output Mapping Types
// =============================================================================

/** Input mapping function: convert ACP tool args to Pi tool input */
export type InputMapper<TInput> = (args: Record<string, unknown>) => TInput;

/** Output mapping function: convert Pi tool result to ACP tool content */
export type OutputMapper = (result: unknown) => ToolCallContent[];

/** Tool bridge configuration for a specific tool */
export interface ToolBridgeConfig<TInput> {
  /** Pi tool name */
  piToolName: string;
  /** ACP tool kind */
  acpToolKind: ToolKind;
  /** Map ACP tool args to Pi tool input */
  mapInput: InputMapper<TInput>;
  /** Map Pi tool result to ACP tool content */
  mapOutput: OutputMapper;
}

// =============================================================================
// ACP Client Interface (subset needed by Pi's 4 tools)
// =============================================================================

/** Subset of AgentSideConnection used by the tool bridge */
export interface AcpClientInterface {
  /** Session ID for ACP fs/terminal requests */
  sessionId: string;
  /** Normalized capabilities captured during initialize() */
  capabilities: AcpClientCapabilitiesSnapshot;
  /** Create a terminal and execute a command */
  createTerminal(params: {
    command: string;
    cwd?: string;
    env?: EnvVariable[];
    sessionId: string;
  }): Promise<TerminalHandle>;
  /** Read a text file */
  readTextFile(params: { path: string; sessionId: string }): Promise<{ content: string }>;
  /** Write a text file */
  writeTextFile(params: { path: string; content: string; sessionId: string }): Promise<void>;
}

// =============================================================================
// Terminal Polling Helper
// =============================================================================

interface TerminalPollResult {
  output: string;
  exitCode: number | null;
}

async function pollTerminalToCompletion(
  terminal: TerminalHandle,
  options?: { signal?: AbortSignal },
): Promise<TerminalPollResult> {
  let lastOutputLength = 0;
  let resolved = false;
  let accumulatedOutput = "";

  const abortHandler = () => {
    resolved = true;
  };

  if (options?.signal) {
    options.signal.addEventListener("abort", abortHandler);
  }

  return new Promise<TerminalPollResult>((resolve, reject) => {
    const poll = async () => {
      if (resolved) {
        return;
      }

      try {
        const output = await terminal.currentOutput();

        if (output.output.length > lastOutputLength) {
          const newOutput = output.output.slice(lastOutputLength);
          accumulatedOutput += newOutput;
          lastOutputLength = output.output.length;
        }

        if (output.exitStatus !== undefined) {
          resolved = true;

          const exitCode =
            output.exitStatus?.exited === true ? (output.exitStatus.exitCode ?? null) : null;

          resolve({ output: accumulatedOutput, exitCode });
          return;
        }

        setTimeout(poll, TERMINAL_POLL_INTERVAL);
      } catch (err) {
        resolved = true;
        reject(err);
      }
    };

    void poll();

    terminal
      .waitForExit()
      .then((exitResponse) => {
        if (resolved) return;
        resolved = true;

        terminal
          .currentOutput()
          .then((finalOutput) => {
            if (finalOutput.output.length > lastOutputLength) {
              const newOutput = finalOutput.output.slice(lastOutputLength);
              accumulatedOutput += newOutput;
            }

            const exitCode = exitResponse.exited ? (exitResponse.exitCode ?? null) : null;
            resolve({ output: accumulatedOutput, exitCode });
          })
          .catch(() => {
            const exitCode = exitResponse.exited ? (exitResponse.exitCode ?? null) : null;
            resolve({ output: accumulatedOutput, exitCode });
          });
      })
      .catch((err) => {
        if (resolved) return;
        resolved = true;
        reject(err);
      });
  }).finally(() => {
    if (options?.signal) {
      options.signal.removeEventListener("abort", abortHandler);
    }
  });
}

// =============================================================================
// Terminal Management
// =============================================================================

/** ACP terminal-backed BashOperations implementation. */
export class AcpTerminalOperations implements BashOperations {
  private client: AcpClientInterface;

  constructor(client: AcpClientInterface) {
    this.client = client;
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

    const env: EnvVariable[] | undefined = options.env
      ? Object.entries(options.env)
          .filter(([, value]) => value !== undefined)
          .map(([name, value]) => ({ name, value: value as string }))
      : undefined;

    const terminal = await this.client.createTerminal({
      command,
      cwd,
      env,
      sessionId: this.client.sessionId,
    });

    let lastOutputLength = 0;
    let killed = false;
    let resolved = false;

    const shouldStop = () => killed || signal?.aborted || resolved;

    const poll = async () => {
      if (shouldStop()) {
        return;
      }

      try {
        const output = await terminal.currentOutput();

        if (output.output.length > lastOutputLength) {
          const newOutput = output.output.slice(lastOutputLength);
          onData(Buffer.from(newOutput, "utf-8"));
          lastOutputLength = output.output.length;
        }

        if (output.exitStatus !== undefined) {
          resolved = true;
          return;
        }

        setTimeout(poll, TERMINAL_POLL_INTERVAL);
      } catch {
        // Stop polling on error
      }
    };

    void poll();

    const abortHandler = () => {
      killed = true;
      void terminal.kill();
    };

    if (signal) {
      signal.addEventListener("abort", abortHandler);
    }

    const timeoutHandle = timeout
      ? setTimeout(() => {
          killed = true;
          void terminal.kill();
        }, timeout)
      : undefined;

    try {
      const exitResponse = await terminal.waitForExit();
      resolved = true;

      if (timeoutHandle) clearTimeout(timeoutHandle);

      return { exitCode: exitResponse.exitCode ?? null };
    } finally {
      if (signal) {
        signal.removeEventListener("abort", abortHandler);
      }
      if (timeoutHandle) clearTimeout(timeoutHandle);

      terminal.release().catch(() => {
        // Ignore release errors
      });
    }
  }
}

// =============================================================================
// Read Operations Bridge
// =============================================================================

/** ACP Read Operations delegates file reads to the ACP client. */
export class AcpReadOperations implements ReadOperations {
  private client: AcpClientInterface;

  constructor(client: AcpClientInterface) {
    this.client = client;
  }

  async readFile(absolutePath: string): Promise<Buffer> {
    if (!this.client.capabilities.supportsReadTextFile) {
      throw new Error("ACP client does not support fs/read_text_file.");
    }

    const result = await this.client.readTextFile({
      path: absolutePath,
      sessionId: this.client.sessionId,
    });
    return Buffer.from(result.content, "utf-8");
  }

  async access(absolutePath: string): Promise<void> {
    await this.readFile(absolutePath);
  }
}

// =============================================================================
// Write Operations Bridge
// =============================================================================

/** ACP Write Operations delegates file writes to the ACP client. */
export class AcpWriteOperations implements WriteOperations {
  private client: AcpClientInterface;

  constructor(client: AcpClientInterface) {
    this.client = client;
  }

  async writeFile(absolutePath: string, content: string): Promise<void> {
    if (!this.client.capabilities.supportsWriteTextFile) {
      throw new Error("ACP client does not support fs/write_text_file.");
    }

    await this.client.writeTextFile({
      path: absolutePath,
      content,
      sessionId: this.client.sessionId,
    });
  }

  async mkdir(dir: string): Promise<void> {
    if (!this.client.capabilities.supportsTerminal) {
      throw new Error("ACP client does not support terminal/create.");
    }

    const terminal = await this.client.createTerminal({
      command: `mkdir -p ${escapeBash(dir)}`,
      cwd: dir,
      sessionId: this.client.sessionId,
    });

    try {
      await pollTerminalToCompletion(terminal);
    } finally {
      terminal.release().catch(() => {});
    }
  }
}

// =============================================================================
// Edit Operations Bridge
// =============================================================================

/** ACP Edit Operations delegates edits to ACP read + write methods. */
export class AcpEditOperations {
  private readOps: AcpReadOperations;
  private writeOps: AcpWriteOperations;

  constructor(client: AcpClientInterface) {
    this.readOps = new AcpReadOperations(client);
    this.writeOps = new AcpWriteOperations(client);
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

// =============================================================================
// Tool Bridge Main Class
// =============================================================================

/** Lazily creates ACP-backed Pi tool operation bridges. */
export class AcpToolBridge {
  private client: AcpClientInterface;
  private terminalOps?: AcpTerminalOperations;
  private readOps?: AcpReadOperations;
  private writeOps?: AcpWriteOperations;
  private editOps?: AcpEditOperations;

  constructor(client: AcpClientInterface) {
    this.client = client;
  }

  getBashOperations(): BashOperations | undefined {
    if (!this.terminalOps) {
      this.terminalOps = new AcpTerminalOperations(this.client);
    }
    return this.terminalOps;
  }

  getReadOperations(): ReadOperations | undefined {
    if (!this.readOps) {
      this.readOps = new AcpReadOperations(this.client);
    }
    return this.readOps;
  }

  getWriteOperations(): WriteOperations | undefined {
    if (!this.writeOps) {
      this.writeOps = new AcpWriteOperations(this.client);
    }
    return this.writeOps;
  }

  getEditOperations(): AcpEditOperations | undefined {
    if (!this.editOps) {
      this.editOps = new AcpEditOperations(this.client);
    }
    return this.editOps;
  }

  supportsTerminal(): boolean {
    return this.client.capabilities.supportsTerminal;
  }
}

// =============================================================================
// Tool Definition Mapping
// =============================================================================

export function getAcpToolKind(toolName: string): ToolKind {
  return mapToolKind(toolName);
}

// =============================================================================
// Output Converters
// =============================================================================

export function convertReadOutput(result: Buffer | string): ToolCallContent[] {
  const text = typeof result === "string" ? result : result.toString("utf-8");
  return [createToolCallContent(text)];
}

export function convertWriteOutput(result: { path: string; written?: boolean }): ToolCallContent[] {
  return [createToolCallContent(`Written to ${result.path}`)];
}

export function convertEditOutput(result: { path: string; edits: number }): ToolCallContent[] {
  return [createToolCallContent(`Applied ${result.edits} edit(s) to ${result.path}`)];
}

export function convertBashOutput(result: {
  stdout?: string;
  stderr?: string;
  exitCode: number | null;
}): ToolCallContent[] {
  const content: ToolCallContent[] = [];

  if (result.stdout) {
    content.push(createToolCallContent(result.stdout));
  }

  if (result.stderr) {
    content.push(createToolCallContent(`stderr: ${result.stderr}`));
  }

  if (result.exitCode !== null) {
    content.push(createToolCallContent(`Exit code: ${result.exitCode}`));
  }

  return content;
}
