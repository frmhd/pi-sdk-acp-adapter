import {
  createReadToolDefinition,
  type CreateAgentSessionOptions,
  type EditOperations,
  type ModelRuntime,
  type ReadOperations,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";

import {
  AcpWriteOperations,
  HybridReadOperations,
  createLocalEditOperations,
  createLocalReadOperations,
  createLocalWriteOperations,
  getAuthorizedRoots,
  type AcpClientInterface,
} from "../adapter/AcpToolBridge.js";
import type { AcpClientCapabilitiesSnapshot, AcpToolCallState } from "../adapter/types.js";
import {
  type AcpSessionTools,
  createMutationToolTracking,
  markToolBackend,
} from "./toolTracking.js";
import { wrapBashForAcp } from "./wrapBashTool.js";
import { wrapEditForAcp } from "./wrapEditTool.js";
import { wrapWriteForAcp } from "./wrapWriteTool.js";
import { createSubagentTool } from "./wrapSubagentTool.js";

export interface BuildAcpSessionToolsOptions {
  cwd: string;
  additionalDirectories: string[];
  agentDir?: string;
  modelRuntime: ModelRuntime;
  acpClient: AcpClientInterface;
  clientCapabilities: AcpClientCapabilitiesSnapshot;
  onToolCallStateCaptured?: (toolCallId: string, update: Partial<AcpToolCallState>) => void;
}

function buildCoreAcpSessionTools(
  options: BuildAcpSessionToolsOptions,
): Pick<AcpSessionTools, "readTool" | "writeTool" | "editTool" | "bashTool"> {
  const authorizedRoots = getAuthorizedRoots(options.cwd, options.additionalDirectories);
  const acpReadRoots = getAuthorizedRoots(options.cwd);
  const tracking = createMutationToolTracking();

  const localReadOps = createLocalReadOperations({ authorizedRoots });
  const localWriteOps = createLocalWriteOperations({ authorizedRoots });
  const localEditOps = createLocalEditOperations({ authorizedRoots });

  const selectedReadOps: ReadOperations = options.clientCapabilities.supportsReadTextFile
    ? new HybridReadOperations(
        options.acpClient,
        {
          authorizedRoots,
          acpReadRoots,
        },
        localReadOps,
      )
    : localReadOps;

  const selectedWriteOps: WriteOperations = options.clientCapabilities.supportsWriteTextFile
    ? new AcpWriteOperations(options.acpClient, {
        authorizedRoots,
        mkdirStrategy: options.clientCapabilities.supportsTerminal ? "terminal" : "local",
      })
    : localWriteOps;

  const selectedEditOps: EditOperations =
    options.clientCapabilities.supportsReadTextFile &&
    options.clientCapabilities.supportsWriteTextFile
      ? {
          readFile: (absolutePath: string) => selectedReadOps.readFile(absolutePath),
          writeFile: (absolutePath: string, content: string) =>
            selectedWriteOps.writeFile(absolutePath, content),
          access: (absolutePath: string) => selectedReadOps.access(absolutePath),
        }
      : localEditOps;

  const readTool = markToolBackend(
    createReadToolDefinition(options.cwd, { operations: selectedReadOps }),
    options.clientCapabilities.supportsReadTextFile ? "hybrid" : "local",
  );

  const writeTool = wrapWriteForAcp({
    cwd: options.cwd,
    backend: options.clientCapabilities.supportsWriteTextFile ? "acp" : "local",
    readOps: selectedReadOps,
    baseWriteOps: selectedWriteOps,
    tracking,
    onToolCallStateCaptured: options.onToolCallStateCaptured,
  });

  const editTool = wrapEditForAcp({
    cwd: options.cwd,
    backend:
      options.clientCapabilities.supportsReadTextFile &&
      options.clientCapabilities.supportsWriteTextFile
        ? "acp"
        : "local",
    baseEditOps: selectedEditOps,
    tracking,
    onToolCallStateCaptured: options.onToolCallStateCaptured,
  });

  const bashTool = wrapBashForAcp({
    cwd: options.cwd,
    backend: options.clientCapabilities.supportsTerminal ? "acp" : "local",
    acpClient: options.acpClient,
    onToolCallStateCaptured: options.onToolCallStateCaptured,
  });

  return {
    readTool,
    writeTool,
    editTool,
    bashTool,
  };
}

export function buildAcpSessionTools(options: BuildAcpSessionToolsOptions): AcpSessionTools {
  const coreTools = buildCoreAcpSessionTools(options);
  const createChildCustomTools = (
    cwd: string,
  ): NonNullable<CreateAgentSessionOptions["customTools"]> => {
    const childCoreTools = buildCoreAcpSessionTools({
      ...options,
      cwd,
      onToolCallStateCaptured: undefined,
    });

    return [
      childCoreTools.readTool,
      childCoreTools.writeTool,
      childCoreTools.editTool,
      childCoreTools.bashTool,
    ] as unknown as NonNullable<CreateAgentSessionOptions["customTools"]>;
  };

  const subagentTool = createSubagentTool({
    cwd: options.cwd,
    agentDir: options.agentDir,
    modelRuntime: options.modelRuntime,
    createChildCustomTools,
  });

  return {
    ...coreTools,
    subagentTool,
  };
}
