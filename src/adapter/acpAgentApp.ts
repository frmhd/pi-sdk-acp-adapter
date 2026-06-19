import { agent, methods, type AgentApp, type AgentConnection } from "@agentclientprotocol/sdk";

import { AcpAgent, type AcpAdapterConfig } from "./AcpAgent.js";
import { createAcpAgentClientContext } from "./acpClientContext.js";
import type { CreateAcpAgentRuntimeOptions } from "../runtime/AcpAgentRuntime.js";
import type { AgentSession, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { ACP_AGENT_NAME } from "../packageMetadata.js";

type AcpRuntimeFactory = (options: CreateAcpAgentRuntimeOptions) => Promise<{
  session: AgentSession;
  dispose: () => void;
  getSlashCommands?: () => SlashCommandInfo[];
}>;

export interface CreateAcpAgentAppOptions {
  config: AcpAdapterConfig;
  createRuntimeFactory: (
    clientContext: ReturnType<typeof createAcpAgentClientContext>,
  ) => AcpRuntimeFactory;
}

export interface AcpAgentApp {
  app: AgentApp;
  getAgent: () => AcpAgent;
  shutdownAgent: () => Promise<void>;
}

function requireAgent(agent: AcpAgent | undefined): AcpAgent {
  if (!agent) {
    throw new Error("ACP agent is not connected.");
  }

  return agent;
}

/** Registers Pi adapter handlers on the modern ACP agent app API. */
export function createAcpAgentApp(options: CreateAcpAgentAppOptions): AcpAgentApp {
  let acpAgent: AcpAgent | undefined;

  const app = agent({ name: ACP_AGENT_NAME })
    .onConnect((connection: AgentConnection) => {
      const clientContext = createAcpAgentClientContext(connection.client);
      acpAgent = new AcpAgent(
        clientContext,
        options.config,
        options.createRuntimeFactory(clientContext),
      );
    })
    .onRequest(methods.agent.initialize, (ctx) => requireAgent(acpAgent).initialize(ctx.params))
    .onRequest(methods.agent.session.new, (ctx) => requireAgent(acpAgent).newSession(ctx.params))
    .onRequest(methods.agent.session.load, (ctx) => requireAgent(acpAgent).loadSession(ctx.params))
    .onRequest(methods.agent.session.list, (ctx) => requireAgent(acpAgent).listSessions(ctx.params))
    .onRequest(methods.agent.session.resume, (ctx) =>
      requireAgent(acpAgent).resumeSession(ctx.params),
    )
    .onRequest(
      methods.agent.session.close,
      async (ctx) => (await requireAgent(acpAgent).closeSession(ctx.params)) ?? {},
    )
    .onRequest(methods.agent.session.setConfigOption, (ctx) =>
      requireAgent(acpAgent).setSessionConfigOption(ctx.params),
    )
    .onRequest(
      methods.agent.authenticate,
      async (ctx) => (await requireAgent(acpAgent).authenticate(ctx.params)) ?? {},
    )
    .onRequest(methods.agent.session.prompt, (ctx) => requireAgent(acpAgent).prompt(ctx.params))
    .onNotification(methods.agent.session.cancel, (ctx) =>
      requireAgent(acpAgent).cancel(ctx.params),
    );

  return {
    app,
    getAgent: () => requireAgent(acpAgent),
    shutdownAgent: async () => {
      if (acpAgent) {
        await acpAgent.shutdown();
      }
    },
  };
}
