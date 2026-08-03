import { methods, type AgentContext, type SessionNotification } from "@agentclientprotocol/sdk";

/** Client-side ACP surface used by the Pi adapter for outbound notifications. */
export interface AcpAgentClientContext {
  sessionUpdate(params: SessionNotification): Promise<void>;
}

/** Adapts the new ACP agent handler context to the client-call surface used by the adapter. */
export function createAcpAgentClientContext(client: AgentContext): AcpAgentClientContext {
  return {
    sessionUpdate(params) {
      return client.notify(methods.client.session.update, params);
    },
  };
}
