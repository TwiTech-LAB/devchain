export function buildTmuxSessionName(
  projectSlug: string,
  epicId: string,
  agentId: string,
  sessionId: string,
): string {
  const shortEpic = epicId === 'independent' ? epicId : epicId.slice(0, 8);
  const shortAgent = agentId.slice(0, 8);
  const shortSession = sessionId.slice(0, 8);
  return `devchain_${projectSlug}_${shortEpic}_${shortAgent}_${shortSession}`;
}
