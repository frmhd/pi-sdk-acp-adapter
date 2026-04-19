import type { ToolCallContent, ToolKind } from "@agentclientprotocol/sdk";

import { createToolCallContent, mapToolKind } from "../types.js";

export function getAcpToolKind(toolName: string): ToolKind {
  return mapToolKind(toolName);
}

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
