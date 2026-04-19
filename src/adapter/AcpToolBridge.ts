import type { ToolCallContent, ToolKind } from "@agentclientprotocol/sdk";
import type {
  BashOperations,
  ReadOperations,
  WriteOperations,
} from "@mariozechner/pi-coding-agent";

import type { AcpPathAuthorizationOptions } from "./tools/authorization.js";
import { AcpReadOperations } from "./tools/acpReadOperations.js";
import { AcpEditOperations, AcpWriteOperations } from "./tools/acpWriteOperations.js";
import { AcpTerminalOperations, type AcpClientInterface } from "./tools/terminalOperations.js";

export type InputMapper<TInput> = (args: Record<string, unknown>) => TInput;
export type OutputMapper = (result: unknown) => ToolCallContent[];

export interface ToolBridgeConfig<TInput> {
  piToolName: string;
  acpToolKind: ToolKind;
  mapInput: InputMapper<TInput>;
  mapOutput: OutputMapper;
}

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

export type { AcpClientCapabilitiesSnapshot } from "./types.js";

export {
  type AcpPathAuthorizationOptions,
  type AcpReadFallbackPolicyOptions,
  getAuthorizedRoots,
  isPathWithinAuthorizedRoots,
  assertPathAuthorized,
  shouldBypassAcpRead,
} from "./tools/authorization.js";

export { normalizeAcpFsError } from "./tools/acpFsErrors.js";

export {
  createLocalReadOperations,
  createLocalWriteOperations,
  createLocalEditOperations,
  createLocalBashFallbackOperations,
  buildNonInteractiveShellEnv,
} from "./tools/localOperations.js";

export {
  createShellTerminalRequest,
  createMkdirTerminalRequest,
} from "./tools/terminalRequests.js";

export {
  type AcpClientInterface,
  type AcpTerminalLifecycleHooks,
  AcpTerminalOperations,
  waitForTerminalCompletion,
} from "./tools/terminalOperations.js";

export { AcpReadOperations } from "./tools/acpReadOperations.js";
export { HybridReadOperations } from "./tools/hybridReadOperations.js";
export {
  type AcpWriteOperationsOptions,
  AcpWriteOperations,
  AcpEditOperations,
} from "./tools/acpWriteOperations.js";

export {
  getAcpToolKind,
  convertReadOutput,
  convertWriteOutput,
  convertEditOutput,
  convertBashOutput,
} from "./tools/outputConverters.js";
