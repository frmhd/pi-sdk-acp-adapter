import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as {
  name?: string;
  version?: string;
};

export const ADAPTER_PACKAGE_NAME = packageJson.name ?? "pi-sdk-acp-adapter";
export const ADAPTER_VERSION = packageJson.version ?? "0.0.0";

export const ACP_AGENT_NAME = "pi";
export const ACP_AGENT_TITLE = "Pi Coding Agent";
