import { createBashToolDefinition } from "@mariozechner/pi-coding-agent";

import type { AcpToolCallState } from "../adapter/types.js";
import {
  AcpTerminalOperations,
  createLocalBashFallbackOperations,
  type AcpClientInterface,
} from "../adapter/AcpToolBridge.js";
import {
  type AcpSessionTool,
  buildBashRawOutput,
  markToolBackend,
  type ToolBackend,
} from "./toolTracking.js";

export function wrapBashForAcp(options: {
  cwd: string;
  backend: Extract<ToolBackend, "acp" | "local">;
  acpClient: AcpClientInterface;
  onToolCallStateCaptured?: (toolCallId: string, update: Partial<AcpToolCallState>) => void;
}): AcpSessionTool {
  const localBashTool = markToolBackend(
    createBashToolDefinition(options.cwd, { operations: createLocalBashFallbackOperations() }),
    "local",
  );
  const toolTemplate =
    options.backend === "local"
      ? localBashTool
      : markToolBackend(
          createBashToolDefinition(options.cwd, {
            operations: new AcpTerminalOperations(options.acpClient),
          }),
          "acp",
        );

  return markToolBackend(
    {
      ...toolTemplate,
      async execute(...args: Parameters<typeof toolTemplate.execute>) {
        const [toolCallId, params, signal, onUpdate, ctx] = args;

        options.onToolCallStateCaptured?.(toolCallId, {
          toolName: "bash",
          rawInput: params,
        });

        if (options.backend === "local") {
          return localBashTool.execute(toolCallId, params, signal, onUpdate, ctx);
        }

        let emittedTerminalUpdate = false;
        let terminalSnapshot:
          | {
              terminalId: string;
              command: string;
              args: string[];
              cwd: string;
              outputByteLimit: number | null;
            }
          | undefined;

        const trackedBashOps = new AcpTerminalOperations(options.acpClient, {
          onTerminalCreated: (terminal) => {
            terminalSnapshot = {
              terminalId: terminal.terminalId,
              command: terminal.command,
              args: terminal.args,
              cwd: terminal.cwd,
              outputByteLimit: terminal.outputByteLimit,
            };

            options.onToolCallStateCaptured?.(toolCallId, {
              toolName: "bash",
              terminalId: terminal.terminalId,
              releaseTerminal: terminal.release,
              rawOutput: buildBashRawOutput(params, terminalSnapshot),
            });

            if (!emittedTerminalUpdate) {
              emittedTerminalUpdate = true;
              onUpdate?.({ content: [], details: undefined });
            }
          },
          onTerminalOutput: (output) => {
            if (!terminalSnapshot) {
              return;
            }

            options.onToolCallStateCaptured?.(toolCallId, {
              rawOutput: buildBashRawOutput(params, terminalSnapshot, {
                output: output.output,
                truncated: output.truncated,
              }),
            });
          },
          onTerminalExit: (result) => {
            if (!terminalSnapshot) {
              return;
            }

            options.onToolCallStateCaptured?.(toolCallId, {
              rawOutput: buildBashRawOutput(params, terminalSnapshot, {
                output: result.output,
                truncated: result.truncated,
                exitCode: result.exitCode,
                signal: result.signal,
              }),
            });
          },
        });

        return markToolBackend(
          createBashToolDefinition(options.cwd, { operations: trackedBashOps }),
          "acp",
        ).execute(toolCallId, params, signal, onUpdate, ctx);
      },
    },
    options.backend,
  );
}
