import { projectCompose } from './docker-project-compose';
import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { AppError } from '../../../common/errors/error-types';
import { DockerArchiveJournal } from '../../core/controllers/docker-archive-journal';
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
  DOCKER_PROJECT_LABEL,
  type DockerHostOptions,
  type DockerInspectTimes,
  type DockerScanResult,
} from '../host/host-docker.dto';
import {
  DockerImportInventoryStore,
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
  type DockerCopyBackRequest,
  type DockerCopyBackResult,
  type DockerSyncState,
} from './docker-copy-back.dto';
import {
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
} from './docker-handoff.store';
import {
  isVolumeMount,
  type DockerDataGroupCheck,
  type DockerDataMembers,
  type DockerDataState,
  type DockerPlanItem,
  type DockerTransferDetails,
} from './docker-plan.dto';
import { DockerPlanService, pagedDockerScan } from './docker-plan.service';
import { DockerPlanSourceService } from './docker-plan-source.service';
import { dockerCopyBackMismatchMessage, vmUserMismatch } from '../vm-user-identity';

const NEEDS_CHOICE: ReadonlySet<DockerDataState> = new Set(['both-changed', 'unknown']);
const RUNNING_STATES = new Set(['running', 'restarting', 'paused']);

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
/** Project-labelled, project-root Compose, or imported-volume Compose holders may stop. */
function projectHolder(
  holder: DockerScanResult['containers'][number],
  vm: DockerScanResult,
  projectId: string,
  projectRoot: string,
): boolean {
  const compose = holder.labels[COMPOSE_PROJECT_LABEL];
  return (
    holder.labels[DOCKER_PROJECT_LABEL] === projectId ||
    projectCompose(holder.labels, projectRoot, projectId) ||
    (holder.labels[DOCKER_PROJECT_LABEL] === undefined &&
      compose !== undefined &&
      vm.volumes.some(
        (v) =>
          v.labels[DOCKER_PROJECT_LABEL] === projectId &&
          v.labels[COMPOSE_PROJECT_LABEL] === compose,
      ))
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
  ) {}

  /** The change check of the data a Connect imported; reads metadata only. */
  async syncState(
    projectId: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<DockerSyncState> {
    const { remoteId } = DockerSyncStateRequestSchema.parse(input);
    const inventory = this.inventory.get(projectId, remoteId);
    if (!inventory)
      return {
        availability: {
          available: false,
          side: null,
          reason: { code: 'not-imported', message: 'No Docker data of this project is on the VM.' },
        },
        imported: false,
        groups: [],
      };
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
        imported: true,
        groups: [],
      };
    const plan = await this.plans.plan(projectId, { remoteId }, signal, {
      estimate: false,
      dataBindPaths: inventory.items.flatMap((item) => item.bindPaths),
    });
    if (!plan.availability.available)
      return { availability: plan.availability, imported: true, groups: [] };
    const root = await this.plans.projectRoot(projectId);
    return {
      availability: plan.availability,
      imported: true,
      groups: importedGroups(plan.dataGroups ?? [], inventory, root).map((group) => ({
        key: dockerDataGroupKey(group),
        itemNames: plan.items.filter((i) => group.itemIds.includes(i.id)).map((i) => i.name),
        volumes: group.volumes,
        bindPaths: group.bindPaths,
        state: group.state,
        needsChoice: NEEDS_CHOICE.has(group.state),
      })),
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
      const request = DockerCopyBackRequestSchema.parse(run.details.dockerCopyBack ?? {});
      const previous = await this.store.readCopyBack(run.operation.id);
      if (previous) {
        const mismatch = vmUserMismatch(
          this.source.uid(),
          this.source.gid(),
          await this.host.remoteRuntime(remoteId),
        );
        if (mismatch)
          throw new DockerCopyBackError(
            dockerCopyBackMismatchMessage(mismatch),
            'DOCKER_COPY_BACK_UNAVAILABLE',
            409,
          );
      }
      const record = previous ?? (await this.decide(run, request, signal));
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
        this.stamp(projectId, remoteId, verified, verified.at);

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
        dockerCopyBackResult: {
          copied: record.groups.filter((g) => record.verified[g.key]).map((g) => g.label),
          kept: kept.map((g) => g.label),
          skipped: record.groups
            .filter((g) => g.action === 'skip' || record.absent.includes(g.key))
            .map((g) => g.label),
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
    if (inventory) {
      const plan = await this.plans.plan(projectId, { remoteId }, signal, {
        estimate: false,
        dataBindPaths: inventory.items.flatMap((item) => item.bindPaths),
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
      const root = await this.plans.projectRoot(projectId);
      record.apiVersion = plan.apiVersion;
      record.projectContainers = plan.items
        .filter(
          (item) =>
            item.kind === 'container' &&
            (item.linkedReasons.length > 0 || inventory.items.some((i) => i.name === item.name)),
        )
        .map((item) => item.id);
      record.groups = importedGroups(plan.dataGroups ?? [], inventory, root).map((group) => {
        const key = dockerDataGroupKey(group);
        const items = plan.items.filter((i) => group.itemIds.includes(i.id));
        const choice = request.choices[key];
        const images = [...new Set(items.flatMap((i) => i.images.map((image) => image.id)))];
        return {
          key,
          label: items.map((i) => i.name).join(', ') || key,
          state: group.state,
          action: copyBackAction(group.state, choice),
          volumes: group.volumes,
          bindPaths: group.bindPaths,
          images,
          // The VM engine's ID for each image, when the import inventory paired
          // one; the home ID itself otherwise, which is also the same-store value.
          vmImages: images.map(
            (id) =>
              inventory.items.find((item) => item.imageId === id && item.vmImageId)?.vmImageId ??
              id,
          ),
          sizeBytes: groupSize(items, group),
        };
      });
      // The dialog's scan may be older than this one; its absent choice is not a decision.
      const unresolved = record.groups.filter(
        (g) => NEEDS_CHOICE.has(g.state) && !request.choices[g.key],
      );
      if (unresolved.length)
        throw choiceRequired(
          unresolved.map((g) =>
            g.state === 'unknown'
              ? `The changes of ${g.label} cannot be checked.`
              : `${g.label} changed on both this PC and the VM.`,
          ),
        );
    }
    await this.store.writeCopyBack(run.operation.id, record);
    return record;
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
    const members = presentOnVm(group, vm, projectId);
    if (!members.volumes.length && !members.bindPaths.length) {
      record.absent.push(group.key);
      await this.store.writeCopyBack(operationId, record);
      return;
    }
    const images = await this.helperImages(client, remoteId, group, vm, options);
    for (const volume of members.volumes)
      if (
        !(await optionalDockerJson(
          client,
          `/volumes/${encodeURIComponent(volume)}`,
          options.signal,
        ))
      )
        throw new DockerCopyBackError(`Volume ${volume} no longer exists on this PC.`);

    // Every refusal comes before anything stops.
    const vmHolders = vm.containers.filter((c) => holds(c, members));
    // A stopped unrelated holder writes nothing and is never stopped by DevChain; the
    // check after the stops refuses it if it runs again.
    const unrelated = vmHolders.filter(
      (c) => !projectHolder(c, vm, projectId, projectRoot) && c.metadata?.running !== false,
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
    const homeUnrelated = homeRunning.filter((c) => !record.projectContainers.includes(c.Id));
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

    const change = await this.homeChange(client, record, group, homeAgain, options.signal);
    if (change) throw choiceRequired([change]);
    if (!record.started.includes(group.key)) {
      record.started.push(group.key);
      await this.store.writeCopyBack(operationId, record);
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
    for (const { type, source } of sources)
      await this.copyOne(client, remoteId, projectId, type, source, images, context);
    const at = new Date().toISOString();
    record.verified[group.key] = { at, ...members };
    await this.store.writeCopyBack(operationId, record);
    this.stamp(projectId, remoteId, members, at);
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
        projectHolder(holder, vm, projectId, projectRoot) &&
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
    { options, progress }: CopyContext,
  ): Promise<void> {
    const signal = options.signal;
    progress.item(source, type === 'volume' ? 'volume' : 'bind');
    if (type === 'bind') await mkdir(source, { recursive: true });
    // The restore replaces a single file whole, so only its folder must exist.
    if (type === 'file') await mkdir(dirname(source), { recursive: true });
    else await this.clear(client, homeImage, type, source, signal);
    const layout = dockerArchiveLayout(type, source);
    const helper = await this.journal.create(client, homeImage, [layout.mount], signal);
    try {
      const { archive, sha256 } = await this.host.dockerReadArchive(
        remoteId,
        { projectId, image: vmImage, mountType: type, source },
        options,
      );
      const hash = createHash('sha256');
      const toEngine = new PassThrough();
      // The whole VM stream is read, for the digest and its trailer, even after the
      // engine stopped reading at the tar's end marker.
      const received = (async () => {
        for await (const chunk of archive as AsyncIterable<Buffer>) {
          hash.update(chunk);
          progress.add(chunk.length);
          if (toEngine.destroyed || toEngine.writableEnded) continue;
          if (!toEngine.write(chunk))
            await new Promise<void>((done) => {
              const settle = () => {
                toEngine.off('drain', settle).off('close', settle);
                done();
              };
              toEngine.on('drain', settle).on('close', settle);
            });
        }
        if (!toEngine.destroyed) toEngine.end();
      })();
      try {
        await Promise.all([
          received,
          writeDockerArchive(client, helper.id, toEngine, signal, layout.writePath).catch(
            (error: unknown) => {
              archive.destroy();
              throw error;
            },
          ),
        ]);
      } catch (error) {
        toEngine.destroy();
        archive.destroy();
        await received.catch(() => undefined);
        throw error;
      }
      const expected = sha256();
      if (!expected || expected !== hash.digest('hex'))
        throw new DockerCopyBackError(
          `The data of ${source} copied from the VM did not match; press Retry.`,
          'DOCKER_COPY_BACK_DIGEST_MISMATCH',
        );
    } finally {
      await this.journal.cleanup(client, helper);
    }
    progress.complete();
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
    if (!group.images.length)
      throw new DockerCopyBackError(
        'No image of it is on this PC to run the copy helper; pull or build one of its images and press Retry.',
        'DOCKER_COPY_BACK_IMAGE_MISSING',
      );
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
    throw new DockerCopyBackError(
      `Image ${group.images[0]} is missing on this PC; the copy needs it to restore the data. Pull or build it and press Retry.`,
      'DOCKER_COPY_BACK_IMAGE_MISSING',
    );
  }

  private scanVm(
    remoteId: string,
    group: DockerCopyBackGroup,
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

  /** The copied members get a new 'to-home' baseline; other members keep theirs. */
  private stamp(projectId: string, remoteId: string, members: DockerDataMembers, at: string) {
    const inventory = this.inventory.get(projectId, remoteId);
    if (!inventory) return;
    const groups = supersedeGroupRecords(inventory.groups ?? [], [
      {
        volumes: members.volumes,
        bindPaths: members.bindPaths,
        lastSyncedAt: at,
        lastSyncDirection: 'to-home',
      },
    ]);
    this.inventory.set(projectId, remoteId, { ...inventory, groups });
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
    const inventory = this.inventory.get(projectId, remoteId);
    if (!inventory) return;
    const groups = (inventory.groups ?? []).filter(
      (record) =>
        !(
          !record.lastSyncedAt &&
          record.vmDiscardedAt === at &&
          kept.some((g) => sameDataGroup(g, record))
        ),
    );
    for (const group of kept)
      groups.push({ volumes: group.volumes, bindPaths: group.bindPaths, vmDiscardedAt: at });
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

interface HelperImages {
  vmImage: string;
  homeImage: string;
}
interface CopyContext {
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
