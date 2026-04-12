/**
 * ACP Tool Bridge
 *
 * Bridges Pi's built-in tools (read, write, edit, bash, grep, find, ls) to ACP tool call protocol.
 * Handles tool input/output conversion and terminal management delegation.
 */

import type { ToolCallContent, ToolKind, TerminalHandle } from "@agentclientprotocol/sdk";
import type { EnvVariable } from "@agentclientprotocol/sdk";

import type {
  BashOperations,
  ReadOperations,
  WriteOperations,
  LsOperations,
  GrepOperations,
} from "@mariozechner/pi-coding-agent";

import { createToolCallContent, mapToolKind } from "./types.js";

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
// ACP Client Interface (subset needed for terminal management)
// =============================================================================

/** Subset of AgentSideConnection used by the tool bridge */
export interface AcpClientInterface {
  /** Session ID for terminal requests */
  sessionId: string;
  /** Create a terminal and execute a command */
  createTerminal(params: {
    command: string;
    cwd?: string;
    env?: EnvVariable[];
    sessionId: string;
  }): Promise<TerminalHandle>;
  /** Read a text file */
  readTextFile(params: { path: string }): Promise<{ content: string }>;
  /** Write a text file */
  writeTextFile(params: { path: string; content: string }): Promise<void>;
}

// =============================================================================
// Terminal Polling Helper
// =============================================================================

/**
 * Result from polling a terminal for output
 */
interface TerminalPollResult {
  output: string;
  exitCode: number | null;
}

/**
 * Poll terminal until completion and collect output.
 * Handles cumulative output correctly (only captures deltas).
 */
async function pollTerminalToCompletion(
  terminal: TerminalHandle,
  options?: { signal?: AbortSignal },
): Promise<TerminalPollResult> {
  let lastOutputLength = 0;
  let resolved = false;

  // Store accumulated output
  let accumulatedOutput = "";

  // Set up abort handler
  const abortHandler = () => {
    resolved = true;
  };

  if (options?.signal) {
    options.signal.addEventListener("abort", abortHandler);
  }

  // Start polling for output
  return new Promise<TerminalPollResult>((resolve, reject) => {
    const poll = async () => {
      if (resolved) {
        return;
      }

      try {
        const output = await terminal.currentOutput();

        // Get new output since last check (handle cumulative output)
        if (output.output.length > lastOutputLength) {
          const newOutput = output.output.slice(lastOutputLength);
          accumulatedOutput += newOutput;
          lastOutputLength = output.output.length;
        }

        // Check if process has exited
        if (output.exitStatus !== undefined) {
          resolved = true;

          const exitCode =
            output.exitStatus?.exited === true ? (output.exitStatus.exitCode ?? null) : null;

          resolve({ output: accumulatedOutput, exitCode });
          return;
        }

        // Schedule next poll
        setTimeout(poll, TERMINAL_POLL_INTERVAL);
      } catch (err) {
        resolved = true;
        reject(err);
      }
    };

    // Start polling
    void poll();

    // Also wait for exit as a backup
    terminal
      .waitForExit()
      .then((exitResponse) => {
        if (resolved) return;
        resolved = true;

        // Final output fetch
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

/**
 * ACP Terminal Operations
 * Delegates bash command execution to the ACP client via terminal protocol.
 * Uses polling for output since the terminal API doesn't have an onData callback.
 */
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

    // Convert env to ACP format (filter out undefined values)
    const env: EnvVariable[] | undefined = options.env
      ? Object.entries(options.env)
          .filter(([, value]) => value !== undefined)
          .map(([name, value]) => ({ name, value: value as string }))
      : undefined;

    // Create terminal via ACP client
    const terminal = await this.client.createTerminal({
      command,
      cwd,
      env,
      sessionId: this.client.sessionId,
    });

    let lastOutputLength = 0;
    let killed = false;
    let resolved = false;

    // Helper to check if we should stop polling
    const shouldStop = () => killed || signal?.aborted || resolved;

    // Start polling for output
    const poll = async () => {
      if (shouldStop()) {
        return;
      }

      try {
        const output = await terminal.currentOutput();

        // Get new output since last check (output is cumulative)
        if (output.output.length > lastOutputLength) {
          const newOutput = output.output.slice(lastOutputLength);
          onData(Buffer.from(newOutput, "utf-8"));
          lastOutputLength = output.output.length;
        }

        // Check if process has exited
        if (output.exitStatus !== undefined) {
          resolved = true;
          return;
        }

        // Schedule next poll
        setTimeout(poll, TERMINAL_POLL_INTERVAL);
      } catch {
        // Stop polling on error
      }
    };

    // Start polling
    void poll();

    // Set up abort handler
    const abortHandler = () => {
      killed = true;
      void terminal.kill();
    };

    if (signal) {
      signal.addEventListener("abort", abortHandler);
    }

    // Set up timeout
    const timeoutHandle = timeout
      ? setTimeout(() => {
          killed = true;
          void terminal.kill();
        }, timeout)
      : undefined;

    try {
      // Wait for terminal to complete
      const exitResponse = await terminal.waitForExit();
      resolved = true;

      if (timeoutHandle) clearTimeout(timeoutHandle);

      return { exitCode: exitResponse.exitCode ?? null };
    } finally {
      if (signal) {
        signal.removeEventListener("abort", abortHandler);
      }
      if (timeoutHandle) clearTimeout(timeoutHandle);

      // Release terminal resources
      terminal.release().catch(() => {
        // Ignore release errors
      });
    }
  }
}

// =============================================================================
// Read Operations Bridge
// =============================================================================

/**
 * ACP Read Operations
 * Delegates file reading to the ACP client.
 */
export class AcpReadOperations implements ReadOperations {
  private client: AcpClientInterface;

  constructor(client: AcpClientInterface) {
    this.client = client;
  }

  async readFile(absolutePath: string): Promise<Buffer> {
    const result = await this.client.readTextFile({ path: absolutePath });
    return Buffer.from(result.content, "utf-8");
  }

  async access(absolutePath: string): Promise<void> {
    // Try to read to check accessibility
    await this.readFile(absolutePath);
  }
}

// =============================================================================
// Write Operations Bridge
// =============================================================================

/**
 * ACP Write Operations
 * Delegates file writing to the ACP client.
 */
export class AcpWriteOperations implements WriteOperations {
  private client: AcpClientInterface;

  constructor(client: AcpClientInterface) {
    this.client = client;
  }

  async writeFile(absolutePath: string, content: string): Promise<void> {
    await this.client.writeTextFile({ path: absolutePath, content });
  }

  async mkdir(dir: string): Promise<void> {
    // Use terminal to create directory with mkdir -p
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

/**
 * ACP Edit Operations
 * Delegates file editing to the ACP client using read + write.
 */
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
// Grep Operations Bridge
// =============================================================================

/**
 * ACP Grep Operations
 * Uses find + read to perform grep-like operations via the ACP client.
 * Implements GrepOperations interface for Pi tool integration.
 */
export class AcpGrepOperations implements GrepOperations {
  private client: AcpClientInterface;
  private readOps: AcpReadOperations;

  constructor(client: AcpClientInterface) {
    this.client = client;
    this.readOps = new AcpReadOperations(client);
  }

  /**
   * Check if path is a directory.
   * Uses test command to check if path is a directory.
   */
  async isDirectory(absolutePath: string): Promise<boolean> {
    const cmd = `test -d ${escapeBash(absolutePath)} && echo "true" || echo "false"`;

    try {
      const terminal = await this.client.createTerminal({
        command: cmd,
        cwd: absolutePath,
        sessionId: this.client.sessionId,
      });

      try {
        const result = await pollTerminalToCompletion(terminal);
        return result.output.trim().includes("true");
      } finally {
        terminal.release().catch(() => {});
      }
    } catch {
      return false;
    }
  }

  /**
   * Read file contents for context lines.
   */
  async readFile(absolutePath: string): Promise<string> {
    const buffer = await this.readOps.readFile(absolutePath);
    return buffer.toString("utf-8");
  }
}

// =============================================================================
// Find Operations Bridge
// =============================================================================

/**
 * ACP Find Operations
 * Delegates file search to the ACP client.
 */
export class AcpFindOperations {
  private client: AcpClientInterface;

  constructor(client: AcpClientInterface) {
    this.client = client;
  }

  async exists(absolutePath: string): Promise<boolean> {
    // Use test -e which is more reliable across BSD/GNU
    const cmd = `test -e ${escapeBash(absolutePath)} && echo "true" || echo "false"`;

    try {
      const terminal = await this.client.createTerminal({
        command: cmd,
        cwd: absolutePath,
        sessionId: this.client.sessionId,
      });

      try {
        const result = await pollTerminalToCompletion(terminal);
        return result.output.trim().includes("true");
      } finally {
        terminal.release().catch(() => {});
      }
    } catch {
      return false;
    }
  }

  async glob(
    pattern: string,
    cwd: string,
    options: { ignore: string[]; limit: number },
  ): Promise<string[]> {
    const searchPath = cwd || ".";
    // Convert glob pattern to find -name pattern if possible
    const findPattern = pattern.startsWith("**/") ? pattern.slice(3) : pattern;

    // Build ignore arguments for find (prune patterns)
    const ignoreArgs = options.ignore
      .filter((p) => p.startsWith("**/"))
      .map((p) => `-not -path ${escapeBash(p.replace(/^\*\*\//, ""))}`)
      .join(" ");

    const cmd = `find ${escapeBash(searchPath)} ${ignoreArgs} -name ${escapeBash(findPattern)} -maxdepth 10 2>/dev/null | head -${options.limit || 100}`;

    try {
      const terminal = await this.client.createTerminal({
        command: cmd,
        cwd: searchPath,
        sessionId: this.client.sessionId,
      });

      try {
        const result = await pollTerminalToCompletion(terminal);
        return result.output.split("\n").filter((line) => line.trim() !== "");
      } finally {
        terminal.release().catch(() => {});
      }
    } catch {
      return [];
    }
  }
}

// =============================================================================
// Ls Operations Bridge
// =============================================================================

/**
 * ACP Ls Operations
 * Lists directory contents via the ACP client.
 */
export class AcpLsOperations implements LsOperations {
  private client: AcpClientInterface;

  constructor(client: AcpClientInterface) {
    this.client = client;
  }

  async exists(absolutePath: string): Promise<boolean> {
    // Use test -e which is more reliable across BSD/GNU
    const cmd = `test -e ${escapeBash(absolutePath)} && echo "true" || echo "false"`;

    try {
      const terminal = await this.client.createTerminal({
        command: cmd,
        cwd: absolutePath,
        sessionId: this.client.sessionId,
      });

      try {
        const result = await pollTerminalToCompletion(terminal);
        return result.output.trim().includes("true");
      } finally {
        terminal.release().catch(() => {});
      }
    } catch {
      return false;
    }
  }

  async stat(absolutePath: string): Promise<{ isDirectory: () => boolean }> {
    // Use test -d which is more reliable than parsing ls -ld output
    const cmd = `test -d ${escapeBash(absolutePath)} && echo "true" || echo "false"`;

    try {
      const terminal = await this.client.createTerminal({
        command: cmd,
        cwd: absolutePath,
        sessionId: this.client.sessionId,
      });

      try {
        const result = await pollTerminalToCompletion(terminal);
        return {
          isDirectory: () => result.output.trim().includes("true"),
        };
      } finally {
        terminal.release().catch(() => {});
      }
    } catch {
      return {
        isDirectory: () => false,
      };
    }
  }

  async readdir(absolutePath: string): Promise<string[]> {
    return this.ls({ path: absolutePath });
  }

  async ls(options?: { path?: string; limit?: number }): Promise<string[]> {
    const listPath = options?.path || ".";
    // Use ls -A1 which doesn't show . and .. but also doesn't show total line
    const cmd = `ls -A1 ${escapeBash(listPath)} 2>/dev/null || echo ""`;

    try {
      const terminal = await this.client.createTerminal({
        command: cmd,
        cwd: listPath,
        sessionId: this.client.sessionId,
      });

      try {
        const result = await pollTerminalToCompletion(terminal);
        const lines = result.output
          .split("\n")
          .filter((line) => line.trim() !== "")
          .slice(0, options?.limit || 100);

        return lines;
      } finally {
        terminal.release().catch(() => {});
      }
    } catch {
      return [];
    }
  }
}

// =============================================================================
// Tool Bridge Main Class
// =============================================================================

/**
 * ACP Tool Bridge
 * Manages all tool operations and delegates to ACP client.
 */
export class AcpToolBridge {
  private client: AcpClientInterface;
  private terminalOps?: AcpTerminalOperations;
  private readOps?: AcpReadOperations;
  private writeOps?: AcpWriteOperations;
  private editOps?: AcpEditOperations;
  private grepOps?: AcpGrepOperations;
  private findOps?: AcpFindOperations;
  private lsOps?: AcpLsOperations;

  constructor(client: AcpClientInterface) {
    this.client = client;
  }

  /**
   * Get bash operations for terminal delegation
   */
  getBashOperations(): BashOperations | undefined {
    if (!this.terminalOps) {
      this.terminalOps = new AcpTerminalOperations(this.client);
    }
    return this.terminalOps;
  }

  /**
   * Get read operations for file reading delegation
   */
  getReadOperations(): ReadOperations | undefined {
    if (!this.readOps) {
      this.readOps = new AcpReadOperations(this.client);
    }
    return this.readOps;
  }

  /**
   * Get write operations for file writing delegation
   */
  getWriteOperations(): WriteOperations | undefined {
    if (!this.writeOps) {
      this.writeOps = new AcpWriteOperations(this.client);
    }
    return this.writeOps;
  }

  /**
   * Get edit operations for file editing delegation
   */
  getEditOperations(): AcpEditOperations | undefined {
    if (!this.editOps) {
      this.editOps = new AcpEditOperations(this.client);
    }
    return this.editOps;
  }

  /**
   * Get grep operations for search delegation
   */
  getGrepOperations(): AcpGrepOperations | undefined {
    if (!this.grepOps) {
      this.grepOps = new AcpGrepOperations(this.client);
    }
    return this.grepOps;
  }

  /**
   * Get find operations for directory listing delegation
   */
  getFindOperations(): AcpFindOperations | undefined {
    if (!this.findOps) {
      this.findOps = new AcpFindOperations(this.client);
    }
    return this.findOps;
  }

  /**
   * Get ls operations for directory listing delegation
   */
  getLsOperations(): LsOperations | undefined {
    if (!this.lsOps) {
      this.lsOps = new AcpLsOperations(this.client);
    }
    return this.lsOps;
  }

  /**
   * Check if the client supports terminal operations
   */
  supportsTerminal(): boolean {
    return typeof this.client.createTerminal === "function";
  }
}

// =============================================================================
// Tool Definition Mapping
// =============================================================================

/**
 * Map Pi tool name to ACP tool kind
 */
export function getAcpToolKind(toolName: string): ToolKind {
  return mapToolKind(toolName);
}

// =============================================================================
// Output Converters
// =============================================================================

/**
 * Convert read result to ACP content
 */
export function convertReadOutput(result: Buffer | string): ToolCallContent[] {
  const text = typeof result === "string" ? result : result.toString("utf-8");
  return [createToolCallContent(text)];
}

/**
 * Convert write result to ACP content
 */
export function convertWriteOutput(result: { path: string; written?: boolean }): ToolCallContent[] {
  return [createToolCallContent(`Written to ${result.path}`)];
}

/**
 * Convert edit result to ACP content
 */
export function convertEditOutput(result: { path: string; edits: number }): ToolCallContent[] {
  return [createToolCallContent(`Applied ${result.edits} edit(s) to ${result.path}`)];
}

/**
 * Convert bash result to ACP content
 */
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

/**
 * Convert grep result to ACP content
 */
export function convertGrepOutput(results: string[]): ToolCallContent[] {
  return [createToolCallContent(results.join("\n"))];
}

/**
 * Convert find/ls result to ACP content
 */
export function convertFindOutput(results: string[]): ToolCallContent[] {
  return [createToolCallContent(results.join("\n"))];
}
