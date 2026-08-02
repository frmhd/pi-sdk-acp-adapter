import { createInterface, type Interface } from "node:readline/promises";
import { join } from "node:path";

import type { AuthMethod } from "@agentclientprotocol/sdk";

import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthEvent, AuthPrompt, Provider } from "@earendil-works/pi-ai";

export const ACP_TERMINAL_AUTH_FLAG = "--acp-terminal-auth";
const ACP_TERMINAL_AUTH_METHOD_PREFIX = "terminal:";
const LEGACY_TERMINAL_AUTH_META_KEY = "terminal-auth";

export interface ParsedTerminalAuthCliArgs {
  isTerminalAuthInvocation: boolean;
  providerId?: string;
}

export interface RunTerminalAuthCliOptions {
  providerId?: string;
  modelRuntime?: Pick<ModelRuntime, "getProviders" | "login">;
  io?: {
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
    error?: NodeJS.WritableStream;
    isTTY?: boolean;
  };
}

function writeLine(stream: NodeJS.WritableStream, message = ""): void {
  stream.write(`${message}\n`);
}

function normalizeProviderId(providerId?: string): string | undefined {
  const normalized = providerId?.trim();
  return normalized ? normalized : undefined;
}

function stripTerminalAuthArgs(args: string[]): string[] {
  const stripped: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === ACP_TERMINAL_AUTH_FLAG) {
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        i += 1;
      }
      continue;
    }

    if (arg.startsWith(`${ACP_TERMINAL_AUTH_FLAG}=`)) {
      continue;
    }

    stripped.push(arg);
  }

  return stripped;
}

function getLegacyTerminalAuthCommand(currentArgv: string[]): {
  command: string;
  args: string[];
} {
  const command = currentArgv[0] ?? process.execPath;
  const args = stripTerminalAuthArgs(currentArgv.slice(1));
  return { command, args };
}

function buildLegacyTerminalAuthMeta(
  provider: Provider,
  currentArgv: string[],
): {
  [key: string]: unknown;
} {
  const { command, args } = getLegacyTerminalAuthCommand(currentArgv);

  return {
    [LEGACY_TERMINAL_AUTH_META_KEY]: {
      label: provider.name,
      command,
      args: [...args, ACP_TERMINAL_AUTH_FLAG, provider.id],
      env: {},
    },
  };
}

export function parseTerminalAuthCliArgs(args: string[]): ParsedTerminalAuthCliArgs {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === ACP_TERMINAL_AUTH_FLAG) {
      const next = args[i + 1];
      return {
        isTerminalAuthInvocation: true,
        providerId: next && !next.startsWith("-") ? normalizeProviderId(next) : undefined,
      };
    }

    if (arg.startsWith(`${ACP_TERMINAL_AUTH_FLAG}=`)) {
      return {
        isTerminalAuthInvocation: true,
        providerId: normalizeProviderId(arg.slice(`${ACP_TERMINAL_AUTH_FLAG}=`.length)),
      };
    }
  }

  return {
    isTerminalAuthInvocation: false,
  };
}

export function buildTerminalAuthMethodId(providerId: string): string {
  return `${ACP_TERMINAL_AUTH_METHOD_PREFIX}${providerId}`;
}

export function getProviderIdFromTerminalAuthMethodId(methodId: string): string | undefined {
  if (!methodId.startsWith(ACP_TERMINAL_AUTH_METHOD_PREFIX)) {
    return undefined;
  }

  return normalizeProviderId(methodId.slice(ACP_TERMINAL_AUTH_METHOD_PREFIX.length));
}

/** OAuth-capable providers from a ModelRuntime, sorted by display name. */
export function getOAuthProviders(modelRuntime: Pick<ModelRuntime, "getProviders">): Provider[] {
  return modelRuntime
    .getProviders()
    .filter((provider) => provider.auth.oauth !== undefined)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function buildTerminalAuthMethods(
  modelRuntime: Pick<ModelRuntime, "getProviders">,
  options: {
    currentArgv?: string[];
  } = {},
): AuthMethod[] {
  const currentArgv = options.currentArgv ?? process.argv;

  return getOAuthProviders(modelRuntime).map((provider) => ({
    id: buildTerminalAuthMethodId(provider.id),
    name: provider.name,
    description: `Authenticate Pi with ${provider.name} in an interactive terminal session.`,
    type: "terminal" as const,
    args: [ACP_TERMINAL_AUTH_FLAG, provider.id],
    _meta: buildLegacyTerminalAuthMeta(provider, currentArgv),
  }));
}

async function selectOAuthLoginOption(
  prompt: Extract<AuthPrompt, { type: "select" }>,
  question: (prompt: string) => Promise<string>,
  output: NodeJS.WritableStream,
): Promise<string | undefined> {
  writeLine(output, prompt.message);
  prompt.options.forEach((option, index) => {
    writeLine(output, `  ${index + 1}. ${option.label}`);
  });
  writeLine(output);

  while (true) {
    const answer = (await question("Select an option by number (empty to cancel): ")).trim();
    if (!answer) {
      return undefined;
    }

    const selection = Number.parseInt(answer, 10);
    if (Number.isInteger(selection) && selection >= 1 && selection <= prompt.options.length) {
      return prompt.options[selection - 1]?.id;
    }

    writeLine(
      output,
      `Please enter a number between 1 and ${prompt.options.length}, or press Enter to cancel.`,
    );
  }
}

async function selectProvider(
  providers: Provider[],
  preferredProviderId: string | undefined,
  question: (prompt: string) => Promise<string>,
  output: NodeJS.WritableStream,
): Promise<Provider> {
  if (preferredProviderId) {
    const provider = providers.find((candidate) => candidate.id === preferredProviderId);
    if (!provider) {
      throw new Error(`Unknown OAuth provider: ${preferredProviderId}`);
    }
    return provider;
  }

  if (providers.length === 0) {
    throw new Error("No OAuth providers are available for Pi terminal auth.");
  }

  if (providers.length === 1) {
    return providers[0];
  }

  writeLine(output, "Available Pi authentication providers:");
  providers.forEach((provider, index) => {
    writeLine(output, `  ${index + 1}. ${provider.name} (${provider.id})`);
  });
  writeLine(output);

  while (true) {
    const answer = (await question("Select a provider by number: ")).trim();
    const selection = Number.parseInt(answer, 10);
    if (Number.isInteger(selection) && selection >= 1 && selection <= providers.length) {
      return providers[selection - 1];
    }
    writeLine(output, `Please enter a number between 1 and ${providers.length}.`);
  }
}

/**
 * Ask a readline question, rejecting when the optional AbortSignal fires.
 * Used to honor per-prompt cancellation from the Pi login flow (e.g. a
 * `manual_code` prompt raced against a local OAuth callback server).
 */
function questionWithSignal(rl: Interface, prompt: string, signal?: AbortSignal): Promise<string> {
  return signal ? rl.question(prompt, { signal }) : rl.question(prompt);
}

function handleAuthPrompt(
  rl: Interface,
  output: NodeJS.WritableStream,
): (prompt: AuthPrompt) => Promise<string> {
  return async (prompt) => {
    switch (prompt.type) {
      case "text":
      case "secret": {
        const suffix = prompt.placeholder ? ` (${prompt.placeholder})` : "";
        return questionWithSignal(rl, `${prompt.message}${suffix}: `, prompt.signal);
      }
      case "select": {
        const optionId = await selectOAuthLoginOption(
          prompt,
          (question) => questionWithSignal(rl, question, prompt.signal),
          output,
        );
        if (optionId === undefined) {
          throw new Error("Login canceled.");
        }
        return optionId;
      }
      case "manual_code": {
        const suffix = prompt.placeholder ? ` (${prompt.placeholder})` : "";
        return questionWithSignal(rl, `${prompt.message}${suffix}: `, prompt.signal);
      }
    }
  };
}

function handleAuthEvent(
  output: NodeJS.WritableStream,
  providerName: string,
): (event: AuthEvent) => void {
  return (event) => {
    switch (event.type) {
      case "info":
        writeLine(output, event.message);
        for (const link of event.links ?? []) {
          writeLine(output, link.url);
        }
        writeLine(output);
        break;
      case "auth_url":
        if (event.instructions) {
          writeLine(output, event.instructions);
        }
        writeLine(output, `Open this URL to continue ${providerName} authentication:`);
        writeLine(output, event.url);
        writeLine(output);
        break;
      case "device_code":
        writeLine(output, `Device authorization for ${providerName}:`);
        writeLine(output, `  Open: ${event.verificationUri}`);
        writeLine(output, `  Code: ${event.userCode}`);
        if (event.expiresInSeconds !== undefined) {
          writeLine(output, `  Expires in ${event.expiresInSeconds} seconds.`);
        }
        if (event.intervalSeconds !== undefined) {
          writeLine(output, `  Polling interval: ${event.intervalSeconds} seconds.`);
        }
        writeLine(output);
        break;
      case "progress":
        writeLine(output, event.message);
        break;
    }
  };
}

export async function runTerminalAuthCli(options: RunTerminalAuthCliOptions = {}): Promise<number> {
  const modelRuntime = options.modelRuntime ?? (await ModelRuntime.create());
  const input = options.io?.input ?? process.stdin;
  const output = options.io?.output ?? process.stdout;
  const error = options.io?.error ?? process.stderr;
  const isTTY = options.io?.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);

  if (!isTTY) {
    writeLine(error, "[pi-acp] Terminal auth requires an interactive TTY.");
    return 1;
  }

  const providers = getOAuthProviders(modelRuntime);

  if (providers.length === 0) {
    writeLine(error, "[pi-acp] No OAuth providers are available for terminal auth.");
    return 1;
  }

  const rl = createInterface({ input, output, terminal: true });

  try {
    const provider = await selectProvider(
      providers,
      normalizeProviderId(options.providerId),
      (prompt) => rl.question(prompt),
      output,
    );

    writeLine(output, `[pi-acp] Starting Pi terminal auth for ${provider.name}.`);
    writeLine(output, `Credentials will be stored in ${join(getAgentDir(), "auth.json")}.`);
    writeLine(output);

    await modelRuntime.login(provider.id, "oauth", {
      prompt: handleAuthPrompt(rl, output),
      notify: handleAuthEvent(output, provider.name),
    });

    writeLine(output);
    writeLine(output, `[pi-acp] Successfully authenticated with ${provider.name}.`);
    return 0;
  } catch (errorValue) {
    const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
    writeLine(error, `[pi-acp] Terminal auth failed: ${message}`);
    return 1;
  } finally {
    rl.close();
  }
}
