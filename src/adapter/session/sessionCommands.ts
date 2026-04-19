import type { AvailableCommand } from "@agentclientprotocol/sdk";
import type { SlashCommandInfo } from "@mariozechner/pi-coding-agent";

function fallbackCommandDescription(command: SlashCommandInfo): string {
  return `Run /${command.name}`;
}

export function buildAcpAvailableCommands(commands: SlashCommandInfo[]): AvailableCommand[] {
  return commands.map((command) => ({
    name: command.name,
    description: command.description?.trim() || fallbackCommandDescription(command),
  }));
}

export function areAvailableCommandsEqual(
  left: AvailableCommand[] | undefined,
  right: AvailableCommand[],
): boolean {
  if (!left || left.length !== right.length) {
    return false;
  }

  return left.every((command, index) => {
    const other = right[index];
    return (
      command.name === other.name &&
      command.description === other.description &&
      JSON.stringify(command.input ?? null) === JSON.stringify(other.input ?? null)
    );
  });
}
