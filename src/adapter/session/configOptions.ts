import type {
  Implementation,
  SessionConfigOption,
  SessionConfigSelect,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
  SessionConfigSelectOptions,
} from "@agentclientprotocol/sdk";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";

import type { AcpSessionState } from "../types.js";
import {
  buildUsageConfigDescription,
  buildUsageConfigLabel,
  USAGE_CONFIG_OPTION_ID,
  USAGE_CONFIG_OPTION_VALUE,
} from "./configFormatting.js";
import { clientSupportsGroupedOptions, clientSupportsUsageConfigOption } from "./clientSupport.js";

type ModelOptionIdentity = Pick<Model<Api>, "id" | "provider">;

export const ALL_THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: "Off (No reasoning)",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
};

export function getAvailableModels(modelRegistry: ModelRegistry): Model<Api>[] {
  return modelRegistry.getAvailable();
}

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

function modelToOption(model: Model<Api>): SessionConfigSelectOption {
  return {
    name: `${model.name} (${model.provider})`,
    description: model.reasoning ? "Supports thinking/reasoning" : undefined,
    value: getModelOptionValue(model),
  };
}

function thinkingLevelToOption(level: ThinkingLevel): SessionConfigSelectOption {
  return {
    name: THINKING_LEVEL_LABELS[level] || level.charAt(0).toUpperCase() + level.slice(1),
    value: level,
  };
}

export function createModelConfigOption(
  availableModels: Model<Api>[],
  currentModelId: string | undefined,
  currentProvider?: string,
  clientInfo?: Implementation | null,
): SessionConfigOption {
  if (availableModels.length === 0) {
    const selectPayload: SessionConfigSelect = {
      currentValue: "no_models",
      options: [
        {
          value: "no_models",
          name: "No models available",
          description: "Configure API keys to enable model selection",
        },
      ],
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

  const currentModel = currentModelId
    ? findModelById(currentModelId, availableModels, currentProvider)
    : undefined;
  const currentValue = getModelOptionValue(currentModel ?? availableModels[0]!);

  let options: SessionConfigSelectOptions;
  if (clientSupportsGroupedOptions(clientInfo)) {
    const modelsByProvider = new Map<string, Model<Api>[]>();
    for (const model of availableModels) {
      const existing = modelsByProvider.get(model.provider) || [];
      existing.push(model);
      modelsByProvider.set(model.provider, existing);
    }

    const groups: SessionConfigSelectGroup[] = Array.from(modelsByProvider.entries()).map(
      ([provider, models]) => ({
        group: provider,
        name: provider.charAt(0).toUpperCase() + provider.slice(1),
        options: models.map(modelToOption),
      }),
    );
    options = groups;
  } else {
    options = availableModels.map(modelToOption);
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

export function createUsageConfigOption(session: AcpSessionState): SessionConfigOption {
  const label = buildUsageConfigLabel(session);
  const description = buildUsageConfigDescription(session);

  const selectPayload: SessionConfigSelect = {
    currentValue: USAGE_CONFIG_OPTION_VALUE,
    options: [
      {
        value: USAGE_CONFIG_OPTION_VALUE,
        name: label,
        description,
      },
    ],
  };

  return {
    type: "select",
    id: USAGE_CONFIG_OPTION_ID,
    name: "Usage",
    description,
    ...selectPayload,
  } as SessionConfigOption;
}

export function getCurrentConfigOptions(
  session: AcpSessionState,
  availableModels: Model<Api>[],
  clientInfo?: Implementation | null,
): SessionConfigOption[] {
  const options: SessionConfigOption[] = [];

  if (clientSupportsUsageConfigOption(clientInfo)) {
    options.push(createUsageConfigOption(session));
  }

  options.push(
    createModelConfigOption(
      availableModels,
      session.currentModelId,
      session.session?.state.model?.provider,
      clientInfo,
    ),
  );

  const currentThinkingLevel = session.currentThinkingLevel || "medium";
  options.push(createThinkingConfigOption(ALL_THINKING_LEVELS, currentThinkingLevel));

  return options;
}

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

  if (currentProvider) {
    const match = matches.find((m) => m.provider === currentProvider);
    if (match) return match;
  }

  return matches[0];
}
