/**
 * ACP Tool Bridge
 *
 * Bridges Pi's built-in tools (read, write, edit, bash, grep, find, ls) to ACP tool call protocol.
 * Handles tool input/output conversion and terminal management delegation.
 */

import type { ToolCallContent, ToolKind, TerminalHandle } from "@agentclientprotocol/sdk";

import type {
  BashOperations,
  ReadOperations,
  WriteOperations,
  LsOperations,
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
  /** Create a terminal and execute a command */
  createTerminal(params: {
    command: string;
    cwd: string;
    terminalId?: string;
    env?: [string, string][];
    size?: { cols: number; rows: number };
  }): Promise<TerminalHandle>;
  /** Read a text file */
  readTextFile(params: { path: string }): Promise<{ content: string }>;
  /** Write a text file */
  writeTextFile(params: { path: string; content: string }): Promise<void>;
  /** Check if terminal creation is supported */
  supportsTerminal?(): boolean;
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

    // Create terminal via ACP client
    const terminal = await this.client.createTerminal({
      command,
      cwd,
      terminalId: undefined, // Client will generate one
      env: options.env ? (Object.entries(options.env) as [string, string][]) : undefined,
      size: { cols: 80, rows: 24 },
    });

    let lastOutputLength = 0;
    let pollInterval: NodeJS.Timeout | undefined;
    let killed = false;
    let resolved = false;

    // Helper to check if we should stop polling
    const shouldStop = () => killed || signal?.aborted || resolved;

    // Start polling for output
    pollInterval = setInterval(async () => {
      if (shouldStop()) {
        if (pollInterval) clearInterval(pollInterval);
        return;
      }

      try {
        const output = await terminal.currentOutput();

        // Get new output since last check
        if (output.output.length > lastOutputLength) {
          const newOutput = output.output.slice(lastOutputLength);
          onData(Buffer.from(newOutput, "utf-8"));
          lastOutputLength = output.output.length;
        }

        // Check if process has exited
        if (output.exitStatus !== undefined) {
          resolved = true;
          if (pollInterval) clearInterval(pollInterval);
        }
      } catch {
        if (pollInterval) clearInterval(pollInterval);
      }
    }, TERMINAL_POLL_INTERVAL);

    // Set up abort handler
    const abortHandler = () => {
      killed = true;
      void terminal.kill();
      if (pollInterval) clearInterval(pollInterval);
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

      if (pollInterval) clearInterval(pollInterval);
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
    // ACP doesn't have a dedicated mkdir method, so we use writeTextFile
    // with empty content to create the directory via the client's filesystem
    // Note: This may need to be handled differently based on client capabilities
    try {
      await this.client.writeTextFile({
        path: dir.replace(/[/\\]*$/, "") + "/.pi-mkdir-placeholder",
        content: "",
      });
    } catch {
      // Ignore - directory may already exist or client handles mkdir differently
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
 */
export class AcpGrepOperations {
  private client: AcpClientInterface;

  constructor(client: AcpClientInterface) {
    this.client = client;
  }

  async grep(options: {
    pattern: string;
    path?: string;
    glob?: string;
    ignoreCase?: boolean;
    literal?: boolean;
    context?: number;
    limit?: number;
  }): Promise<string[]> {
    // For grep, we need to search file contents
    // ACP doesn't have a dedicated grep method, so we implement it via terminal
    // This is a fallback - ideally the client should support native grep
    const flags = options.ignoreCase ? "-i" : "";
    const literalFlag = options.literal ? "-F" : "";
    const contextFlag = options.context ? `-C${options.context}` : "";

    const searchDir = options.path || ".";
    const cmd = `grep ${flags} ${literalFlag} ${contextFlag} ${escapeBash(options.pattern)} ${escapeBash(searchDir)} 2>/dev/null || true`;

    let lastOutputLength = 0;

    try {
      const terminal = await this.client.createTerminal({
        command: cmd,
        cwd: searchDir,
        terminalId: undefined,
        size: { cols: 80, rows: 24 },
      });

      const results: string[] = [];
      let resolved = false;

      // Poll for output
      const pollInterval = setInterval(async () => {
        if (resolved) {
          clearInterval(pollInterval);
          return;
        }

        try {
          const output = await terminal.currentOutput();

          // Get new output since last check
          if (output.output.length > lastOutputLength) {
            const newOutput = output.output.slice(lastOutputLength);
            results.push(newOutput);
            lastOutputLength = output.output.length;
          }

          // Check if process has exited
          if (output.exitStatus !== undefined) {
            resolved = true;
            clearInterval(pollInterval);
          }
        } catch {
          resolved = true;
          clearInterval(pollInterval);
        }
      }, TERMINAL_POLL_INTERVAL);

      await terminal.waitForExit();
      resolved = true;

      if (pollInterval) clearInterval(pollInterval);

      const output = results.join("");
      const lines = output.split("\n").filter((line) => line.trim() !== "");

      terminal.release().catch(() => {});

      if (options.limit) {
        return lines.slice(0, options.limit);
      }

      return lines;
    } catch {
      // Fallback: return empty results if grep fails
      return [];
    }
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
    const cmd = `ls -d ${escapeBash(absolutePath)} 2>/dev/null && echo "exists" || echo "not_found"`;

    try {
      const terminal = await this.client.createTerminal({
        command: cmd,
        cwd: ".",
        terminalId: undefined,
        size: { cols: 80, rows: 24 },
      });

      const results: string[] = [];
      const pollInterval = setInterval(async () => {
        try {
          const output = await terminal.currentOutput();
          if (output.output) results.push(output.output);
          if (output.exitStatus !== undefined) clearInterval(pollInterval);
        } catch {
          clearInterval(pollInterval);
        }
      }, 50);

      await terminal.waitForExit();
      clearInterval(pollInterval);
      terminal.release().catch(() => {});

      return results.join("").includes("exists");
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
    // Convert glob pattern to find -name pattern if possible, or just use find with -name
    // Note: simple glob to find conversion
    const findPattern = pattern.startsWith("**/") ? pattern.slice(3) : pattern;

    const cmd = `find ${escapeBash(searchPath)} -name ${escapeBash(findPattern)} -maxdepth 10 2>/dev/null | head -${options.limit || 100}`;

    let lastOutputLength = 0;

    try {
      const terminal = await this.client.createTerminal({
        command: cmd,
        cwd: searchPath,
        terminalId: undefined,
        size: { cols: 80, rows: 24 },
      });

      const results: string[] = [];
      let resolved = false;

      // Poll for output
      const pollInterval = setInterval(async () => {
        if (resolved) {
          clearInterval(pollInterval);
          return;
        }

        try {
          const output = await terminal.currentOutput();

          // Get new output since last check
          if (output.output.length > lastOutputLength) {
            const newOutput = output.output.slice(lastOutputLength);
            results.push(newOutput);
            lastOutputLength = output.output.length;
          }

          // Check if process has exited
          if (output.exitStatus !== undefined) {
            resolved = true;
            clearInterval(pollInterval);
          }
        } catch {
          resolved = true;
          clearInterval(pollInterval);
        }
      }, TERMINAL_POLL_INTERVAL);

      await terminal.waitForExit();
      resolved = true;

      if (pollInterval) clearInterval(pollInterval);

      terminal.release().catch(() => {});

      return results
        .join("")
        .split("\n")
        .filter((line) => line.trim() !== "");
    } catch {
      return [];
    }
  }

  /**
   * Legacy find method for backwards compatibility or direct use
   * @deprecated Use glob() instead
   */
  async find(options: { pattern?: string; path?: string; limit?: number }): Promise<string[]> {
    return this.glob(options.pattern || "*", options.path || ".", {
      ignore: [],
      limit: options.limit || 100,
    });
  }
}

// =============================================================================
// Ls Operations Bridge
// =============================================================================

/**
 * ACP Ls Operations
 * Lists directory contents via the ACP client.
 */
export class AcpLsOperations {
  private client: AcpClientInterface;

  constructor(client: AcpClientInterface) {
    this.client = client;
  }

  async exists(absolutePath: string): Promise<boolean> {
    // Use ls to check if path exists
    const cmd = `ls -d ${escapeBash(absolutePath)} 2>/dev/null && echo "exists" || echo "not_found"`;

    try {
      const terminal = await this.client.createTerminal({
        command: cmd,
        cwd: ".",
        terminalId: undefined,
        size: { cols: 80, rows: 24 },
      });

      const results: string[] = [];

      // Quick poll for output
      const pollInterval = setInterval(async () => {
        try {
          const output = await terminal.currentOutput();
          if (output.output) {
            results.push(output.output);
          }
          if (output.exitStatus !== undefined) {
            clearInterval(pollInterval);
          }
        } catch {
          clearInterval(pollInterval);
        }
      }, 50);

      await terminal.waitForExit();
      clearInterval(pollInterval);
      terminal.release().catch(() => {});

      const output = results.join("");
      return output.includes("exists");
    } catch {
      return false;
    }
  }

  async stat(absolutePath: string): Promise<{ isDirectory: () => boolean }> {
    // Use ls -la to check if it's a directory
    const cmd = `ls -ld ${escapeBash(absolutePath)} 2>/dev/null`;

    try {
      const terminal = await this.client.createTerminal({
        command: cmd,
        cwd: ".",
        terminalId: undefined,
        size: { cols: 80, rows: 24 },
      });

      const results: string[] = [];

      // Quick poll for output
      const pollInterval = setInterval(async () => {
        try {
          const output = await terminal.currentOutput();
          if (output.output) {
            results.push(output.output);
          }
          if (output.exitStatus !== undefined) {
            clearInterval(pollInterval);
          }
        } catch {
          clearInterval(pollInterval);
        }
      }, 50);

      await terminal.waitForExit();
      clearInterval(pollInterval);
      terminal.release().catch(() => {});

      const output = results.join("");
      const isDir = output.startsWith("d") || output.includes("/");

      return {
        isDirectory: () => isDir,
      };
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
    const cmd = `ls -A1 ${escapeBash(listPath)} 2>/dev/null || ls ${escapeBash(listPath)} 2>/dev/null || echo ""`;

    let lastOutputLength = 0;

    try {
      const terminal = await this.client.createTerminal({
        command: cmd,
        cwd: listPath,
        terminalId: undefined,
        size: { cols: 80, rows: 24 },
      });

      const results: string[] = [];
      let resolved = false;

      // Poll for output
      const pollInterval = setInterval(async () => {
        if (resolved) {
          clearInterval(pollInterval);
          return;
        }

        try {
          const output = await terminal.currentOutput();

          // Get new output since last check
          if (output.output.length > lastOutputLength) {
            const newOutput = output.output.slice(lastOutputLength);
            results.push(newOutput);
            lastOutputLength = output.output.length;
          }

          // Check if process has exited
          if (output.exitStatus !== undefined) {
            resolved = true;
            clearInterval(pollInterval);
          }
        } catch {
          resolved = true;
          clearInterval(pollInterval);
        }
      }, TERMINAL_POLL_INTERVAL);

      await terminal.waitForExit();
      resolved = true;

      if (pollInterval) clearInterval(pollInterval);

      terminal.release().catch(() => {});

      const output = results.join("");
      const lines = output
        .split("\n")
        .filter((line) => line.trim() !== "")
        .slice(0, options?.limit || 100);

      // Skip the total line at the top
      return lines.filter((line) => !line.startsWith("total "));
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
