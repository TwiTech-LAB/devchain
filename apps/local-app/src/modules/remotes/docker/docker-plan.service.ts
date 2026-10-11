import {
  groupDockerData,
  checkDockerDataGroup,
  mountedData,
  overlapsData,
} from './docker-data-groups';
import { applyDockerGroupOwnership, type DockerOwnershipConsumer } from './docker-ownership';
import { projectContainer } from './docker-project-resources';
import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { join, resolve } from 'node:path';
import { AppError } from '../../../common/errors/error-types';
import {
  DockerEngineClient,
  DockerEngineError,
  selectDockerApiVersion,
} from '../../core/controllers/docker-engine.client';
import {
  STORAGE_SERVICE,
  type ProjectStorage,
  type RemoteStorage,
} from '../../storage/interfaces/storage.interface';
import type {
  DockerHostOptions,
  DockerPathCapacity,
  DockerScanResult,
} from '../host/host-docker.dto';
import {
  DockerImportInventoryStore,
  vmImageCandidates,
  inventoryBindPaths,
} from '../operations/docker-import-inventory.store';
import { RemoteHostClient, type HostRuntime } from '../operations/remote-host.client';
import { ConnectChoicesStore } from '../connect-choices.store';
import {
  hasUnknownUserIds,
  vmUserMismatch,
  vmUserWarning,
  type VmUserMismatch,
} from '../vm-user-identity';
import {
  DockerPlanRequestSchema,
  DockerUserFixApplySchema,
  DockerUserFixVerifySchema,
  isVolumeMount,
  type DockerPlan,
  type DockerPresence,
  type DockerOwnershipContext,
  type DockerOwnershipDecision,
  type DockerUserFixProposal,
  type DockerUserFixApplyResult,
} from './docker-plan.dto';
import { composeUserFixProposal, applyComposeUserFix } from './docker-compose-user-fix';
import {
  copiesImages,
  estimateDockerPlan,
  movesToVm,
  planDockerFit,
  potentialDataMounts,
  skipsImageCopy,
  uniqueCopiedMounts,
  writerStops,
  keptWriterStops,
} from './docker-plan-fit';
import { projectAnchoredPath, strictlyWithin, within } from './docker-plan-files';
import {
  applyDockerPolicy,
  applyDockerDataPolicy,
  blocksMode,
  dockerReconnect,
  dockerNetworkPolicy,
  dockerNetworkWarnings,
} from './docker-plan-policy';
import {
  DockerPlanSourceService,
  DockerAvailabilityError,
  reusable,
} from './docker-plan-source.service';

/**
 * A VM scan of any number of paths, 64 per request (the route's limit): later
 * pages add their path results and the holder metadata they found.
 */
export async function pagedDockerScan(
  paths: string[],
  scan: (page: string[], first: boolean) => Promise<DockerScanResult>,
): Promise<DockerScanResult> {
  const result = await scan(paths.slice(0, 64), true);
  for (let offset = 64; offset < paths.length; offset += 64) {
    const more = await scan(paths.slice(offset, offset + 64), false);
    for (const c of more.containers) {
      const original = result.containers.find((entry) => entry.id === c.id);
      if (original && c.metadata) original.metadata = c.metadata;
      if (original && c.user !== undefined) original.user = c.user;
    }
    result.paths.push(...more.paths);
  }
  return result;
}

/** The copy speeds the estimate measured: 16 MB to the VM, and the home image export. */
interface DockerCopySpeeds {
  at: number;
  probeSeconds: number;
  exportRate: number | null;
}
export interface DockerPlanOptions {
  estimate?: boolean;
  reuse?: boolean;
  /** Project-anchored paths still excluded from file sync during copy-back. */
  dataBindPaths?: readonly string[];
}
const USER_FIX_PROPOSAL_TTL_MS = 600_000;
const proposalExpired = (issued: { at: number }): boolean =>
  Date.now() - issued.at >= USER_FIX_PROPOSAL_TTL_MS;

@Injectable()
export class DockerPlanService {
  /** Per VM; a choice in the dialog cannot change them. */
  private readonly speeds = new Map<string, DockerCopySpeeds>();
  private readonly userFixes = new Map<
    string,
    {
      at: number;
      projectId: string;
      remoteId: string;
      itemId?: string;
      root: string;
      proposal: DockerUserFixProposal;
    }
  >();

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: ProjectStorage & RemoteStorage,
    private readonly source: DockerPlanSourceService,
    private readonly remote: RemoteHostClient,
    private readonly inventory: DockerImportInventoryStore,
    private readonly choices: ConnectChoicesStore,
  ) {}

  async projectRoot(projectId: string): Promise<string> {
    return (await this.storage.getProject(projectId)).rootPath;
  }

  async presence(projectId: string, signal?: AbortSignal): Promise<DockerPresence> {
    return this.source.presence(await this.projectRoot(projectId), signal);
  }

  async applyUserFix(
    projectId: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<DockerUserFixApplyResult> {
    const request = DockerUserFixApplySchema.parse(input);
    const issued = this.userFixes.get(request.proposalId);
    if (
      !issued ||
      issued.projectId !== projectId ||
      issued.remoteId !== request.remoteId ||
      proposalExpired(issued) ||
      (await this.projectRoot(projectId)) !== issued.root
    )
      throw new AppError(
        'The Compose user proposal is unavailable. Get a fresh plan.',
        'DOCKER_USER_FIX_STALE',
        409,
      );
    if (issued.proposal.canApply) {
      const fresh = await this.plan(projectId, { remoteId: request.remoteId }, signal, {
        estimate: false,
        reuse: false,
      });
      const fixes = issued.itemId
        ? fresh.items
            .filter((item) => item.id === issued.itemId)
            .flatMap((item) => [
              item.ownership?.fixProposal,
              ...(item.serviceOwnership?.map((service) => service.ownership.fixProposal) ?? []),
            ])
        : (fresh.dataGroups?.flatMap(
            (group) =>
              group.ownershipConsumers?.map((consumer) => consumer.ownership.fixProposal) ?? [],
          ) ?? []);
      const current = fixes.find(
        (proposal) =>
          proposal?.service === issued.proposal.service &&
          proposal.file === issued.proposal.file &&
          proposal.container === issued.proposal.container,
      );
      if (
        !current ||
        current.oldUser !== issued.proposal.oldUser ||
        current.newUser !== issued.proposal.newUser
      )
        throw new AppError(
          'The Compose service or user changed since the plan. Get a fresh plan.',
          'DOCKER_USER_FIX_STALE',
          409,
        );
      if (!current.canApply)
        throw new AppError(
          current.reason ?? 'This proposal requires a manual edit, then Verify.',
          'DOCKER_USER_FIX_SHOW_ONLY',
          422,
        );
    }
    signal?.throwIfAborted();
    await applyComposeUserFix(issued.root, issued.proposal);
    this.source.invalidate();
    for (const [id, fix] of this.userFixes)
      if (fix.projectId === projectId && fix.proposal.file === issued.proposal.file)
        this.userFixes.delete(id);
    return { applied: true };
  }

  /** Verification always resolves Compose with both identities, even immediately after a plan. */
  verifyUserFix(projectId: string, input: unknown, signal?: AbortSignal): Promise<DockerPlan> {
    const request = DockerUserFixVerifySchema.parse(input);
    return this.plan(projectId, request, signal, { estimate: false, reuse: false });
  }

  /**
   * Connect calls this again before stopping anything. No cached plan or client paths are trusted.
   * `estimate: false` skips the copy-time probe for a caller that does not show the estimate.
   * `reuse` lets the dialog reuse measurements of the last two minutes that its choices
   * cannot change: disk usage, writable-layer sizes, folder sizes, linked containers'
   * Compose configurations and copy speeds.
   * Connect never passes it.
   */
  async plan(
    projectId: string,
    input: unknown,
    signal?: AbortSignal,
    { estimate = true, reuse = false, dataBindPaths = [] }: DockerPlanOptions = {},
  ): Promise<DockerPlan> {
    const request = DockerPlanRequestSchema.parse(input);
    const [project] = await Promise.all([
      this.storage.getProject(projectId),
      this.storage.getRemote(request.remoteId),
    ]);
    const plan: DockerPlan = {
      projectId,
      remoteId: request.remoteId,
      scannedAt: new Date().toISOString(),
      availability: { available: true, side: null, reason: null },
      apiVersion: null,
      items: [],
      filesystems: [],
      copySize: { bytes: 0, unknown: false },
      fit: 'unknown',
      canConnect: false,
      warnings: [],
      managedExclusions: [],
      codePaths: [],
      reconnect: null,
      estimate: null,
    };
    // Bound interactive scans; cancellation remains available to Connect's preflight.
    const scanSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
      : AbortSignal.timeout(120_000);
    let client: DockerEngineClient;
    try {
      client = await this.source.connect(scanSignal);
    } catch (error) {
      if (signal?.aborted) throw error;
      return unavailable(
        plan,
        'home',
        error instanceof DockerAvailabilityError ? error.reason : 'unavailable',
        error instanceof DockerEngineError ? error.message : 'Home Docker is unavailable.',
      );
    }
    // Asked together but judged in order, so the same reason is reported; an unavailable VM
    // is reported without waiting for the version answers.
    const versions = Promise.all([
      client.version(scanSignal),
      this.remote.dockerVersion(request.remoteId, { signal: scanSignal }),
    ]);
    void versions.catch(() => undefined);
    let runtime: HostRuntime;
    try {
      runtime = await this.remote.remoteRuntime(request.remoteId);
    } catch {
      return unavailable(plan, 'remote', 'remote-unreachable', 'The VM is unavailable.');
    }
    const mismatch = vmUserMismatch(this.source.uid(), this.source.gid(), runtime);
    if (mismatch && hasUnknownUserIds(mismatch))
      return unavailable(plan, 'remote', 'vm-user-mismatch', vmUserWarning(mismatch), mismatch);
    const ownership: DockerOwnershipContext | undefined = mismatch
      ? {
          home: { uid: mismatch.homeUid!, gid: mismatch.homeGid! },
          vm: { uid: mismatch.vmUid!, gid: mismatch.vmGid! },
        }
      : undefined;
    if (!runtime.docker?.installed)
      return unavailable(
        plan,
        'remote',
        'remote-no-docker',
        'The VM reports no usable Docker engine and Compose installation.',
      );
    try {
      const [homeVersion, targetVersion] = await versions;
      plan.apiVersion = selectDockerApiVersion(homeVersion, targetVersion);
      client.apiVersion = plan.apiVersion;
    } catch (error) {
      if (signal?.aborted) throw error;
      return unavailable(
        plan,
        'remote',
        error instanceof DockerEngineError && error.code === 'incompatible-api'
          ? 'incompatible-api'
          : 'remote-unreachable',
        error instanceof DockerEngineError
          ? error.message
          : 'Cannot negotiate Docker APIs with the VM.',
      );
    }
    const options = { signal: scanSignal, apiVersion: plan.apiVersion };
    const inventory = this.inventory.get(projectId, request.remoteId);
    const absolutePaths = (paths: readonly string[]) =>
      paths.map((path) => join(project.rootPath, path));
    let scanned;
    try {
      scanned = await this.source.scan(client, project.rootPath, scanSignal, {
        reuse,
        ownership,
        previousBindPaths: absolutePaths(inventoryBindPaths(inventory, project.rootPath)),
        dataBindPaths: absolutePaths(dataBindPaths),
      });
    } catch (error) {
      if (error instanceof DockerEngineError && error.code === 'unsupported')
        throw new AppError(error.message, 'DOCKER_UNSUPPORTED_SETTING', 422);
      throw error;
    }
    plan.items = scanned.items;
    plan.codePaths = scanned.codePaths.map((path) =>
      resolve(path) === resolve(project.rootPath)
        ? '/'
        : projectAnchoredPath(project.rootPath, path),
    );
    const records = inventory?.groups ?? [];
    const dataGroups = groupDockerData(
      plan.items,
      project.rootPath,
      records.map((group) => ({
        volumes: group.volumes,
        bindPaths: group.bindPaths.filter(
          (path) =>
            strictlyWithin(project.rootPath, path) &&
            !plan.codePaths.includes(projectAnchoredPath(project.rootPath, path)),
        ),
      })),
      scanned.ownershipConsumers,
    );
    const holderVolumes = [...new Set(dataGroups.flatMap((g) => g.volumes))];
    const externalPaths = [
      ...new Set([
        ...dataGroups.flatMap((g) => g.bindPaths),
        ...plan.items.flatMap((i) =>
          i.mounts
            .filter((m) => m.kind === 'readonly-external-bind' && m.source.length <= 4096)
            .map((m) => m.source),
        ),
      ]),
    ];
    let target: DockerScanResult;
    const fixedNetworks = [
      ...new Set(plan.items.flatMap((i) => i.fixedIPv4?.map((f) => f.network) ?? [])),
    ];
    // A fixed address implies its network is in item.networks too.
    const scanNetworks = plan.items.some((item) => item.networks?.length);
    try {
      target = await pagedDockerScan(externalPaths, (paths, first) =>
        first && scanNetworks
          ? this.remote.dockerScan(request.remoteId, paths, options, holderVolumes, fixedNetworks)
          : this.remote.dockerScan(request.remoteId, paths, options, holderVolumes),
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      return unavailable(plan, 'remote', 'remote-docker-routes', VM_ROUTES_MESSAGE);
    }
    const consumers: DockerOwnershipConsumer[] = scanned.ownershipConsumers ?? [];
    const vmConsumers = new Map<string, DockerOwnershipConsumer>();
    if (ownership) {
      for (const container of target.containers) {
        const consumer: DockerOwnershipConsumer = {
          name: `VM ${container.name}`,
          user: container.user,
          ownership: {
            ...ownership,
            class:
              (projectContainer(container, project.rootPath, projectId, target.volumes)
                ? inventory?.items.find((item) => item.name === container.name.replace(/^\//, ''))
                    ?.ownership?.class
                : undefined) ?? 'exact',
          },
          ...mountedData(container.mounts),
        };
        consumers.push(consumer);
        vmConsumers.set(container.id, consumer);
      }
    }
    const ownershipGroups = ownership
      ? groupDockerData(plan.items, project.rootPath, dataGroups, consumers)
      : dataGroups;
    const extraPaths = ownershipGroups
      .flatMap((group) => group.bindPaths)
      .filter((path) => !externalPaths.includes(path));
    const extraVolumes = ownershipGroups
      .flatMap((group) => group.volumes)
      .filter((volume) => !holderVolumes.includes(volume));
    if (extraPaths.length || extraVolumes.length) {
      try {
        const extra = await pagedDockerScan([...new Set(extraPaths)], (paths) =>
          this.remote.dockerScan(request.remoteId, paths, options, [
            ...new Set([...holderVolumes, ...extraVolumes]),
          ]),
        );
        target.paths.push(...extra.paths);
        for (const container of extra.containers) {
          const original = target.containers.find((entry) => entry.id === container.id);
          if (original && container.metadata) original.metadata = container.metadata;
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        return unavailable(plan, 'remote', 'remote-docker-routes', VM_ROUTES_MESSAGE);
      }
    }
    plan.dataGroups = ownershipGroups.map((group) =>
      checkDockerDataGroup(group, records, scanned.holders, target, projectId, project.rootPath),
    );
    applyDockerPolicy(
      plan.items,
      request,
      target,
      projectId,
      runtime.homePath ?? null,
      project.rootPath,
      request.items === undefined ? this.choices.get(projectId)?.items : undefined,
    );
    if (ownership) {
      // Only a project-owned counterpart whose data remains untouched (or is explicitly
      // reset) is removed from the mapping-conflict check. All other holders still count.
      for (const container of target.containers) {
        const counterpart = plan.items.find(
          (item) => item.name === container.name.replace(/^\//, ''),
        );
        if (
          !counterpart?.selectedMode ||
          !['replace', 'leave-as-is'].includes(counterpart.targetAction)
        )
          continue;
        const group = plan.dataGroups.find((entry) => entry.itemIds.includes(counterpart.id));
        if (
          !group ||
          !consumers.some(
            (consumer) =>
              overlapsData(group, consumer) && consumer.ownership.class === 'follows-user',
          )
        )
          continue;
        const consumer = vmConsumers.get(container.id);
        if (consumer) consumer.counterpart = true;
      }
      applyDockerGroupOwnership(plan.dataGroups, plan.items, consumers, ownership);
      await this.userFixProposals(plan, consumers, project.rootPath);
    }
    applyDockerDataPolicy(
      plan.items,
      plan.dataGroups,
      request,
      target,
      inventory,
      project.rootPath,
      projectId,
    );
    const acceptedFixes = new Set(
      request.items?.filter((entry) => entry.moveWithoutUserFix).map((entry) => entry.id),
    );
    for (const item of plan.items) {
      if (item.ownership?.class !== 'needs-user-fix' || !item.selectedMode) continue;
      if (acceptedFixes.has(item.id))
        item.warnings.push({
          code: 'user-fix-skipped',
          message:
            'Move without the fix: this container keeps the home user on the VM and cannot write project folders or read project files restricted to the VM user.',
        });
      else
        item.blockers.push({
          code: 'user-fix-not-accepted',
          message:
            'Apply and Verify the Compose user fix, choose Move without the fix, or deselect this item. Skipping its data does not fix project-folder access.',
        });
    }
    for (const item of plan.items) {
      if (item.selectedMode && skipsImageCopy(item, project.rootPath)) {
        item.images = item.images.map((image) => ({ ...image, notCopied: true }));
        item.notes.push('Image: not copied; the VM builds it from the synced project.');
      }
    }
    plan.networks = dockerNetworkPolicy(plan.items, target);
    plan.warnings.push(...dockerNetworkWarnings(plan.networks));
    // The dialog shows exactly who the handoff stops besides the moving containers.
    const containerIds = new Set(plan.items.filter((i) => i.kind === 'container').map((i) => i.id));
    const movingContainers = new Set(
      plan.items.filter((i) => i.kind === 'container' && movesToVm(i)).map((i) => i.id),
    );
    for (const item of plan.items)
      item.alsoStops = (
        item.selectedMode && item.dataAction === 'keep-vm'
          ? keptWriterStops(item, plan.items)
          : writerStops(item, containerIds, project.rootPath)
      ).filter((id) => !movingContainers.has(id));
    // Per-item sizes use the same mount-kind and deduplication rules as the fit check.
    for (const item of plan.items) {
      const data = uniqueCopiedMounts(
        [{ ...item, selectedMode: 'container-and-data', dataAction: undefined }],
        project.rootPath,
      );
      item.dataSize = {
        bytes: data.reduce((total, mount) => total + mount.size.bytes, 0),
        unknown: data.some((mount) => mount.size.unknown),
      };
    }
    const mounts = uniqueCopiedMounts(plan.items, project.rootPath);
    const bindPaths = mounts
      .filter(
        (m) => !isVolumeMount(m.kind) && runtime.homePath && within(runtime.homePath, m.source),
      )
      .map((m) => m.source);
    const binds: DockerPathCapacity[] = [];
    // The same images `planDockerFit` counts; kept data may need one for a missing VM container.
    const imageIds = [
      ...new Set(
        plan.items
          .filter((item) => copiesImages(item, project.rootPath))
          .flatMap((i) => i.images.map((image) => image.id)),
      ),
    ];
    const candidates = new Map(imageIds.map((id) => [id, vmImageCandidates(inventory, id)]));
    let present: { ids: string[] };
    try {
      for (let offset = 0; offset < bindPaths.length; offset += 64)
        binds.push(
          ...(
            await this.remote.dockerCapacity(
              request.remoteId,
              bindPaths.slice(offset, offset + 64),
              options,
            )
          ).paths,
        );
      present = await this.remote.dockerImagesPresent(
        request.remoteId,
        [...new Set([...candidates.values()].flat())],
        options,
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      return unavailable(plan, 'remote', 'remote-docker-routes', VM_ROUTES_MESSAGE);
    }
    // planDockerFit compares home IDs, so present VM IDs translate back before it.
    const presentHomeIds = imageIds.filter((id) =>
      candidates.get(id)!.some((candidate) => present.ids.includes(candidate)),
    );
    const fit = planDockerFit(
      plan.items,
      presentHomeIds,
      {
        dockerRoot: runtime.docker.capacity?.dockerRoot ?? null,
        imageStore: runtime.docker.capacity?.imageStore ?? null,
        binds,
      },
      project.rootPath,
    );
    plan.filesystems = fit.filesystems;
    plan.copySize = { bytes: fit.bytes, unknown: fit.unknown };
    plan.fit = fit.fit;
    plan.canConnect =
      fit.fit !== 'refused' &&
      plan.items.every(
        (item) =>
          !item.selectedMode || !item.blockers.some((b) => blocksMode(item.selectedMode!, b.code)),
      );
    for (const item of plan.items) {
      if (
        !item.selectedMode &&
        item.mounts.some((m) => m.kind === 'project-bind' && m.size.unknown)
      )
        plan.warnings.push({
          code: 'unreadable-unselected-folder',
          message: `${item.name} has an unreadable or incompletely measured project folder. File sync may stall on it unless it is excluded.`,
        });
    }
    const managedMounts = [
      ...mounts,
      ...plan.items
        .filter((i) => i.selectedMode && i.dataAction === 'keep-vm')
        .flatMap((i) => potentialDataMounts(i, project.rootPath)),
    ];
    // Start-empty resets the whole shared group, including deselected and recorded-only members.
    const resetBinds = plan.dataGroups
      .filter((group) =>
        plan.items.some(
          (item) =>
            group.itemIds.includes(item.id) &&
            item.selectedMode &&
            item.dataAction === 'start-empty',
        ),
      )
      .flatMap((group) => group.bindPaths)
      .filter((path) => strictlyWithin(project.rootPath, path));
    plan.managedExclusions = [
      ...new Set([
        ...managedMounts.filter((m) => m.kind === 'project-bind').map((m) => m.source),
        ...resetBinds,
      ]),
    ].map((path) => projectAnchoredPath(project.rootPath, path));
    plan.reconnect = dockerReconnect(
      plan.items,
      this.inventory.get(projectId, request.remoteId),
      project.rootPath,
    );
    if (!estimate) return plan;
    if (fit.bytes === 0) plan.estimate = estimateDockerPlan(0, 0, null);
    else {
      try {
        const speeds = await this.copySpeeds(
          request.remoteId,
          client,
          fit.images[0],
          options,
          reuse,
        );
        plan.estimate = estimateDockerPlan(fit.bytes, speeds.probeSeconds, speeds.exportRate);
      } catch {
        if (signal?.aborted) signal.throwIfAborted();
        plan.warnings.push({
          code: 'estimate-unavailable',
          message: 'The copy-time estimate is unavailable.',
        });
      }
    }
    return plan;
  }

  private async userFixProposals(
    plan: DockerPlan,
    consumers: DockerOwnershipConsumer[],
    root: string,
  ): Promise<void> {
    for (const [id, issued] of this.userFixes)
      if (proposalExpired(issued)) this.userFixes.delete(id);
    const seen = new Set<DockerOwnershipDecision>();
    const proposals = new Map<string, DockerUserFixProposal>();
    for (const consumer of consumers) {
      const ownership = consumer.ownership;
      const compose = ownership.compose;
      if (
        seen.has(ownership) ||
        !compose ||
        !['needs-user-fix', 'image-user-hint'].includes(ownership.class)
      )
        continue;
      seen.add(ownership);
      const item = plan.items.find((entry) => entry.id === consumer.itemId);
      const container =
        item?.kind === 'container'
          ? item
          : plan.items.find(
              (entry) =>
                entry.kind === 'container' &&
                entry.ownership?.compose?.service === compose.service &&
                entry.ownership.compose.directory === compose.directory &&
                JSON.stringify(entry.ownership.compose.files) === JSON.stringify(compose.files),
            );
      const itemId = consumer.itemId ?? container?.id;
      const key = JSON.stringify([itemId, ownership.class, compose, consumer.user]);
      const proposal =
        proposals.get(key) ??
        (await composeUserFixProposal(
          root,
          ownership,
          container?.name ?? null,
          randomUUID(),
          consumer.user,
        ));
      if (!proposal) continue;
      proposals.set(key, proposal);
      ownership.fixProposal = proposal;
      this.userFixes.set(proposal.id, {
        at: Date.now(),
        projectId: plan.projectId,
        remoteId: plan.remoteId,
        ...(itemId ? { itemId } : {}),
        root,
        proposal,
      });
    }
    // Evict older scans first; every proposal returned by this plan stays usable.
    const current = new Set([...proposals.values()].map((proposal) => proposal.id));
    for (const id of this.userFixes.keys()) {
      if (this.userFixes.size <= 1000) break;
      if (!current.has(id)) this.userFixes.delete(id);
    }
  }

  private async copySpeeds(
    remoteId: string,
    client: DockerEngineClient,
    image: string | undefined,
    options: DockerHostOptions & { signal: AbortSignal },
    reuse: boolean,
  ): Promise<DockerCopySpeeds> {
    const recent = this.speeds.get(remoteId);
    if (reuse && recent && reusable(recent.at) && (recent.exportRate !== null || !image))
      return recent;
    const start = performance.now();
    await this.remote.dockerProbe(remoteId, probeBody(), options);
    const probeSeconds = (performance.now() - start) / 1000;
    const exportRate = image ? await this.source.exportRate(client, image, options.signal) : null;
    const measured = { at: Date.now(), probeSeconds, exportRate };
    this.speeds.set(remoteId, measured);
    return measured;
  }
}

const VM_ROUTES_MESSAGE = 'The VM cannot answer Docker import queries; update DevChain on the VM.';

function unavailable(
  plan: DockerPlan,
  side: 'home' | 'remote',
  code: string,
  message: string,
  userMismatch?: VmUserMismatch,
): DockerPlan {
  return {
    ...plan,
    availability: {
      available: false,
      side,
      reason: { code, message },
      ...(userMismatch ? { userMismatch } : {}),
    },
    items: [],
    apiVersion: null,
  };
}
function probeBody(): Readable {
  return Readable.from(
    (function* () {
      const chunk = Buffer.alloc(64 * 1024);
      for (let i = 0; i < 256; i++) yield chunk;
    })(),
  );
}
