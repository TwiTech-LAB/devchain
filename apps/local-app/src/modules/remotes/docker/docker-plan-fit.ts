import type { DockerFilesystem } from '../../core/controllers/docker-runtime';
import type { DockerPathCapacity } from '../host/host-docker.dto';
import {
  COPYABLE_MOUNT_KINDS,
  isVolumeMount,
  type DockerPlan,
  type DockerPlanFilesystem,
  type DockerPlanItem,
  type DockerPlanMount,
  type DockerPlanSize,
} from './docker-plan.dto';
import { resolve } from 'node:path';
import { within } from './docker-plan-files';

export const DOCKER_LOAD_MARGIN_BYTES = 256 * 1024 * 1024;
export interface DockerPlanCapacity {
  imageStore: DockerFilesystem | null;
  dockerRoot: DockerFilesystem | null;
  binds: DockerPathCapacity[];
}
export function copiedMounts(item: DockerPlanItem): DockerPlanMount[] {
  if (!item.selectedMode || item.selectedMode === 'without-data' || item.dataAction === 'keep-vm')
    return [];
  return item.mounts.filter((mount) =>
    item.temporary ? mount.kind === 'named-volume' : COPYABLE_MOUNT_KINDS.includes(mount.kind),
  );
}
/**
 * The mounts whose data the import copies. A bind of the whole project root is
 * code that file sync carries, so it goes before anything else, or the nested
 * dedupe below would hide every in-project data folder behind it.
 */
export function copiedDataMounts(item: DockerPlanItem, projectRoot: string): DockerPlanMount[] {
  const root = resolve(projectRoot);
  return copiedMounts(item).filter(
    (mount) => isVolumeMount(mount.kind) || resolve(mount.source) !== root,
  );
}
/** The data the item could copy, whatever its current choice omits. */
export function potentialDataMounts(item: DockerPlanItem, projectRoot: string): DockerPlanMount[] {
  return copiedDataMounts(
    { ...item, selectedMode: 'container-and-data', dataAction: undefined },
    projectRoot,
  );
}
/**
 * The selected item goes to the VM: it moves, or it keeps a VM copy that may
 * still need its image or container.
 */
export function movesToVm(item: DockerPlanItem): boolean {
  return (
    Boolean(item.selectedMode) &&
    (item.targetAction !== 'leave-as-is' || item.dataAction === 'keep-vm')
  );
}
/**
 * The home containers Connect stops because they write data this selected item
 * copies. Nothing when the item stays as it is or copies no data.
 */
export function writerStops(
  item: DockerPlanItem,
  containerIds: ReadonlySet<string>,
  projectRoot: string,
): string[] {
  if (item.targetAction === 'leave-as-is' || !copiedDataMounts(item, projectRoot).length) return [];
  return item.writerGroup.filter((id) => containerIds.has(id));
}
export function uniqueCopiedMounts(
  items: DockerPlanItem[],
  projectRoot: string,
): DockerPlanMount[] {
  const all = [
    ...new Map(
      items
        .flatMap((item) => copiedDataMounts(item, projectRoot))
        .map((m) => [`${isVolumeMount(m.kind) ? 'volume' : 'bind'}:${m.source}`, m]),
    ).values(),
  ];
  return all.filter(
    (m) =>
      isVolumeMount(m.kind) ||
      !all.some(
        (other) => other !== m && !isVolumeMount(other.kind) && within(other.source, m.source),
      ),
  );
}
export function planDockerFit(
  items: DockerPlanItem[],
  presentImages: string[],
  capacity: DockerPlanCapacity,
  projectRoot: string,
): {
  filesystems: DockerPlanFilesystem[];
  fit: DockerPlan['fit'];
  bytes: number;
  images: string[];
} {
  const groups = new Map<string, DockerPlanFilesystem>();
  const add = (
    path: string,
    sample: DockerFilesystem | null,
    size: DockerPlanSize,
    headroomBytes = 0,
  ) => {
    const key = sample?.filesystemId ?? `unknown:${path}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        filesystemId: sample?.filesystemId ?? null,
        paths: [],
        requiredBytes: 0,
        headroomBytes: 0,
        freeBytes: sample?.freeBytes ?? null,
        unknown: sample === null,
        status: 'unknown',
      };
      groups.set(key, group);
    }
    if (!group.paths.includes(path)) group.paths.push(path);
    if (sample && group.freeBytes !== null)
      group.freeBytes = Math.min(group.freeBytes, sample.freeBytes);
    group.requiredBytes += size.bytes + headroomBytes;
    group.headroomBytes += headroomBytes;
    group.unknown ||= size.unknown;
  };
  const images = [
    ...new Map(
      items
        // Data-only and temporary items still need their image for the VM's archive helper.
        .filter(movesToVm)
        .flatMap((i) => i.images)
        .map((image) => [image.id, image]),
    ).values(),
  ].filter((i) => !presentImages.includes(i.id));
  let bytes = 0;
  for (const image of images) {
    add(capacity.imageStore?.path ?? 'image-store', capacity.imageStore, image.size);
    bytes += image.size.bytes;
  }
  if (images.length) {
    // Keep one image's transient load space plus a fixed operating margin, not a payload multiplier.
    add(
      capacity.imageStore?.path ?? 'image-store',
      capacity.imageStore,
      { bytes: 0, unknown: images.some((i) => i.size.unknown) },
      Math.max(...images.map((i) => i.size.bytes)) + DOCKER_LOAD_MARGIN_BYTES,
    );
  }
  for (const mount of uniqueCopiedMounts(items, projectRoot)) {
    bytes += mount.size.bytes;
    if (isVolumeMount(mount.kind))
      add(capacity.dockerRoot?.path ?? 'docker-root', capacity.dockerRoot, mount.size);
    else {
      const sample = capacity.binds.find((s) => s.path === mount.source);
      add(mount.source, sample && !('unknown' in sample) ? sample : null, mount.size);
    }
  }
  for (const group of groups.values()) group.status = filesystemStatus(group);
  const filesystems = [...groups.values()];
  // The worst filesystem decides.
  const fit =
    (['refused', 'unknown', 'warning'] as const).find((status) =>
      filesystems.some((f) => f.status === status),
    ) ?? 'fits';
  return { filesystems, fit, bytes, images: images.map((i) => i.id) };
}
function filesystemStatus(group: DockerPlanFilesystem): DockerPlanFilesystem['status'] {
  if (group.freeBytes !== null && group.requiredBytes > group.freeBytes) return 'refused';
  if (group.unknown) return 'unknown';
  if (group.freeBytes !== null && group.requiredBytes > group.freeBytes * 0.8) return 'warning';
  return 'fits';
}

/** Export and transfer overlap; only the post-transfer load tail is serial. */
export function estimateDockerPlan(
  bytes: number,
  probeSeconds: number,
  exportBytesPerSecond: number | null,
): DockerPlan['estimate'] {
  if (bytes === 0)
    return {
      minSeconds: 0,
      maxSeconds: 0,
      probeBytes: 16 * 1024 * 1024,
      loadTailKnown: false,
      approximate: true,
    };
  if (!(probeSeconds > 0) || !(exportBytesPerSecond && exportBytesPerSecond > 0)) return null;
  const transfer = (bytes / (16 * 1024 * 1024)) * probeSeconds;
  const exporting = bytes / exportBytesPerSecond;
  return {
    minSeconds: Math.max(exporting, transfer),
    maxSeconds: (exporting + transfer) * 3,
    probeBytes: 16 * 1024 * 1024,
    loadTailKnown: false,
    approximate: true,
  };
}

/** Kept groups still stop all home writers before ownership moves to the VM. */
export function keptWriterStops(item: DockerPlanItem, all: DockerPlanItem[]): string[] {
  if (!item.selectedMode || item.dataAction !== 'keep-vm') return [];
  const members = new Set(item.dataGroup ?? [item.id]);
  const containers = new Set(all.filter((i) => i.kind === 'container').map((i) => i.id));
  return [...new Set(all.filter((i) => members.has(i.id)).flatMap((i) => i.writerGroup))].filter(
    (id) => containers.has(id),
  );
}
