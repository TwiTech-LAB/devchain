import { ValidationError } from '../../../common/errors/error-types';
import {
  COMPOSE_PROJECT_LABEL,
  DOCKER_PROJECT_LABEL,
  type DockerScanResult,
} from '../host/host-docker.dto';
import type { DockerImportInventory } from '../operations/docker-import-inventory.store';
import { copiedDataMounts, copiedMounts } from './docker-plan-fit';
import { projectAnchoredPath, within } from './docker-plan-files';
import {
  COPYABLE_MOUNT_KINDS,
  isVolumeMount,
  type DockerDataChoice,
  type DockerDataGroupCheck,
  type DockerDataState,
  type DockerSelectionItem,
  type DockerPlan,
  type DockerPlanItem,
  type DockerPlanRequest,
  type DockerSelectionMode,
} from './docker-plan.dto';

/** Blockers that stop only an item's data; "Copy without its data" still moves the container. */
export const DATA_BLOCKER_CODES: readonly string[] = [
  'non-local-volume',
  'external-writable-bind',
  'bind-destination',
];
/** Whether a blocker still blocks an item selected in this mode. */
export function blocksMode(mode: DockerSelectionMode, code: string): boolean {
  if (mode === 'without-data') return !DATA_BLOCKER_CODES.includes(code);
  return mode !== 'data-only' || code !== 'runtime-bound';
}

export function applyDockerPolicy(
  items: DockerPlanItem[],
  request: DockerPlanRequest,
  target: DockerScanResult,
  projectId: string,
  targetHome: string | null,
  targetUid: number | null,
  homeUid: number | null,
): void {
  const selections = new Map<string, DockerSelectionMode>();
  for (const selection of request.items ?? []) {
    if (selections.has(selection.id) || !items.some((i) => i.id === selection.id))
      throw new ValidationError('Docker selection has duplicate or unknown item ids');
    selections.set(selection.id, selection.mode);
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
    item.warnings = item.warnings.filter(
      (warning) =>
        warning.code !== 'home-uid' ||
        (targetUid !== null && homeUid !== null && targetUid !== homeUid),
    );
    for (const warning of item.warnings)
      if (warning.code === 'home-uid')
        warning.message = `Container runs as home uid ${homeUid}; VM uid is ${targetUid}. File permissions may differ.`;
    const runtimeBound = item.blockers.some((b) => b.code === 'runtime-bound');
    const dataBlocked = item.blockers.some((b) => DATA_BLOCKER_CODES.includes(b.code));
    const containerBlocked = item.blockers.some((b) =>
      ['runtime-bound', 'architecture-mismatch', 'readonly-path-missing'].includes(b.code),
    );
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
      if (runtimeBound && !dataBlocked && item.blockers.every((b) => b.code === 'runtime-bound'))
        item.choices.push('data-only');
    }
    item.defaultSelected =
      item.linkedReasons.length > 0 && !item.temporary && item.blockers.length === 0;
    item.selectedMode =
      request.items === undefined
        ? item.defaultSelected
          ? (item.choices[0] ?? null)
          : null
        : (selections.get(item.id) ?? null);
    if (item.selectedMode && !item.choices.includes(item.selectedMode))
      throw new ValidationError(`Unavailable Docker selection mode for item ${item.id}`);

    const existing = target.containers.find((c) => c.name.replace(/^\//, '') === item.name);
    if (
      existing &&
      item.kind === 'container' &&
      !item.temporary &&
      item.selectedMode !== 'data-only'
    ) {
      const composeProject = existing.labels[COMPOSE_PROJECT_LABEL];
      const imported =
        composeProject &&
        target.volumes.some(
          (v) =>
            v.labels[DOCKER_PROJECT_LABEL] === projectId &&
            v.labels[COMPOSE_PROJECT_LABEL] === composeProject,
        );
      const holdsImported =
        composeProject &&
        existing.mounts.some(
          (m) =>
            m.type === 'volume' &&
            target.volumes.some(
              (v) =>
                v.name === m.name &&
                v.labels[DOCKER_PROJECT_LABEL] === projectId &&
                v.labels[COMPOSE_PROJECT_LABEL] === composeProject,
            ),
        );
      if (existing.labels[DOCKER_PROJECT_LABEL] === projectId || holdsImported)
        item.targetAction = 'replace';
      else if (
        imported &&
        !existing.mounts.some(
          (m) =>
            m.type === 'volume' &&
            target.volumes.some(
              (v) => v.name === m.name && Boolean(v.labels[DOCKER_PROJECT_LABEL]),
            ),
        )
      ) {
        item.targetAction = 'leave-as-is';
        item.notes.push('already on the VM (managed by Compose), left as is');
      } else {
        item.targetAction = 'conflict';
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
          (Boolean(holder.labels[COMPOSE_PROJECT_LABEL]) &&
            holder.labels[COMPOSE_PROJECT_LABEL] === volume.labels[COMPOSE_PROJECT_LABEL] &&
            volume.labels[DOCKER_PROJECT_LABEL] === projectId);
        if (!managed)
          item.blockers.push({
            code: 'unrelated-holder',
            message: `VM container ${holder.name} holds volume ${mount.source} and blocks replacement.`,
          });
      }
    }
  }
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
    // Without-data cannot authorize replacing shared data through a sibling item.
    if (
      action === 'replace-home' &&
      selected.some((i) => i.selectedMode === 'without-data') &&
      selected.some((i) => i.selectedMode !== 'without-data')
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
