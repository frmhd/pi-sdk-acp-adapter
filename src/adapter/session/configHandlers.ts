import type {
  Implementation,
  SessionConfigOption,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";

import type { AcpSessionState } from "../types.js";
import { USAGE_CONFIG_OPTION_ID } from "./configFormatting.js";
import {
  ALL_THINKING_LEVELS,
  findModelById,
  getCurrentConfigOptions,
  getModelOptionValue,
} from "./configOptions.js";

export interface SetConfigResult {
  applied: boolean;
  error?: string;
}

async function applyModelConfigChange(
  value: unknown,
  session: AcpSessionState,
  availableModels: Model<Api>[],
): Promise<SetConfigResult> {
  if (typeof value !== "string" || !value) {
    return { applied: false, error: `Invalid model ID: ${String(value)}` };
  }

  const currentProvider = session.session?.state.model?.provider;
  const model = findModelById(value, availableModels, currentProvider);

  if (!model) {
    return { applied: false, error: `Model not found: ${value}` };
  }

  if (!session.session) {
    return { applied: false, error: "Session not initialized" };
  }

  try {
    await session.session.setModel(model);
    session.currentModelId = getModelOptionValue(model);
    return { applied: true };
  } catch (err) {
    console.error(`Failed to set model ${value}:`, err);
    return {
      applied: false,
      error: `Failed to set model: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function applyThinkingLevelConfigChange(value: unknown, session: AcpSessionState): SetConfigResult {
  if (typeof value !== "string" || !value) {
    return { applied: false, error: `Invalid thinking level: ${String(value)}` };
  }

  const level = value as ThinkingLevel;
  if (!ALL_THINKING_LEVELS.includes(level)) {
    return { applied: false, error: `Unsupported thinking level: ${value}` };
  }

  if (!session.session) {
    return { applied: false, error: "Session not initialized" };
  }

  session.session.setThinkingLevel(level);
  session.currentThinkingLevel = level;
  return { applied: true };
}

export async function handleSetSessionConfigOption(
  params: SetSessionConfigOptionRequest,
  session: AcpSessionState,
  availableModels: Model<Api>[],
): Promise<SetConfigResult> {
  if ("type" in params && params.type === "boolean") {
    return { applied: false, error: "Boolean config values are not supported for select options" };
  }

  switch (params.configId) {
    case "model":
      return applyModelConfigChange(params.value, session, availableModels);
    case "thinking_level":
      return applyThinkingLevelConfigChange(params.value, session);
    case USAGE_CONFIG_OPTION_ID:
      return { applied: true };
    default:
      return { applied: false, error: `Unknown config option: ${params.configId}` };
  }
}

export function buildSetSessionConfigOptionResponse(
  session: AcpSessionState,
  availableModels: Model<Api>[],
  clientInfo?: Implementation | null,
): SetSessionConfigOptionResponse {
  return {
    configOptions: getCurrentConfigOptions(session, availableModels, clientInfo),
  };
}

export function areSessionConfigOptionsEqual(
  left: SessionConfigOption[] | undefined,
  right: SessionConfigOption[],
): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right);
}
