import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { homedir } from "node:os";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

import { ALL_THINKING_LEVELS } from "./configOptions.js";

const PREFERENCES_FILE = `${homedir()}/.pi/agent/model-thinking-preferences.json`;

type ModelPreferences = Record<string, ThinkingLevel>;

let cachedPreferences: ModelPreferences | null = null;
let writeLock: Promise<void> = Promise.resolve();
let writeDisabled = false;

export function isValidThinkingLevel(value: string | undefined): value is ThinkingLevel {
  return !!value && ALL_THINKING_LEVELS.includes(value as ThinkingLevel);
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "ENOENT"
  );
}

async function readPreferencesFile(): Promise<ModelPreferences> {
  try {
    const raw = await readFile(PREFERENCES_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const prefs: ModelPreferences = {};

    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && isValidThinkingLevel(value)) {
        prefs[key] = value;
      }
    }

    writeDisabled = false;
    return prefs;
  } catch (error) {
    if (isEnoent(error)) {
      return {};
    }
    console.warn("Failed to load model thinking preferences:", error);
    writeDisabled = true;
    return {};
  }
}

async function writePreferencesFile(prefs: ModelPreferences): Promise<void> {
  if (writeDisabled) {
    console.warn("Skipping model preferences write because previous read failed.");
    return;
  }

  try {
    await mkdir(dirname(PREFERENCES_FILE), { recursive: true });
    const tempFile = `${PREFERENCES_FILE}.tmp`;
    await writeFile(tempFile, JSON.stringify(prefs, null, 2), "utf-8");
    await rename(tempFile, PREFERENCES_FILE);
  } catch (error) {
    console.warn("Failed to persist model thinking preferences:", error);
  }
}

async function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const previousLock = writeLock;
  let releaseLock: () => void = () => {};
  writeLock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  await previousLock;
  try {
    return await fn();
  } finally {
    releaseLock();
  }
}

export async function loadModelPreferences(): Promise<ModelPreferences> {
  if (cachedPreferences !== null) {
    return cachedPreferences;
  }

  const prefs = await readPreferencesFile();
  cachedPreferences = prefs;
  return prefs;
}

/**
 * Get the saved thinking level preference for a model.
 * Returns undefined if no preference has been saved.
 */
export async function getModelThinkingPreference(
  modelId: string,
): Promise<ThinkingLevel | undefined> {
  const prefs = await loadModelPreferences();
  return prefs[modelId];
}

/**
 * Save a thinking level preference for a model.
 */
export async function setModelThinkingPreference(
  modelId: string,
  level: ThinkingLevel,
): Promise<void> {
  await withWriteLock(async () => {
    const prefs = await readPreferencesFile();
    prefs[modelId] = level;
    cachedPreferences = prefs;
    await writePreferencesFile(prefs);
  });
}

/**
 * Reset the in-memory cache. Only exposed for testing.
 */
export function resetModelPreferencesCache(): void {
  cachedPreferences = null;
  writeDisabled = false;
}

/**
 * Remove preferences for models that are no longer in the available models set.
 */
export async function cleanupModelPreferences(availableModelIds: Set<string>): Promise<void> {
  await withWriteLock(async () => {
    const prefs = await readPreferencesFile();
    let changed = false;

    for (const modelId of Object.keys(prefs)) {
      if (!availableModelIds.has(modelId)) {
        delete prefs[modelId];
        changed = true;
      }
    }

    if (changed) {
      cachedPreferences = prefs;
      await writePreferencesFile(prefs);
    }
  });
}
