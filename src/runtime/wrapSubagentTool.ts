import type { Model } from "@mariozechner/pi-ai";
import {
  StringEnum,
  Type,
  type Api,
  type AssistantMessage,
  type Message,
} from "@mariozechner/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  SettingsManager,
  SessionManager,
  defineTool,
  getAgentDir,
  type CreateAgentSessionOptions,
  type ExtensionContext,
  type ModelRegistry,
} from "@mariozechner/pi-coding-agent";

import { findModelById } from "../adapter/AcpSessionConfig.js";
import { markToolBackend, type AcpSessionTool } from "./toolTracking.js";
import { type AgentScope, type SubagentConfig, discoverSubagents } from "./subagentAgents.js";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const ACP_SAFE_SUBAGENT_TOOL_NAMES = ["read", "write", "edit", "bash"] as const;
const DEFAULT_SUBAGENT_TOOL_NAMES = [...ACP_SAFE_SUBAGENT_TOOL_NAMES];

interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

interface SingleResult {
  agent: string;
  agentSource: "user" | "project" | "unknown";
  task: string;
  exitCode: number;
  stderr: string;
  output: string;
  lastProgress: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
}

interface SubagentDetails {
  mode: "single" | "parallel" | "chain";
  agentScope: AgentScope;
  projectAgentsDir: string | null;
  results: SingleResult[];
}

const TaskItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task to delegate to the agent" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const SubagentParams = Type.Object({
  agent: Type.Optional(
    Type.String({ description: "Name of the agent to invoke (for single mode)" }),
  ),
  task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
  tasks: Type.Optional(
    Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" }),
  ),
  chain: Type.Optional(
    Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" }),
  ),
  agentScope: Type.Optional(
    StringEnum(["user", "project", "both"] as const, {
      description:
        'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
      default: "user",
    }),
  ),
  confirmProjectAgents: Type.Optional(
    Type.Boolean({
      description: "Prompt before running project-local agents. Default: true.",
      default: true,
    }),
  ),
  cwd: Type.Optional(
    Type.String({ description: "Working directory for the agent process (single mode)" }),
  ),
});

function createEmptyUsage(): UsageStats {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  };
}

function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    for (const part of msg.content) {
      if (part.type === "text" && part.text.trim()) {
        return part.text;
      }
    }
  }
  return "";
}

function getLastAssistant(messages: Message[]): AssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      return msg as AssistantMessage;
    }
  }
  return undefined;
}

function appendUsage(usage: UsageStats, messages: Message[]): UsageStats {
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const assistant = message as AssistantMessage;
    usage.turns += 1;
    usage.input += assistant.usage?.input || 0;
    usage.output += assistant.usage?.output || 0;
    usage.cacheRead += assistant.usage?.cacheRead || 0;
    usage.cacheWrite += assistant.usage?.cacheWrite || 0;
    usage.cost += assistant.usage?.cost?.total || 0;
    usage.contextTokens = assistant.usage?.totalTokens || usage.contextTokens;
  }
  return usage;
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return msg.includes("abort") || msg.includes("cancel") || error.name === "AbortError";
}

function formatSingleOutput(result: SingleResult): string {
  return result.output || result.lastProgress || "(no output)";
}

function buildProgressText(
  currentText: string,
  lastToolLine: string,
  defaultText = "(running...)",
): string {
  const trimmed = currentText.trim();
  if (trimmed) return trimmed;
  if (lastToolLine) return lastToolLine;
  return defaultText;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];

  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = Array.from({ length: items.length }) as TOut[];
  let nextIndex = 0;

  const workers = Array.from({ length: limit }, async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current]!, current);
    }
  });

  await Promise.all(workers);
  return results;
}

function resolveSubagentModel(
  modelSpec: string | undefined,
  currentModel: Model<Api> | undefined,
  modelRegistry: ModelRegistry,
): Model<Api> | undefined {
  if (!modelSpec) {
    return currentModel;
  }

  const available = modelRegistry.getAvailable();
  const slashIndex = modelSpec.indexOf("/");
  if (slashIndex > 0) {
    const provider = modelSpec.slice(0, slashIndex);
    const id = modelSpec.slice(slashIndex + 1);
    return (
      available.find((model) => model.provider === provider && model.id === id) ?? currentModel
    );
  }

  return findModelById(modelSpec, available, currentModel?.provider) ?? currentModel;
}

function getAllowedToolNames(agent: SubagentConfig): string[] {
  const requested =
    agent.tools && agent.tools.length > 0 ? agent.tools : DEFAULT_SUBAGENT_TOOL_NAMES;
  const safeTools = new Set<string>(ACP_SAFE_SUBAGENT_TOOL_NAMES);

  return requested.filter(
    (toolName, index, list) =>
      toolName !== "subagent" && safeTools.has(toolName) && list.indexOf(toolName) === index,
  );
}

function makeDetails(
  mode: "single" | "parallel" | "chain",
  agentScope: AgentScope,
  projectAgentsDir: string | null,
  results: SingleResult[],
): SubagentDetails {
  return {
    mode,
    agentScope,
    projectAgentsDir,
    results,
  };
}

async function runSingleAgent(options: {
  defaultCwd: string;
  agentDir?: string;
  modelRegistry: ModelRegistry;
  agents: SubagentConfig[];
  agentName: string;
  task: string;
  cwd?: string;
  step?: number;
  signal?: AbortSignal;
  ctx: ExtensionContext;
  createChildCustomTools: (cwd: string) => NonNullable<CreateAgentSessionOptions["customTools"]>;
  mode: "single" | "parallel" | "chain";
  agentScope: AgentScope;
  projectAgentsDir: string | null;
  onUpdate?: (partial: {
    content: Array<{ type: "text"; text: string }>;
    details: SubagentDetails;
  }) => void;
  previousResults?: SingleResult[];
}): Promise<SingleResult> {
  const agent = options.agents.find((candidate) => candidate.name === options.agentName);
  if (!agent) {
    const available = options.agents.map((candidate) => `"${candidate.name}"`).join(", ") || "none";
    return {
      agent: options.agentName,
      agentSource: "unknown",
      task: options.task,
      exitCode: 1,
      stderr: `Unknown agent: "${options.agentName}". Available agents: ${available}.`,
      output: "",
      lastProgress: "",
      usage: createEmptyUsage(),
      step: options.step,
    };
  }

  const cwd = options.cwd ?? options.defaultCwd;
  const currentResult: SingleResult = {
    agent: agent.name,
    agentSource: agent.source,
    task: options.task,
    exitCode: 0,
    stderr: "",
    output: "",
    lastProgress: "",
    usage: createEmptyUsage(),
    model: agent.model,
    step: options.step,
  };

  let currentText = "";
  let lastToolLine = "";
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let unsubscribe: (() => void) | undefined;
  let removeAbortListener: (() => void) | undefined;

  const emitUpdate = () => {
    if (!options.onUpdate) {
      return;
    }
    currentResult.lastProgress = buildProgressText(currentText, lastToolLine);
    options.onUpdate({
      content: [{ type: "text", text: formatSingleOutput(currentResult) }],
      details: makeDetails(options.mode, options.agentScope, options.projectAgentsDir, [
        ...(options.previousResults ?? []),
        currentResult,
      ]),
    });
  };

  try {
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: options.agentDir ?? getAgentDir(),
      appendSystemPromptOverride: (base) =>
        agent.systemPrompt.trim() ? [...base, agent.systemPrompt.trim()] : base,
    });
    await loader.reload();

    const model = resolveSubagentModel(
      agent.model,
      options.ctx.model as Model<Api> | undefined,
      options.modelRegistry,
    );
    const customTools = options.createChildCustomTools(cwd);

    const created = await createAgentSession({
      cwd,
      agentDir: options.agentDir,
      modelRegistry: options.modelRegistry,
      model,
      tools: getAllowedToolNames(agent),
      customTools,
      thinkingLevel: agent.thinkingLevel,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.create(cwd, options.agentDir ?? getAgentDir()),
    });

    session = created.session;
    currentResult.model = model ? `${model.provider}/${model.id}` : currentResult.model;

    unsubscribe = session.subscribe((event) => {
      switch (event.type) {
        case "tool_execution_start": {
          lastToolLine = `→ ${event.toolName}`;
          emitUpdate();
          break;
        }
        case "message_update": {
          if (event.assistantMessageEvent.type === "text_delta") {
            currentText += event.assistantMessageEvent.delta;
            emitUpdate();
          }
          break;
        }
      }
    });

    if (options.signal) {
      const onAbort = () => {
        void session?.abort();
      };
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
      }
    }

    await session.prompt(`Task: ${options.task}`);

    const messages = session.state.messages as Message[];
    currentResult.output = getFinalOutput(messages);
    currentResult.lastProgress =
      currentResult.output || buildProgressText(currentText, lastToolLine, "(no output)");
    currentResult.usage = appendUsage(createEmptyUsage(), messages);

    const lastAssistant = getLastAssistant(messages);
    if (lastAssistant) {
      currentResult.stopReason = lastAssistant.stopReason;
      currentResult.errorMessage = lastAssistant.errorMessage;
      currentResult.model ??= lastAssistant.model
        ? `${lastAssistant.provider}/${lastAssistant.model}`
        : undefined;
    }

    return currentResult;
  } catch (error) {
    currentResult.exitCode = 1;
    currentResult.stopReason = isAbortError(error) ? "aborted" : "error";
    currentResult.errorMessage = error instanceof Error ? error.message : String(error);
    currentResult.stderr = currentResult.errorMessage;
    currentResult.lastProgress = buildProgressText(
      currentText,
      lastToolLine,
      currentResult.errorMessage,
    );
    return currentResult;
  } finally {
    unsubscribe?.();
    removeAbortListener?.();
    session?.dispose();
  }
}

export function createSubagentTool(options: {
  cwd: string;
  agentDir?: string;
  modelRegistry: ModelRegistry;
  createChildCustomTools: (cwd: string) => NonNullable<CreateAgentSessionOptions["customTools"]>;
}): AcpSessionTool {
  return markToolBackend(
    defineTool({
      name: "subagent",
      label: "Subagent",
      description: [
        "Delegate tasks to specialized ACP-aware subagents with isolated context.",
        "Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
        'Default agent scope is "user" (from ~/.pi/agent/agents).',
        'To enable project-local agents in .pi/agents, set agentScope: "both" (or "project").',
      ].join(" "),
      parameters: SubagentParams,

      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        const agentScope: AgentScope = params.agentScope ?? "user";
        const discovery = discoverSubagents(ctx.cwd, agentScope, options.agentDir);
        const agents = discovery.agents;
        const confirmProjectAgents = params.confirmProjectAgents ?? true;

        const hasChain = (params.chain?.length ?? 0) > 0;
        const hasTasks = (params.tasks?.length ?? 0) > 0;
        const hasSingle = Boolean(params.agent && params.task);
        const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);
        const mode = hasChain ? "chain" : hasTasks ? "parallel" : "single";

        if (modeCount !== 1) {
          const available =
            agents.map((agent) => `${agent.name} (${agent.source})`).join(", ") || "none";
          return {
            content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
            details: makeDetails(mode, agentScope, discovery.projectAgentsDir, []),
            isError: true,
          };
        }

        if (
          (agentScope === "project" || agentScope === "both") &&
          confirmProjectAgents &&
          ctx.hasUI
        ) {
          const requestedAgentNames = new Set<string>();
          if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
          if (params.tasks) for (const task of params.tasks) requestedAgentNames.add(task.agent);
          if (params.agent) requestedAgentNames.add(params.agent);

          const projectAgentsRequested = Array.from(requestedAgentNames)
            .map((name) => agents.find((candidate) => candidate.name === name))
            .filter((candidate): candidate is SubagentConfig => candidate?.source === "project");

          if (projectAgentsRequested.length > 0) {
            const names = projectAgentsRequested.map((agent) => agent.name).join(", ");
            const dir = discovery.projectAgentsDir ?? "(unknown)";
            const ok = await ctx.ui.confirm(
              "Run project-local agents?",
              `Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
            );
            if (!ok) {
              return {
                content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
                details: makeDetails(mode, agentScope, discovery.projectAgentsDir, []),
              };
            }
          }
        }

        if (params.chain?.length) {
          const results: SingleResult[] = [];
          let previousOutput = "";

          for (let index = 0; index < params.chain.length; index++) {
            const step = params.chain[index]!;
            const task = step.task.replace(/\{previous\}/g, previousOutput);
            const result = await runSingleAgent({
              defaultCwd: ctx.cwd,
              agentDir: options.agentDir,
              modelRegistry: options.modelRegistry,
              agents,
              agentName: step.agent,
              task,
              cwd: step.cwd,
              step: index + 1,
              signal,
              ctx,
              createChildCustomTools: options.createChildCustomTools,
              mode: "chain",
              agentScope,
              projectAgentsDir: discovery.projectAgentsDir,
              previousResults: results,
              onUpdate,
            });
            results.push(result);

            const failed =
              result.exitCode !== 0 ||
              result.stopReason === "error" ||
              result.stopReason === "aborted";
            if (failed) {
              const errorText = result.errorMessage || result.stderr || formatSingleOutput(result);
              return {
                content: [
                  {
                    type: "text",
                    text: `Chain stopped at step ${index + 1} (${step.agent}): ${errorText}`,
                  },
                ],
                details: makeDetails("chain", agentScope, discovery.projectAgentsDir, results),
                isError: true,
              };
            }

            previousOutput = result.output;
          }

          return {
            content: [{ type: "text", text: formatSingleOutput(results[results.length - 1]!) }],
            details: makeDetails("chain", agentScope, discovery.projectAgentsDir, results),
          };
        }

        if (params.tasks?.length) {
          if (params.tasks.length > MAX_PARALLEL_TASKS) {
            return {
              content: [
                {
                  type: "text",
                  text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
                },
              ],
              details: makeDetails("parallel", agentScope, discovery.projectAgentsDir, []),
              isError: true,
            };
          }

          const allResults: SingleResult[] = params.tasks.map((task) => ({
            agent: task.agent,
            agentSource: "unknown",
            task: task.task,
            exitCode: -1,
            stderr: "",
            output: "",
            lastProgress: "(running...)",
            usage: createEmptyUsage(),
          }));

          const emitParallelUpdate = () => {
            if (!onUpdate) return;
            const running = allResults.filter((result) => result.exitCode === -1).length;
            const done = allResults.length - running;
            onUpdate({
              content: [
                {
                  type: "text",
                  text: `Parallel: ${done}/${allResults.length} done, ${running} running...`,
                },
              ],
              details: makeDetails("parallel", agentScope, discovery.projectAgentsDir, [
                ...allResults,
              ]),
            });
          };

          const results = await mapWithConcurrencyLimit(
            params.tasks,
            MAX_CONCURRENCY,
            async (task, index) => {
              const result = await runSingleAgent({
                defaultCwd: ctx.cwd,
                agentDir: options.agentDir,
                modelRegistry: options.modelRegistry,
                agents,
                agentName: task.agent,
                task: task.task,
                cwd: task.cwd,
                signal,
                ctx,
                createChildCustomTools: options.createChildCustomTools,
                mode: "parallel",
                agentScope,
                projectAgentsDir: discovery.projectAgentsDir,
                onUpdate: (partial) => {
                  const current = partial.details.results[partial.details.results.length - 1];
                  if (current) {
                    allResults[index] = current;
                    emitParallelUpdate();
                  }
                },
              });
              allResults[index] = result;
              emitParallelUpdate();
              return result;
            },
          );

          const successCount = results.filter((result) => result.exitCode === 0).length;
          const summaries = results.map((result) => {
            const preview = formatSingleOutput(result);
            return `[${result.agent}] ${result.exitCode === 0 ? "completed" : "failed"}: ${preview}`;
          });

          return {
            content: [
              {
                type: "text",
                text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
              },
            ],
            details: makeDetails("parallel", agentScope, discovery.projectAgentsDir, results),
            isError: successCount !== results.length,
          };
        }

        if (params.agent && params.task) {
          const result = await runSingleAgent({
            defaultCwd: ctx.cwd,
            agentDir: options.agentDir,
            modelRegistry: options.modelRegistry,
            agents,
            agentName: params.agent,
            task: params.task,
            cwd: params.cwd,
            signal,
            ctx,
            createChildCustomTools: options.createChildCustomTools,
            mode: "single",
            agentScope,
            projectAgentsDir: discovery.projectAgentsDir,
            onUpdate,
          });

          const failed =
            result.exitCode !== 0 ||
            result.stopReason === "error" ||
            result.stopReason === "aborted";
          if (failed) {
            const errorText = result.errorMessage || result.stderr || formatSingleOutput(result);
            return {
              content: [
                { type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorText}` },
              ],
              details: makeDetails("single", agentScope, discovery.projectAgentsDir, [result]),
              isError: true,
            };
          }

          return {
            content: [{ type: "text", text: formatSingleOutput(result) }],
            details: makeDetails("single", agentScope, discovery.projectAgentsDir, [result]),
          };
        }

        const available =
          agents.map((agent) => `${agent.name} (${agent.source})`).join(", ") || "none";
        return {
          content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
          details: makeDetails("single", agentScope, discovery.projectAgentsDir, []),
          isError: true,
        };
      },
    }),
    "acp",
  );
}

export { DEFAULT_SUBAGENT_TOOL_NAMES };
