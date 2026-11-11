/** Identity of the DevChain session that owns a provider launch. */
export interface SessionIdentity {
  apiUrl: string;
  projectId: string;
  agentId: string;
  sessionId: string;
}

export function sessionIdentityEnv(identity: SessionIdentity): Record<string, string> {
  return {
    DEVCHAIN_SESSION_ID: identity.sessionId,
    DEVCHAIN_PROJECT_ID: identity.projectId,
    DEVCHAIN_AGENT_ID: identity.agentId,
    DEVCHAIN_API_URL: identity.apiUrl,
  };
}
