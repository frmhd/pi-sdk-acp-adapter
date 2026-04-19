import type { ToolCallContent } from "@agentclientprotocol/sdk";

import { createTerminalContent, createToolCallContent } from "../types.js";
import { mapPiContentBlockToAcp } from "./contentBlocks.js";
import type { ToolEventMappingContext } from "./toolPresentation.js";

export function mapStructuredToolResultContent(result: unknown): ToolCallContent[] | undefined {
  if (typeof result !== "object" || result === null) {
    return undefined;
  }

  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) {
    return undefined;
  }

  const mapped = content.map(mapPiContentBlockToAcp).filter(Boolean) as ToolCallContent[];
  return mapped.length > 0 ? mapped : undefined;
}

export function extractTextFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const textFields = ["stdout", "content", "output", "result", "message", "text", "data", "stderr"];

  for (const field of textFields) {
    if (typeof record[field] === "string") {
      return record[field] as string;
    }
  }

  for (const field of textFields) {
    if (Array.isArray(record[field])) {
      const parts: string[] = [];

      for (const item of record[field] as unknown[]) {
        if (typeof item === "string") {
          parts.push(item);
          continue;
        }

        if (typeof item === "object" && item !== null) {
          const objectItem = item as Record<string, unknown>;
          if (typeof objectItem.text === "string") {
            parts.push(objectItem.text);
          } else if (typeof objectItem.path === "string") {
            parts.push(objectItem.path);
          } else if (typeof objectItem.match === "string") {
            parts.push(objectItem.match);
          }
        }
      }

      if (parts.length > 0) {
        return parts.join("\n");
      }
    }
  }

  if (typeof record.exitCode === "number") {
    return `Exit code: ${record.exitCode}`;
  }

  return undefined;
}

export function mapToolResultContent(result: unknown): ToolCallContent[] | undefined {
  const structuredContent = mapStructuredToolResultContent(result);
  if (structuredContent && structuredContent.length > 0) {
    return structuredContent;
  }

  const text = extractTextFromUnknown(result);
  return text ? [createToolCallContent(text)] : undefined;
}

export function mapTerminalToolContent(
  context?: ToolEventMappingContext,
): ToolCallContent[] | undefined {
  const terminalId = context?.toolCallState?.terminalId;
  return terminalId ? [createTerminalContent(terminalId)] : undefined;
}
