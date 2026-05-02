import * as fs from "node:fs";
import * as path from "node:path";

import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";

import { isValidThinkingLevel } from "../adapter/session/modelPreferences.js";

export type AgentScope = "user" | "project" | "both";

export interface SubagentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  thinkingLevel?: ThinkingLevel;
  systemPrompt: string;
  source: "user" | "project";
  filePath: string;
}

export interface AgentDiscoveryResult {
  agents: SubagentConfig[];
  projectAgentsDir: string | null;
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): SubagentConfig[] {
  const agents: SubagentConfig[] = [];

  if (!fs.existsSync(dir)) {
    return agents;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return agents;
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
    if (!frontmatter.name || !frontmatter.description) {
      continue;
    }

    const tools = frontmatter.tools
      ?.split(",")
      .map((tool) => tool.trim())
      .filter(Boolean);

    const thinkingLevel = frontmatter.thinkingLevel?.trim();

    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: tools && tools.length > 0 ? tools : undefined,
      model: frontmatter.model,
      thinkingLevel: isValidThinkingLevel(thinkingLevel) ? thinkingLevel : undefined,
      systemPrompt: body,
      source,
      filePath,
    });
  }

  return agents;
}

function isDirectory(candidatePath: string): boolean {
  try {
    return fs.statSync(candidatePath).isDirectory();
  } catch {
    return false;
  }
}

function findNearestProjectAgentsDir(cwd: string): string | null {
  let currentDir = cwd;

  while (true) {
    const candidate = path.join(currentDir, ".pi", "agents");
    if (isDirectory(candidate)) {
      return candidate;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

export function discoverSubagents(
  cwd: string,
  scope: AgentScope,
  agentDir = getAgentDir(),
): AgentDiscoveryResult {
  const userDir = path.join(agentDir, "agents");
  const projectAgentsDir = findNearestProjectAgentsDir(cwd);

  const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
  const projectAgents =
    scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

  const byName = new Map<string, SubagentConfig>();

  if (scope === "both") {
    for (const agent of userAgents) byName.set(agent.name, agent);
    for (const agent of projectAgents) byName.set(agent.name, agent);
  } else if (scope === "user") {
    for (const agent of userAgents) byName.set(agent.name, agent);
  } else {
    for (const agent of projectAgents) byName.set(agent.name, agent);
  }

  return {
    agents: Array.from(byName.values()),
    projectAgentsDir,
  };
}
