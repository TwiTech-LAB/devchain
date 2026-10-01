/** Composite restart key for a local agent. */
export function restartKeyForMain(agentId: string): string {
  return `:${agentId}`;
}
