import { ValidationError } from '../../../common/errors/error-types';
import { containsIPv4, overlappingIPv4Range } from '../../core/controllers/docker-settings';
import {
  COMPOSE_PROJECT_LABEL,
  DOCKER_PROJECT_LABEL,
  type DockerScanResult,
} from '../host/host-docker.dto';
import type { DockerImportInventory } from '../operations/docker-import-inventory.store';
import { connectChoiceKey, type ConnectDockerChoice } from '../connect-choices.dto';
import { copiedDataMounts, copiedMounts } from './docker-plan-fit';
import { projectAnchoredPath, within } from './docker-plan-files';
import { projectCompose } from './docker-project-compose';
import {
  COPYABLE_MOUNT_KINDS,
  isVolumeMount,
  type DockerDataChoice,
  type DockerDataGroupCheck,
  type DockerDataState,
  type DockerNetworkRange,
  type DockerSelectionItem,
  type DockerPlan,
  type DockerPlanItem,
  type DockerPlanNetwork,
  type DockerPlanIssue,
  type DockerPlanRequest,
  type DockerSelectionMode,
} from './docker-plan.dto';

/** Blockers that stop only an item's data; "Copy without its data" still moves the container. */
export const DATA_BLOCKER_CODES: readonly string[] = [
  'non-local-volume',
  'external-writable-bind',
  'bind-destination',
];
const CONTAINER_ONLY_BLOCKER_CODES = [
  'runtime-bound',
  'fixed-ipv4-unavailable',
  'privileged-not-accepted',
];
const CONTAINER_BLOCKER_CODES = [
  ...CONTAINER_ONLY_BLOCKER_CODES,
  'architecture-mismatch',
  'readonly-path-missing',
];
/** Whether a blocker still blocks an item selected in this mode. */
export function blocksMode(mode: DockerSelectionMode, code: string): boolean {
  if (mode === 'without-data') return !DATA_BLOCKER_CODES.includes(code);
  return mode !== 'data-only' || !CONTAINER_ONLY_BLOCKER_CODES.includes(code);
}

export function applyDockerPolicy(
  items: DockerPlanItem[],
  request: DockerPlanRequest,
  target: DockerScanResult,
  projectId: string,
  targetHome: string | null,
  projectRoot: string,
  remembered: Readonly<Record<string, ConnectDockerChoice>> = {},
): void {
  const selections = new Map<string, DockerSelectionItem>();
  for (const selection of request.items ?? []) {
    if (selections.has(selection.id) || !items.some((i) => i.id === selection.id))
      throw new ValidationError('Docker selection has duplicate or unknown item ids');
    selections.set(selection.id, selection);
  }
  for (const item of items) {
    for (const mount of item.mounts) {
      if (item.temporary && mount.kind !== 'named-volume') continue;
      if (isVolumeMount(mount.kind) && mount.driver !== 'local')
        item.blockers.push({
          code: 'non-local-volume',
          message: `Volume ${mount.source} does not use the local driver.`,
        });
      if (mount.kind === 'external-bind')
        item.blockers.push({
          code: 'external-writable-bind',
          message: `Data cannot move: ${mount.source} is outside the home folder.`,
        });
      if (
        !isVolumeMount(mount.kind) &&
        COPYABLE_MOUNT_KINDS.includes(mount.kind) &&
        (!targetHome || !within(targetHome, mount.source))
      )
        item.blockers.push({
          code: 'bind-destination',
          message: `Data cannot move: ${mount.source} is outside the VM home folder.`,
        });
      if (mount.kind === 'readonly-external-bind') {
        const found = target.paths.find((path) => path.path === mount.source);
        if (!found || !('exists' in found) || !found.exists)
          item.blockers.push({
            code: 'readonly-path-missing',
            message: `Read-only path ${mount.source} is missing or could not be verified on the VM.`,
          });
      }
    }
    if (
      !item.temporary &&
      item.images.some(
        (image) =>
          normalizeArchitecture(image.architecture) !== normalizeArchitecture(target.architecture),
      )
    )
      item.blockers.push({
        code: 'architecture-mismatch',
        message: 'Image architecture differs from the VM.',
      });
    const existing = target.containers.find((c) => c.name.replace(/^\//, '') === item.name);
    const action = existing
      ? counterpartAction(existing, target, projectId, projectRoot, item)
      : 'create';
    fixedIPv4Policy(item, target, action === 'conflict' ? undefined : existing?.id);
    const dataBlocked = item.blockers.some((b) => DATA_BLOCKER_CODES.includes(b.code));
    const containerBlocked = item.blockers.some((b) => CONTAINER_BLOCKER_CODES.includes(b.code));
    if (item.temporary || item.kind === 'compose-project')
      item.choices =
        dataBlocked ||
        item.blockers.some(
          (b) => b.code === 'architecture-mismatch' || b.code === 'compose-unreadable',
        )
          ? []
          : ['data-only'];
    else {
      if (!containerBlocked && !dataBlocked) item.choices.push('container-and-data');
      if (!containerBlocked) item.choices.push('without-data');
      if (
        (item.privileged && !dataBlocked) ||
        (item.blockers.length > 0 &&
          item.blockers.every((b) => CONTAINER_ONLY_BLOCKER_CODES.includes(b.code)))
      )
        item.choices.push('data-only');
    }
    item.defaultSelected =
      item.linkedReasons.length > 0 && !item.temporary && item.blockers.length === 0;
    if (request.items !== undefined) {
      item.selectedMode = selections.get(item.id)?.mode ?? null;
    } else {
      const saved = remembered[connectChoiceKey(item)];
      if (saved?.included === false) {
        item.defaultSelected = false;
        item.selectedMode = null;
      } else if (saved?.mode && item.choices.includes(saved.mode)) {
        item.defaultSelected = true;
        item.selectedMode = saved.mode;
      } else {
        item.selectedMode = item.defaultSelected ? (item.choices[0] ?? null) : null;
      }
    }
    if (item.selectedMode && !item.choices.includes(item.selectedMode))
      throw new ValidationError(
        item.blockers.find(
          (b) => b.code === 'fixed-ipv4-unavailable' && blocksMode(item.selectedMode!, b.code),
        )?.message ?? `Unavailable Docker selection mode for item ${item.id}`,
      );

    if (
      existing &&
      item.kind === 'container' &&
      !item.temporary &&
      item.selectedMode !== 'data-only'
    ) {
      item.targetAction = action;
      if (action === 'leave-as-is') {
        item.notes.push('already on the VM (managed by Compose), left as is');
      } else if (action === 'conflict') {
        item.blockers.push({
          code: 'container-conflict',
          message: `The VM container ${item.name} is not owned by this project; skip it or resolve the conflict manually.`,
        });
      }
    }
    if (item.temporary || item.selectedMode === 'data-only') item.targetAction = 'data-only';
    for (const mount of copiedMounts(item)) {
      if (!isVolumeMount(mount.kind)) continue;
      const volume = target.volumes.find((v) => v.name === mount.source);
      if (!volume) continue;
      if (volume.labels[DOCKER_PROJECT_LABEL] !== projectId)
        item.blockers.push({
          code: 'volume-conflict',
          message: `VM volume ${mount.source} is not owned by this project; it cannot be replaced.`,
        });
      for (const holder of target.containers.filter((c) =>
        c.mounts.some((m) => m.type === 'volume' && m.name === mount.source),
      )) {
        const managed =
          holder.labels[DOCKER_PROJECT_LABEL] === projectId ||
          projectCompose(holder.labels, projectRoot, projectId) ||
          (holder.labels[DOCKER_PROJECT_LABEL] === undefined &&
            Boolean(holder.labels[COMPOSE_PROJECT_LABEL]) &&
            holder.labels[COMPOSE_PROJECT_LABEL] === volume.labels[COMPOSE_PROJECT_LABEL] &&
            volume.labels[DOCKER_PROJECT_LABEL] === projectId);
        if (!managed)
          item.blockers.push({
            code: 'unrelated-holder',
            message: `VM container ${holder.name} holds volume ${mount.source} and blocks replacement.`,
          });
      }
    }
    // Acceptance gates execution after choice generation so container modes stay available.
    if (
      item.privileged &&
      (item.selectedMode === 'container-and-data' || item.selectedMode === 'without-data') &&
      !selections.get(item.id)?.acceptPrivileged
    )
      item.blockers.push({
        code: 'privileged-not-accepted',
        message: 'Accept Run privileged for this container, or pick Copy its data only.',
      });
  }
}
function counterpartAction(
  existing: DockerScanResult['containers'][number],
  target: DockerScanResult,
  projectId: string,
  projectRoot: string,
  home: DockerPlanItem,
): 'replace' | 'leave-as-is' | 'conflict' {
  const owner = existing.labels[DOCKER_PROJECT_LABEL];
  if (owner !== undefined && owner !== projectId) return 'conflict';
  const composeProject = existing.labels[COMPOSE_PROJECT_LABEL];
  const importedVolumes = target.volumes.filter(
    (v) =>
      v.labels[DOCKER_PROJECT_LABEL] === projectId &&
      v.labels[COMPOSE_PROJECT_LABEL] === composeProject,
  );
  const holdsImported =
    composeProject &&
    existing.mounts.some(
      (m) => m.type === 'volume' && importedVolumes.some((v) => v.name === m.name),
    );
  if (existing.labels[DOCKER_PROJECT_LABEL] === projectId || holdsImported) return 'replace';
  if (projectCompose(existing.labels, projectRoot, projectId))
    return home.mounts.some((mount) => COPYABLE_MOUNT_KINDS.includes(mount.kind))
      ? 'replace'
      : 'leave-as-is';
  if (
    composeProject &&
    importedVolumes.length &&
    !existing.mounts.some(
      (m) =>
        m.type === 'volume' &&
        target.volumes.some((v) => v.name === m.name && Boolean(v.labels[DOCKER_PROJECT_LABEL])),
    )
  )
    return 'leave-as-is';
  return 'conflict';
}

export function rangeConflict(
  homeSubnets: readonly string[],
  vmNetworks: DockerScanResult['networks'] = [],
  vmRoutes: readonly string[] = [],
): string | undefined {
  return (
    vmNetworks.find((other) => overlappingIPv4Range(homeSubnets, other.subnets))?.name ??
    overlappingIPv4Range(homeSubnets, vmRoutes)
  );
}

export function dockerNetworkPolicy(
  items: DockerPlanItem[],
  target: DockerScanResult,
): DockerPlanNetwork[] {
  const networks = new Map<string, DockerNetworkRange>();
  const selected = items.filter((item) => item.kind === 'container' && item.selectedMode);
  for (const item of selected)
    for (const network of item.networks ?? []) networks.set(network.name, network);
  const fixedNetworks = new Set(
    selected
      .filter((item) => !item.temporary && item.selectedMode !== 'data-only')
      .flatMap((item) => item.fixedIPv4?.map((fixed) => fixed.network) ?? []),
  );
  return [...networks.values()].map((network): DockerPlanNetwork => {
    const existing = target.networks?.find((vm) => vm.name === network.name);
    if (existing) {
      const differs = !network.subnets.some((home) => existing.subnets.includes(home));
      // The reused network's own range and bridge route would go with it.
      const overlaps = differs
        ? rangeConflict(
            network.subnets,
            target.networks?.filter((vm) => vm.name !== network.name),
            target.routes?.filter((route) => !existing.subnets.includes(route)),
          )
        : undefined;
      return {
        ...network,
        kind: 'reused',
        vmSubnets: existing.subnets,
        differs,
        ...(overlaps ? { overlaps } : {}),
      };
    }
    const overlaps = rangeConflict(network.subnets, target.networks, target.routes);
    return overlaps && !fixedNetworks.has(network.name)
      ? { ...network, kind: 'automatic-range', overlaps }
      : { ...network, kind: 'home-range' };
  });
}

export function dockerNetworkWarnings(networks: DockerPlanNetwork[]): DockerPlanIssue[] {
  return networks.flatMap((network) => {
    if (network.kind === 'automatic-range')
      return [
        {
          code: 'network-automatic-range',
          message: `Network ${network.name} uses an automatic VM range because its home range ${network.subnets.join(', ')} overlaps ${network.overlaps}.`,
        },
      ];
    if (network.kind === 'reused' && network.differs) {
      const remedy = network.overlaps
        ? `The home range overlaps ${network.overlaps} on the VM, so removing the VM network would not restore it. Keep the VM range, or free the home range on the VM first.`
        : 'Remove the VM network when no container uses it, then connect again.';
      return [
        {
          code: 'network-range-differs',
          message: `VM network ${network.name} uses ${network.vmSubnets.join(', ') || 'no IPv4 range'}, not the home range ${network.subnets.join(', ') || 'no IPv4 range'}. ${remedy}`,
        },
      ];
    }
    return [];
  });
}

function fixedIPv4Policy(
  item: DockerPlanItem,
  target: DockerScanResult,
  counterpartId?: string,
): void {
  for (const fixed of item.fixedIPv4 ?? []) {
    const reason = fixedIPv4Refusal(fixed, target, counterpartId);
    if (reason)
      item.blockers.push({
        code: 'fixed-ipv4-unavailable',
        message: `${item.name} cannot use ${fixed.address} on network ${fixed.network}: ${reason}`,
      });
  }
}
/** Why the VM cannot give a fixed address; none when it can. */
function fixedIPv4Refusal(
  fixed: NonNullable<DockerPlanItem['fixedIPv4']>[number],
  target: DockerScanResult,
  counterpartId: string | undefined,
): string | undefined {
  const network = target.networks?.find((n) => n.name === fixed.network);
  if (!network) {
    const vmNetwork = target.networks?.find((other) =>
      overlappingIPv4Range(fixed.subnets, other.subnets),
    );
    if (vmNetwork)
      return `the home network range overlaps VM network ${vmNetwork.name}. Remove the unused VM network and connect again, or change the network range and address on the PC.`;
    const route = overlappingIPv4Range(fixed.subnets, target.routes ?? []);
    if (route)
      return `the home network range overlaps VM on-link route ${route}. Change the network range and address on the PC, then connect again.`;
    return undefined;
  }
  if (!network.subnets.some((subnet) => containsIPv4(subnet, fixed.address)))
    return 'the address is outside the VM network range. Remove the VM network when no container uses it and connect again, or change the address on the PC.';
  const holder = network.addresses?.find(
    (entry) => entry.address === fixed.address && entry.containerId !== counterpartId,
  );
  if (holder)
    return `VM container ${holder.containerName} uses that address. Free the address on the VM, or change the address on the PC.`;
  return undefined;
}

export function dockerReconnect(
  items: DockerPlanItem[],
  inventory: DockerImportInventory | null,
  projectRoot: string,
): DockerPlan['reconnect'] {
  if (!inventory) return null;
  const selected = items.filter(
    (i) =>
      i.selectedMode &&
      i.selectedMode !== 'without-data' &&
      i.dataAction !== 'keep-vm' &&
      i.dataState !== 'no-record' &&
      i.targetAction !== 'leave-as-is' &&
      (!i.dataChoiceRequired || i.dataChoice),
  );
  const mounts = selected.flatMap((item) => copiedDataMounts(item, projectRoot));
  const bindPaths = new Set(
    mounts
      .filter((m) => m.kind === 'project-bind')
      .map((m) => projectAnchoredPath(projectRoot, m.source)),
  );
  const replacing = inventory.items
    .filter(
      (prior) =>
        selected.some((i) => i.name === prior.name) ||
        prior.volumes.some((v) => mounts.some((m) => m.source === v.name)) ||
        prior.bindPaths.some((p) => bindPaths.has(p)),
    )
    .map((i) => i.name);
  if (!replacing.length) return null;
  return {
    importedAt: inventory.importedAt,
    replacing,
    lossNotice:
      'Fresh home data replaces the VM copies DevChain created. VM changes not copied back are lost; Cancel cannot recover a VM copy already replaced.',
  };
}
function normalizeArchitecture(value: string): string {
  return ({ x86_64: 'amd64', aarch64: 'arm64' } as Record<string, string>)[value] ?? value;
}

/** Apply data decisions after ownership checks, so keeping data never bypasses a refusal. */
export function applyDockerDataPolicy(
  items: DockerPlanItem[],
  groups: DockerDataGroupCheck[],
  request: DockerPlanRequest,
  target: DockerScanResult,
): void {
  const selections = new Map<string, DockerSelectionItem>(
    (request.items ?? []).map((i) => [i.id, i]),
  );
  // Without data differs from container and data only while the VM holds none of the
  // item's data; where the VM holds it, Keep VM copy or Replace decides instead.
  for (const item of items) {
    const state = groups.find((g) => g.itemIds.includes(item.id))?.state;
    if (state === 'no-record' || !item.choices.includes('container-and-data')) continue;
    item.choices = item.choices.filter((choice) => choice !== 'without-data');
    if (item.selectedMode !== 'without-data') continue;
    // Only a remembered mode reaches here without request items; it falls back to the default.
    if (request.items !== undefined)
      throw new ValidationError(`Unavailable Docker selection mode for item ${item.id}`);
    item.selectedMode = item.choices[0] ?? null;
  }
  for (const group of groups) {
    const members = items.filter((i) => group.itemIds.includes(i.id));
    const selected = members.filter((i) => i.selectedMode);
    const choices = new Set(selected.flatMap((i) => selections.get(i.id)?.dataChoice ?? []));
    if (choices.size > 1)
      throw new ValidationError('Docker items sharing data must use the same data choice');
    const choice = [...choices][0];
    const missing = {
      volumes: group.volumes.filter((v) => !target.volumes.some((existing) => existing.name === v)),
      bindPaths: group.bindPaths.filter((p) =>
        target.paths.some((entry) => entry.path === p && 'exists' in entry && !entry.exists),
      ),
    };
    const partial = missing.volumes.length > 0 || missing.bindPaths.length > 0;
    const requiresChoice =
      group.state === 'both-changed' ||
      group.state === 'unknown' ||
      (partial && group.state === 'home-newer');
    const action = connectDataAction(group.state, choice, requiresChoice);
    // In the first plan, a remembered without-data decides for its whole data group.
    if (
      request.items === undefined &&
      action === 'replace-home' &&
      selected.some((i) => i.selectedMode === 'without-data')
    ) {
      for (const member of selected) {
        if (member.choices.includes('without-data')) {
          member.selectedMode = 'without-data';
        } else {
          member.selectedMode = null;
          member.defaultSelected = false;
        }
      }
    }
    // Without-data cannot authorize replacing shared data through a sibling item.
    if (
      action === 'replace-home' &&
      selected.some((i) => i.selectedMode === 'without-data') &&
      selected.some((i) => i.selectedMode !== null && i.selectedMode !== 'without-data')
    )
      throw new ValidationError(
        'Docker items sharing data cannot mix replacement and without-data choices',
      );
    for (const item of members) {
      item.dataGroup = group.itemIds;
      item.dataState = group.state;
      item.dataChoice = choice;
      item.dataAction = action;
      item.dataChoiceRequired = requiresChoice;
      item.missingData = missing;
      if (requiresChoice && !choice)
        item.blockers.push({
          code: 'data-choice-required',
          message: 'Choose Keep VM copy or Replace with home data for this shared data group.',
        });
      if (action === 'keep-vm' && item.targetAction === 'replace')
        item.targetAction = 'leave-as-is';
    }
  }
}

/** A group's Connect action: the user's choice, else its state's default; none while a required choice is missing. */
function connectDataAction(
  state: DockerDataState,
  choice: DockerDataChoice | undefined,
  requiresChoice: boolean,
): DockerDataChoice | undefined {
  if (state === 'no-record') return 'replace-home';
  if (choice !== undefined) return choice;
  if (state === 'in-sync' || state === 'vm-newer') return 'keep-vm';
  if (requiresChoice) return undefined;
  return 'replace-home';
}
