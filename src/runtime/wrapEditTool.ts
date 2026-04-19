import { createEditToolDefinition, type EditOperations } from "@mariozechner/pi-coding-agent";

import type { AcpToolCallState } from "../adapter/types.js";
import { resolveToolPath } from "../shared/paths.js";
import {
  type AcpSessionTool,
  type MutationToolTracking,
  markToolBackend,
  trackMutationToolCall,
  type ToolBackend,
} from "./toolTracking.js";

export function wrapEditForAcp(options: {
  cwd: string;
  backend: Extract<ToolBackend, "acp" | "local">;
  baseEditOps: EditOperations;
  tracking: MutationToolTracking;
  onToolCallStateCaptured?: (toolCallId: string, update: Partial<AcpToolCallState>) => void;
}): AcpSessionTool {
  const trackedEditOps: EditOperations = {
    readFile: async (path: string) => {
      const buffer = await options.baseEditOps.readFile(path);
      options.tracking.editContents.set(path, buffer.toString("utf-8"));
      return buffer;
    },
    writeFile: async (path: string, content: string) => {
      const oldText = options.tracking.editContents.get(path);
      const toolCallId = options.tracking.activeMutationToolCalls.get(path);

      if (oldText !== undefined && toolCallId) {
        options.onToolCallStateCaptured?.(toolCallId, {
          toolName: "edit",
          path,
          diff: { path, oldText, newText: content },
        });
        options.tracking.emitMutationToolProgressUpdate(toolCallId);
      }

      options.tracking.editContents.delete(path);
      return options.baseEditOps.writeFile(path, content);
    },
    access: async (path: string) => options.baseEditOps.access(path),
  };

  const baseTool = markToolBackend(
    createEditToolDefinition(options.cwd, { operations: trackedEditOps }),
    options.backend,
  );

  return markToolBackend(
    {
      ...baseTool,
      async execute(...args: Parameters<typeof baseTool.execute>) {
        const [toolCallId, params, signal, onUpdate, ctx] = args;
        const absolutePath = resolveToolPath(params.path, options.cwd);

        options.onToolCallStateCaptured?.(toolCallId, {
          toolName: "edit",
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
              options.tracking.editContents.delete(absolutePath);
            }
          },
        );
      },
    },
    options.backend,
  );
}
