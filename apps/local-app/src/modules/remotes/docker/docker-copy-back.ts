import { foreignProjectOwner, projectContainer, projectVolume } from './docker-project-resources';
import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PassThrough, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from '../../../common/errors/error-types';
import { DockerArchiveJournal } from '../../core/controllers/docker-archive-journal';
import { DockerArchiveOwnerTransform } from '../../core/controllers/docker-archive-owners';
import {
  DOCKER_ARCHIVE_HELPER_LABEL,
  dockerArchiveLayout,
  writeDockerArchive,
  type DockerCopiedSource,
} from '../../core/controllers/docker-archive';
import {
  DockerEngineClient,
  DockerEngineError,
  changeDockerContainerState,
  optionalDockerJson,
} from '../../core/controllers/docker-engine.client';
import {
  COMPOSE_PROJECT_LABEL,
  COMPOSE_VERSION_LABEL,
  COMPOSE_VOLUME_LABEL,
  DOCKER_PROJECT_LABEL,
  type DockerHostOptions,
  type DockerInspectTimes,
  type DockerScanResult,
} from '../host/host-docker.dto';
import {
  DockerImportInventoryStore,
  inventoryBindPaths,
  type DockerImportInventory,
} from '../operations/docker-import-inventory.store';
import { RemoteHostClient } from '../operations/remote-host.client';
import {
  requireProjectId,
  type RemoteOperationStepRun,
} from '../operations/remote-operation.types';
import { HOST_API_KEY_REJECTED_MESSAGE } from '../host-api-key';
import { REMOTE_HEALTH_PORT, type RemoteHealthPort } from '../ports/remote-health.port';
import {
  DockerCopyBackRequestSchema,
  DockerSyncStateRequestSchema,
  FILE_SYNC_SKIP_REASON,
  FOLLOWS_USER_SKIP_REASON,
  type DockerCopyBackRequest,
  type DockerCopyBackResult,
  type DockerSyncState,
} from './docker-copy-back.dto';
import {
  checkDockerDataGroup,
  groupDockerData,
  dockerDataGroupKey,
  mountedData,
  overlapsData,
  presentOnVm,
  sameDataGroup,
  supersedeGroupRecords,
  usedAfter,
} from './docker-data-groups';
import {
  DockerHandoffStore,
  type DockerCopyBackGroup,
  type DockerCopyBackRecord,
  type DockerCopyBackDataGroup,
} from './docker-handoff.store';
import {
  isVolumeMount,
  type DockerDataGroupCheck,
  type DockerDataMembers,
  type DockerDataState,
  type DockerOwnershipContext,
  type DockerOwnershipDecision,
  type DockerDataRepresentation,
  type DockerPlan,
  type DockerPlanItem,
  type DockerPlanMount,
  type DockerTransferDetails,
} from './docker-plan.dto';
import { DockerPlanService, pagedDockerScan } from './docker-plan.service';
import { DockerPlanSourceService, unknownSize } from './docker-plan-source.service';
import { DockerCopyBackExclusions } from './docker-copy-back-exclusions';
import {
  dockerCopyBackMismatchMessage,
  hasUnknownUserIds,
  vmUserMismatch,
} from '../vm-user-identity';
import {
  applyDockerGroupOwnership,
  classifyDockerOwnership,
  dockerNumericUid,
  exactUidAllowed,
  literalHomeComposeUser,
  ownershipRecord,
  userIdsDiffer,
  type DockerOwnershipConsumer,
} from './docker-ownership';
import {
  desiredDataRepresentation,
  recordedDataRepresentation,
  resourceMembers,
  sameDataRepresentation,
  splitDataRepresentations,
} from './docker-data-representation';
import { within } from './docker-plan-files';

const NEEDS_CHOICE: ReadonlySet<DockerDataState> = new Set(['both-changed', 'unknown']);
const RUNNING_STATES = new Set(['running', 'restarting', 'paused']);
/** The labels a volume recreated on this PC keeps from its VM original. */
const KEPT_VOLUME_LABELS = [
  DOCKER_PROJECT_LABEL,
  COMPOSE_PROJECT_LABEL,
  COMPOSE_VOLUME_LABEL,
  COMPOSE_VERSION_LABEL,
];

class DockerCopyBackError extends AppError {
  constructor(message: string, code = 'DOCKER_COPY_BACK_FAILED', status = 502) {
    super(message, code, status);
  }
}
const CHOICE_REQUIRED = 'DOCKER_COPY_BACK_CHOICE_REQUIRED';
const START_AGAIN = 'Cancel this Disconnect and start it again to choose which data to keep.';
function choiceRequired(reasons: string[]): DockerCopyBackError {
  return new DockerCopyBackError(`${reasons.join(' ')} ${START_AGAIN}`, CHOICE_REQUIRED, 409);
}
function messageOf(error: unknown): string {
  if (error instanceof AppError || error instanceof DockerEngineError) return error.message;
  return 'The Docker copy failed.';
}

/** Groups holding data a Connect imported: the inventory's volumes, folders or group records. */
function importedGroups(
  groups: DockerDataGroupCheck[],
  inventory: DockerImportInventory,
  root: string,
): DockerDataGroupCheck[] {
  const imported: DockerDataMembers = {
    volumes: [
      ...inventory.items.flatMap((item) => item.volumes.map((v) => v.name)),
      ...(inventory.groups ?? []).flatMap((g) => g.volumes),
    ],
    bindPaths: [
      ...inventory.items.flatMap((item) => item.bindPaths.map((path) => join(root, path))),
      ...(inventory.groups ?? []).flatMap((g) => g.bindPaths),
    ],
  };
  return groups.filter((group) => overlapsData(group, imported));
}

/** The volumes and absolute folders an imported item recorded. */
function itemData(item: DockerImportInventory['items'][number], root: string): DockerDataMembers {
  return {
    volumes: item.volumes.map((volume) => volume.name),
    bindPaths: item.bindPaths.map((path) => join(root, path)),
  };
}

function recordedGroupOwnership(
  inventory: DockerImportInventory | null,
  group: DockerDataMembers,
  root: string,
) {
  const records = (inventory?.groups ?? [])
    .filter((record) => overlapsData(group, record))
    .map((record) => record.ownership)
    .concat(
      (inventory?.items ?? [])
        .filter((item) => overlapsData(group, itemData(item, root)))
        .map((item) => item.ownership),
    );
  return records.find((entry) => entry?.class === 'follows-user') ?? records.find(Boolean);
}

function recordedCopyBackData(
  inventory: DockerImportInventory | null,
  group: DockerDataGroupCheck,
  root: string,
): DockerCopyBackDataGroup[] {
  const groups = inventory?.groups ?? [];
  const records = [
    ...groups,
    ...(inventory?.items ?? []).flatMap((item) =>
      (item.dataRepresentations ?? [])
        .flatMap((snapshot) =>
          resourceMembers(snapshot).map((members) => ({
            ...members,
            representation: snapshot.representation,
            ownership: item.ownership,
          })),
        )
        .filter((snapshot) => !groups.some((record) => overlapsData(record, snapshot))),
    ),
  ];
  return splitDataRepresentations(group, records).map((part) => ({
    volumes: part.volumes,
    bindPaths: part.bindPaths,
    representation: part.representation,
    ownership: part.ownership ?? recordedGroupOwnership(inventory, part, root),
  }));
}

function wasImported(
  members: DockerDataMembers,
  inventory: DockerImportInventory | null,
  root: string,
): boolean {
  return Boolean(
    inventory?.groups?.some((record) => overlapsData(record, members)) ||
      inventory?.items.some(
        (item) =>
          overlapsData(members, itemData(item, root)) ||
          item.dataRepresentations?.some((record) => overlapsData(record, members)),
      ),
  );
}

function unknownFollowsData(
  parts: DockerCopyBackDataGroup[],
  inventory: DockerImportInventory | null,
): boolean {
  const records = [
    ...(inventory?.groups ?? []),
    ...(inventory?.items ?? []).flatMap((item) => item.dataRepresentations ?? []),
  ];
  return parts.some(
    (part) =>
      !part.representation &&
      (part.ownership?.class === 'follows-user' ||
        records.some(
          (record) => record.representation?.kind === 'mapped' && overlapsData(record, part),
        )),
  );
}

interface Mounted {
  mounts: Array<{ type: string; name?: string; source?: string }>;
  labels: Record<string, string>;
}
/** Archive helpers are DevChain's own, never started, and not writers. */
function holds(container: Mounted, members: DockerDataMembers): boolean {
  return (
    !container.labels[DOCKER_ARCHIVE_HELPER_LABEL] &&
    overlapsData(mountedData(container.mounts), members)
  );
}

interface HomeContainer {
  Id: string;
  Names?: string[];
  State?: string;
  Labels?: Record<string, string>;
  Mounts?: Array<{ Type: string; Name?: string; Source?: string }>;
}
const homeName = (c: HomeContainer) => c.Names?.[0]?.replace(/^\//, '') ?? c.Id;
const homeMounted = (c: HomeContainer): Mounted => ({
  labels: c.Labels ?? {},
  mounts: (c.Mounts ?? []).map((m) => ({ type: m.Type, name: m.Name, source: m.Source })),
});

/** Newly resolved VM binds that the file-sync exclusions do not cover yet. */
function blockedBinds(
  group: Pick<DockerCopyBackGroup, 'createdOnVm' | 'bindPaths' | 'dataRepresentations'>,
  confirmed: string[],
): string[] {
  const created = group.createdOnVm
    ? group.bindPaths
    : (group.dataRepresentations ?? [])
        .filter((part) => part.createdOnVm)
        .flatMap((part) => part.bindPaths);
  return created.filter((path) => !confirmed.includes(path));
}

/** What a kept group is recorded as: its imported snapshots, else the group itself. */
function keptParts(group: DockerCopyBackGroup): DockerCopyBackDataGroup[] {
  if (!group.createdOnVm && group.dataRepresentations?.length) return group.dataRepresentations;
  return [{ volumes: group.volumes, bindPaths: group.bindPaths, ownership: group.ownership }];
}

/** The `dockerCopyBackSkipped` detail: every bind path that file sync still carries. */
function skippedProgress(record: DockerCopyBackRecord) {
  return Object.values(record.fileSyncSkipped ?? {})
    .flat()
    .map((path) => ({ path, reason: FILE_SYNC_SKIP_REASON }));
}

/**
 * Disconnect's optional copy of Docker data back to this PC, per data group:
 * vm-newer groups are copied, both-changed and unknown ones follow the user's
 * choice, the rest stay. Every writer stops first; home containers stay stopped.
 * Nothing on the VM changes except stopped containers, and no home volume or
 * container is deleted.
 */
@Injectable()
export class DockerCopyBack {
  private readonly active = new Map<string, AbortController>();

  constructor(
    private readonly plans: DockerPlanService,
    private readonly source: DockerPlanSourceService,
    private readonly host: RemoteHostClient,
    private readonly store: DockerHandoffStore,
    private readonly journal: DockerArchiveJournal,
    private readonly inventory: DockerImportInventoryStore,
    @Inject(REMOTE_HEALTH_PORT) private readonly health: RemoteHealthPort,
    private readonly exclusions: DockerCopyBackExclusions,
  ) {}

  /** The change check of the data a Connect imported; reads metadata only. */
  async syncState(
    projectId: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<DockerSyncState> {
    const { remoteId } = DockerSyncStateRequestSchema.parse(input);
    const inventory = this.inventory.get(projectId, remoteId);
    const imported = Boolean(inventory);
    const health = this.health.getState(remoteId);
    let unavailable: DockerSyncState['availability']['reason'] = null;
    if (!health.online) {
      unavailable = { code: 'remote-unreachable', message: 'The VM is unavailable.' };
    } else if (health.apiKeyRejected) {
      unavailable = { code: 'remote-unreachable', message: HOST_API_KEY_REJECTED_MESSAGE };
    } else if (!health.versionMatches) {
      unavailable = {
        code: 'remote-version-mismatch',
        message: `The VM runs version ${health.version ?? 'unknown'}, which differs from this PC.`,
      };
    }
    if (unavailable)
      return {
        availability: { available: false, side: 'remote', reason: unavailable },
        imported,
        groups: [],
      };
    const root = await this.plans.projectRoot(projectId);
    const plan = await this.plans.plan(projectId, { remoteId }, signal, {
      estimate: false,
      dataBindPaths: inventoryBindPaths(inventory, root),
    });
    if (!plan.availability.available)
      return { availability: plan.availability, imported, groups: [] };
    const groups = await this.candidates(projectId, remoteId, plan, inventory, root, signal);
    const targets = groups.flatMap((group) => blockedBinds(group, []));
    const confirmed = await this.exclusions.preview(projectId, remoteId, root, targets, signal);
    return {
      availability:
        !inventory && !groups.length
          ? {
              available: false,
              side: null,
              reason: {
                code: 'not-imported',
                message: 'No Docker data of this project is on the VM.',
              },
            }
          : plan.availability,
      imported,
      groups: groups.map((group) => {
        const syncedByFileSync = blockedBinds(group, confirmed);
        return {
          key: group.key,
          itemNames: group.itemNames,
          volumes: group.volumes,
          bindPaths: group.bindPaths,
          state: group.state,
          ...(group.dataRepresentations && {
            dataRepresentations: group.dataRepresentations.map((part) => ({
              volumes: part.volumes,
              bindPaths: part.bindPaths,
              ...(part.representation && {
                representation: {
                  kind: part.representation.kind,
                  home: { uid: part.representation.home.uid, gid: part.representation.home.gid },
                  vm: { uid: part.representation.vm.uid, gid: part.representation.vm.gid },
                },
              }),
            })),
          }),
          needsChoice:
            !group.skipReason && !syncedByFileSync.length && NEEDS_CHOICE.has(group.state),
          ...(group.skipReason ? { skipReason: group.skipReason } : {}),
          ...(group.createdOnVm && { createdOnVm: true }),
          ...(syncedByFileSync.length && { syncedByFileSync }),
        };
      }),
    };
  }

  interrupt(operationId: string): void {
    this.active.get(operationId)?.abort();
  }

  /** The labels of groups whose home data was emptied but never verified. */
  async partialGroups(operationId: string): Promise<string[]> {
    const record = await this.store.readCopyBack(operationId);
    if (!record) return [];
    return record.groups
      .filter((g) => record.started.includes(g.key) && !record.verified[g.key])
      .map((g) => g.label);
  }

  async finish(operationId: string): Promise<void> {
    this.active.delete(operationId);
    await this.store.remove(operationId);
  }

  prepareHomeCopy(run: RemoteOperationStepRun): Promise<void> {
    return this.step(run, async (signal) => {
      const record = await this.recordFor(run, signal);
      await this.prepareExclusions(run, record, signal);
    });
  }

  private async recordFor(run: RemoteOperationStepRun, signal: AbortSignal) {
    const previous = await this.store.readCopyBack(run.operation.id);
    if (!previous)
      return this.decide(
        run,
        DockerCopyBackRequestSchema.parse(run.details.dockerCopyBack ?? {}),
        signal,
      );
    const mismatch = vmUserMismatch(
      this.source.uid(),
      this.source.gid(),
      await this.host.remoteRuntime(run.operation.remoteId),
    );
    if (mismatch && hasUnknownUserIds(mismatch))
      throw new DockerCopyBackError(
        dockerCopyBackMismatchMessage(mismatch),
        'DOCKER_COPY_BACK_UNAVAILABLE',
        409,
      );
    const projectId = requireProjectId(run.operation);
    const inventory = this.inventory.get(projectId, run.operation.remoteId);
    const root = await this.plans.projectRoot(projectId);
    for (const group of previous.groups) {
      const ownership = group.ownership ?? recordedGroupOwnership(inventory, group, root);
      group.dataRepresentations ??= recordedCopyBackData(
        inventory,
        { ...group, itemIds: [] },
        root,
      ).map((part) => ({
        ...part,
        ownership: part.ownership ?? (!part.representation ? ownership : undefined),
      }));
      if (unknownFollowsData(group.dataRepresentations, inventory)) {
        group.ownership = ownership;
        group.skipReason = FOLLOWS_USER_SKIP_REASON;
        group.action = 'skip';
      }
    }
    await this.store.writeCopyBack(run.operation.id, previous);
    return previous;
  }

  private async prepareExclusions(
    run: RemoteOperationStepRun,
    record: DockerCopyBackRecord,
    signal: AbortSignal,
  ) {
    const projectId = requireProjectId(run.operation);
    const targets = record.groups
      .filter(
        (g) =>
          g.action === 'copy-home' && !record.verified[g.key] && !record.absent.includes(g.key),
      )
      .flatMap((g) => g.bindPaths);
    if (targets.length)
      record.exclusions = await this.exclusions.prepare(
        projectId,
        run.operation.remoteId,
        await this.plans.projectRoot(projectId),
        [...new Set(targets)],
        signal,
      );
    await this.store.writeCopyBack(run.operation.id, record);
  }

  /**
   * Decides once per operation, then copies group by group. A failed group
   * fails the step after the others ran; Retry skips the verified ones. A group
   * whose home data changed after the decision is never emptied: the step
   * refuses with `DOCKER_COPY_BACK_CHOICE_REQUIRED` until a new Disconnect asks.
   */
  copyHome(run: RemoteOperationStepRun): Promise<void> {
    return this.step(run, async (signal) => {
      const projectId = requireProjectId(run.operation);
      const { remoteId } = run.operation;
      const record = await this.recordFor(run, signal);
      // Older operations have no preparation step. Every Retry consumes a fresh attempt.
      if (!record.exclusions?.pending) await this.prepareExclusions(run, record, signal);
      if (record.exclusions) {
        record.exclusions.pending = false;
        await this.store.writeCopyBack(run.operation.id, record);
      }
      const projectRoot = await this.plans.projectRoot(projectId);
      const kept = record.groups.filter((g) => g.action === 'keep-home');
      if (kept.length && !record.keptAt) {
        // The discard acknowledges VM changes up to now, so the VM's project writers stop
        // first; an unrelated holder keeps running and the group may ask again.
        const options: DockerHostOptions = { signal, apiVersion: record.apiVersion };
        for (const group of kept)
          await this.stopVmProjectHolders(
            remoteId,
            projectId,
            await this.scanVm(remoteId, group, options),
            group,
            options,
            projectRoot,
          );
        record.keptAt = new Date().toISOString();
        await this.store.writeCopyBack(run.operation.id, record);
      }
      if (record.keptAt) this.discardVm(projectId, remoteId, kept, record.keptAt);
      for (const verified of Object.values(record.verified))
        this.stamp(projectId, remoteId, verified, verified.at, projectRoot);

      const pending = record.groups.filter(
        (g) =>
          g.action === 'copy-home' && !record.verified[g.key] && !record.absent.includes(g.key),
      );
      if (pending.length) {
        const client = await this.source.connect(signal);
        client.apiVersion = record.apiVersion;
        const options: DockerHostOptions = { signal, apiVersion: record.apiVersion };
        // Every attempt, Retry too: nothing is emptied for a decision home data has outgrown.
        const outgrown: string[] = [];
        const containers = await this.homeContainers(client, signal);
        for (const group of pending) {
          const change = await this.homeChange(client, record, group, containers, signal);
          if (change) outgrown.push(change);
        }
        if (outgrown.length) throw choiceRequired(outgrown);
        const progress = new CopyProgress(run, pending);
        const failures: string[] = [];
        let needsChoice = false;
        for (const group of pending) {
          try {
            await this.copyGroup(run.operation.id, record, group, client, projectId, remoteId, {
              options,
              progress,
              projectRoot,
              run,
              confirmBinds: async (paths) => {
                if (!paths.length) return [];
                const proof = record.exclusions;
                if (!proof) return [];
                const live = await this.exclusions.confirm(
                  projectId,
                  remoteId,
                  projectRoot,
                  paths,
                  proof.revision,
                  signal,
                );
                return live.filter((path) => proof.confirmed.includes(path));
              },
            });
          } catch (error) {
            if (signal.aborted) throw error;
            needsChoice ||= error instanceof AppError && error.code === CHOICE_REQUIRED;
            failures.push(`${group.label}: ${messageOf(error)}`);
          }
        }
        await progress.finish();
        if (needsChoice)
          throw new DockerCopyBackError(
            `Docker data was not copied home. ${failures.join(' ')}`,
            CHOICE_REQUIRED,
            409,
          );
        if (failures.length)
          throw new DockerCopyBackError(
            `Docker data was not copied home. ${failures.join(' ')} Retry copies only what is left.`,
          );
      }
      await run.progress({
        dockerOwnershipSkipped: record.groups
          .filter((group) => group.skipReason)
          .map((group) => ({ label: group.label, reason: group.skipReason })),
        dockerCopyBackSkipped: skippedProgress(record),
        dockerCopyBackResult: {
          copied: record.groups.filter((g) => record.verified[g.key]).map((g) => g.label),
          kept: kept.map((g) => g.label),
          skipped: record.groups
            .filter(
              (g) =>
                g.action === 'skip' ||
                record.absent.includes(g.key) ||
                record.fileSyncSkipped?.[g.key]?.length,
            )
            .map((g) => g.label),
          alreadyTargetEntries: Object.values(record.verified).reduce(
            (sum, verified) => sum + (verified.alreadyTargetEntries ?? 0),
            0,
          ),
        } satisfies DockerCopyBackResult,
      });
    });
  }

  private async decide(
    run: RemoteOperationStepRun,
    request: DockerCopyBackRequest,
    signal: AbortSignal,
  ): Promise<DockerCopyBackRecord> {
    const projectId = requireProjectId(run.operation);
    const { remoteId } = run.operation;
    const record: DockerCopyBackRecord = {
      apiVersion: '',
      groups: [],
      projectContainers: [],
      started: [],
      verified: {},
      absent: [],
      // Before the check: a holder that starts while it runs counts as later.
      decidedAt: new Date().toISOString(),
    };
    const inventory = this.inventory.get(projectId, remoteId);
    const root = await this.plans.projectRoot(projectId);
    const plan = await this.plans.plan(projectId, { remoteId }, signal, {
      estimate: false,
      dataBindPaths: inventoryBindPaths(inventory, root),
    });
    if (plan.availability.reason?.code === 'vm-user-mismatch')
      throw new DockerCopyBackError(
        plan.availability.userMismatch
          ? dockerCopyBackMismatchMessage(plan.availability.userMismatch)
          : plan.availability.reason.message,
        'DOCKER_COPY_BACK_UNAVAILABLE',
        409,
      );
    if (!plan.availability.available || !plan.apiVersion) {
      const reason = plan.availability.reason?.message ?? 'Docker is unavailable.';
      throw new DockerCopyBackError(
        plan.availability.side === 'home'
          ? `Docker on this PC cannot be used: ${reason} Fix it and press Retry, or Cancel.`
          : `The VM's Docker cannot be used: ${reason} Start it and press Retry, or Cancel.`,
        'DOCKER_COPY_BACK_UNAVAILABLE',
      );
    }
    record.apiVersion = plan.apiVersion;
    record.projectContainers = plan.items
      .filter(
        (item) =>
          item.kind === 'container' &&
          (item.linkedReasons.length > 0 || inventory?.items.some((i) => i.name === item.name)),
      )
      .map((item) => item.id);
    const candidates = await this.candidates(projectId, remoteId, plan, inventory, root, signal);
    const confirmed = await this.exclusions.preview(
      projectId,
      remoteId,
      root,
      candidates.flatMap((group) => blockedBinds(group, [])),
      signal,
    );
    record.groups = candidates.map(({ itemNames: _names, ...group }) => {
      const blocked = blockedBinds(group, confirmed);
      if (blocked.length) {
        record.fileSyncSkipped ??= {};
        record.fileSyncSkipped[group.key] = blocked;
      }
      return {
        ...group,
        action:
          group.skipReason || blocked.length
            ? 'skip'
            : copyBackAction(group.state, request.choices[group.key]),
      };
    });
    const unresolved = record.groups.filter(
      (g) =>
        !g.skipReason &&
        NEEDS_CHOICE.has(g.state) &&
        !record.fileSyncSkipped?.[g.key]?.length &&
        !request.choices[g.key],
    );
    if (unresolved.length)
      throw choiceRequired(
        unresolved.map((g) =>
          g.state === 'unknown'
            ? `The changes of ${g.label} cannot be checked.`
            : `${g.label} changed on both this PC and the VM.`,
        ),
      );
    await this.store.writeCopyBack(run.operation.id, record);
    return record;
  }

  private async candidates(
    projectId: string,
    remoteId: string,
    plan: DockerPlan,
    inventory: DockerImportInventory | null,
    root: string,
    signal?: AbortSignal,
  ): Promise<CopyCandidate[]> {
    const imported = inventory ? importedGroups(plan.dataGroups ?? [], inventory, root) : [];
    const candidates: CopyCandidate[] = imported.map((group) => {
      const items = plan.items.filter((i) => group.itemIds.includes(i.id));
      const images = [...new Set(items.flatMap((i) => i.images.map((image) => image.id)))];
      const itemNames = items.map((i) => i.name);
      const ownership = recordedGroupOwnership(inventory, group, root);
      const dataRepresentations = recordedCopyBackData(inventory, group, root);
      return {
        ...(ownership ? { ownership } : {}),
        dataRepresentations,
        ...(unknownFollowsData(dataRepresentations, inventory)
          ? { skipReason: FOLLOWS_USER_SKIP_REASON }
          : {}),
        key: dockerDataGroupKey(group),
        label: itemNames.join(', ') || dockerDataGroupKey(group),
        itemNames,
        state: group.state,
        volumes: group.volumes,
        bindPaths: group.bindPaths,
        images,
        vmImages: images.map(
          (id) =>
            inventory?.items.find((item) => item.imageId === id && item.vmImageId)?.vmImageId ?? id,
        ),
        sizeBytes: groupSize(items, group),
      };
    });
    const options = { signal, apiVersion: plan.apiVersion! };
    // The discovery scan is separate from the bounded per-group metadata/existence scans.
    const vm = await this.host.dockerScan(remoteId, [], options);
    const items: Array<Pick<DockerPlanItem, 'id' | 'mounts' | 'temporary'>> = [];
    const overlapsImported = (members: DockerDataMembers) =>
      imported.some((g) => overlapsData(g, members));
    for (const container of vm.containers) {
      if (!projectContainer(container, root, projectId, vm.volumes)) continue;
      const mounts: DockerPlanMount[] = [];
      for (const mount of container.mounts) {
        if (mount.type === 'volume' && mount.name) {
          const volume = vm.volumes.find((v) => v.name === mount.name);
          if (
            volume &&
            projectVolume(volume.labels, vm.containers, root, projectId, vm.volumes) &&
            !overlapsImported({ volumes: [volume.name], bindPaths: [] })
          )
            mounts.push({
              kind: 'named-volume',
              source: volume.name,
              destination: mount.destination,
              readOnly: false,
              size: unknownSize(),
            });
          continue;
        }
        const source = mount.source;
        if (
          mount.type !== 'bind' ||
          !source ||
          source === root ||
          !within(root, source) ||
          overlapsImported({ volumes: [], bindPaths: [source] })
        )
          continue;
        const kind = await this.source.bindKind(root, source, false, [], signal);
        if (kind === 'project-bind')
          mounts.push({
            kind,
            source,
            destination: mount.destination,
            readOnly: false,
            size: unknownSize(),
          });
      }
      items.push({ id: container.id, mounts, temporary: false });
    }
    const groups = groupDockerData(items, root);
    const identities = await this.knownIdentities(remoteId);
    const context = identities && userIdsDiffer(identities) ? identities : undefined;
    for (const candidate of candidates) {
      if (identities)
        await this.resolveImportedNewData(
          candidate,
          vm,
          projectId,
          root,
          inventory,
          identities,
          signal,
        );
      const refusal = await this.mappedOwnershipRefusal(
        candidate,
        candidate,
        vm,
        projectId,
        root,
        inventory,
        signal,
        identities,
      );
      if (refusal) candidate.skipReason ??= refusal;
    }
    if (!groups.length) return candidates;
    const consumers = context
      ? await this.vmOwnershipConsumers(vm, projectId, root, context, signal)
      : [];
    const client = await this.source.connect(signal);
    client.apiVersion = plan.apiVersion!;
    const containers = await this.homeContainers(client, signal);
    const holders = await Promise.all(
      containers.map(async (container) => {
        const inspect = await optionalDockerJson<DockerInspectTimes>(
          client,
          `/containers/${encodeURIComponent(container.Id)}/json`,
          signal,
        );
        return {
          ...mountedData(homeMounted(container).mounts),
          metadata: inspect
            ? {
                created: inspect.Created,
                startedAt: inspect.State?.StartedAt,
                running: inspect.State?.Running,
              }
            : undefined,
        };
      }),
    );
    for (const group of groups) {
      const scanned = await this.scanVm(remoteId, group, options);
      const members = presentOnVm(group, scanned, projectId, root);
      if (!members.volumes.length && !members.bindPaths.length) continue;
      const check = checkDockerDataGroup(
        { ...members, itemIds: group.itemIds },
        inventory?.groups ?? [],
        holders,
        scanned,
        projectId,
        root,
      );
      const hasHomeData = await this.hasHomeData(client, members, signal);
      const state =
        check.state === 'unknown' ? (hasHomeData ? 'unknown' : 'vm-newer') : check.state;
      const held = vm.containers.filter((c) => group.itemIds.includes(c.id));
      if (context) applyDockerGroupOwnership([check], [], consumers, context);
      const dataRepresentations = splitDataRepresentations(check).map((part) => ({
        volumes: part.volumes,
        bindPaths: part.bindPaths,
        representation: part.representation,
        ownership: ownershipRecord(part.ownership),
      }));
      const itemNames = held.map((c) => c.name);
      const images = [...new Set(held.flatMap((c) => (c.image ? [c.image] : [])))];
      candidates.push({
        dataRepresentations,
        ...(check.ownership ? { ownership: ownershipRecord(check.ownership) } : {}),
        ...(check.ownership?.refusalReasons?.length
          ? { skipReason: check.ownership.refusalReasons.map((reason) => reason.message).join(' ') }
          : {}),
        key: dockerDataGroupKey(members),
        label: itemNames.join(', ') || dockerDataGroupKey(members),
        itemNames,
        ...members,
        state,
        images,
        vmImages: images,
        imageReferences: [
          ...new Set(held.flatMap((c) => (c.imageReference ? [c.imageReference] : []))),
        ],
        createdOnVm: true,
        sizeBytes: 0,
      });
    }
    return candidates;
  }

  /** Both machines' process ids, or undefined while either is unknown. */
  private async knownIdentities(remoteId: string): Promise<DockerOwnershipContext | undefined> {
    const runtime = await this.host.remoteRuntime(remoteId);
    const uid = this.source.uid();
    const gid = this.source.gid();
    if (uid === null || gid === null || runtime.uid == null || runtime.gid == null)
      return undefined;
    return { home: { uid, gid }, vm: { uid: runtime.uid, gid: runtime.gid } };
  }

  private async resolveImportedNewData(
    group: CopyCandidate,
    vm: DockerScanResult,
    projectId: string,
    root: string,
    inventory: DockerImportInventory | null,
    context: DockerOwnershipContext,
    signal?: AbortSignal,
  ): Promise<void> {
    const fresh = resourceMembers(group).filter(
      (members) => !wasImported(members, inventory, root),
    );
    if (!fresh.length) return;
    const consumers = await this.vmOwnershipConsumers(
      vm,
      projectId,
      root,
      context,
      signal,
      inventory,
      true,
    );
    const freshMembers = {
      volumes: fresh.flatMap((members) => members.volumes),
      bindPaths: fresh.flatMap((members) => members.bindPaths),
    };
    group.dataRepresentations = (group.dataRepresentations ?? [])
      .map((part) => ({
        ...part,
        volumes: part.volumes.filter((volume) => !freshMembers.volumes.includes(volume)),
        bindPaths: part.bindPaths.filter((path) => !freshMembers.bindPaths.includes(path)),
      }))
      .filter((part) => part.volumes.length || part.bindPaths.length);
    for (const members of fresh) {
      const checked: DockerDataGroupCheck = { ...members, itemIds: [], state: group.state };
      applyDockerGroupOwnership([checked], [], consumers, context);
      group.dataRepresentations.push({
        ...members,
        representation: desiredDataRepresentation(checked),
        ownership: ownershipRecord(checked.ownership),
        createdOnVm: true,
      });
      if (checked.ownership?.refusalReasons?.length)
        group.skipReason ??= checked.ownership.refusalReasons
          .map((reason) => reason.message)
          .join(' ');
    }
  }

  private async vmOwnershipConsumers(
    vm: DockerScanResult,
    projectId: string,
    root: string,
    context: DockerOwnershipContext,
    signal?: AbortSignal,
    recorded?: DockerImportInventory | null,
    requireCurrentCompose = false,
  ): Promise<DockerOwnershipConsumer[]> {
    const ownershipOnVm = new Map<string, DockerOwnershipDecision>();
    const literalHomeOnVm = new Set<string>();
    const recordedFollower = (
      container: DockerScanResult['containers'][number],
    ): DockerOwnershipDecision | undefined => {
      if (!projectContainer(container, root, projectId, vm.volumes)) return undefined;
      const item = recorded?.items.find(
        (item) =>
          item.name === container.name.replace(/^\//, '') &&
          (item.vmImageId ?? item.imageId) === container.image,
      );
      const ownership = item?.ownership;
      if (
        ownership?.class !== 'follows-user' ||
        ownership.home.uid !== context.home.uid ||
        ownership.home.gid !== context.home.gid ||
        ownership.vm.uid !== context.vm.uid ||
        ownership.vm.gid !== context.vm.gid
      )
        return undefined;
      const user = container.user;
      const gid = user?.split(':')[1];
      const compatible =
        ownership.targetUser !== undefined
          ? user === ownership.targetUser
          : dockerNumericUid(user) === ownership.vm.uid &&
            (gid === undefined || gid === String(ownership.vm.gid));
      return compatible ? { ...context, class: 'follows-user' } : undefined;
    };
    const resolved = new Map<string, Promise<{ homeUser?: string; vmUser?: string } | null>>();
    for (const container of vm.containers) {
      const service = container.labels['com.docker.compose.service'];
      const directory = container.labels['com.docker.compose.project.working_dir'] || root;
      if (!service || !projectContainer(container, root, projectId, vm.volumes)) continue;
      const files = container.labels['com.docker.compose.project.config_files']
        ?.split(',')
        .filter(Boolean);
      const key = JSON.stringify([directory, files, service]);
      if (!resolved.has(key))
        resolved.set(
          key,
          (async () => {
            try {
              const [home, target] = await Promise.all(
                [context.home, context.vm].map((ids) =>
                  this.source.compose(directory, {
                    files,
                    allProfiles: true,
                    signal,
                    env: { DEVCHAIN_UID: String(ids.uid), DEVCHAIN_GID: String(ids.gid) },
                  }),
                ),
              );
              if (!home || !target || !home.services?.[service] || !target.services?.[service])
                return null;
              return {
                homeUser: home.services[service].user,
                vmUser: target.services[service].user,
              };
            } catch (error) {
              if (signal?.aborted) throw error;
              return null;
            }
          })(),
        );
      const users = await resolved.get(key);
      const retained = !users && !requireCurrentCompose ? recordedFollower(container) : undefined;
      const ownership =
        retained ??
        classifyDockerOwnership(
          context,
          container.user,
          undefined,
          false,
          users ? { source: { directory, files: files ?? [], service }, ...users } : undefined,
          true,
        );
      if (
        (recorded !== undefined || requireCurrentCompose) &&
        users &&
        ownership.class === 'follows-user' &&
        container.user !== users.vmUser
      ) {
        ownership.class = 'exact';
        delete ownership.target;
      }
      const exactAllowed = exactUidAllowed(dockerNumericUid(container.user), context);
      if (
        !users &&
        !retained &&
        !(recorded !== undefined && !requireCurrentCompose && exactAllowed)
      )
        ownership.refusalReasons = [
          {
            code: 'ownership-resolution-failed',
            message: `${container.name}: Cannot resolve the VM Compose data ownership with both home and VM user ids. Verify the Compose configuration before copying this data home.`,
          },
        ];
      else if (
        users &&
        (recorded === undefined || container.user === users.vmUser) &&
        literalHomeComposeUser(context, users.homeUser, users.vmUser)
      )
        literalHomeOnVm.add(container.id);
      ownershipOnVm.set(container.id, ownership);
    }
    return vm.containers
      .filter((container) => !container.labels[DOCKER_ARCHIVE_HELPER_LABEL])
      .map((container) => ({
        ...mountedData(container.mounts),
        name: container.name,
        user: container.user,
        ownership:
          ownershipOnVm.get(container.id) ??
          recordedFollower(container) ??
          classifyDockerOwnership(context, container.user, undefined, false, undefined, true),
        literalHomeUser: literalHomeOnVm.has(container.id),
      }));
  }

  private async hasHomeData(
    client: DockerEngineClient,
    members: DockerDataMembers,
    signal?: AbortSignal,
  ): Promise<boolean> {
    for (const name of members.volumes)
      if (await optionalDockerJson(client, `/volumes/${encodeURIComponent(name)}`, signal))
        return true;
    for (const path of members.bindPaths) {
      signal?.throwIfAborted();
      try {
        const stats = await lstat(path);
        if (!stats.isDirectory() || (await readdir(path)).length) return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true;
      }
    }
    return false;
  }

  private async mappedOwnershipRefusal(
    group: Pick<DockerCopyBackGroup, 'dataRepresentations' | 'createdOnVm' | 'label' | 'state'>,
    members: DockerDataMembers,
    vm: DockerScanResult,
    projectId: string,
    root: string,
    inventory: DockerImportInventory | null | undefined,
    signal?: AbortSignal,
    currentContext?: DockerOwnershipContext,
  ): Promise<string | undefined> {
    for (const part of group.dataRepresentations ?? []) {
      const representation = part.representation;
      if (!representation || (representation.kind !== 'mapped' && !part.createdOnVm)) continue;
      const context = part.createdOnVm ? (currentContext ?? representation) : representation;
      const mapped = {
        volumes: members.volumes.filter((volume) => part.volumes.includes(volume)),
        bindPaths: members.bindPaths.filter((path) =>
          overlapsData(part, { volumes: [], bindPaths: [path] }),
        ),
      };
      if (!mapped.volumes.length && !mapped.bindPaths.length) continue;
      const checked: DockerDataGroupCheck = { ...mapped, itemIds: [], state: group.state };
      const consumers = await this.vmOwnershipConsumers(
        vm,
        projectId,
        root,
        context,
        signal,
        inventory,
        part.createdOnVm,
      );
      // Imported data keeps its recorded mapping even when no live consumer follows the user.
      if (!group.createdOnVm && !part.createdOnVm)
        consumers.push({
          ...mapped,
          name: group.label,
          ownership: { ...representation, class: 'follows-user' },
        });
      applyDockerGroupOwnership([checked], [], consumers, context);
      if (checked.ownership?.refusalReasons?.length)
        return checked.ownership.refusalReasons.map((reason) => reason.message).join(' ');
      if (
        (group.createdOnVm || part.createdOnVm) &&
        resourceMembers(mapped).some(
          (resource) =>
            !sameDataRepresentation(desiredDataRepresentation(checked, resource), representation),
        )
      )
        return `${[...mapped.volumes, ...mapped.bindPaths].join(', ')}: The current VM consumers require a different owner representation. Start Disconnect again after verifying their user ids and Compose configuration.`;
    }
  }

  private async checkMappedOwnership(
    group: DockerCopyBackGroup,
    members: DockerDataMembers,
    vm: DockerScanResult,
    projectId: string,
    root: string,
    remoteId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    let currentContext: DockerOwnershipContext | undefined;
    if (group.dataRepresentations?.some((part) => part.createdOnVm)) {
      currentContext = await this.knownIdentities(remoteId);
      if (!currentContext)
        throw new DockerCopyBackError(
          'The current home and VM user ids cannot be verified before copying new Docker data.',
          'DOCKER_COPY_BACK_OWNERSHIP_CHANGED',
          409,
        );
    }
    const refusal = await this.mappedOwnershipRefusal(
      group,
      members,
      vm,
      projectId,
      root,
      group.createdOnVm ? undefined : this.inventory.get(projectId, remoteId),
      signal,
      currentContext,
    );
    if (refusal) throw new DockerCopyBackError(refusal, 'DOCKER_COPY_BACK_OWNERSHIP_CHANGED', 409);
  }

  private async copyGroup(
    operationId: string,
    record: DockerCopyBackRecord,
    group: DockerCopyBackGroup,
    client: DockerEngineClient,
    projectId: string,
    remoteId: string,
    context: CopyContext,
  ): Promise<void> {
    const { options, projectRoot } = context;
    const vm = await this.scanVm(remoteId, group, options);
    const members = presentOnVm(group, vm, projectId, projectRoot);
    if (!members.volumes.length && !members.bindPaths.length) {
      record.absent.push(group.key);
      await this.store.writeCopyBack(operationId, record);
      return;
    }
    // True when file sync still carries a bind folder: the group is skipped, not copied.
    const skippedAsSynced = async (): Promise<boolean> => {
      const confirmed = await context.confirmBinds(members.bindPaths);
      const blocked = members.bindPaths.filter((path) => !confirmed.includes(path));
      if (!blocked.length) return false;
      await this.skipSyncedBinds(context.run, record, group, blocked);
      return true;
    };
    if (await skippedAsSynced()) return;
    if (record.fileSyncSkipped) delete record.fileSyncSkipped[group.key];
    await this.checkMappedOwnership(
      group,
      members,
      vm,
      projectId,
      projectRoot,
      remoteId,
      options.signal,
    );
    const images = await this.helperImages(client, remoteId, group, vm, options);
    const missingVolumes: string[] = [];
    for (const volume of members.volumes) {
      const home = await optionalDockerJson<{ Labels?: Record<string, string> }>(
        client,
        `/volumes/${encodeURIComponent(volume)}`,
        options.signal,
      );
      if (!home) missingVolumes.push(volume);
      else if (foreignProjectOwner(home.Labels, projectId))
        throw new DockerCopyBackError(
          `Volume ${volume} on this PC belongs to another project.`,
          'DOCKER_UNRELATED_HOLDER',
        );
    }

    // Every refusal comes before anything stops.
    const vmHolders = vm.containers.filter((c) => holds(c, members));
    // A stopped unrelated holder writes nothing and is never stopped by DevChain; the
    // check after the stops refuses it if it runs again.
    const unrelated = vmHolders.filter(
      (c) =>
        !projectContainer(c, projectRoot, projectId, vm.volumes) && c.metadata?.running !== false,
    );
    if (unrelated.length)
      throw new DockerCopyBackError(
        `Running VM containers that are not part of this project use its data: ${unrelated.map((c) => c.name).join(', ')}. Stop them on the VM and press Retry, or Cancel.`,
        'DOCKER_UNRELATED_HOLDER',
      );
    const homeHolders = (await this.homeContainers(client, options.signal)).filter((c) =>
      holds(homeMounted(c), members),
    );
    const homeRunning = homeHolders.filter((c) => RUNNING_STATES.has(c.State ?? ''));
    const homeUnrelated = homeRunning.filter(
      (c) => foreignProjectOwner(c.Labels, projectId) || !record.projectContainers.includes(c.Id),
    );
    if (homeUnrelated.length)
      throw new DockerCopyBackError(
        `Running containers on this PC that are not part of this project use its data: ${homeUnrelated.map(homeName).join(', ')}. Stop them and press Retry, or Cancel.`,
        'DOCKER_UNRELATED_HOLDER',
      );
    await this.stopVmProjectHolders(remoteId, projectId, vm, members, options, projectRoot);
    for (const holder of homeRunning)
      await changeDockerContainerState(client, holder.Id, 'stop', options.signal);

    // A restart policy or a user may have started a writer again.
    const [vmAgain, homeAgain] = await Promise.all([
      this.scanVm(remoteId, group, options),
      this.homeContainers(client, options.signal),
    ]);
    const stillRunning = [
      ...vmAgain.containers
        .filter((c) => holds(c, members) && c.metadata?.running !== false)
        .map((c) => `${c.name} (VM)`),
      ...homeAgain
        .filter((c) => holds(homeMounted(c), members) && RUNNING_STATES.has(c.State ?? ''))
        .map((c) => `${homeName(c)} (this PC)`),
    ];
    if (stillRunning.length)
      throw new DockerCopyBackError(
        `Containers that use its data are running again: ${stillRunning.join(', ')}. Stop them and press Retry, or Cancel.`,
      );

    await this.checkMappedOwnership(
      group,
      members,
      vmAgain,
      projectId,
      projectRoot,
      remoteId,
      options.signal,
    );
    const change = await this.homeChange(client, record, group, homeAgain, options.signal);
    if (change) throw choiceRequired([change]);
    if (await skippedAsSynced()) return;
    if (!record.started.includes(group.key)) {
      record.started.push(group.key);
      await this.store.writeCopyBack(operationId, record);
    }
    for (const name of missingVolumes) {
      const volume = vmAgain.volumes.find((v) => v.name === name);
      if (
        !volume ||
        !projectVolume(volume.labels, vmAgain.containers, projectRoot, projectId, vmAgain.volumes)
      )
        throw new DockerCopyBackError(
          `Volume ${name} is no longer held for this project on the VM.`,
        );
      const labels = Object.fromEntries(
        Object.entries(volume.labels).filter(([key]) => KEPT_VOLUME_LABELS.includes(key)),
      );
      await client.json(
        'POST',
        '/volumes/create',
        { Name: name, Labels: labels },
        { signal: options.signal },
      );
    }
    // The VM's answer says which bound paths are single files.
    const files = new Set(vmAgain.paths.filter((p) => 'exists' in p && p.file).map((p) => p.path));
    const sources = [
      ...members.volumes.map((source) => ({ type: 'volume' as const, source })),
      ...members.bindPaths.map((source) => ({
        type: files.has(source) ? ('file' as const) : ('bind' as const),
        source,
      })),
    ];
    context.missingVolumes = missingVolumes;
    let alreadyTargetEntries = 0;
    for (const { type, source } of sources) {
      if (type !== 'volume' && !(await context.confirmBinds([source])).includes(source)) {
        await this.skipSyncedBinds(context.run, record, group, [source]);
        throw new DockerCopyBackError(`${source}: ${FILE_SYNC_SKIP_REASON}.`);
      }
      alreadyTargetEntries += await this.copyOne(
        client,
        remoteId,
        projectId,
        type,
        source,
        images,
        context,
        recordedDataRepresentation(
          type === 'volume'
            ? { volumes: [source], bindPaths: [] }
            : { volumes: [], bindPaths: [source] },
          group.dataRepresentations ?? [],
        ),
      );
    }
    const at = new Date().toISOString();
    const dataRepresentations = (group.dataRepresentations ?? [])
      .map((part) => ({
        ...part,
        volumes: part.volumes.filter((volume) => members.volumes.includes(volume)),
        bindPaths: part.bindPaths.filter((path) => members.bindPaths.includes(path)),
      }))
      .filter((part) => part.volumes.length || part.bindPaths.length);
    record.verified[group.key] = { at, ...members, dataRepresentations, alreadyTargetEntries };
    await this.store.writeCopyBack(operationId, record);
    this.stamp(projectId, remoteId, record.verified[group.key], at, projectRoot);
  }

  private async skipSyncedBinds(
    run: RemoteOperationStepRun,
    record: DockerCopyBackRecord,
    group: DockerCopyBackGroup,
    paths: string[],
  ) {
    // Preserve the data group's baseline when any of its bind members is unsafe.
    record.fileSyncSkipped ??= {};
    record.fileSyncSkipped[group.key] = paths;
    await this.store.writeCopyBack(run.operation.id, record);
    await run.progress({ dockerCopyBackSkipped: skippedProgress(record) });
  }

  /** Stops the VM holders of `members` that belong to the project, Compose-only ones included. */
  private async stopVmProjectHolders(
    remoteId: string,
    projectId: string,
    vm: DockerScanResult,
    members: DockerDataMembers,
    options: DockerHostOptions,
    projectRoot: string,
  ): Promise<void> {
    for (const holder of vm.containers)
      if (
        holds(holder, members) &&
        projectContainer(holder, projectRoot, projectId, vm.volumes) &&
        holder.metadata?.running !== false
      )
        await this.host.dockerStopContainer(remoteId, holder.id, projectId, {
          ...options,
          projectRoot,
        });
  }

  /** Empties the home volume or folder, then restores the VM's archive; the digests must match. */
  private async copyOne(
    client: DockerEngineClient,
    remoteId: string,
    projectId: string,
    type: DockerCopiedSource,
    source: string,
    { vmImage, homeImage }: HelperImages,
    context: CopyContext,
    representation?: DockerDataRepresentation,
  ): Promise<number> {
    const { options, progress, projectRoot } = context;
    const signal = options.signal;
    progress.item(source, type === 'volume' ? 'volume' : 'bind');
    const existed =
      type === 'volume'
        ? !context.missingVolumes?.includes(source)
        : await lstat(source).then(
            () => true,
            (error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT') return false;
              throw error;
            },
          );
    if (type === 'bind') await mkdir(source, { recursive: true });
    // The restore replaces a single file whole, so only its folder must exist.
    if (type === 'file') await mkdir(dirname(source), { recursive: true });
    else if (existed) await this.clear(client, homeImage, type, source, signal);
    const layout = dockerArchiveLayout(type, source);
    const helper = await this.journal.create(client, homeImage, [layout.mount], signal);
    let alreadyTargetEntries = 0;
    try {
      const { archive, sha256 } = await this.host.dockerReadArchive(
        remoteId,
        { projectId, projectRoot, image: vmImage, mountType: type, source },
        options,
      );
      const hash = createHash('sha256');
      const toEngine = new PassThrough();
      const owners =
        representation?.kind === 'mapped'
          ? new DockerArchiveOwnerTransform({ from: representation.vm, to: representation.home })
          : undefined;
      const raw = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          hash.update(chunk);
          progress.add(chunk.length);
          callback(null, chunk);
        },
      });
      // The whole VM stream is read, for the digest and its trailer, even after the
      // engine stopped reading at the tar's end marker.
      const relay = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          if (toEngine.destroyed || toEngine.writableEnded) return callback();
          if (!toEngine.write(chunk)) {
            const settle = () => {
              toEngine.off('drain', settle).off('close', settle);
              callback();
            };
            toEngine.on('drain', settle).on('close', settle);
          } else callback();
        },
        final(callback) {
          if (!toEngine.destroyed) toEngine.end();
          callback();
        },
      });
      const received = pipeline([archive, raw, ...(owners ? [owners] : []), relay], { signal });
      const restored = writeDockerArchive(
        client,
        helper.id,
        toEngine,
        signal,
        layout.writePath,
      ).catch((error: unknown) => {
        archive.destroy();
        throw error;
      });
      try {
        await Promise.all([received, restored]);
        const expected = sha256();
        if (!expected || expected !== hash.digest('hex'))
          throw new DockerCopyBackError(
            `The data of ${source} copied from the VM did not match; press Retry.`,
            'DOCKER_COPY_BACK_DIGEST_MISMATCH',
          );
        alreadyTargetEntries = owners?.result?.alreadyTargetEntries ?? 0;
      } catch (error) {
        toEngine.destroy();
        archive.destroy();
        await Promise.allSettled([received, restored]);
        throw error;
      } finally {
        toEngine.destroy();
      }
    } finally {
      await this.journal.cleanup(client, helper);
    }
    progress.complete();
    return alreadyTargetEntries;
  }

  private async clear(
    client: DockerEngineClient,
    homeImage: string,
    type: 'volume' | 'bind',
    source: string,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.journal.clear(client, homeImage, type, source, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new DockerCopyBackError(
        `${type === 'volume' ? 'Volume' : 'Folder'} ${source} could not be emptied on this PC with image ${homeImage}. Empty it yourself and press Retry, or Cancel.`,
        'DOCKER_COPY_BACK_CLEAR_FAILED',
      );
    }
  }

  /** A group image present on the VM for the read, and one present here for the restore. */
  private async helperImages(
    client: DockerEngineClient,
    remoteId: string,
    group: DockerCopyBackGroup,
    vm: DockerScanResult,
    options: DockerHostOptions,
  ): Promise<HelperImages> {
    // Records written before VM IDs existed carry one list for both engines.
    const vmCandidates = group.vmImages ?? group.images;
    const { ids } = await this.host.dockerImagesPresent(remoteId, vmCandidates, options);
    const vmImage =
      vmCandidates.find((id) => ids.includes(id)) ??
      vm.containers.find((container) => container.image && holds(container, group))?.image;
    if (!vmImage)
      throw new DockerCopyBackError(
        `The VM has none of its images (${vmCandidates.join(', ')}) to read the data.`,
        'DOCKER_COPY_BACK_IMAGE_MISSING',
      );
    for (const id of group.images)
      if (
        await optionalDockerJson(client, `/images/${encodeURIComponent(id)}/json`, options.signal)
      )
        return { vmImage, homeImage: id };
    const references = [
      ...new Set([
        ...(group.imageReferences ?? []),
        ...vm.containers
          .filter((c) => holds(c, group))
          .flatMap((c) => (c.imageReference ? [c.imageReference] : [])),
      ]),
    ];
    for (const reference of references) {
      try {
        let present = await optionalDockerJson<{ Id: string }>(
          client,
          `/images/${encodeURIComponent(reference)}/json`,
          options.signal,
        );
        if (!present) {
          await client.pullImage(reference, options.signal);
          present = await optionalDockerJson<{ Id: string }>(
            client,
            `/images/${encodeURIComponent(reference)}/json`,
            options.signal,
          );
        }
        if (present?.Id) return { vmImage, homeImage: present.Id };
      } catch {
        options.signal?.throwIfAborted();
      }
    }
    throw new DockerCopyBackError(
      `Image ${references[0] ?? group.images[0] ?? 'of this group'} is missing on this PC; the copy needs it to restore the data. Pull or build it and press Retry.`,
      'DOCKER_COPY_BACK_IMAGE_MISSING',
    );
  }

  private scanVm(
    remoteId: string,
    group: DockerDataMembers,
    options: DockerHostOptions,
  ): Promise<DockerScanResult> {
    return pagedDockerScan(group.bindPaths, (paths) =>
      this.host.dockerScan(remoteId, paths, options, group.volumes),
    );
  }

  /**
   * Why home data of `group` may have changed after the decision, or null: a
   * holder on this PC created or started after `decidedAt`, or, for a copy the
   * decision made on its own (vm-newer), a holder running now. The metadata rule
   * is the change check's; missing metadata counts as a change.
   */
  private async homeChange(
    client: DockerEngineClient,
    record: DockerCopyBackRecord,
    group: DockerCopyBackGroup,
    containers: HomeContainer[],
    signal?: AbortSignal,
  ): Promise<string | null> {
    const decided = Date.parse(record.decidedAt);
    const automatic = group.state === 'vm-newer';
    if (
      group.createdOnVm &&
      automatic &&
      !record.started.includes(group.key) &&
      (await this.hasHomeData(client, group, signal))
    )
      return `${group.label} now has data on this PC that the Disconnect did not decide to replace.`;
    for (const holder of containers) {
      if (!holds(homeMounted(holder), group)) continue;
      const inspect = await optionalDockerJson<DockerInspectTimes>(
        client,
        `/containers/${encodeURIComponent(holder.Id)}/json`,
        signal,
      );
      if (!inspect) continue;
      if (usedAfter(inspect.Created, inspect.State?.StartedAt, decided))
        return `${homeName(holder)} on this PC used the data of ${group.label} after the Disconnect decided what to copy.`;
      if (automatic && inspect.State?.Running)
        return `${homeName(holder)} on this PC is running and may be changing the data of ${group.label}.`;
    }
    return null;
  }

  private homeContainers(client: DockerEngineClient, signal?: AbortSignal) {
    return client.json<HomeContainer[]>('GET', '/containers/json?all=true', undefined, { signal });
  }

  /** What a Connect imported, or an empty inventory for the first baseline to land in. */
  private inventoryOrEmpty(projectId: string, remoteId: string, at: string): DockerImportInventory {
    return this.inventory.get(projectId, remoteId) ?? { items: [], importedAt: at };
  }

  /** The copied members get a new 'to-home' baseline; other members keep theirs. */
  private stamp(
    projectId: string,
    remoteId: string,
    members: DockerDataMembers & { dataRepresentations?: DockerCopyBackDataGroup[] },
    at: string,
    root: string,
  ) {
    const inventory = this.inventoryOrEmpty(projectId, remoteId, at);
    const parts = members.dataRepresentations?.length
      ? members.dataRepresentations
      : [
          {
            volumes: members.volumes,
            bindPaths: members.bindPaths,
            ownership: recordedGroupOwnership(inventory, members, root),
            representation: undefined,
          },
        ];
    const groups = supersedeGroupRecords(
      inventory.groups ?? [],
      parts.map(({ createdOnVm: _createdOnVm, ...part }) => ({
        ...part,
        lastSyncedAt: at,
        lastSyncDirection: 'to-home' as const,
      })),
    );
    const items = inventory.items.map((item) => {
      const itemMembers = itemData(item, root);
      const copied = parts
        .map((part) => ({
          volumes: part.volumes.filter((volume) => itemMembers.volumes.includes(volume)),
          bindPaths: part.bindPaths.filter((path) =>
            overlapsData({ volumes: [], bindPaths: [path] }, itemMembers),
          ),
          representation: part.representation,
        }))
        .filter((part) => part.volumes.length || part.bindPaths.length);
      if (!copied.length) return item;
      return {
        ...item,
        dataRepresentations: supersedeGroupRecords(item.dataRepresentations ?? [], copied),
      };
    });
    this.inventory.set(projectId, remoteId, { ...inventory, items, groups });
  }

  /**
   * "Keep home data": a discard record covering exactly the kept group, so VM
   * changes before `at` no longer count for it, and for nothing else. Without a
   * sync record, home counts as changed, and the next Connect copies it.
   */
  private discardVm(
    projectId: string,
    remoteId: string,
    kept: DockerCopyBackGroup[],
    at: string,
  ): void {
    if (!kept.length) return;
    const inventory = this.inventoryOrEmpty(projectId, remoteId, at);
    const groups = (inventory.groups ?? []).filter(
      (record) =>
        !(
          !record.lastSyncedAt &&
          record.vmDiscardedAt === at &&
          kept.some((group) => keptParts(group).some((part) => sameDataGroup(part, record)))
        ),
    );
    for (const group of kept)
      for (const { createdOnVm: _createdOnVm, ...part } of keptParts(group))
        groups.push({ ...part, vmDiscardedAt: at });
    this.inventory.set(projectId, remoteId, { ...inventory, groups });
  }

  private async step(
    run: RemoteOperationStepRun,
    body: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    const controller = new AbortController();
    this.active.set(run.operation.id, controller);
    try {
      await body(controller.signal);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new DockerCopyBackError(messageOf(error));
    } finally {
      if (this.active.get(run.operation.id) === controller) this.active.delete(run.operation.id);
    }
  }
}

type CopyCandidate = Omit<DockerCopyBackGroup, 'action'> & { itemNames: string[] };

interface HelperImages {
  vmImage: string;
  homeImage: string;
}
interface CopyContext {
  missingVolumes?: string[];
  run: RemoteOperationStepRun;
  confirmBinds: (paths: string[]) => Promise<string[]>;
  projectRoot: string;
  options: DockerHostOptions;
  progress: CopyProgress;
}

/** Vm-newer groups copy on their own; both-changed and unknown ones follow the user's choice. */
function copyBackAction(
  state: DockerDataState,
  choice: DockerCopyBackGroup['action'] | undefined,
): DockerCopyBackGroup['action'] {
  if (state === 'vm-newer') return 'copy-home';
  if (NEEDS_CHOICE.has(state) && choice) return choice;
  return 'skip';
}

function groupSize(items: DockerPlanItem[], group: DockerDataMembers): number {
  const sizes = new Map<string, number>();
  for (const mount of items.flatMap((i) => i.mounts)) {
    const volume = isVolumeMount(mount.kind);
    if (volume ? group.volumes.includes(mount.source) : group.bindPaths.includes(mount.source))
      sizes.set(`${volume ? 'v' : 'b'}:${mount.source}`, mount.size.bytes);
  }
  return [...sizes.values()].reduce((sum, bytes) => sum + bytes, 0);
}

/** `details.docker` for the copy home: bytes read from the VM against the planned sizes. */
class CopyProgress {
  private readonly details: DockerTransferDetails;
  constructor(
    private readonly run: RemoteOperationStepRun,
    groups: DockerCopyBackGroup[],
  ) {
    this.details = {
      bytesDone: 0,
      bytesTotal: groups.reduce((sum, g) => sum + g.sizeBytes, 0),
      rateBytesPerSecond: null,
      etaSeconds: null,
      item: null,
      replaced: [],
    };
  }
  item(name: string, phase: 'volume' | 'bind'): void {
    this.details.item = { name, phase };
    this.publish();
  }
  add(bytes: number): void {
    this.details.bytesDone += bytes;
    this.details.bytesTotal = Math.max(this.details.bytesTotal, this.details.bytesDone);
    this.publish();
  }
  complete(): void {
    this.details.item = null;
    this.publish();
  }
  async finish(): Promise<void> {
    this.details.item = null;
    await this.run.progress({ docker: { ...this.details } });
  }
  private publish(): void {
    void this.run.progress({ docker: { ...this.details } });
  }
}
