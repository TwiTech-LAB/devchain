import { dataGroupIdentity, groupDockerData, supersedeGroupRecords } from './docker-data-groups';
import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import { DockerArchiveJournal } from '../../core/controllers/docker-archive-journal';
import { dockerArchiveLayout, readDockerArchive } from '../../core/controllers/docker-archive';
import {
  DockerEngineClient,
  DockerEngineError,
  changeDockerContainerState,
  dockerErrorCode,
  isDockerNotFound,
} from '../../core/controllers/docker-engine.client';
import {
  projectDockerCreate,
  type DockerContainerInspect,
} from '../../core/controllers/docker-settings';
import type { RemoteOperation } from '../../storage/models/domain.models';
import { IGNORE_PATTERNS_MAX } from '../../file-sync/file-sync.dto';
import { FileSyncManagedExclusionsStore } from '../../file-sync/file-sync-managed-exclusions.store';
import {
  DockerImportInventoryStore,
  vmImageCandidates,
  type DockerImportInventory,
} from '../operations/docker-import-inventory.store';
import { RemoteHostClient, RemoteHostRequestError } from '../operations/remote-host.client';
import { RemoteOperationStepRefusedError } from '../operations/remote-operation.errors';
import {
  requireProjectId,
  stepStarted,
  type RemoteOperationStepRun,
} from '../operations/remote-operation.types';
import type { DockerArchiveRequest, DockerHostOptions } from '../host/host-docker.dto';
import {
  copiedDataMounts,
  movesToVm,
  potentialDataMounts,
  uniqueCopiedMounts,
  writerStops,
  keptWriterStops,
} from './docker-plan-fit';
import { projectAnchoredPath, within } from './docker-plan-files';
import {
  isVolumeMount,
  type DockerPlanItem,
  type DockerSelection,
  type DockerTransferDetails,
} from './docker-plan.dto';
import { blocksMode } from './docker-plan-policy';
import { DockerPlanService } from './docker-plan.service';
import { DockerPlanSourceService } from './docker-plan-source.service';
import {
  DockerHandoffStore,
  type DockerCapturedContainer,
  type DockerHandoffBind,
  type DockerHandoffItem,
  type DockerHandoffRecord,
  type DockerHandoffVolume,
} from './docker-handoff.store';

const logger = createLogger('DockerHandoff');

const RATE_WARMUP_MS = 5_000;
const DEFAULT_NETWORKS = new Set(['bridge', 'host', 'none', 'default']);

export function dockerSelection(details: Record<string, unknown>): DockerSelection | null {
  const selection = details.dockerSelection as DockerSelection | undefined;
  return selection?.items?.length ? selection : null;
}

/** Engine and host failures carry cleaned messages; anything else is reduced to a fixed one. */
class DockerHandoffError extends AppError {
  constructor(message: string, code = 'DOCKER_HANDOFF_FAILED') {
    super(message, code, 502);
  }
}
function clean(error: unknown): unknown {
  if (error instanceof AppError) return error;
  if (error instanceof DockerEngineError)
    return new DockerHandoffError(error.message, dockerErrorCode(error.code));
  return new DockerHandoffError('The Docker copy failed.');
}
function notFound(error: unknown): boolean {
  return (
    (error instanceof RemoteHostRequestError &&
      (error.status === 404 || error.details?.hostCode === 'not-found')) ||
    isDockerNotFound(error)
  );
}

/**
 * Connect's Docker steps. Home drives; the VM executes through its own
 * `api/host/docker` routes. Every VM or home change is recorded in the
 * operation's durable record before it happens, so retry and cancel act on
 * the truth after a lost response or a restart.
 */
@Injectable()
export class DockerHandoff {
  private readonly active = new Map<string, AbortController>();
  /**
   * How long Cancel waits: for the whole VM cleanup, for reaching home Docker,
   * and for each home restart. A hung engine or VM must not keep the project
   * frozen; what is left is reported instead. Specs shorten them.
   */
  rollbackLimits = { vmCleanupMs: 10 * 60_000, homeConnectMs: 30_000, homeStartMs: 60_000 };

  constructor(
    private readonly plans: DockerPlanService,
    private readonly source: DockerPlanSourceService,
    private readonly host: RemoteHostClient,
    private readonly store: DockerHandoffStore,
    private readonly journal: DockerArchiveJournal,
    private readonly exclusions: FileSyncManagedExclusionsStore,
    private readonly inventory: DockerImportInventoryStore,
  ) {}

  interrupt(operationId: string): void {
    this.active.get(operationId)?.abort();
  }

  /** Re-scans and refuses before anything is stopped; the manifest is built here, never from the client. */
  preflight(run: RemoteOperationStepRun): Promise<void> {
    return this.step(run, async (signal) => {
      const projectId = requireProjectId(run.operation);
      const selection = dockerSelection(run.details);
      if (!selection) return;
      // Nothing here reads the copy-time estimate, so its probe is skipped.
      const plan = await this.plans.plan(
        projectId,
        { remoteId: run.operation.remoteId, items: selection.items },
        signal,
        { estimate: false },
      );
      if (!plan.availability.available || !plan.apiVersion)
        throw new RemoteOperationStepRefusedError(
          'DOCKER_PLAN_REFUSED',
          plan.availability.reason?.message ?? 'Docker is unavailable.',
          { reason: plan.availability.reason?.code ?? null },
        );
      const selected = plan.items.filter((item) => item.selectedMode);
      if (!plan.canConnect) {
        const reasons = [
          ...plan.filesystems
            .filter((fs) => fs.status === 'refused')
            .map((fs) => `Not enough space on the VM for ${fs.paths.join(', ')}.`),
          ...selected.flatMap((item) =>
            item.blockers
              .filter((b) => blocksMode(item.selectedMode!, b.code))
              .map((b) => `${item.name}: ${b.message}`),
          ),
        ];
        throw new RemoteOperationStepRefusedError(
          'DOCKER_PLAN_REFUSED',
          reasons.join(' ') || 'The Docker import cannot proceed.',
          { fit: plan.fit },
        );
      }
      const record = buildRecord(
        plan.items,
        selected,
        plan.apiVersion,
        await this.plans.projectRoot(projectId),
      );
      const previousRecord = await this.store.read(run.operation.id);
      record.inventoryBefore =
        previousRecord?.inventoryBefore !== undefined
          ? previousRecord.inventoryBefore
          : this.inventory.get(projectId, run.operation.remoteId);
      for (const kept of record.keptInventory ?? []) {
        const prior = record.inventoryBefore?.items.find((item) => item.name === kept.name);
        if (prior?.vmImageId && prior.imageId === kept.imageId) kept.vmImageId = prior.vmImageId;
      }
      // Folders of earlier imports that this Connect does not re-select stay on the VM
      // and must stay out of file sync too.
      const managed = [
        ...new Set([
          ...plan.managedExclusions,
          ...(this.inventory
            .get(projectId, run.operation.remoteId)
            ?.items.flatMap((item) => item.bindPaths) ?? []),
        ]),
      ];
      if (managed.length > IGNORE_PATTERNS_MAX)
        throw new RemoteOperationStepRefusedError(
          'DOCKER_TOO_MANY_DATA_FOLDERS',
          `The Docker data folders need ${managed.length} file-sync exclusions; at most ${IGNORE_PATTERNS_MAX} are supported.`,
          { count: managed.length },
        );
      await this.store.write(run.operation.id, record);
      // Once per operation: a retried preflight must not record its own set as the previous one.
      if (!('managedExclusionsBefore' in run.details))
        await run.progress({ managedExclusionsBefore: this.exclusions.get(projectId) });
      this.exclusions.set(projectId, managed);
      await run.progress({
        docker: {
          bytesDone: 0,
          bytesTotal: record.bytesTotal,
          rateBytesPerSecond: null,
          etaSeconds: null,
          item: null,
          replaced: plan.reconnect?.replacing ?? [],
        } satisfies DockerTransferDetails,
      });
    });
  }

  /** Captures settings, then stops the selected containers and their writer groups. */
  stopHome(run: RemoteOperationStepRun): Promise<void> {
    return this.step(run, async (signal) => {
      const record = await this.requireRecord(run.operation.id);
      const client = await this.homeClient(record, signal);
      const settings = await this.store.readSettings(run.operation.id);
      for (const item of record.items.filter((i) => i.createsContainer)) {
        if (settings[item.id]) continue;
        const inspect = await client.json<DockerContainerInspect & HomeContainer>(
          'GET',
          `/containers/${encodeURIComponent(item.id)}/json`,
          undefined,
          { signal },
        );
        const captured = captureSettings(inspect, item.name, client.socketPath);
        for (const name of networkNames(captured.config))
          if (!record.networks.some((n) => n.name === name))
            record.networks.push(await homeNetwork(client, name, signal));
        settings[item.id] = captured;
      }
      // Settings reach disk before anything stops, so a crash cannot strand a container.
      await this.store.writeSettings(run.operation.id, settings);
      await this.store.write(run.operation.id, record);
      for (const id of record.stopIds) {
        let state: HomeContainer;
        try {
          state = await client.json<HomeContainer>(
            'GET',
            `/containers/${encodeURIComponent(id)}/json`,
            undefined,
            { signal },
          );
        } catch (error) {
          // A stopped `--rm` container is gone; its named volumes remain.
          if (notFound(error)) continue;
          throw error;
        }
        if (!state.State?.Running) continue;
        if (!record.stopped.some((s) => s.id === id)) {
          record.stopped.push({
            id,
            temporary: state.HostConfig?.AutoRemove === true,
            ...(state.Name && { name: state.Name.replace(/^\//, '') }),
          });
          await this.store.write(run.operation.id, record);
        }
        await changeDockerContainerState(client, id, 'stop', signal);
      }
    });
  }

  /** Images the VM lacks, then volumes: each is recorded only once its digest matched. */
  push(run: RemoteOperationStepRun): Promise<void> {
    return this.step(run, async (signal) => {
      const projectId = requireProjectId(run.operation);
      const { remoteId } = run.operation;
      const record = await this.requireRecord(run.operation.id);
      const client = await this.homeClient(record, signal);
      const options: DockerHostOptions = { signal, apiVersion: record.apiVersion };
      const progress = new TransferProgress(run, record);
      await this.journal.reconcile(client, signal);

      const pendingImages = record.images.filter((i) => !record.verified.images.includes(i.id));
      const candidates = new Map(
        pendingImages.map((image) => [
          image.id,
          vmImageCandidates(record.inventoryBefore, image.id),
        ]),
      );
      const present = pendingImages.length
        ? (
            await this.host.dockerImagesPresent(
              remoteId,
              [...new Set([...candidates.values()].flat())],
              options,
            )
          ).ids
        : [];
      for (const image of pendingImages) {
        progress.item(image.id, 'image', image.sizeBytes);
        const vmId = candidates.get(image.id)!.find((id) => present.includes(id));
        if (vmId) image.vmId = vmId;
        else {
          const saved = await saveImage(client, image.id, signal);
          const loaded = await this.host.dockerLoadImage(
            remoteId,
            progress.count(saved.archive),
            options,
          );
          image.vmId = loadedVmId(image.id, saved.layers, loaded.images);
        }
        record.verified.images.push(image.id);
        await this.store.write(run.operation.id, record);
        progress.complete();
      }

      const presentKeptVolumes = record.ensureVolumes?.length
        ? new Set((await this.host.dockerScan(remoteId, [], options)).volumes.map((v) => v.name))
        : new Set<string>();
      for (const name of record.ensureVolumes ?? []) {
        if (!presentKeptVolumes.has(name) && !record.created.volumes.includes(name)) {
          record.created.volumes.push(name);
          await this.store.write(run.operation.id, record);
        }
        // Existing owned volumes are reused; the route refuses ownership conflicts.
        await this.host.dockerCreateVolume(
          remoteId,
          {
            projectId,
            name,
            labels: await homeVolumeLabels(client, name, signal),
          },
          options,
        );
      }
      const existing = record.volumes.some((v) => !restoresData(record, v.name))
        ? new Set((await this.host.dockerScan(remoteId, [], options)).volumes.map((v) => v.name))
        : new Set<string>();
      for (const volume of record.volumes) {
        if (record.verified.volumes.includes(volume.name)) continue;
        const restore = restoresData(record, volume.name);
        progress.item(volume.name, 'volume', restore ? volume.sizeBytes : 0);
        // "Copy without its data" keeps a VM volume an earlier import left.
        if (
          !restore &&
          existing.has(volume.name) &&
          !record.created.volumes.includes(volume.name)
        ) {
          record.verified.volumes.push(volume.name);
          await this.store.write(run.operation.id, record);
          progress.complete();
          continue;
        }
        await this.replaceVolume(run.operation.id, record, projectId, remoteId, volume, options);
        const labels = await homeVolumeLabels(client, volume.name, signal);
        record.created.volumes.push(volume.name);
        await this.store.write(run.operation.id, record);
        await this.host.dockerCreateVolume(
          remoteId,
          { projectId, name: volume.name, labels },
          options,
        );
        if (restore) {
          await this.copy(
            client,
            progress,
            remoteId,
            { projectId, image: volume.helperImage, mountType: 'volume', source: volume.name },
            vmImageId(record, volume.helperImage),
            options,
          );
          (record.copiedData ??= { volumes: [], binds: [] }).volumes.push(volume.name);
        }
        record.verified.volumes.push(volume.name);
        await this.store.write(run.operation.id, record);
        progress.complete();
      }
      await progress.finish();
    });
  }

  /** After the file-sync flip: bind data, networks, then the stopped containers. */
  createHost(run: RemoteOperationStepRun): Promise<void> {
    return this.step(run, async (signal) => {
      const projectId = requireProjectId(run.operation);
      const { remoteId } = run.operation;
      const record = await this.requireRecord(run.operation.id);
      const client = await this.homeClient(record, signal);
      const options: DockerHostOptions = { signal, apiVersion: record.apiVersion };
      const progress = new TransferProgress(run, record);

      for (let offset = 0; offset < (record.ensureBinds?.length ?? 0); offset += 64)
        await this.host.dockerPrepareBinds(
          remoteId,
          {
            projectId,
            paths: record
              .ensureBinds!.slice(offset, offset + 64)
              .map((path) => ({ path, replace: false })),
          },
          options,
        );
      const binds = record.binds.filter((b) => !record.verified.binds.includes(b.path));
      // A bound single file moves as a file, so the VM never puts a folder in its place.
      const files = new Set<string>();
      for (const bind of binds) if (await isFile(bind.path)) files.add(bind.path);
      const fileFlag = (path: string) => (files.has(path) ? { file: true as const } : {});
      const created = binds.filter((b) => !b.replace);
      for (let offset = 0; offset < created.length; offset += 64)
        await this.host.dockerPrepareBinds(
          remoteId,
          {
            projectId,
            paths: created
              .slice(offset, offset + 64)
              .map((b) => ({ path: b.path, replace: false, ...fileFlag(b.path) })),
          },
          options,
        );
      // One request per replaced folder, so a failure names its folder.
      for (const bind of binds.filter((b) => b.replace)) {
        try {
          await this.host.dockerPrepareBinds(
            remoteId,
            {
              projectId,
              paths: [
                {
                  path: bind.path,
                  replace: true,
                  image: vmImageId(record, bind.helperImage),
                  ...fileFlag(bind.path),
                },
              ],
            },
            options,
          );
        } catch (error) {
          if (!(error instanceof RemoteHostRequestError) || error.status !== 422) throw error;
          throw new DockerHandoffError(
            `The VM folder ${bind.path} could not be emptied for the fresh copy. Empty it on the VM (for example, sudo rm -rf ${bind.path}/*) and press Retry, or Cancel.`,
            'DOCKER_BIND_CLEAR_FAILED',
          );
        }
      }
      for (const bind of binds) {
        progress.item(bind.path, 'bind', bind.sizeBytes);
        await this.copy(
          client,
          progress,
          remoteId,
          {
            projectId,
            image: bind.helperImage,
            mountType: files.has(bind.path) ? 'file' : 'bind',
            source: bind.path,
          },
          vmImageId(record, bind.helperImage),
          options,
        );
        (record.copiedData ??= { volumes: [], binds: [] }).binds.push(bind.path);
        record.verified.binds.push(bind.path);
        await this.store.write(run.operation.id, record);
        progress.complete();
      }

      for (const network of record.networks) {
        progress.item(network.name, 'network');
        // An earlier import's network is reused and never counts as this attempt's.
        const { created } = await this.host.dockerCreateNetwork(
          remoteId,
          {
            projectId,
            name: network.name,
            labels: network.labels,
            internal: network.internal,
            attachable: network.attachable,
            options: network.options,
          },
          options,
        );
        if (created && !record.created.networks.includes(network.name)) {
          record.created.networks.push(network.name);
          await this.store.write(run.operation.id, record);
        }
      }

      const settings = await this.store.readSettings(run.operation.id);
      for (const item of record.items.filter((i) => i.createsContainer)) {
        if (record.verified.containers.includes(item.name)) continue;
        const captured = settings[item.id];
        if (!captured)
          throw new DockerHandoffError(`The captured settings of ${item.name} are missing.`);
        progress.item(item.name, 'container');
        // A replaced import, or this attempt's own create whose answer was lost.
        if (item.targetAction === 'replace' || record.created.containers.includes(item.name))
          await this.deleteIfPresent(remoteId, 'containers', item.name, projectId, options);
        record.created.containers.push(item.name);
        await this.store.write(run.operation.id, record);
        await this.host.dockerCreateContainer(
          remoteId,
          {
            projectId,
            name: item.name,
            config: {
              ...captured.config,
              Image: vmImageId(record, String(captured.config.Image)),
            },
          },
          options,
        );
        record.verified.containers.push(item.name);
        await this.store.write(run.operation.id, record);
      }
      await progress.finish();

      // This push's verified pair wins over a carried one: it reflects the VM now.
      const vmPair = (imageId: string, carried?: string) => {
        const vmId = record.images.find((i) => i.id === imageId)?.vmId ?? carried;
        return vmId && vmId !== imageId ? { vmImageId: vmId } : {};
      };
      const imported: DockerImportInventory['items'] = record.items
        .filter(
          (item) =>
            item.targetAction !== 'leave-as-is' &&
            !record.keptInventory?.some((kept) => kept.name === item.name),
        )
        .map((item) => ({
          name: item.name,
          imageId: item.imageIds[0] ?? item.id,
          ...vmPair(item.imageIds[0] ?? item.id),
          volumes: item.volumes.map((name) => ({
            name,
            sizeBytes: record.volumes.find((v) => v.name === name)?.sizeBytes ?? null,
          })),
          // buildRecord never lists the root; home binds outside the project have no anchored path.
          bindPaths: item.binds
            .filter((path) => within(record.projectRoot, path))
            .map((path) => projectAnchoredPath(record.projectRoot, path)),
          sizeBytes: item.sizeBytes,
        }));
      imported.push(
        ...(record.keptInventory ?? []).map(({ vmImageId: carried, ...item }) => ({
          ...item,
          ...vmPair(item.imageId, carried),
        })),
      );
      // An earlier import's item that this Connect did not re-import keeps its VM copy.
      const kept = (this.inventory.get(projectId, remoteId)?.items ?? []).filter(
        (prior) => !imported.some((item) => item.name === prior.name),
      );
      // Persist the timestamp once: a retry must not hide later holder activity.
      record.inventoryStampedAt ??= new Date().toISOString();
      if (record.inventoryBefore === undefined)
        record.inventoryBefore = this.inventory.get(projectId, remoteId);
      await this.store.write(run.operation.id, record);
      const stamped = (record.dataGroups ?? [])
        .filter(
          (group) =>
            !record.keptGroups?.some((kept) =>
              kept.itemIds.some((id) => group.itemIds.includes(id)),
            ) &&
            record.items
              .filter((i) => group.itemIds.includes(i.id))
              .every((i) => i.targetAction !== 'leave-as-is' && i.mode !== 'without-data') &&
            group.volumes.every((v) => record.copiedData?.volumes.includes(v)) &&
            group.bindPaths.every((p) =>
              record.copiedData?.binds.some((copied) => within(copied, p)),
            ),
        )
        .map(({ volumes, bindPaths }) => ({
          volumes,
          bindPaths,
          lastSyncedAt: record.inventoryStampedAt!,
          lastSyncDirection: 'to-vm' as const,
        }));
      const preserved = new Map(
        (record.inventoryBefore?.groups ?? []).map((g) => [dataGroupIdentity(g), g]),
      );
      for (const { volumes, bindPaths } of record.discardedHomeGroups ?? []) {
        const key = dataGroupIdentity({ volumes, bindPaths });
        preserved.set(key, {
          ...preserved.get(key),
          volumes,
          bindPaths,
          homeDiscardedAt: record.inventoryStampedAt,
        });
      }
      this.inventory.set(projectId, remoteId, {
        groups: supersedeGroupRecords([...preserved.values()], stamped),
        importedAt: record.inventoryStampedAt,
        items: [...imported, ...kept],
      });
      const docker = (run.details.docker ?? {}) as DockerTransferDetails;
      await run.progress({
        docker: {
          ...docker,
          item: null,
          result: {
            withoutData: record.items.filter((i) => i.mode === 'without-data').map((i) => i.name),
            dataOnly: record.items.filter((i) => i.mode === 'data-only').map((i) => i.name),
          },
        },
      });
    });
  }

  /** Disconnect: stops the project's DevChain containers on the VM before the final sync. */
  stopHost(run: RemoteOperationStepRun): Promise<void> {
    return this.step(run, async (signal) => {
      const projectId = requireProjectId(run.operation);
      if (!this.inventory.get(projectId, run.operation.remoteId)) return;
      try {
        await this.host.dockerStopProject(run.operation.remoteId, projectId, { signal });
      } catch (error) {
        // An engine that is down runs nothing; it must not block the Disconnect.
        if (!(error instanceof RemoteHostRequestError) || error.status !== 503) throw error;
        run.details.dockerStopSkipped = 'The VM Docker engine is unavailable.';
      }
    });
  }

  /**
   * Cancel: removes only what this attempt created on the VM, then restarts
   * only the home containers it stopped (never `--rm` ones). A replaced VM copy
   * is not recovered. VM failures are reported, not thrown, so home recovers.
   */
  async rollback(
    operation: RemoteOperation,
  ): Promise<{ dockerCleanupError?: string; dockerNotRestarted?: string[] }> {
    const record = await this.store.read(operation.id);
    if (!record) {
      await this.store.remove(operation.id);
      return {};
    }
    const projectId = requireProjectId(operation);
    if (record.inventoryBefore !== undefined) {
      if (record.inventoryBefore)
        this.inventory.set(projectId, operation.remoteId, record.inventoryBefore);
      else this.inventory.delete(projectId, operation.remoteId);
    }
    const cleanupSignal = AbortSignal.timeout(this.rollbackLimits.vmCleanupMs);
    const options: DockerHostOptions = { apiVersion: record.apiVersion, signal: cleanupSignal };
    let cleanupError: string | undefined;
    if (stepStarted(operation, 'docker_push') || stepStarted(operation, 'docker_create_host')) {
      try {
        for (const name of [...record.created.containers].reverse())
          await this.deleteIfPresent(operation.remoteId, 'containers', name, projectId, options);
        for (const name of record.created.networks)
          await this.deleteIfPresent(
            operation.remoteId,
            'networks',
            name,
            projectId,
            options,
          ).catch(
            // A network an earlier import created and still uses stays.
            () => undefined,
          );
        for (const name of record.created.volumes)
          await this.deleteIfPresent(operation.remoteId, 'volumes', name, projectId, options);
      } catch (error) {
        if (cleanupSignal.aborted)
          cleanupError =
            'The VM Docker cleanup did not finish in time. Remove the remaining Docker items of this project on the VM.';
        else
          cleanupError =
            error instanceof AppError ? error.message : 'The VM Docker cleanup failed.';
        logger.warn({ operationId: operation.id }, 'Docker VM cleanup after cancel failed');
      }
    }
    // Best effort: a container that cannot start (port taken, bind source gone) or an
    // unreachable engine must not keep the Cancel from giving the project back.
    const notRestarted: string[] = [];
    const restart = record.stopped.filter((s) => !s.temporary);
    if (restart.length) {
      // A hung home engine gives up here; the containers left are named in the result.
      const client = await this.homeClient(
        record,
        AbortSignal.timeout(this.rollbackLimits.homeConnectMs),
      ).catch(() => null);
      for (const stopped of restart) {
        const started =
          client !== null &&
          (await changeDockerContainerState(
            client,
            stopped.id,
            'start',
            AbortSignal.timeout(this.rollbackLimits.homeStartMs),
          ).then(
            () => true,
            () => false,
          ));
        if (!started) notRestarted.push(stopped.name ?? stopped.id);
      }
      if (notRestarted.length)
        logger.warn(
          { operationId: operation.id, count: notRestarted.length },
          'Home Docker containers were not restarted after cancel',
        );
    }
    await this.store.remove(operation.id);
    return {
      ...(cleanupError && { dockerCleanupError: cleanupError }),
      ...(notRestarted.length > 0 && { dockerNotRestarted: notRestarted }),
    };
  }

  /** Settings never outlive the operation. */
  async finish(operationId: string): Promise<void> {
    this.active.delete(operationId);
    await this.store.remove(operationId);
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
      throw clean(error);
    } finally {
      if (this.active.get(run.operation.id) === controller) this.active.delete(run.operation.id);
    }
  }

  private async requireRecord(operationId: string): Promise<DockerHandoffRecord> {
    const record = await this.store.read(operationId);
    if (!record)
      throw new DockerHandoffError(
        'The Docker import record is missing; cancel and connect again.',
      );
    return record;
  }

  private async homeClient(
    record: DockerHandoffRecord,
    signal?: AbortSignal,
  ): Promise<DockerEngineClient> {
    const client = await this.source.connect(signal);
    client.apiVersion = record.apiVersion;
    return client;
  }

  /**
   * A copied volume is always created fresh: a previous import's copy is
   * deleted with its DevChain or imported-Compose holders, and an attempt's own
   * unverified volume is recreated rather than overlaid.
   */
  private async replaceVolume(
    operationId: string,
    record: DockerHandoffRecord,
    projectId: string,
    remoteId: string,
    volume: DockerHandoffVolume,
    options: DockerHostOptions,
  ): Promise<void> {
    const { holders } = await this.host.dockerVolumeHolders(remoteId, volume.name, options);
    for (const holder of holders) {
      try {
        await this.host.dockerDelete(remoteId, 'containers', holder.id, projectId, options);
      } catch (error) {
        if (notFound(error)) continue;
        if (error instanceof RemoteHostRequestError && error.status === 403)
          throw new RemoteOperationStepRefusedError(
            'DOCKER_UNRELATED_HOLDER',
            `A VM container that is not part of this project holds volume ${volume.name}.`,
          );
        throw error;
      }
    }
    const deleted = await this.deleteIfPresent(
      remoteId,
      'volumes',
      volume.name,
      projectId,
      options,
    );
    if (
      deleted &&
      !record.created.volumes.includes(volume.name) &&
      !record.replaced.includes(volume.name)
    ) {
      record.replaced.push(volume.name);
      await this.store.write(operationId, record);
    }
  }

  private async deleteIfPresent(
    remoteId: string,
    kind: 'volumes' | 'containers' | 'networks',
    name: string,
    projectId: string,
    options: DockerHostOptions,
  ): Promise<boolean> {
    try {
      await this.host.dockerDelete(remoteId, kind, name, projectId, options);
      return true;
    } catch (error) {
      if (!notFound(error)) throw error;
      return false;
    }
  }

  /**
   * Streams one volume or folder from a never-started home helper; the VM's digest
   * must match. `request.image` is the home ID; the VM helper runs `vmImage`.
   */
  private async copy(
    client: DockerEngineClient,
    progress: TransferProgress,
    remoteId: string,
    request: DockerArchiveRequest,
    vmImage: string,
    options: DockerHostOptions,
  ): Promise<void> {
    const layout = dockerArchiveLayout(request.mountType, request.source);
    const helper = await this.journal.create(
      client,
      request.image,
      [{ ...layout.mount, ReadOnly: true }],
      options.signal,
    );
    try {
      const archive = await readDockerArchive(client, helper.id, options.signal, layout.readPath);
      const hash = createHash('sha256');
      const body = progress.count(archive, (chunk) => hash.update(chunk));
      const { sha256 } = await this.host.dockerWriteArchive(
        remoteId,
        { ...request, image: vmImage },
        body,
        options,
      );
      if (sha256 !== hash.digest('hex'))
        throw new DockerHandoffError('The copied data did not match on the VM; retry the copy.');
    } finally {
      await this.journal.cleanup(client, helper);
    }
  }
}

/** Which home containers stop, what moves, and with which helper image; nothing from the client. */
export function buildRecord(
  all: DockerPlanItem[],
  selected: DockerPlanItem[],
  apiVersion: string,
  projectRoot: string,
): DockerHandoffRecord {
  const moving = selected.filter(movesToVm);
  const helperImage = (item: DockerPlanItem): string => {
    const image = item.images[0]?.id ?? moving.flatMap((i) => i.images)[0]?.id;
    if (!image)
      throw new RemoteOperationStepRefusedError(
        'DOCKER_PLAN_REFUSED',
        `${item.name}: no local image is available to copy its data.`,
      );
    return image;
  };
  const copied = new Map(selected.map((item) => [item, copiedDataMounts(item, projectRoot)]));
  const unique = uniqueCopiedMounts(moving, projectRoot);
  const owner = (source: string) =>
    moving.find((i) => copied.get(i)!.some((m) => m.source === source))!;
  const volumes: DockerHandoffVolume[] = unique
    .filter((m) => isVolumeMount(m.kind))
    .map((m) => ({
      name: m.source,
      helperImage: helperImage(owner(m.source)),
      sizeBytes: m.size.bytes,
    }));
  const binds: DockerHandoffBind[] = unique
    .filter((m) => !isVolumeMount(m.kind))
    .map((m) => ({
      path: m.source,
      replace: m.kind === 'project-bind',
      helperImage: helperImage(owner(m.source)),
      sizeBytes: m.size.bytes,
    }));
  // Volumes of "copy without its data" containers are created empty, so the VM never
  // creates an unlabelled volume for them at first start.
  for (const item of moving)
    for (const name of emptyVolumes(item))
      if (!volumes.some((v) => v.name === name))
        volumes.push({ name, helperImage: helperImage(item), sizeBytes: 0 });
  const images = [...new Map(moving.flatMap((i) => i.images).map((i) => [i.id, i])).values()].map(
    (image) => ({ id: image.id, sizeBytes: image.size.bytes }),
  );
  const containerIds = new Set(all.filter((i) => i.kind === 'container').map((i) => i.id));
  const stopIds = new Set<string>();
  for (const item of moving) {
    if (item.kind === 'container') stopIds.add(item.id);
    for (const id of writerStops(item, containerIds, projectRoot)) stopIds.add(id);
    for (const id of keptWriterStops(item, all)) stopIds.add(id);
  }
  const items: DockerHandoffItem[] = selected.map((item) => {
    const mounts = copied.get(item)!;
    return {
      id: item.id,
      name: item.name,
      kind: item.kind,
      mode: item.selectedMode!,
      temporary: item.temporary,
      targetAction: item.targetAction,
      createsContainer:
        item.kind === 'container' &&
        !item.temporary &&
        item.selectedMode !== 'data-only' &&
        item.targetAction !== 'leave-as-is',
      imageIds: item.images.map((i) => i.id),
      volumes: [
        ...new Set([
          ...mounts.filter((m) => isVolumeMount(m.kind)).map((m) => m.source),
          ...emptyVolumes(item),
        ]),
      ],
      binds: mounts.filter((m) => !isVolumeMount(m.kind)).map((m) => m.source),
      sizeBytes: mounts.some((m) => m.size.unknown)
        ? null
        : mounts.reduce((sum, m) => sum + m.size.bytes, 0),
    };
  });
  const dataGroups = groupDockerData(all, projectRoot).filter((g) =>
    g.itemIds.some((id) => selected.some((i) => i.id === id)),
  );
  const keptGroups = dataGroups.filter((g) =>
    selected.some((i) => g.itemIds.includes(i.id) && i.dataAction === 'keep-vm'),
  );
  const keptItems = selected.filter((i) => i.dataAction === 'keep-vm');
  return {
    dataGroups,
    keptGroups,
    discardedHomeGroups: keptGroups.filter((g) =>
      selected.some((i) => g.itemIds.includes(i.id) && i.dataChoice === 'keep-vm'),
    ),
    ensureVolumes: [...new Set(keptItems.flatMap((i) => i.missingData?.volumes ?? []))],
    ensureBinds: [...new Set(keptItems.flatMap((i) => i.missingData?.bindPaths ?? []))],
    keptInventory: keptItems.map((i) => {
      const mounts = potentialDataMounts(i, projectRoot);
      return {
        name: i.name,
        imageId: i.images[0]?.id ?? i.id,
        volumes: mounts
          .filter((m) => isVolumeMount(m.kind))
          .map((m) => ({ name: m.source, sizeBytes: m.size.unknown ? null : m.size.bytes })),
        bindPaths: mounts
          .filter((m) => m.kind === 'project-bind')
          .map((m) => projectAnchoredPath(projectRoot, m.source)),
        sizeBytes: mounts.some((m) => m.size.unknown)
          ? null
          : mounts.reduce((sum, m) => sum + m.size.bytes, 0),
      };
    }),
    copiedData: { volumes: [], binds: [] },
    apiVersion,
    projectRoot,
    items,
    images,
    volumes,
    binds,
    stopIds: [...stopIds],
    stopped: [],
    networks: [],
    verified: { images: [], volumes: [], binds: [], containers: [] },
    created: { volumes: [], networks: [], containers: [] },
    replaced: [],
    bytesTotal: totalBytes(images, volumes, binds),
  };
}
/** Local volumes of a "copy without its data" item: created empty on the VM. */
function emptyVolumes(item: DockerPlanItem): string[] {
  if (item.selectedMode !== 'without-data' || item.dataAction === 'keep-vm') return [];
  return item.mounts
    .filter((m) => isVolumeMount(m.kind) && m.driver === 'local')
    .map((m) => m.source);
}
function totalBytes(...lists: Array<Array<{ sizeBytes: number }>>): number {
  return lists.reduce((sum, list) => sum + list.reduce((s, entry) => s + entry.sizeBytes, 0), 0);
}
function restoresData(record: DockerHandoffRecord, volume: string): boolean {
  return record.items.some((i) => i.mode !== 'without-data' && i.volumes.includes(volume));
}

interface HomeContainer {
  Id?: string;
  Name?: string;
  State?: { Running?: boolean };
  HostConfig?: { AutoRemove?: boolean };
  Mounts?: Array<{ Type: string; Name?: string; Destination: string; RW?: boolean }>;
}

/**
 * The reviewed create projection, plus mount identities: every volume mount
 * gets NoCopy (Docker would otherwise fill an empty volume from the image), and
 * anonymous volumes are mounted by their exact name so Compose reuses them.
 */
export function captureSettings(
  inspect: DockerContainerInspect & HomeContainer,
  name: string,
  socketPath: string,
): DockerCapturedContainer {
  const config = projectDockerCreate(inspect, socketPath);
  const host = config.HostConfig as {
    Binds?: string[];
    Mounts?: Array<Record<string, unknown>>;
  };
  const referenced = new Set<string>();
  if (Array.isArray(host.Binds))
    host.Binds = host.Binds.map((bind) => {
      const [source, target, options] = bind.split(':');
      if (source.startsWith('/') || target === undefined) return bind;
      referenced.add(source);
      const flags = options ? options.split(',') : [];
      return flags.includes('nocopy')
        ? bind
        : `${source}:${target}:${[...flags, 'nocopy'].join(',')}`;
    });
  const mounts = Array.isArray(host.Mounts) ? host.Mounts : [];
  for (const mount of mounts) {
    if (mount.Type !== 'volume') continue;
    if (!mount.Source)
      mount.Source = inspect.Mounts?.find((m) => m.Destination === mount.Target)?.Name ?? '';
    referenced.add(String(mount.Source));
    mount.VolumeOptions = { ...(mount.VolumeOptions as object | undefined), NoCopy: true };
  }
  for (const mount of inspect.Mounts ?? []) {
    if (mount.Type !== 'volume' || !mount.Name || referenced.has(mount.Name)) continue;
    mounts.push({
      Type: 'volume',
      Source: mount.Name,
      Target: mount.Destination,
      ReadOnly: mount.RW === false,
      VolumeOptions: { NoCopy: true },
    });
  }
  if (mounts.length) host.Mounts = mounts;
  return { name, config };
}
function networkNames(config: Record<string, unknown>): string[] {
  const endpoints = (config.NetworkingConfig as { EndpointsConfig?: Record<string, unknown> })
    ?.EndpointsConfig;
  return Object.keys(endpoints ?? {}).filter((name) => !DEFAULT_NETWORKS.has(name));
}
async function homeNetwork(client: DockerEngineClient, name: string, signal: AbortSignal) {
  const network = await client.json<{
    Name: string;
    Driver: string;
    Internal?: boolean;
    Attachable?: boolean;
    Labels?: Record<string, string> | null;
    Options?: Record<string, string> | null;
  }>('GET', `/networks/${encodeURIComponent(name)}`, undefined, { signal });
  if (network.Driver !== 'bridge')
    throw new RemoteOperationStepRefusedError(
      'DOCKER_PLAN_REFUSED',
      `Network ${name} uses the ${network.Driver} driver; only bridge networks move.`,
    );
  return {
    name,
    labels: network.Labels ?? {},
    internal: network.Internal === true,
    attachable: network.Attachable === true,
    options: network.Options ?? {},
  };
}
async function homeVolumeLabels(
  client: DockerEngineClient,
  name: string,
  signal: AbortSignal,
): Promise<Record<string, string>> {
  const volume = await client.json<{ Labels?: Record<string, string> | null }>(
    'GET',
    `/volumes/${encodeURIComponent(name)}`,
    undefined,
    { signal },
  );
  return volume.Labels ?? {};
}
/** Saves under the tags that still name this ID, so Compose finds the image by name on the VM. */
async function saveImage(
  client: DockerEngineClient,
  id: string,
  signal: AbortSignal,
): Promise<{ archive: Readable; layers: string[] }> {
  const image = await client.json<{
    RepoTags?: string[] | null;
    RootFS?: { Layers?: string[] | null };
  }>('GET', `/images/${encodeURIComponent(id)}/json`, undefined, { signal });
  const names = image.RepoTags?.length ? image.RepoTags : [id];
  const query = names.map((n) => `names=${encodeURIComponent(n)}`).join('&');
  return {
    archive: await client.stream('GET', `/images/get?${query}`, { signal }),
    layers: image.RootFS?.Layers ?? [],
  };
}

/**
 * The VM ID of a loaded home image: the reported image with the same layers in
 * the same order. Both image stores keep layer digests, while the image ID of a
 * containerd-store engine is its manifest digest, not the home config digest.
 */
function loadedVmId(
  homeId: string,
  homeLayers: string[],
  reported: Array<{ id: string; layers: string[] }>,
): string {
  const matches = reported.filter(
    (image) =>
      image.layers.length === homeLayers.length &&
      image.layers.every((layer, index) => layer === homeLayers[index]),
  );
  const match = matches.find((image) => image.id === homeId) ?? matches[0];
  if (!match)
    throw new DockerHandoffError(
      `The VM loaded image ${homeId}, but none of the images it reported (${reported.map((i) => i.id).join(', ') || 'none'}) has the same layers. The VM engine can store images under its own IDs. Retry the copy.`,
    );
  return match.id;
}

function isFile(path: string): Promise<boolean> {
  return stat(path).then(
    (stats) => stats.isFile(),
    () => false,
  );
}

/** Every VM-side request names an image by its VM ID; the home ID when none is known. */
function vmImageId(record: DockerHandoffRecord, homeId: string): string {
  return record.images.find((image) => image.id === homeId)?.vmId ?? homeId;
}

/** Bytes, rate and ETA for `details.docker`; the rate appears after five seconds of samples. */
class TransferProgress {
  private readonly startedAt = Date.now();
  private stepBytes = 0;
  private itemStart = 0;
  private itemPlanned = 0;
  private readonly details: DockerTransferDetails;

  constructor(
    private readonly run: RemoteOperationStepRun,
    record: DockerHandoffRecord,
  ) {
    const previous = run.details.docker as DockerTransferDetails | undefined;
    const done = totalBytes(
      record.images.filter((i) => record.verified.images.includes(i.id)),
      record.volumes.filter((v) => record.verified.volumes.includes(v.name)),
      record.binds.filter((b) => record.verified.binds.includes(b.path)),
    );
    this.details = {
      replaced: record.replaced,
      ...previous,
      bytesDone: done,
      bytesTotal: Math.max(record.bytesTotal, done),
      rateBytesPerSecond: null,
      etaSeconds: null,
      item: null,
    };
  }

  /**
   * Planned sizes come from the scan, while streamed archives carry headers:
   * an item's streamed bytes count up to its planned size, and completing it
   * lands exactly there, so the total stays consistent.
   */
  item(
    name: string,
    phase: NonNullable<DockerTransferDetails['item']>['phase'],
    plannedBytes = 0,
  ): void {
    this.details.item = { name, phase };
    this.itemStart = this.details.bytesDone;
    this.itemPlanned = plannedBytes;
    this.publish();
  }
  complete(): void {
    this.details.bytesDone = Math.max(this.details.bytesDone, this.itemStart + this.itemPlanned);
    this.itemPlanned = 0;
    this.itemStart = this.details.bytesDone;
    this.add(0);
  }
  count(source: Readable, observe?: (chunk: Buffer) => void): Readable {
    const counter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        observe?.(chunk);
        this.add(chunk.length);
        callback(null, chunk);
      },
    });
    pipeline(source, counter).catch(() => undefined);
    return counter;
  }
  async finish(): Promise<void> {
    this.details.item = null;
    await this.run.progress({ docker: { ...this.details } });
  }

  private add(bytes: number): void {
    this.stepBytes += bytes;
    const next = this.details.bytesDone + bytes;
    this.details.bytesDone =
      this.itemPlanned > 0 ? Math.min(next, this.itemStart + this.itemPlanned) : next;
    this.details.bytesTotal = Math.max(this.details.bytesTotal, this.details.bytesDone);
    const elapsed = Date.now() - this.startedAt;
    if (elapsed >= RATE_WARMUP_MS && this.stepBytes > 0) {
      const rate = this.stepBytes / (elapsed / 1000);
      this.details.rateBytesPerSecond = Math.round(rate);
      this.details.etaSeconds = Math.ceil(
        Math.max(0, this.details.bytesTotal - this.details.bytesDone) / rate,
      );
    }
    this.publish();
  }
  private publish(): void {
    void this.run.progress({ docker: { ...this.details } });
  }
}
