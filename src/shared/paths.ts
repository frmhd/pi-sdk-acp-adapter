import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";

/** Expand Pi/ACP path shorthands to normal filesystem paths. */
export function expandToolPath(filePath: string): string {
  if (filePath === "~") {
    return homedir();
  }

  if (filePath.startsWith("~/")) {
    return `${homedir()}${filePath.slice(1)}`;
  }

  return filePath.startsWith("@") ? filePath.slice(1) : filePath;
}

/** Resolve a tool path relative to the session cwd when needed. */
export function resolveToolPath(filePath: string, cwd?: string): string {
  const expanded = expandToolPath(filePath);
  if (isAbsolute(expanded) || !cwd) {
    return expanded;
  }

  return resolvePath(cwd, expanded);
}

/** Convert an absolute path into a cwd-relative display path when possible. */
export function toDisplayPath(absolutePath: string, cwd?: string): string {
  if (!cwd || !absolutePath || absolutePath.length === 0) {
    return absolutePath;
  }

  const normalizedCwd = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;

  if (absolutePath === normalizedCwd) {
    return ".";
  }

  const prefix = `${normalizedCwd}/`;
  if (absolutePath.startsWith(prefix)) {
    return absolutePath.slice(prefix.length);
  }

  return absolutePath;
}
