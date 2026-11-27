import { providerDisplayName } from '@/ui/components/project/wizard/providerDisplay';
import type { ProfileProviderConfig } from '@/ui/lib/provider-configs';
import type { SavePointAvailability, SessionTreeNode } from '@/ui/lib/sessions';

export const FORK_SESSION_TITLE =
  'Start a new session with a copy of this conversation. This session stays unchanged.';

export function sessionTreeLabel(node: SessionTreeNode): string {
  const date = () =>
    new Date(node.startedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  if (node.beforeRollback) return `Before rollback · ${date()}`;
  if (node.name) return node.name;
  if (node.kind === 'save_point') return `Save point · ${date()}`;
  // The provider session ID changes at each rollback; the DevChain ID does not.
  return node.id.slice(0, 8);
}

export interface SessionTreeTableRow {
  node: SessionTreeNode;
  depth: number;
  branch: { expanded: boolean; toggle: () => void } | null;
  /** The save points of a session row, in list order. */
  savePoints: SessionTreeNode[];
}

export function sessionProviderMismatch(
  node: SessionTreeNode,
  currentProviderName?: string | null,
) {
  return Boolean(
    node.providerNameAtLaunch &&
      currentProviderName &&
      node.providerNameAtLaunch.toLowerCase() !== currentProviderName.toLowerCase(),
  );
}

/** Why Restore is refused for a provider change: the launch provider and the viewing agent's. */
export function providerMismatchReason(
  node: SessionTreeNode,
  currentProviderName: string,
  agentName: string | null | undefined,
): string {
  return `Started with ${launchProviderLabel(node)}. ${agentLabel(agentName)} uses ${providerDisplayName(currentProviderName)}.`;
}

function launchProviderLabel(node: SessionTreeNode): string {
  return providerDisplayName(node.providerNameAtLaunch ?? '');
}

function agentLabel(agentName: string | null | undefined): string {
  return agentName || 'This agent';
}

/**
 * The config a restore of this row switches the agent to: the first config, in profile order,
 * on the row's launch provider. Undefined when there is none or the configs are not loaded.
 */
export function findSwitchConfig(
  node: SessionTreeNode,
  providerConfigs: readonly ProfileProviderConfig[] | undefined,
): ProfileProviderConfig | undefined {
  const launched = node.providerNameAtLaunch?.toLowerCase();
  if (!launched) return undefined;
  return providerConfigs?.find((config) => config.providerName?.toLowerCase() === launched);
}

/** Why Restore stays off for a provider change: no config on the launch provider in the profile. */
export function noSwitchConfigReason(
  node: SessionTreeNode,
  currentProviderName: string,
  agentName: string | null | undefined,
): string {
  return `${providerMismatchReason(node, currentProviderName, agentName)} ${agentLabel(agentName)}'s profile has no ${launchProviderLabel(node)} config.`;
}

/** The short note on an enabled Restore that switches providers. */
export function switchRestoreHint(node: SessionTreeNode, config: ProfileProviderConfig): string {
  return `Restores on ${launchProviderLabel(node)} (${config.name})`;
}

/** The confirm text of a restore that switches the agent to `config`. */
export function switchRestoreWarning(
  node: SessionTreeNode,
  config: ProfileProviderConfig,
  currentProviderName: string | null | undefined,
  agentName: string | null | undefined,
): string {
  const launched = launchProviderLabel(node);
  const current = currentProviderName
    ? providerDisplayName(currentProviderName)
    : 'another provider';
  const agent = agentLabel(agentName);
  return `Restore on ${launched}? ${agent} uses ${current}. Restore switches ${agent} to the ${launched} config "${config.name}" with its default model and effort.`;
}

/** A row without owner fields belongs to the viewing agent. */
export function ownedBy(node: SessionTreeNode, agentId: string): boolean {
  return !node.agentId || node.agentId === agentId;
}

export function ownerLabel(node: SessionTreeNode): string {
  return node.agentName || 'another agent';
}

/** A family session that runs on another agent: nothing here may change it. */
export function runningElsewhere(node: SessionTreeNode, agentId: string): boolean {
  return node.status === 'running' && !ownedBy(node, agentId);
}

export function runningOnLabel(node: SessionTreeNode): string {
  return `Running on ${ownerLabel(node)}`;
}

/**
 * Why Fork and Roll back are off for a record of another agent, or null when the viewing agent owns
 * it. For a save point in a session's list, pass the session: its owner decides.
 */
export function otherOwnerHint(agentId: string, owner: SessionTreeNode): string | null {
  if (ownedBy(owner, agentId)) return null;
  if (owner.status === 'running') return runningOnLabel(owner);
  if (owner.kind === 'save_point') return `Owned by ${ownerLabel(owner)}`;
  return 'Restore to this agent first';
}

/**
 * The server's fork source rule. Unlike Restore, a source with no launch provider is a mismatch.
 * A running source is not offered at all, so status is not checked here.
 */
export function forkSourceBlocked(node: SessionTreeNode, currentProviderName?: string | null) {
  return (
    !node.providerNameAtLaunch ||
    sessionProviderMismatch(node, currentProviderName) ||
    !node.providerSessionId ||
    !node.transcriptAvailable
  );
}

/** Save point controls are hidden for a team member and shown, enabled or not, for all others. */
export function showSavePointControls(savePoints: SavePointAvailability | undefined) {
  return Boolean(savePoints && (savePoints.available || savePoints.reason !== 'TEAM_MEMBER'));
}
