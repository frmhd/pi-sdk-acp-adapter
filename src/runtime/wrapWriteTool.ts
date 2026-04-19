import {
  createWriteToolDefinition,
  type ReadOperations,
  type WriteOperations,
} from "@mariozechner/pi-coding-agent";

import type { AcpToolCallState } from "../adapter/types.js";
import { resolveToolPath } from "../shared/paths.js";
import {
  type AcpSessionTool,
  type MutationToolTracking,
  markToolBackend,
  trackMutationToolCall,
  type ToolBackend,
} from "./toolTracking.js";

export function wrapWriteForAcp(options: {
  cwd: string;
  backend: Extract<ToolBackend, "acp" | "local">;
  readOps: ReadOperations;
  baseWriteOps: WriteOperations;
  tracking: MutationToolTracking;
  onToolCallStateCaptured?: (toolCallId: string, update: Partial<AcpToolCallState>) => void;
}): AcpSessionTool {
  const trackedWriteOps: WriteOperations = {
    writeFile: async (path: string, content: string) => {
      const toolCallId = options.tracking.activeMutationToolCalls.get(path);
      let oldText: string | null = null;

      try {
        const existing = await options.readOps.readFile(path);
        oldText = existing.toString("utf-8");
      } catch {
        oldText = null;
      }

      if (toolCallId) {
        options.onToolCallStateCaptured?.(toolCallId, {
          toolName: "write",
          path,
          diff: { path, oldText, newText: content },
        });
        options.tracking.emitMutationToolProgressUpdate(toolCallId);
      }

      return options.baseWriteOps.writeFile(path, content);
    },
    mkdir: async (dir: string) => options.baseWriteOps.mkdir(dir),
  };

  const baseTool = markToolBackend(
    createWriteToolDefinition(options.cwd, { operations: trackedWriteOps }),
    options.backend,
  );

  return markToolBackend(
    {
      ...baseTool,
      async execute(...args: Parameters<typeof baseTool.execute>) {
        const [toolCallId, params, signal, onUpdate, ctx] = args;
        const absolutePath = resolveToolPath(params.path, options.cwd);

        options.onToolCallStateCaptured?.(toolCallId, {
          toolName: "write",
          path: absolutePath,
        });

        if (onUpdate) {
          onUpdate({ content: [], details: undefined });
          options.tracking.mutationToolProgressUpdates.set(toolCallId, () => {
            onUpdate({ content: [], details: undefined });
          });
        } else {
          options.tracking.mutationToolProgressUpdates.delete(toolCallId);
        }

        return trackMutationToolCall(
          options.tracking.activeMutationToolCalls,
          absolutePath,
          toolCallId,
          async () => {
            try {
              return await baseTool.execute(toolCallId, params, signal, onUpdate, ctx);
            } finally {
              options.tracking.mutationToolProgressUpdates.delete(toolCallId);
            }
          },
        );
      },
    },
    options.backend,
  );
}
