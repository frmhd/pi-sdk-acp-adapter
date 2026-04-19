import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

import type { AcpBashTerminalRawOutput } from "../adapter/types.js";

export type ToolBackend = "acp" | "local" | "hybrid";

export type AcpSessionTool = ToolDefinition<any, any, any> & {
  acpBackend: ToolBackend;
};

export interface AcpSessionTools {
  readTool: AcpSessionTool;
  writeTool: AcpSessionTool;
  editTool: AcpSessionTool;
  bashTool: AcpSessionTool;
}

export interface MutationToolTracking {
  activeMutationToolCalls: Map<string, string>;
  mutationToolProgressUpdates: Map<string, () => void>;
  editContents: Map<string, string>;
  emitMutationToolProgressUpdate: (toolCallId: string | undefined) => void;
}

export function trackMutationToolCall<T>(
  activeMutationToolCalls: Map<string, string>,
  absolutePath: string,
  toolCallId: string,
  execute: () => Promise<T>,
): Promise<T> {
  activeMutationToolCalls.set(absolutePath, toolCallId);

  return execute().finally(() => {
    if (activeMutationToolCalls.get(absolutePath) === toolCallId) {
      activeMutationToolCalls.delete(absolutePath);
    }
  });
}

export function createMutationToolTracking(): MutationToolTracking {
  const activeMutationToolCalls = new Map<string, string>();
  const mutationToolProgressUpdates = new Map<string, () => void>();
  const editContents = new Map<string, string>();

  return {
    activeMutationToolCalls,
    mutationToolProgressUpdates,
    editContents,
    emitMutationToolProgressUpdate(toolCallId) {
      if (!toolCallId) {
        return;
      }

      const emit = mutationToolProgressUpdates.get(toolCallId);
      if (!emit) {
        return;
      }

      mutationToolProgressUpdates.delete(toolCallId);
      emit();
    },
  };
}

export function buildBashRawOutput(
  input: { command: string; timeout?: number },
  terminal: {
    terminalId: string;
    command: string;
    args: string[];
    cwd: string;
    outputByteLimit: number | null;
  },
  update?: Partial<Pick<AcpBashTerminalRawOutput, "output" | "truncated" | "exitCode" | "signal">>,
): AcpBashTerminalRawOutput {
  return {
    type: "acp_terminal",
    input: {
      command: input.command,
      timeout: input.timeout ?? null,
    },
    execution: {
      command: terminal.command,
      args: terminal.args,
      cwd: terminal.cwd,
      outputByteLimit: terminal.outputByteLimit,
    },
    terminalId: terminal.terminalId,
    fullOutputPath: null,
    ...update,
  };
}

export function markToolBackend<T extends object>(
  tool: T,
  backend: ToolBackend,
): T & { acpBackend: ToolBackend } {
  return Object.assign(tool, { acpBackend: backend });
}
