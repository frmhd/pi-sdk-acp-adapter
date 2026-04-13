/**
 * ACP Tool Bridge
 *
 * Bridges Pi's 4 core tools (read, write, edit, bash) to ACP client methods.
 * File operations are delegated through ACP filesystem requests and command
 * execution is delegated through ACP terminals.
 */

import { resolve as resolvePath, sep } from "node:path";

import type {
  ToolCallContent,
  ToolKind,
  TerminalHandle,
  EnvVariable,
} from "@agentclientprotocol/sdk";

import {
  DEFAULT_MAX_BYTES,
  type BashOperations,
  type ReadOperations,
  type WriteOperations,
} from "@mariozechner/pi-coding-agent";

import { createToolCallContent, mapToolKind, type AcpClientCapabilitiesSnapshot } from "./types.js";

// =============================================================================
// Utils
// =============================================================================

/** Escape a string for use in a POSIX shell command. */
function escapeBash(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`;
}

/** Escape a string for use in cmd.exe. */
function escapeCmd(str: string): string {
  return `"${str.replace(/(["^%])/g, "^$1")}"`;
}

/**
 * Build an ACP terminal request for a shell command string.
 *
 * ACP clients like Zed already execute terminal requests through the client's
 * configured shell. Pre-wrapping the command in `sh -lc`/`cmd /c` makes the
 * adapter depend on the agent host shell/platform instead of the client shell
 * and breaks shell-managed async constructs like background jobs.
 */
export function createShellTerminalRequest(command: string): { command: string; args: string[] } {
  return {
    command,
    args: [],
  };
}

function createMkdirTerminalRequest(dir: string): { command: string; args: string[] } {
  if (process.platform === "win32") {
    return createShellTerminalRequest(`mkdir ${escapeCmd(dir)}`);
  }

  return createShellTerminalRequest(`mkdir -p ${escapeBash(dir)}`);
}

export interface AcpPathAuthorizationOptions {
  /** Absolute workspace roots allowed for ACP filesystem operations. */
  authorizedRoots?: string[];
}

function normalizeAuthorizedPath(path: string): string {
  const normalized = resolvePath(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function getAuthorizedRoots(cwd: string, additionalDirectories: string[] = []): string[] {
  return Array.from(
    new Set(
      [cwd, ...additionalDirectories]
        .filter((path): path is string => typeof path === "string" && path.length > 0)
        .map((path) => resolvePath(path)),
    ),
  );
}

function isPathWithinAuthorizedRoot(path: string, root: string): boolean {
  if (path === root) {
    return true;
  }

  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return path.startsWith(rootPrefix);
}

export function assertPathAuthorized(
  path: string,
  authorizedRoots: string[],
  operation: "read" | "write" | "create directory",
): void {
  if (authorizedRoots.length === 0) {
    return;
  }

  const normalizedPath = normalizeAuthorizedPath(path);
  const normalizedRoots = authorizedRoots.map(normalizeAuthorizedPath);

  if (normalizedRoots.some((root) => isPathWithinAuthorizedRoot(normalizedPath, root))) {
    return;
  }

  throw new Error(
    `ACP ${operation} denied for path ${JSON.stringify(path)}. Allowed workspace roots: ${authorizedRoots.join(", ")}. Filesystem access is limited to the session cwd and additionalDirectories.`,
  );
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
    args?: string[];
    cwd?: string;
    env?: EnvVariable[];
    outputByteLimit?: number | null;
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
  truncated: boolean;
  exitCode: number | null;
  signal: string | null;
}

function hasTerminalExited(output: {
  exitStatus?: { exitCode?: number | null; signal?: string | null } | null;
}): boolean {
  return output.exitStatus != null;
}

async function pollTerminalToCompletion(
  terminal: TerminalHandle,
  options?: { signal?: AbortSignal },
): Promise<TerminalPollResult> {
  let resolved = false;
  let latestOutput = "";
  let latestTruncated = false;

  const abortHandler = () => {
    // Do not resolve early here; the caller is responsible for killing the terminal.
    // We still wait for the terminal to report its final exit status/output.
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
        latestOutput = output.output;
        latestTruncated = output.truncated;

        // ACP clients report a running terminal as `exitStatus: null`.
        // Only treat the terminal as completed when an actual exit-status
        // object is present.
        if (hasTerminalExited(output)) {
          resolved = true;
          resolve({
            output: latestOutput,
            truncated: latestTruncated,
            exitCode: output.exitStatus?.exitCode ?? null,
            signal: output.exitStatus?.signal ?? null,
          });
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
      .then(async (exitResponse) => {
        if (resolved) return;
        resolved = true;

        try {
          const finalOutput = await terminal.currentOutput();
          latestOutput = finalOutput.output;
          latestTruncated = finalOutput.truncated;
        } catch {
          // Best-effort final output fetch only.
        }

        resolve({
          output: latestOutput,
          truncated: latestTruncated,
          exitCode: exitResponse.exitCode ?? null,
          signal: exitResponse.signal ?? null,
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

/** Extra hooks used to associate ACP terminals with Pi bash tool calls. */
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

/** ACP terminal-backed BashOperations implementation. */
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

    const env: EnvVariable[] | undefined = options.env
      ? Object.entries(options.env)
          .filter(([, value]) => value !== undefined)
          .map(([name, value]) => ({ name, value: value as string }))
      : undefined;

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
    let resolved = false;

    const shouldStop = () => killed || signal?.aborted || resolved;

    const poll = async () => {
      if (shouldStop()) {
        return;
      }

      try {
        const output = await terminal.currentOutput();
        this.hooks.onTerminalOutput?.({ output: output.output, truncated: output.truncated });

        // Do not stream incremental terminal snapshots into Pi's bash tool.
        // ACP terminal output is a snapshot, not an append-only stream, so it can
        // shrink or otherwise change between polls. Feeding those snapshots into
        // Pi incrementally causes stale/incorrect final tool results.
        // Instead, we let the ACP client own the live terminal UI and only pass
        // the final terminal output back into Pi once the command has finished.
        if (hasTerminalExited(output)) {
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

    const timeoutHandle =
      timeout && timeout > 0
        ? setTimeout(() => {
            killed = true;
            void terminal.kill();
          }, timeout * 1000)
        : undefined;

    try {
      const result = await pollTerminalToCompletion(terminal, { signal });
      resolved = true;

      if (result.output.length > 0) {
        onData(Buffer.from(result.output, "utf-8"));
      }

      this.hooks.onTerminalExit?.(result);
      return { exitCode: result.exitCode };
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

// =============================================================================
// Read Operations Bridge
// =============================================================================

/** ACP Read Operations delegates file reads to the ACP client. */
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
  private authorizedRoots: string[];

  constructor(client: AcpClientInterface, options: AcpPathAuthorizationOptions = {}) {
    this.client = client;
    this.authorizedRoots = options.authorizedRoots ?? [];
  }

  async writeFile(absolutePath: string, content: string): Promise<void> {
    assertPathAuthorized(absolutePath, this.authorizedRoots, "write");
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
    assertPathAuthorized(dir, this.authorizedRoots, "create directory");

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

  constructor(client: AcpClientInterface, options: AcpPathAuthorizationOptions = {}) {
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

// =============================================================================
// Tool Bridge Main Class
// =============================================================================

/** Lazily creates ACP-backed Pi tool operation bridges. */
export class AcpToolBridge {
  private client: AcpClientInterface;
  private authorization: AcpPathAuthorizationOptions;
  private terminalOps?: AcpTerminalOperations;
  private readOps?: AcpReadOperations;
  private writeOps?: AcpWriteOperations;
  private editOps?: AcpEditOperations;

  constructor(client: AcpClientInterface, authorization: AcpPathAuthorizationOptions = {}) {
    this.client = client;
    this.authorization = authorization;
  }

  getBashOperations(): BashOperations | undefined {
    if (!this.terminalOps) {
      this.terminalOps = new AcpTerminalOperations(this.client);
    }
    return this.terminalOps;
  }

  getReadOperations(): ReadOperations | undefined {
    if (!this.readOps) {
      this.readOps = new AcpReadOperations(this.client, this.authorization);
    }
    return this.readOps;
  }

  getWriteOperations(): WriteOperations | undefined {
    if (!this.writeOps) {
      this.writeOps = new AcpWriteOperations(this.client, this.authorization);
    }
    return this.writeOps;
  }

  getEditOperations(): AcpEditOperations | undefined {
    if (!this.editOps) {
      this.editOps = new AcpEditOperations(this.client, this.authorization);
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
