/** Composite restart key for a main (non-worktree) agent. */
export function restartKeyForMain(agentId: string): string {
  return `:${agentId}`;
}

/** Composite restart key for a worktree agent. */
export function restartKeyForWorktree(apiBase: string, agentId: string): string {
  return `${apiBase}:${agentId}`;
}
