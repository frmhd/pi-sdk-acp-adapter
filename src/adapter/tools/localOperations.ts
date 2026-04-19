import { constants } from "node:fs";
import {
  access as fsAccess,
  mkdir as fsMkdir,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { extname } from "node:path";

import {
  createLocalBashOperations,
  type BashOperations,
  type EditOperations,
  type ReadOperations,
  type WriteOperations,
} from "@mariozechner/pi-coding-agent";

import { assertPathAuthorized, type AcpPathAuthorizationOptions } from "./authorization.js";

const LOCAL_IMAGE_MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function detectLocalImageMimeType(absolutePath: string): string | null {
  return LOCAL_IMAGE_MIME_TYPES[extname(absolutePath).toLowerCase()] ?? null;
}

export function createLocalReadOperations(
  options: AcpPathAuthorizationOptions = {},
): ReadOperations {
  const authorizedRoots = options.authorizedRoots ?? [];

  return {
    async readFile(absolutePath: string): Promise<Buffer> {
      assertPathAuthorized(absolutePath, authorizedRoots, "read");
      return fsReadFile(absolutePath);
    },
    async access(absolutePath: string): Promise<void> {
      assertPathAuthorized(absolutePath, authorizedRoots, "read");
      await fsAccess(absolutePath, constants.R_OK);
    },
    async detectImageMimeType(absolutePath: string): Promise<string | null> {
      assertPathAuthorized(absolutePath, authorizedRoots, "read");
      return detectLocalImageMimeType(absolutePath);
    },
  };
}

export function createLocalWriteOperations(
  options: AcpPathAuthorizationOptions = {},
): WriteOperations {
  const authorizedRoots = options.authorizedRoots ?? [];

  return {
    async writeFile(absolutePath: string, content: string): Promise<void> {
      assertPathAuthorized(absolutePath, authorizedRoots, "write");
      await fsWriteFile(absolutePath, content, "utf-8");
    },
    async mkdir(dir: string): Promise<void> {
      assertPathAuthorized(dir, authorizedRoots, "create directory");
      await fsMkdir(dir, { recursive: true });
    },
  };
}

export function createLocalEditOperations(
  options: AcpPathAuthorizationOptions = {},
): EditOperations {
  const authorizedRoots = options.authorizedRoots ?? [];
  const localReadOps = createLocalReadOperations({ authorizedRoots });
  const localWriteOps = createLocalWriteOperations({ authorizedRoots });

  return {
    readFile: localReadOps.readFile,
    writeFile: localWriteOps.writeFile,
    async access(absolutePath: string): Promise<void> {
      assertPathAuthorized(absolutePath, authorizedRoots, "read");
      await fsAccess(absolutePath, constants.R_OK | constants.W_OK);
    },
  };
}

const PAGER_DISABLING_ENV: NodeJS.ProcessEnv = {
  PAGER: "cat",
  GH_PAGER: "cat",
  GIT_PAGER: "cat",
};

export function buildNonInteractiveShellEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...PAGER_DISABLING_ENV,
    ...env,
  };
}

export function createLocalBashFallbackOperations(): BashOperations {
  const localBash = createLocalBashOperations();

  return {
    exec(command, cwd, options) {
      return localBash.exec(command, cwd, {
        ...options,
        env: buildNonInteractiveShellEnv(options.env),
      });
    },
  };
}
