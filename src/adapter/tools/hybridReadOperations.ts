import type { ReadOperations } from "@mariozechner/pi-coding-agent";

import {
  isPathWithinAuthorizedRoots,
  shouldBypassAcpRead,
  type AcpReadFallbackPolicyOptions,
} from "./authorization.js";
import { AcpReadOperations } from "./acpReadOperations.js";
import { createLocalReadOperations } from "./localOperations.js";
import type { AcpClientInterface } from "./terminalOperations.js";

export class HybridReadOperations implements ReadOperations {
  private readonly localReadOps: ReadOperations;
  private readonly unrestrictedLocalReadOps: ReadOperations;
  private readonly acpReadOps: AcpReadOperations;
  private readonly policy: AcpReadFallbackPolicyOptions;

  constructor(
    client: AcpClientInterface,
    options: AcpReadFallbackPolicyOptions = {},
    localReadOps: ReadOperations = createLocalReadOperations({
      authorizedRoots: options.authorizedRoots,
    }),
  ) {
    this.localReadOps = localReadOps;
    this.unrestrictedLocalReadOps = createLocalReadOperations({ authorizedRoots: [] });
    this.acpReadOps = new AcpReadOperations(client, {
      authorizedRoots: options.authorizedRoots,
    });
    this.policy = options;
  }

  private getLocalReadOpsForPath(absolutePath: string): ReadOperations {
    const authorizedRoots = this.policy.authorizedRoots ?? [];
    if (
      authorizedRoots.length === 0 ||
      isPathWithinAuthorizedRoots(absolutePath, authorizedRoots)
    ) {
      return this.localReadOps;
    }
    return this.unrestrictedLocalReadOps;
  }

  async readFile(absolutePath: string): Promise<Buffer> {
    if (shouldBypassAcpRead(absolutePath, this.policy)) {
      return this.getLocalReadOpsForPath(absolutePath).readFile(absolutePath);
    }

    return this.acpReadOps.readFile(absolutePath);
  }

  async access(absolutePath: string): Promise<void> {
    if (shouldBypassAcpRead(absolutePath, this.policy)) {
      return this.getLocalReadOpsForPath(absolutePath).access(absolutePath);
    }

    return this.acpReadOps.access(absolutePath);
  }

  async detectImageMimeType(absolutePath: string): Promise<string | null | undefined> {
    if (shouldBypassAcpRead(absolutePath, this.policy)) {
      return this.getLocalReadOpsForPath(absolutePath).detectImageMimeType?.(absolutePath);
    }

    return undefined;
  }
}
