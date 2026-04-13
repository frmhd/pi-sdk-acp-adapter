/**
 * ACP Session Configuration
 *
 * Manages session configuration options for models and thinking levels.
 * These options allow ACP clients (like Zed) to display configuration UI
 * and let users select models and thinking levels.
 */

import type {
  SessionConfigOption,
  SessionConfigSelect,
  SessionConfigSelectOptions,
  SessionConfigSelectOption,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk";

import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { Model, Api } from "@mariozechner/pi-ai";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

import type { AcpSessionState } from "./types.js";

type ModelOptionIdentity = Pick<Model<Api>, "id" | "provider">;

// =============================================================================
// Constants
// =============================================================================

/** All thinking levels supported by Pi, including xhigh */
export const ALL_THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

/** Thinking level display names — avoids model-specific hardcoding */
const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: "Off (No reasoning)",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get available models from the model registry.
 * Note: Pi's ModelRegistry.getAvailable() is synchronous.
 */
export function getAvailableModels(modelRegistry: ModelRegistry): Model<Api>[] {
  return modelRegistry.getAvailable();
}

/**
 * Serialize a model into the exact ACP config-option value string.
 *
 * Zed stores favorites for session config options by `value`, not by the
 * display label. Using only `model.id` causes collisions when multiple
 * providers expose the same model id/name. Encoding provider + id keeps each
 * favorite scoped to a single provider/model pair while remaining a plain ACP
 * string value.
 */
export function getModelOptionValue(model: ModelOptionIdentity): string {
  return JSON.stringify({ provider: model.provider, id: model.id });
}

function parseModelOptionValue(value: string): ModelOptionIdentity | undefined {
  try {
    const parsed = JSON.parse(value) as { provider?: unknown; id?: unknown };
    if (typeof parsed.provider === "string" && typeof parsed.id === "string") {
      return { provider: parsed.provider, id: parsed.id };
    }
  } catch {
    // Backwards compatibility: older config values used the raw model id.
  }

  return undefined;
}

/**
 * Convert model to ACP session config select option.
 */
function modelToOption(model: Model<Api>): SessionConfigSelectOption {
  return {
    name: `${model.name} (${model.provider})`,
    description: model.reasoning ? "Supports thinking/reasoning" : undefined,
    value: getModelOptionValue(model),
  };
}

/**
 * Convert thinking level to ACP session config select option
 */
function thinkingLevelToOption(level: ThinkingLevel): SessionConfigSelectOption {
  return {
    name: THINKING_LEVEL_LABELS[level] || level.charAt(0).toUpperCase() + level.slice(1),
    value: level,
  };
}

// =============================================================================
// Config Option Creators
// =============================================================================

/**
 * Create a model selection config option for ACP.
 * When currentModelId is undefined, currentValue is set to the first model's
 * serialized option value so the client always has a valid selection (empty
 * string would not match any option).
 */
export function createModelConfigOption(
  availableModels: Model<Api>[],
  currentModelId: string | undefined,
  currentProvider?: string,
): SessionConfigOption {
  if (availableModels.length === 0) {
    // Return an empty/default option if no models are available
    const selectPayload: SessionConfigSelect = {
      currentValue: "",
      options: [],
    };
    return {
      type: "select",
      id: "model",
      name: "Model",
      description: "Select the AI model to use for coding assistance",
      category: "model",
      ...selectPayload,
    } as SessionConfigOption;
  }

  // Group models by provider
  const modelsByProvider = new Map<string, Model<Api>[]>();

  for (const model of availableModels) {
    const existing = modelsByProvider.get(model.provider) || [];
    existing.push(model);
    modelsByProvider.set(model.provider, existing);
  }

  // Determine currentValue using the exact ACP option value. This keeps the
  // selected option aligned with what ACP clients persist/favorite.
  const currentModel = currentModelId
    ? findModelById(currentModelId, availableModels, currentProvider)
    : undefined;
  const currentValue = getModelOptionValue(currentModel ?? availableModels[0]!);

  // Create options - either grouped or flat based on provider count
  let options: SessionConfigSelectOptions;

  if (modelsByProvider.size > 1) {
    // Group by provider
    const groups = Array.from(modelsByProvider.entries()).map(([provider, models]) => ({
      group: provider,
      name: provider.charAt(0).toUpperCase() + provider.slice(1),
      options: models.map(modelToOption),
    }));

    options = groups;
  } else {
    // Flat list if only one provider
    const allModels = Array.from(modelsByProvider.values()).flat();
    options = allModels.map(modelToOption);
  }

  const selectPayload: SessionConfigSelect = {
    currentValue,
    options,
  };

  return {
    type: "select",
    id: "model",
    name: "Model",
    description: "Select the AI model to use for coding assistance",
    category: "model",
    ...selectPayload,
  } as SessionConfigOption;
}

/**
 * Create a thinking level selection config option for ACP
 */
export function createThinkingConfigOption(
  availableLevels: ThinkingLevel[],
  currentLevel: ThinkingLevel,
): SessionConfigOption {
  const options: SessionConfigSelectOptions = availableLevels.map(thinkingLevelToOption);

  const selectPayload: SessionConfigSelect = {
    currentValue: currentLevel,
    options,
  };

  return {
    type: "select",
    id: "thinking_level",
    name: "Thinking Level",
    description: "Set the model's thinking/reasoning level",
    category: "thought_level",
    ...selectPayload,
  } as SessionConfigOption;
}

// =============================================================================
// Current Config State
// =============================================================================

/**
 * Get current config options for a session.
 * Uses the session's current model and thinking level as defaults.
 */
export function getCurrentConfigOptions(
  session: AcpSessionState,
  availableModels: Model<Api>[],
): SessionConfigOption[] {
  const options: SessionConfigOption[] = [];

  // Add model config option
  options.push(
    createModelConfigOption(
      availableModels,
      session.currentModelId,
      session.session?.state.model?.provider,
    ),
  );

  // Add thinking level config option
  const currentThinkingLevel = session.currentThinkingLevel || "medium";
  options.push(createThinkingConfigOption(ALL_THINKING_LEVELS, currentThinkingLevel));

  return options;
}

// =============================================================================
// Config Option Handler
// =============================================================================

/**
 * Find a model from the available models.
 *
 * Supports both the current provider-qualified ACP config value and the older
 * raw model-id format for backwards compatibility with previously persisted
 * client settings.
 */
export function findModelById(
  modelId: string,
  availableModels: Model<Api>[],
  currentProvider?: string,
): Model<Api> | undefined {
  const optionIdentity = parseModelOptionValue(modelId);
  if (optionIdentity) {
    return availableModels.find(
      (model) => model.id === optionIdentity.id && model.provider === optionIdentity.provider,
    );
  }

  const matches = availableModels.filter((m) => m.id === modelId);

  if (matches.length <= 1) {
    return matches[0];
  }

  // Multiple matches — try to disambiguate using current provider.
  if (currentProvider) {
    const match = matches.find((m) => m.provider === currentProvider);
    if (match) return match;
  }

  // Fall back to first match if provider disambiguation fails.
  return matches[0];
}

/**
 * Result of handleSetSessionConfigOption indicating what happened
 */
export interface SetConfigResult {
  /** Whether the config was successfully applied */
  applied: boolean;
  /** Error message if application failed (for logging/debugging) */
  error?: string;
}

/**
 * Handle setSessionConfigOption request.
 * Updates the session's model or thinking level based on the option.
 *
 * @returns The set config result indicating success/failure
 */
export async function handleSetSessionConfigOption(
  params: SetSessionConfigOptionRequest,
  session: AcpSessionState,
  availableModels: Model<Api>[],
): Promise<SetConfigResult> {
  // ACP SetSessionConfigOptionRequest is an intersection type combining:
  //   ({ type: "boolean"; value: boolean } | { value: SessionConfigValueId })
  //   & { configId, sessionId, _meta }
  // Check "type" in params to detect the boolean variant.
  // Reject boolean values for select-type options (model, thinking_level).
  if ("type" in params && params.type === "boolean") {
    return { applied: false, error: `Boolean config values are not supported for select options` };
  }

  const optionId = params.configId;
  const value = params.value;

  switch (optionId) {
    case "model": {
      if (typeof value !== "string" || !value) {
        return { applied: false, error: `Invalid model ID: ${String(value)}` };
      }

      const currentProvider = session.session?.state.model?.provider;
      const model = findModelById(value, availableModels, currentProvider);

      if (!model) {
        return { applied: false, error: `Model not found: ${value}` };
      }

      if (!session.session) {
        return { applied: false, error: `Session not initialized` };
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

    case "thinking_level": {
      if (typeof value !== "string" || !value) {
        return { applied: false, error: `Invalid thinking level: ${String(value)}` };
      }

      const level = value as ThinkingLevel;

      // Validate against all thinking levels (including xhigh)
      if (!ALL_THINKING_LEVELS.includes(level)) {
        return { applied: false, error: `Unsupported thinking level: ${value}` };
      }

      if (!session.session) {
        return { applied: false, error: `Session not initialized` };
      }

      session.session.setThinkingLevel(level);
      session.currentThinkingLevel = level;
      return { applied: true };
    }

    default:
      return { applied: false, error: `Unknown config option: ${optionId}` };
  }
}

/**
 * Build the response for setSessionConfigOption.
 * Always returns the full current config options, reflecting any changes made.
 */
export function buildSetSessionConfigOptionResponse(
  session: AcpSessionState,
  availableModels: Model<Api>[],
): SetSessionConfigOptionResponse {
  return {
    configOptions: getCurrentConfigOptions(session, availableModels),
  };
}
