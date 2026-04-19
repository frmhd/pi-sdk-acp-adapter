import { resolve as resolvePath, sep } from "node:path";

export interface AcpPathAuthorizationOptions {
  authorizedRoots?: string[];
}

export interface AcpReadFallbackPolicyOptions extends AcpPathAuthorizationOptions {
  acpReadRoots?: string[];
  alwaysLocalRoots?: string[];
}

function normalizeAuthorizedPath(path: string): string {
  const normalized = resolvePath(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function getAuthorizedRoots(cwd: string, additionalDirectories: string[] = []): string[] {
  return Array.from(
    new Set(
      [cwd, ...additionalDirectories]
        .filter((path): path is string => typeof path === "string" && path.length > 0)
        .map((path) => resolvePath(path)),
    ),
  );
}

function isPathWithinAuthorizedRoot(path: string, root: string): boolean {
  if (path === root) {
    return true;
  }

  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return path.startsWith(rootPrefix);
}

export function isPathWithinAuthorizedRoots(path: string, roots: string[]): boolean {
  if (roots.length === 0) {
    return true;
  }

  const normalizedPath = normalizeAuthorizedPath(path);
  const normalizedRoots = roots.map(normalizeAuthorizedPath);
  return normalizedRoots.some((root) => isPathWithinAuthorizedRoot(normalizedPath, root));
}

export function assertPathAuthorized(
  path: string,
  authorizedRoots: string[],
  operation: "read" | "write" | "create directory",
): void {
  if (authorizedRoots.length === 0 || isPathWithinAuthorizedRoots(path, authorizedRoots)) {
    return;
  }

  throw new Error(
    `ACP ${operation} denied for path ${JSON.stringify(path)}. Allowed workspace roots: ${authorizedRoots.join(", ")}. Filesystem access is limited to the session cwd and additionalDirectories.`,
  );
}

export function shouldBypassAcpRead(
  absolutePath: string,
  options: AcpReadFallbackPolicyOptions,
): boolean {
  const authorizedRoots = options.authorizedRoots ?? [];
  const alwaysLocalRoots = options.alwaysLocalRoots ?? [];
  const acpReadRoots = options.acpReadRoots ?? authorizedRoots;

  if (alwaysLocalRoots.length > 0 && isPathWithinAuthorizedRoots(absolutePath, alwaysLocalRoots)) {
    return true;
  }

  if (acpReadRoots.length === 0 || isPathWithinAuthorizedRoots(absolutePath, acpReadRoots)) {
    return false;
  }

  if (authorizedRoots.length === 0 || isPathWithinAuthorizedRoots(absolutePath, authorizedRoots)) {
    return true;
  }

  return true;
}
