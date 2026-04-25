import { completeSimple, getEnvApiKey } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";

import { normalizeSessionTitle } from "../session/sessionMetadata.js";

const TITLE_GENERATION_SYSTEM_PROMPT = `You are a helpful assistant that generates concise, descriptive titles for chat conversations.
Given a user's message, create a short title (3-6 words) that summarizes the topic.
Return ONLY the title text, with no quotes, punctuation, or explanation.
Keep it under 50 characters.`;

const TITLE_REGENERATION_SYSTEM_PROMPT = `You are a helpful assistant that generates concise, descriptive titles for chat conversations.
Given all user messages from a conversation, create a short title (3-6 words) that captures the overall topic.
Return ONLY the title text, with no quotes, punctuation, or explanation.
Keep it under 50 characters.`;

export function getSmallModelSpec(): { provider: string; modelId: string } | null {
  const env = process.env.PI_ACP_SMALL_MODEL;
  if (!env?.trim()) return null;

  const slashIdx = env.indexOf("/");
  if (slashIdx === -1 || slashIdx === 0 || slashIdx === env.length - 1) {
    console.warn(`PI_ACP_SMALL_MODEL has invalid format: "${env}". Expected "provider/model-id".`);
    return null;
  }

  return {
    provider: env.slice(0, slashIdx).trim(),
    modelId: env.slice(slashIdx + 1).trim(),
  };
}

export async function generateSessionTitle(
  userText: string,
  modelRegistry: ModelRegistry,
): Promise<string | null> {
  return generateTitleWithPrompt(userText, modelRegistry, TITLE_GENERATION_SYSTEM_PROMPT);
}

const MAX_MESSAGES_FOR_TITLE = 20;
const MAX_COMBINED_TEXT_LENGTH = 4000;

export async function generateSessionTitleFromMessages(
  userMessages: string[],
  modelRegistry: ModelRegistry,
): Promise<string | null> {
  if (userMessages.length === 0) return null;

  const recentMessages = userMessages.slice(-MAX_MESSAGES_FOR_TITLE);

  let combinedText = recentMessages
    .map((text, index) => `Message ${index + 1}:\n${text}`)
    .join("\n\n---\n\n");

  if (combinedText.length > MAX_COMBINED_TEXT_LENGTH) {
    combinedText = combinedText.slice(0, MAX_COMBINED_TEXT_LENGTH).trimEnd() + "\n\n[...]";
  }

  return generateTitleWithPrompt(combinedText, modelRegistry, TITLE_REGENERATION_SYSTEM_PROMPT);
}

async function generateTitleWithPrompt(
  userText: string,
  modelRegistry: ModelRegistry,
  systemPrompt: string,
): Promise<string | null> {
  const spec = getSmallModelSpec();
  if (!spec) return null;

  const model = modelRegistry.find(spec.provider, spec.modelId);
  if (!model) {
    if (process.env.DEBUG) {
      console.warn(
        `[title-generation] Model not found: ${spec.provider}/${spec.modelId}. Skipping.`,
      );
    }
    return null;
  }

  // Only generate titles if auth is already configured for this provider.
  // This keeps title generation zero-config when the user picks a model
  // from a provider they already use (e.g. main model = anthropic/claude-sonnet-4,
  // title model = anthropic/claude-haiku-4).
  if (!modelRegistry.hasConfiguredAuth(model)) {
    if (process.env.DEBUG) {
      console.warn(
        `[title-generation] Auth not configured for ${spec.provider}. ` +
          `Use a model from a provider that already has auth configured. Skipping.`,
      );
    }
    return null;
  }

  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    if (process.env.DEBUG) {
      console.warn(
        `[title-generation] Auth lookup failed for ${spec.provider}/${spec.modelId}: ${auth.error}. Skipping.`,
      );
    }
    return null;
  }

  // Resolve API key: prefer Pi auth storage, fall back to env var lookup
  // (same fallback chain the provider functions use internally).
  const apiKey = auth.apiKey ?? getEnvApiKey(spec.provider);

  if (process.env.DEBUG) {
    console.warn("[title-generation] resolved auth:", {
      hasStorageKey: !!auth.apiKey,
      hasEnvKey: !!getEnvApiKey(spec.provider),
      hasHeaders: !!auth.headers,
    });
  }

  // No outer try/catch: let unexpected API/network errors propagate.
  // Callers that need graceful degradation (e.g., automatic title generation
  // on the first prompt) should handle exceptions at their own boundary.
  const response = await completeSimple(
    model,
    {
      systemPrompt,
      messages: [
        {
          role: "user",
          content: userText,
          timestamp: Date.now(),
        },
      ],
    },
    {
      temperature: 0.3,
      apiKey,
      ...(auth.headers && { headers: auth.headers }),
    },
  );

  // Debug: log what the model actually returned
  if (process.env.DEBUG) {
    console.warn("[title-generation] response:", {
      stopReason: response.stopReason,
      errorMessage: response.errorMessage,
      content: JSON.stringify(response.content),
    });
  }

  if (response.errorMessage) {
    console.warn(`Title generation API error: ${response.errorMessage}`);
    return null;
  }

  // Try to find text content. Some models may return thinking-only or empty responses.
  const textContent = response.content.find(
    (c): c is { type: "text"; text: string } => c.type === "text",
  );

  if (!textContent) {
    // Defensive: some providers return text in unexpected shapes — try any item with a text field
    const anyItem = response.content.find(
      (c) => "text" in c && typeof (c as any).text === "string",
    );
    if (anyItem) {
      const title = normalizeSessionTitle((anyItem as { text: string }).text);
      if (title) return title;
    }

    const contentTypes = response.content.map((c) => (c as any).type ?? "unknown").join(", ");
    console.warn(
      `Title generation response contained no text content. Types received: [${contentTypes}]`,
    );
    return null;
  }

  const title = normalizeSessionTitle(textContent.text);
  if (!title) {
    console.warn("Title generation returned empty title.");
    return null;
  }

  return title;
}
