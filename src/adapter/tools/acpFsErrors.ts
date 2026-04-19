function isAcpResourceNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const errorWithCode = error as Error & { code?: unknown };
  return errorWithCode.code === -32002 || /resource not found/i.test(error.message);
}

export function normalizeAcpFsError(error: unknown, absolutePath: string): Error {
  if (isAcpResourceNotFoundError(error)) {
    const normalized = new Error(
      `ENOENT: no such file or directory, open ${JSON.stringify(absolutePath)}`,
    ) as NodeJS.ErrnoException;
    normalized.code = "ENOENT";
    normalized.errno = -2;
    normalized.path = absolutePath;
    return normalized;
  }

  return error instanceof Error ? error : new Error(String(error));
}
