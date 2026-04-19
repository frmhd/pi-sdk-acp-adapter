/** Escape a string for use in a POSIX shell command. */
function escapeBash(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`;
}

/** Escape a string for use in cmd.exe. */
function escapeCmd(str: string): string {
  return `"${str.replace(/(["^%])/g, "^$1")}"`;
}

export function createShellTerminalRequest(command: string): { command: string; args: string[] } {
  return {
    command,
    args: [],
  };
}

export function createMkdirTerminalRequest(dir: string): { command: string; args: string[] } {
  if (process.platform === "win32") {
    return createShellTerminalRequest(`mkdir ${escapeCmd(dir)}`);
  }

  return createShellTerminalRequest(`mkdir -p ${escapeBash(dir)}`);
}
