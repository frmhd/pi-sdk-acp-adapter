import type { Implementation } from "@agentclientprotocol/sdk";

export function clientSupportsGroupedOptions(
  clientInfo: Implementation | null | undefined,
): boolean {
  if (!clientInfo?.name) return false;
  return clientInfo.name.toLowerCase() === "zed";
}

export function clientSupportsUsageConfigOption(
  clientInfo: Implementation | null | undefined,
): boolean {
  if (!clientInfo?.name) return false;
  return clientInfo.name.toLowerCase() === "zed";
}
