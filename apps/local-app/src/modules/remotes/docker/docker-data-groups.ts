import { createHash } from 'node:crypto';
import type { DockerDataGroupRecord } from '../operations/docker-import-inventory.store';
import {
  DOCKER_PROJECT_LABEL,
  type DockerHolderMetadata,
  type DockerScanResult,
} from '../host/host-docker.dto';
import { potentialDataMounts } from './docker-plan-fit';
import { within } from './docker-plan-files';
import {
  isVolumeMount,
  type DockerPlanItem,
  type DockerDataMembers,
  type DockerDataGroup,
  type DockerDataGroupCheck,
  type DockerDataState,
} from './docker-plan.dto';

export interface DockerDataHolder extends DockerDataMembers {
  metadata?: DockerHolderMetadata;
}
export function overlapsData(a: DockerDataMembers, b: DockerDataMembers): boolean {
  return (
    a.volumes.some((v) => b.volumes.includes(v)) ||
    a.bindPaths.some((x) => b.bindPaths.some((y) => within(x, y) || within(y, x)))
  );
}
/** The data a container mounts: its named volumes and bind sources. */
export function mountedData(
  mounts: Array<{ type: string; name?: string; source?: string }>,
): DockerDataMembers {
  return {
    volumes: mounts.filter((m) => m.type === 'volume' && m.name).map((m) => m.name!),
    bindPaths: mounts.filter((m) => m.type === 'bind' && m.source).map((m) => m.source!),
  };
}

/** The identity of a data group: the same for the same volumes and folders. */
export function dataGroupIdentity(members: DockerDataMembers): string {
  return JSON.stringify([[...members.volumes].sort(), [...members.bindPaths].sort()]);
}
/** The key of a Disconnect choice: the same for the same volumes and folders. */
export function dockerDataGroupKey(members: DockerDataMembers): string {
  return createHash('sha256').update(dataGroupIdentity(members)).digest('hex').slice(0, 16);
}
export function sameDataGroup(a: DockerDataMembers, b: DockerDataMembers): boolean {
  return dataGroupIdentity(a) === dataGroupIdentity(b);
}

/** Newer records take their members out of older ones; emptied older records go. */
export function supersedeGroupRecords(
  prior: DockerDataGroupRecord[],
  newer: DockerDataGroupRecord[],
): DockerDataGroupRecord[] {
  return [
    ...prior
      .map((record) => ({
        ...record,
        volumes: record.volumes.filter((v) => !newer.some((g) => g.volumes.includes(v))),
        bindPaths: record.bindPaths.filter(
          (p) => !newer.some((g) => g.bindPaths.some((copied) => within(copied, p))),
        ),
      }))
      .filter((g) => g.volumes.length || g.bindPaths.length),
    ...newer,
  ];
}

/** The members the VM holds for the project: its labelled volumes and existing folders. */
export function presentOnVm(
  members: DockerDataMembers,
  vm: DockerScanResult,
  projectId: string,
): DockerDataMembers {
  return {
    volumes: members.volumes.filter((name) =>
      vm.volumes.some((v) => v.name === name && v.labels[DOCKER_PROJECT_LABEL] === projectId),
    ),
    bindPaths: members.bindPaths.filter((path) =>
      vm.paths.some((p) => p.path === path && 'exists' in p && p.exists),
    ),
  };
}

/** A holder created or started after `baseline`; a time that cannot be read counts as use. */
export function usedAfter(
  created: string | undefined,
  startedAt: string | undefined,
  baseline: number,
): boolean {
  const createdAt = Date.parse(created ?? '');
  const started = Date.parse(startedAt ?? '');
  return (
    !Number.isFinite(baseline) ||
    !Number.isFinite(createdAt) ||
    !Number.isFinite(started) ||
    createdAt > baseline ||
    started > baseline
  );
}

export function groupDockerData(items: DockerPlanItem[], root: string): DockerDataGroup[] {
  const members = items
    .map((item) => {
      // Decisions need the potential data even when the current choice omits its copy.
      const mounts = potentialDataMounts(item, root);
      return {
        itemIds: [item.id],
        volumes: mounts.filter((m) => isVolumeMount(m.kind)).map((m) => m.source),
        bindPaths: mounts.filter((m) => !isVolumeMount(m.kind)).map((m) => m.source),
      };
    })
    .filter((m) => m.volumes.length || m.bindPaths.length);
  const groups: DockerDataGroup[] = [];
  const visited = new Set<DockerDataGroup>();
  for (const member of members) {
    if (visited.has(member)) continue;
    const group = [member];
    visited.add(member);
    for (const entry of group)
      for (const candidate of members)
        if (!visited.has(candidate) && overlapsData(entry, candidate)) {
          group.push(candidate);
          visited.add(candidate);
        }
    groups.push({
      itemIds: [...new Set(group.flatMap((g) => g.itemIds))].sort(),
      volumes: [...new Set(group.flatMap((g) => g.volumes))].sort(),
      bindPaths: [...new Set(group.flatMap((g) => g.bindPaths))].sort(),
    });
  }
  return groups;
}

function changed(
  holders: DockerDataHolder[] | null,
  members: DockerDataMembers,
  baseline: number,
): boolean {
  if (!holders || !Number.isFinite(baseline)) return true;
  return holders
    .filter((h) => overlapsData(h, members))
    .some(({ metadata: m }) => {
      if (!m || typeof m.running !== 'boolean' || !m.created || !m.startedAt) return true;
      return m.running || usedAfter(m.created, m.startedAt, baseline);
    });
}

/** Pure metadata check: no engine, filesystem, archive, or content access. */
export function checkDockerDataGroup(
  group: DockerDataGroup,
  records: DockerDataGroupRecord[],
  home: DockerDataHolder[] | null,
  vm: DockerScanResult | null,
  projectId: string,
): DockerDataGroupCheck {
  const present: DockerDataMembers = {
    volumes: group.volumes.filter((name) => !vm || vm.volumes.some((v) => v.name === name)),
    bindPaths: group.bindPaths.filter(
      (path) => !vm || !vm.paths.some((p) => p.path === path && 'exists' in p && !p.exists),
    ),
  };
  if (!present.volumes.length && !present.bindPaths.length) return { ...group, state: 'no-record' };
  const resources: DockerDataMembers[] = [
    ...present.volumes.map((v) => ({ volumes: [v], bindPaths: [] })),
    ...present.bindPaths.map((p) => ({ volumes: [], bindPaths: [p] })),
  ];
  let homeChanged = false;
  let vmChanged = false;
  let unknown = false;
  const holders =
    vm?.containers.map((c) => ({ ...mountedData(c.mounts), metadata: c.metadata })) ?? null;
  for (const resource of resources) {
    const matching = records.filter((r) => overlapsData(r, resource));
    if (!matching.length) {
      unknown = true;
      continue;
    }
    // A discard of a subgroup must not acknowledge changes to the rest of an older, larger group.
    const covering = matching.filter(
      (r) =>
        resource.volumes.every((v) => r.volumes.includes(v)) &&
        resource.bindPaths.every((p) => r.bindPaths.some((b) => within(b, p))),
    );
    const relevant = covering.length ? covering : matching;
    const combine = covering.length ? Math.max : Math.min;
    const baseline = (record: DockerDataGroupRecord, side: 'homeDiscardedAt' | 'vmDiscardedAt') =>
      Math.max(
        record.lastSyncedAt ? Date.parse(record.lastSyncedAt) : -Infinity,
        record[side] ? Date.parse(record[side]!) : -Infinity,
      );
    homeChanged ||= changed(
      home,
      resource,
      combine(...relevant.map((r) => baseline(r, 'homeDiscardedAt'))),
    );
    vmChanged ||= changed(
      holders,
      resource,
      combine(...relevant.map((r) => baseline(r, 'vmDiscardedAt'))),
    );
    // A resource the VM does not hold for the project counts as changed there.
    vmChanged ||= !vm || !sameDataGroup(presentOnVm(resource, vm, projectId), resource);
  }
  return { ...group, state: dataState(unknown, homeChanged, vmChanged) };
}

function dataState(unknown: boolean, homeChanged: boolean, vmChanged: boolean): DockerDataState {
  if (unknown) return 'unknown';
  if (homeChanged && vmChanged) return 'both-changed';
  if (homeChanged) return 'home-newer';
  if (vmChanged) return 'vm-newer';
  return 'in-sync';
}
