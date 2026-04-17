/**
 * ACP Tool Bridge
 *
 * Bridges Pi's 4 core tools (read, write, edit, bash) to ACP client methods.
 * ACP-backed operations stay strict; capability-based backend selection now
 * happens in runtime/session setup.
 */

import { constants } from "node:fs";
import {
  access as fsAccess,
  mkdir as fsMkdir,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { extname, resolve as resolvePath, sep } from "node:path";

import type {
  ToolCallContent,
  ToolKind,
  TerminalHandle,
  EnvVariable,
} from "@agentclientprotocol/sdk";

import {
  DEFAULT_MAX_BYTES,
  createLocalBashOperations,
  type BashOperations,
  type EditOperations,
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
  /** Absolute workspace roots allowed for filesystem operations. */
  authorizedRoots?: string[];
}

export interface AcpReadFallbackPolicyOptions extends AcpPathAuthorizationOptions {
  /** Absolute roots that should keep using ACP fs/read_text_file. */
  acpReadRoots?: string[];
  /** Optional roots that should always bypass ACP reads. */
  alwaysLocalRoots?: string[];
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

function isPathWithinAuthorizedRoots(path: string, roots: string[]): boolean {
  if (roots.length === 0) {
    return true;
  }

  const normalizedPath = normalizeAuthorizedPath(path);
  const normalizedRoots = roots.map(normalizeAuthorizedPath);
  return normalizedRoots.some((root) => isPathWithinAuthorizedRoot(normalizedPath, root));
}

function isAcpResourceNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const errorWithCode = error as Error & { code?: unknown };
  return errorWithCode.code === -32002 || /resource not found/i.test(error.message);
}

export function normalizeAcpFsError(error: unknown, absolutePath: string): Error {
  if (isAcpResourceNotFoundError(error)) {
    const normalized = new Error(
      `ENOENT: no such file or directory, open ${JSON.stringify(absolutePath)}`,
    ) as NodeJS.ErrnoException;
    normalized.code = "ENOENT";
    normalized.errno = -2;
    normalized.path = absolutePath;
    return normalized;
  }

  return error instanceof Error ? error : new Error(String(error));
}

export function assertPathAuthorized(
  path: string,
  authorizedRoots: string[],
  operation: "read" | "write" | "create directory",
): void {
  if (authorizedRoots.length === 0 || isPathWithinAuthorizedRoots(path, authorizedRoots)) {
    return;
  }

  throw new Error(
    `ACP ${operation} denied for path ${JSON.stringify(path)}. Allowed workspace roots: ${authorizedRoots.join(", ")}. Filesystem access is limited to the session cwd and additionalDirectories.`,
  );
}

export function shouldBypassAcpRead(
  absolutePath: string,
  options: AcpReadFallbackPolicyOptions,
): boolean {
  const authorizedRoots = options.authorizedRoots ?? [];
  assertPathAuthorized(absolutePath, authorizedRoots, "read");

  const alwaysLocalRoots = options.alwaysLocalRoots ?? [];
  if (alwaysLocalRoots.length > 0 && isPathWithinAuthorizedRoots(absolutePath, alwaysLocalRoots)) {
    return true;
  }

  const acpReadRoots = options.acpReadRoots ?? authorizedRoots;
  if (acpReadRoots.length === 0) {
    return false;
  }

  return !isPathWithinAuthorizedRoots(absolutePath, acpReadRoots);
}

const LOCAL_IMAGE_MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function detectLocalImageMimeType(absolutePath: string): string | null {
  return LOCAL_IMAGE_MIME_TYPES[extname(absolutePath).toLowerCase()] ?? null;
}

export function createLocalReadOperations(
  options: AcpPathAuthorizationOptions = {},
): ReadOperations {
  const authorizedRoots = options.authorizedRoots ?? [];

  return {
    async readFile(absolutePath: string): Promise<Buffer> {
      assertPathAuthorized(absolutePath, authorizedRoots, "read");
      return fsReadFile(absolutePath);
    },
    async access(absolutePath: string): Promise<void> {
      assertPathAuthorized(absolutePath, authorizedRoots, "read");
      await fsAccess(absolutePath, constants.R_OK);
    },
    async detectImageMimeType(absolutePath: string): Promise<string | null> {
      assertPathAuthorized(absolutePath, authorizedRoots, "read");
      return detectLocalImageMimeType(absolutePath);
    },
  };
}

export function createLocalWriteOperations(
  options: AcpPathAuthorizationOptions = {},
): WriteOperations {
  const authorizedRoots = options.authorizedRoots ?? [];

  return {
    async writeFile(absolutePath: string, content: string): Promise<void> {
      assertPathAuthorized(absolutePath, authorizedRoots, "write");
      await fsWriteFile(absolutePath, content, "utf-8");
    },
    async mkdir(dir: string): Promise<void> {
      assertPathAuthorized(dir, authorizedRoots, "create directory");
      await fsMkdir(dir, { recursive: true });
    },
  };
}

export function createLocalEditOperations(
  options: AcpPathAuthorizationOptions = {},
): EditOperations {
  const authorizedRoots = options.authorizedRoots ?? [];
  const localReadOps = createLocalReadOperations({ authorizedRoots });
  const localWriteOps = createLocalWriteOperations({ authorizedRoots });

  return {
    readFile: localReadOps.readFile,
    writeFile: localWriteOps.writeFile,
    async access(absolutePath: string): Promise<void> {
      assertPathAuthorized(absolutePath, authorizedRoots, "read");
      await fsAccess(absolutePath, constants.R_OK | constants.W_OK);
    },
  };
}

// =============================================================================
// Bash Execution Helpers
// =============================================================================

const PAGER_DISABLING_ENV: NodeJS.ProcessEnv = {
  PAGER: "cat",
  GH_PAGER: "cat",
  GIT_PAGER: "cat",
};

function buildNonInteractiveShellEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...PAGER_DISABLING_ENV,
    ...env,
  };
}

/** Local child_process-backed BashOperations used when ACP terminal is unavailable. */
export function createLocalBashFallbackOperations(): BashOperations {
  const localBash = createLocalBashOperations();

  return {
    exec(command, cwd, options) {
      return localBash.exec(command, cwd, {
        ...options,
        env: buildNonInteractiveShellEnv(options.env),
      });
    },
  };
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

async function waitForTerminalCompletion(
  terminal: TerminalHandle,
  options?: { signal?: AbortSignal },
): Promise<TerminalPollResult> {
  // Use waitForExit() to efficiently wait for terminal completion
  // without polling. Then fetch final output once.
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

    // Inject pager-disabling vars to prevent interactive pagers (like less)
    // from hanging ACP-backed or locally-fallbacked shell execution.
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

    // Set up abort handler before starting the poll loop
    const abortHandler = () => {
      killed = true;
      void terminal.kill();
    };

    if (signal) {
      signal.addEventListener("abort", abortHandler);
    }

    // Set up timeout before starting the poll loop
    const timeoutHandle =
      timeout && timeout > 0
        ? setTimeout(() => {
            killed = true;
            void terminal.kill();
          }, timeout * 1000)
        : undefined;

    // Single poll loop that handles both live progress updates and completion detection
    const terminalResult = await new Promise<TerminalPollResult>((resolve, reject) => {
      const poll = async () => {
        if (shouldStop()) {
          return;
        }

        try {
          const output = await terminal.currentOutput();

          // Live progress update via hooks
          this.hooks.onTerminalOutput?.({ output: output.output, truncated: output.truncated });

          // Check if terminal has completed
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

/** Mixed read operations: ACP within ACP-visible roots, local elsewhere. */
export class HybridReadOperations implements ReadOperations {
  private readonly localReadOps: ReadOperations;
  private readonly acpReadOps: AcpReadOperations;
  private readonly policy: AcpReadFallbackPolicyOptions;

  constructor(
    client: AcpClientInterface,
    options: AcpReadFallbackPolicyOptions = {},
    localReadOps: ReadOperations = createLocalReadOperations({
      authorizedRoots: options.authorizedRoots,
    }),
  ) {
    this.localReadOps = localReadOps;
    this.acpReadOps = new AcpReadOperations(client, {
      authorizedRoots: options.authorizedRoots,
    });
    this.policy = options;
  }

  async readFile(absolutePath: string): Promise<Buffer> {
    if (shouldBypassAcpRead(absolutePath, this.policy)) {
      return this.localReadOps.readFile(absolutePath);
    }

    return this.acpReadOps.readFile(absolutePath);
  }

  async access(absolutePath: string): Promise<void> {
    if (shouldBypassAcpRead(absolutePath, this.policy)) {
      return this.localReadOps.access(absolutePath);
    }

    return this.acpReadOps.access(absolutePath);
  }

  async detectImageMimeType(absolutePath: string): Promise<string | null | undefined> {
    if (shouldBypassAcpRead(absolutePath, this.policy)) {
      return this.localReadOps.detectImageMimeType?.(absolutePath);
    }

    return undefined;
  }
}

// =============================================================================
// Write Operations Bridge
// =============================================================================

export interface AcpWriteOperationsOptions extends AcpPathAuthorizationOptions {
  mkdirStrategy?: "local" | "terminal";
}

/** ACP Write Operations delegates file writes to the ACP client. */
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

// =============================================================================
// Edit Operations Bridge
// =============================================================================

/** ACP Edit Operations delegates edits to ACP read + write methods. */
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

// =============================================================================
// Tool Bridge Main Class
// =============================================================================

/** Lazily creates ACP-backed Pi tool operation bridges. */
export class AcpToolBridge {
  private client: AcpClientInterface;
  private authorization: AcpPathAuthorizationOptions;
  private bashOps?: BashOperations;
  private readOps?: AcpReadOperations;
  private writeOps?: AcpWriteOperations;
  private editOps?: AcpEditOperations;

  constructor(client: AcpClientInterface, authorization: AcpPathAuthorizationOptions = {}) {
    this.client = client;
    this.authorization = authorization;
  }

  getBashOperations(): BashOperations {
    if (!this.bashOps) {
      this.bashOps = new AcpTerminalOperations(this.client);
    }
    return this.bashOps;
  }

  getReadOperations(): ReadOperations {
    if (!this.readOps) {
      this.readOps = new AcpReadOperations(this.client, this.authorization);
    }
    return this.readOps;
  }

  getWriteOperations(): WriteOperations {
    if (!this.writeOps) {
      this.writeOps = new AcpWriteOperations(this.client, this.authorization);
    }
    return this.writeOps;
  }

  getEditOperations(): AcpEditOperations {
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
