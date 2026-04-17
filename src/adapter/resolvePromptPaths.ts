import { readFile as fsReadFile } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath } from "node:path";

import type { AgentSideConnection } from "@agentclientprotocol/sdk";

import { getAuthorizedRoots, shouldBypassAcpRead } from "./AcpToolBridge.js";
import type { AcpClientCapabilitiesSnapshot } from "./types.js";

export interface ResolvePromptPathsOptions {
  text: string;
  cwd: string;
  additionalDirectories: string[];
  connection: AgentSideConnection;
  sessionId: string;
  clientCapabilities: AcpClientCapabilitiesSnapshot;
}

/**
 * Resolve @path patterns in prompt text before the prompt reaches Pi.
 *
 * This is prompt preprocessing, not normal tool execution. It follows the same
 * capability-based read routing policy as the session runtime: prefer ACP
 * readTextFile when the client supports it inside ACP-visible roots, otherwise
 * read locally for authorized paths.
 */
export async function resolvePromptPathsInText(
  options: ResolvePromptPathsOptions,
): Promise<string> {
  const pathRegex = /(?:^|\s)@(?:["']([^"']+)["']|`([^`]+)`|([^\s]+))/g;
  let resolvedText = options.text;
  const matches = Array.from(options.text.matchAll(pathRegex));
  const authorizedRoots = getAuthorizedRoots(options.cwd, options.additionalDirectories);
  const acpReadRoots = getAuthorizedRoots(options.cwd);

  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i];
    const path = match[1] || match[2] || match[3];

    try {
      const fullPath = isAbsolute(path) ? path : resolvePath(options.cwd, path);

      // Determine whether to read locally or via ACP
      // External paths (outside authorizedRoots) are read locally
      const shouldReadLocally =
        !options.clientCapabilities.supportsReadTextFile ||
        shouldBypassAcpRead(fullPath, {
          authorizedRoots,
          acpReadRoots,
        });

      const content = shouldReadLocally
        ? await fsReadFile(fullPath, "utf-8")
        : (
            await options.connection.readTextFile({
              path: fullPath,
              sessionId: options.sessionId,
            })
          ).content;

      const replacement = `\n\n--- @${path} ---\n${content}\n`;
      resolvedText =
        resolvedText.slice(0, match.index) +
        match[0].replace(`@${path}`, replacement) +
        resolvedText.slice(match.index + match[0].length);
    } catch (error) {
      console.warn(`Failed to resolve path @${path}:`, error);
    }
  }

  return resolvedText;
}
