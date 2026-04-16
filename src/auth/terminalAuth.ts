import { createInterface } from "node:readline/promises";
import { join } from "node:path";

import type { AuthMethod } from "@agentclientprotocol/sdk";

import { AuthStorage, getAgentDir } from "@mariozechner/pi-coding-agent";
import type { OAuthProviderInterface } from "@mariozechner/pi-ai";

export const ACP_TERMINAL_AUTH_FLAG = "--acp-terminal-auth";
const ACP_TERMINAL_AUTH_METHOD_PREFIX = "terminal:";
const LEGACY_TERMINAL_AUTH_META_KEY = "terminal-auth";

export interface ParsedTerminalAuthCliArgs {
  isTerminalAuthInvocation: boolean;
  providerId?: string;
}

export interface RunTerminalAuthCliOptions {
  providerId?: string;
  authStorage?: Pick<AuthStorage, "getOAuthProviders" | "login">;
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
  provider: OAuthProviderInterface,
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

export function buildTerminalAuthMethods(
  authStorage: Pick<AuthStorage, "getOAuthProviders">,
  options: {
    enabled: boolean;
    currentArgv?: string[];
  },
): AuthMethod[] {
  if (!options.enabled) {
    return [];
  }

  const currentArgv = options.currentArgv ?? process.argv;

  return authStorage
    .getOAuthProviders()
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((provider) => ({
      id: buildTerminalAuthMethodId(provider.id),
      name: provider.name,
      description: `Authenticate Pi with ${provider.name} in an interactive terminal session.`,
      type: "terminal" as const,
      args: [ACP_TERMINAL_AUTH_FLAG, provider.id],
      _meta: buildLegacyTerminalAuthMeta(provider, currentArgv),
    }));
}

async function selectProvider(
  providers: OAuthProviderInterface[],
  preferredProviderId: string | undefined,
  question: (prompt: string) => Promise<string>,
  output: NodeJS.WritableStream,
): Promise<OAuthProviderInterface> {
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

export async function runTerminalAuthCli(options: RunTerminalAuthCliOptions = {}): Promise<number> {
  const authStorage = options.authStorage ?? AuthStorage.create();
  const input = options.io?.input ?? process.stdin;
  const output = options.io?.output ?? process.stdout;
  const error = options.io?.error ?? process.stderr;
  const isTTY = options.io?.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);

  if (!isTTY) {
    writeLine(error, "[pi-acp] Terminal auth requires an interactive TTY.");
    return 1;
  }

  const providers = authStorage
    .getOAuthProviders()
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));

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

    await authStorage.login(provider.id, {
      onAuth: (info) => {
        if (info.instructions) {
          writeLine(output, info.instructions);
        }
        writeLine(output, `Open this URL to continue ${provider.name} authentication:`);
        writeLine(output, info.url);
        writeLine(output);
      },
      onPrompt: async (prompt) => {
        const suffix = prompt.placeholder ? ` (${prompt.placeholder})` : "";
        const answer = await rl.question(`${prompt.message}${suffix}: `);
        if (!answer && !prompt.allowEmpty) {
          writeLine(output, "A value is required.");
          return rl.question(`${prompt.message}${suffix}: `);
        }
        return answer;
      },
      onProgress: (message) => {
        writeLine(output, message);
      },
      onManualCodeInput: () =>
        rl.question("Paste the full redirect URL or authorization code, then press Enter: "),
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
