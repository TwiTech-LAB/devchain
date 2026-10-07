import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import {
  DockerEngineClient,
  DockerEngineError,
  assertSupportedDocker,
  isDockerNotFound,
  resolveDockerSocket,
  type DockerDiskUsage,
  type DockerInfo,
} from '../../core/controllers/docker-engine.client';
import {
  DEFAULT_NETWORKS,
  fixedIPv4Address,
  ipv4Ranges,
  projectDockerCreate,
  type DockerContainerInspect,
} from '../../core/controllers/docker-settings';
import {
  COMPOSE_PROJECT_LABEL,
  COMPOSE_SERVICE_LABEL,
  type DockerInspectTimes,
} from '../host/host-docker.dto';
import type { DockerDataHolder } from './docker-data-groups';
import { measureDockerBind, within } from './docker-plan-files';
import {
  composeRootLinks,
  containerLinksProject,
  DEFAULT_COMPOSE_FILES,
} from './docker-project-compose';
import {
  COPYABLE_MOUNT_KINDS,
  DOCKER_TEMPORARY_NOTE,
  DOCKER_WRITABLE_LAYER_NOTE,
  isVolumeMount,
  type DockerPlanItem,
  type DockerPlanImage,
  type DockerPlanMount,
  type DockerPlanSize,
  type DockerPresence,
} from './docker-plan.dto';

interface Mount {
  Type: string;
  Name?: string;
  Source: string;
  Destination: string;
  RW: boolean;
  Driver?: string;
}
export interface Container extends DockerContainerInspect, DockerInspectTimes {
  Id: string;
  Name: string;
  Mounts: Mount[];
  SizeRw?: number;
}
interface Volume {
  Name: string;
  Driver: string;
  Labels?: Record<string, string> | null;
}
export interface ComposeConfig {
  name: string;
  services?: Record<
    string,
    {
      image?: string;
      build?: unknown;
      user?: string;
      group_add?: Array<string | number>;
      profiles?: string[];
      volumes?: Array<{ type?: string; source?: string; target?: string; read_only?: boolean }>;
    }
  >;
  volumes?: Record<string, { name?: string; external?: boolean }>;
}
export interface DockerSourceScan {
  holders: DockerDataHolder[];
  items: DockerPlanItem[];
  homePath: string;
  codePaths: string[];
}
export interface DockerSourceScanOptions {
  reuse?: boolean;
  /** Absolute in-project paths from previous imports, including unselected items. */
  previousBindPaths?: readonly string[];
  /** Absolute paths whose data is still excluded during Disconnect. */
  dataBindPaths?: readonly string[];
}

/** The Compose labels that link a container to the project root. */
export function containerProjectLinks(root: string, inspect: Container): string[] {
  return composeRootLinks((inspect.Config.Labels ?? {}) as Record<string, string>, root);
}
/** A container's Compose file set from its labels; null without config files. */
export function composeLabelSet(
  root: string,
  container: Container,
): { directory: string; files: string[]; service: string | null } | null {
  const labels = (container.Config.Labels ?? {}) as Record<string, string>;
  const encoded = labels[`${COMPOSE_PROJECT_LABEL}.config_files`];
  if (!encoded) return null;
  const directory = resolve(labels[`${COMPOSE_PROJECT_LABEL}.working_dir`] || root);
  const files = encoded
    .split(',')
    .filter(Boolean)
    .map((file) => resolve(directory, file));
  if (!files.length) return null;
  return { directory, files, service: labels[COMPOSE_SERVICE_LABEL] || null };
}
/** A Compose service that Compose builds from inside the project and names itself (no `image`). */
function buildsInProject(
  root: string,
  service: NonNullable<ComposeConfig['services']>[string] | undefined,
): boolean {
  if (!service || Object.hasOwn(service, 'image')) return false;
  const build = service.build;
  return (
    typeof build === 'object' &&
    build !== null &&
    'context' in build &&
    typeof build.context === 'string' &&
    isAbsolute(build.context) &&
    within(root, build.context)
  );
}
async function hasRootCompose(root: string): Promise<boolean> {
  for (const name of DEFAULT_COMPOSE_FILES) {
    if (
      await access(join(root, name)).then(
        () => true,
        () => false,
      )
    )
      return true;
  }
  return false;
}

const unknownSize = (): DockerPlanSize => ({ bytes: 0, unknown: true });
const size = (value: number | undefined): DockerPlanSize =>
  typeof value === 'number' && value >= 0 && Number.isFinite(value)
    ? { bytes: value, unknown: false }
    : unknownSize();

/** How long the Connect dialog reuses measurements that its choices cannot change. */
export const DOCKER_PLAN_REUSE_MS = 120_000;

/** True while a measurement taken at `at` may still be reused. */
export function reusable(at: number): boolean {
  return Date.now() - at < DOCKER_PLAN_REUSE_MS;
}

@Injectable()
export class DockerPlanSourceService {
  constructor(private readonly executor: ProcessExecutor) {}

  /**
   * Measurements and Compose configurations of the last scan. Disk usage reads image and
   * volume sizes; writable-layer sizes come from linked containers' sized inspects.
   */
  private recent: {
    at: number;
    usage: DockerDiskUsage;
    writableLayers: Map<string, DockerPlanSize>;
    folders: Map<string, DockerPlanSize>;
    compose: Map<string, ComposeConfig | Error | null>;
  } | null = null;

  /** Throws DockerAvailabilityError with a stable reason for each unusable home engine. */
  async connect(signal?: AbortSignal): Promise<DockerEngineClient> {
    let socket: string;
    try {
      socket = await this.socket();
    } catch (error) {
      throw availability(
        error,
        error instanceof DockerEngineError && error.message.includes('tcp://')
          ? 'remote-docker-host'
          : 'unsupported-endpoint',
      );
    }
    const client = new DockerEngineClient(socket);
    let info: DockerInfo;
    try {
      info = await client.json<DockerInfo>('GET', '/info', undefined, { signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw await socketAvailability(socket, error);
    }
    try {
      assertSupportedDocker(info);
    } catch (error) {
      throw availability(
        error,
        info.OperatingSystem?.includes('Docker Desktop') ? 'docker-desktop' : 'rootless',
      );
    }
    return client;
  }
  async presence(root: string, signal?: AbortSignal): Promise<DockerPresence> {
    signal?.throwIfAborted();
    if (await hasRootCompose(root)) {
      signal?.throwIfAborted();
      return { state: 'present' };
    }
    const deadline = AbortSignal.timeout(5000);
    const scanSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let onAbort: (() => void) | undefined;
    try {
      let socket: string;
      try {
        // Socket discovery has no signal; bound it with the same deadline as the list.
        socket = await Promise.race([
          this.socket(),
          new Promise<never>((_resolve, reject) => {
            onAbort = () => reject(scanSignal.reason);
            scanSignal.addEventListener('abort', onAbort, { once: true });
            if (scanSignal.aborted) onAbort();
          }),
        ]);
      } catch (error) {
        if (scanSignal.aborted) throw error;
        return { state: 'absent' };
      }
      try {
        const containers = await new DockerEngineClient(socket).json<
          Array<{ Labels?: Record<string, string> | null; Mounts?: Mount[] }>
        >('GET', '/containers/json?all=true', undefined, { signal: scanSignal });
        return {
          state: containers.some((container) =>
            containerLinksProject(container.Labels, container.Mounts, root),
          )
            ? 'present'
            : 'absent',
        };
      } catch (error) {
        if (scanSignal.aborted) throw error;
        const failure = await socketAvailability(socket, error);
        return {
          state:
            failure instanceof DockerAvailabilityError &&
            (failure.reason === 'no-socket' || failure.reason === 'no-socket-access')
              ? 'absent'
              : 'unknown',
        };
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      return { state: 'unknown' };
    } finally {
      if (onAbort) scanSignal.removeEventListener('abort', onAbort);
    }
  }
  socket(): Promise<string> {
    return resolveDockerSocket();
  }
  homePath(): string {
    return homedir();
  }
  uid(): number | null {
    return process.getuid?.() ?? null;
  }
  gid(): number | null {
    return process.getgid?.() ?? null;
  }
  measure(path: string, signal?: AbortSignal): Promise<DockerPlanSize> {
    return measureDockerBind(path, undefined, signal);
  }

  async compose(
    root: string,
    options: {
      files?: readonly string[];
      allProfiles?: boolean;
      signal?: AbortSignal;
      env?: NodeJS.ProcessEnv;
    } = {},
  ): Promise<ComposeConfig | null> {
    // Explicit files skip the default-file probe; without them, Compose needs a default file.
    if (!options.files?.length) {
      if (!(await hasRootCompose(root))) return null;
    }
    return new Promise<ComposeConfig>((resolveConfig, reject) => {
      execFile(
        'docker',
        [
          'compose',
          '--project-directory',
          root,
          ...(options.files?.flatMap((path) => ['-f', path]) ?? []),
          ...(options.allProfiles ? ['--profile', '*'] : []),
          'config',
          '--format',
          'json',
        ],
        {
          cwd: root,
          timeout: 30_000,
          maxBuffer: 16 * 1024 * 1024,
          signal: options.signal,
          env: options.env,
        },
        (error, stdout) => {
          // Compose output and stderr can contain interpolated secrets.
          if (error)
            return reject(
              new DockerEngineError(
                'unavailable',
                'Cannot read project Docker Compose configuration',
              ),
            );
          try {
            const config: ComposeConfig = JSON.parse(stdout);
            if (!config || typeof config.name !== 'string') throw new Error();
            resolveConfig(config);
          } catch {
            reject(
              new DockerEngineError('invalid-response', 'Invalid Docker Compose configuration'),
            );
          }
        },
      );
    }).catch((error: unknown) => {
      if (
        options.allProfiles &&
        !options.signal?.aborted &&
        error instanceof DockerEngineError &&
        error.code === 'unavailable'
      )
        return this.compose(root, { ...options, allProfiles: false });
      throw error;
    });
  }

  /**
   * `reuse` takes disk usage, writable-layer sizes, folder sizes and linked containers'
   * Compose configurations from a scan less than two minutes old. Container settings,
   * images and the root Compose file are read again.
   */
  async scan(
    client: DockerEngineClient,
    root: string,
    signal?: AbortSignal,
    { reuse = false, previousBindPaths = [], dataBindPaths = [] }: DockerSourceScanOptions = {},
  ): Promise<DockerSourceScan> {
    const recent = reuse && this.recent && reusable(this.recent.at) ? this.recent : null;
    const composeCache = new Map(recent?.compose);
    const readCompose = async (directory: string, files: string[]) => {
      const key = JSON.stringify([resolve(directory), files]);
      if (!composeCache.has(key)) {
        const config = await this.compose(directory, { files, signal }).catch(
          (error: unknown): Error => (error instanceof Error ? error : new Error(String(error))),
        );
        signal?.throwIfAborted();
        composeCache.set(key, config);
      }
      return composeCache.get(key)!;
    };
    const [listed, usage, volumes, composeAttempt] = await Promise.all([
      client.json<Array<{ Id: string; Labels?: Record<string, string> | null; Mounts?: Mount[] }>>(
        'GET',
        '/containers/json?all=true',
        undefined,
        { signal },
      ),
      recent?.usage ?? client.diskUsage(signal),
      client.json<{ Volumes: Volume[] | null }>('GET', '/volumes', undefined, { signal }),
      // A broken Compose file must not fail the whole scan; it becomes one
      // blocked item below, so the other containers still plan.
      this.compose(root).catch(
        (error: unknown): Error => (error instanceof Error ? error : new Error(String(error))),
      ),
    ]);
    const items: DockerPlanItem[] = [];
    const imageCache = new Map<string, DockerPlanImage>();
    const bindCache = new Map<string, DockerPlanSize>(recent?.folders);
    const image = async (ref: string) => {
      let result = imageCache.get(ref);
      if (!result) {
        const info = await client.json<{ Id: string; Architecture: string }>(
          'GET',
          `/images/${encodeURIComponent(ref)}/json`,
          undefined,
          { signal },
        );
        if (!info?.Id || !info.Architecture)
          throw new DockerEngineError('invalid-response', 'Invalid Docker image metadata');
        result = {
          id: info.Id,
          architecture: info.Architecture,
          size: size(usage.Images?.find((entry) => entry.Id === info.Id)?.Size),
        };
        imageCache.set(ref, result);
      }
      return result;
    };
    const volumeMount = (
      name: string,
      destination: string,
      named: boolean,
      readOnly: boolean,
    ): DockerPlanMount => ({
      kind: named ? 'named-volume' : 'anonymous-volume',
      source: name,
      destination,
      readOnly,
      driver: volumes.Volumes?.find((v) => v.Name === name)?.Driver ?? 'unknown',
      size: size(usage.Volumes?.find((v) => v.Name === name)?.UsageData?.Size),
    });
    const linked = new Set(
      listed
        .filter((entry) => containerLinksProject(entry.Labels, entry.Mounts, root))
        .map((entry) => entry.Id),
    );
    const writableLayers = new Map(recent?.writableLayers);
    const inspects = await Promise.all(
      listed.map(async (entry) => {
        const measureLayer = linked.has(entry.Id) && !writableLayers.has(entry.Id);
        const inspect = await client.json<Container>(
          'GET',
          `/containers/${encodeURIComponent(entry.Id)}/json${measureLayer ? '?size=true' : ''}`,
          undefined,
          { signal },
        );
        if (measureLayer) writableLayers.set(entry.Id, size(inspect.SizeRw));
        return inspect;
      }),
    );
    // One inspect per distinct non-default network, run together.
    const networkNames = [
      ...new Set(
        inspects.flatMap((inspect) =>
          Object.keys(inspect.NetworkSettings?.Networks ?? {}).filter(
            (name) => !DEFAULT_NETWORKS.has(name),
          ),
        ),
      ),
    ];
    const networkSubnets = new Map(
      await Promise.all(
        networkNames.map(async (name) => {
          const network = await client.json<{ IPAM?: { Config?: Array<{ Subnet?: string }> } }>(
            'GET',
            `/networks/${encodeURIComponent(name)}`,
            undefined,
            { signal },
          );
          return [name, ipv4Ranges(network.IPAM?.Config).map((range) => range.Subnet)] as const;
        }),
      ),
    );
    for (const inspect of inspects) {
      const item = baseItem(inspect.Id, inspect.Name.replace(/^\//, ''), 'container');
      for (const [name, endpoint] of Object.entries(inspect.NetworkSettings?.Networks ?? {})) {
        if (DEFAULT_NETWORKS.has(name)) continue;
        const address = fixedIPv4Address(endpoint);
        const subnets = networkSubnets.get(name) ?? [];
        (item.networks ??= []).push({ name, subnets });
        if (address) (item.fixedIPv4 ??= []).push({ network: name, address, subnets });
      }
      const labels = (inspect.Config.Labels ?? {}) as Record<string, string>;
      item.composeProject = labels[COMPOSE_PROJECT_LABEL] ?? null;
      item.temporary = inspect.HostConfig.AutoRemove === true;
      if (inspect.HostConfig.Privileged === true) item.privileged = true;
      if (item.temporary) item.notes.push(DOCKER_TEMPORARY_NOTE);
      item.notes.push(DOCKER_WRITABLE_LAYER_NOTE);
      item.linkedReasons.push(...containerProjectLinks(root, inspect));
      try {
        projectDockerCreate(inspect, client.socketPath);
      } catch (error) {
        if (!(error instanceof DockerEngineError)) throw error;
        // An unsupported setting fails only this container: the item stays in
        // the plan as "cannot move" with the reason, never silently dropped.
        if (error.code === 'cannot-move') {
          if (!item.temporary || !error.message.includes('AutoRemove'))
            item.blockers.push({ code: 'runtime-bound', message: error.message });
        } else if (error.code === 'unsupported') {
          item.blockers.push({ code: 'runtime-bound', message: `${item.name}: ${error.message}` });
        } else {
          throw error;
        }
      }
      item.images = [await image(inspect.Image)];
      item.writableLayer = linked.has(inspect.Id)
        ? (writableLayers.get(inspect.Id) ?? unknownSize())
        : unknownSize();
      for (const mount of inspect.Mounts ?? []) {
        if (mount.Type === 'volume') {
          const named =
            explicitlyNamed(inspect, mount) ||
            Boolean(
              volumes.Volumes?.find((v) => v.Name === mount.Name)?.Labels?.[
                'com.docker.compose.volume'
              ],
            );
          item.mounts.push(
            volumeMount(mount.Name ?? mount.Source, mount.Destination, named, !mount.RW),
          );
        } else if (mount.Type === 'bind') {
          const source = resolve(mount.Source);
          const kind = await this.bindKind(root, source, !mount.RW, dataBindPaths, signal);
          if (kind === 'project-bind' || kind === 'project-code')
            item.linkedReasons.push(`bind:${source}`);
          item.mounts.push({
            kind,
            source,
            destination: mount.Destination,
            readOnly: !mount.RW,
            size: unknownSize(),
          });
        }
      }
      // Only a linked container can be selected, so only its Compose set is read.
      const composeSet = item.linkedReasons.length ? composeLabelSet(root, inspect) : null;
      if (composeSet?.service) {
        const config = await readCompose(composeSet.directory, composeSet.files);
        if (
          !(config instanceof Error) &&
          buildsInProject(root, config?.services?.[composeSet.service])
        )
          item.buildsFromProject = true;
      }
      items.push(item);
    }
    if (composeAttempt instanceof Error) {
      const name = basename(root);
      const item = baseItem(`compose:${name}`, name, 'compose-project');
      item.composeProject = name;
      item.linkedReasons.push('compose-file-at-project-root');
      item.blockers.push({
        code: 'compose-unreadable',
        message: `${name}: ${composeAttempt.message}`,
      });
      items.push(item);
    } else if (
      composeAttempt &&
      !items.some((item) => item.composeProject === composeAttempt.name)
    ) {
      const compose = composeAttempt;
      const item = baseItem(`compose:${compose.name}`, compose.name, 'compose-project');
      item.composeProject = compose.name;
      item.linkedReasons.push('compose-file-at-project-root');
      item.notes.push(
        'compose up recreates the containers on the VM. Only existing volumes and present images are copied.',
      );
      for (const [service, config] of Object.entries(compose.services ?? {})) {
        try {
          item.images.push(await image(config.image ?? `${compose.name}-${service}`));
        } catch (error) {
          if (!isDockerNotFound(error)) throw error;
          item.notes.push(
            config.build
              ? `${service}: the agent builds them on the VM`
              : `${service}: image is not present locally; compose up must pull it on the VM`,
          );
        }
      }
      for (const [key, config] of Object.entries(compose.volumes ?? {})) {
        const name = config.name ?? (config.external ? key : `${compose.name}_${key}`);
        if (volumes.Volumes?.some((v) => v.Name === name))
          item.mounts.push(volumeMount(name, '', true, false));
      }
      items.push(item);
    }
    const previous = await Promise.all(
      [...new Set(previousBindPaths)]
        .filter((path) => within(root, path))
        .map(async (path) => ({
          source: path,
          kind: await this.bindKind(root, path, false, dataBindPaths, signal),
        })),
    );
    const projectMounts = items
      .flatMap((item) => item.mounts)
      .filter((mount) => mount.kind === 'project-bind' || mount.kind === 'project-code');
    const dataPaths = [
      ...projectMounts
        .filter((mount) => mount.kind === 'project-bind')
        .map((mount) => mount.source),
      ...previous.filter((mount) => mount.kind === 'project-bind').map((mount) => mount.source),
      ...dataBindPaths.filter((path) => within(root, path) && resolve(path) !== resolve(root)),
    ];
    const classified = [...projectMounts, ...previous];
    for (const mount of classified)
      if (mount.kind === 'project-code' && dataPaths.some((path) => within(path, mount.source)))
        mount.kind = 'project-bind';
    const codePaths = [
      ...new Set(
        classified.filter((mount) => mount.kind === 'project-code').map((mount) => mount.source),
      ),
    ];
    // Measure only after nested code has inherited its enclosing data classification.
    for (const mount of items.flatMap((item) => item.mounts)) {
      if (isVolumeMount(mount.kind)) continue;
      if (COPYABLE_MOUNT_KINDS.includes(mount.kind)) {
        if (!bindCache.has(mount.source))
          bindCache.set(mount.source, await this.measure(mount.source, signal));
        mount.size = bindCache.get(mount.source) ?? unknownSize();
      } else if (mount.kind === 'project-code') {
        mount.size = { bytes: 0, unknown: false };
      }
    }
    for (const item of items) {
      // A worklist: each member, including ones added on the way, adds the items sharing data with it.
      const group = [item];
      for (const member of group)
        for (const candidate of items)
          if (!group.includes(candidate) && sharesData(member, candidate)) group.push(candidate);
      item.writerGroup = group.map((member) => member.id).sort();
    }
    // A walk that ran out of time is measured again.
    const folders = new Map([...bindCache].filter(([, size]) => !size.unknown));
    this.recent = {
      at: recent?.at ?? Date.now(),
      usage,
      writableLayers: new Map([...writableLayers].filter(([, size]) => !size.unknown)),
      folders,
      compose: composeCache,
    };
    return {
      items,
      homePath: this.homePath(),
      codePaths,
      holders: inspects.map((c) => ({
        volumes: (c.Mounts ?? []).filter((m) => m.Type === 'volume').map((m) => m.Name ?? m.Source),
        bindPaths: (c.Mounts ?? []).filter((m) => m.Type === 'bind').map((m) => m.Source),
        metadata: { created: c.Created, startedAt: c.State?.StartedAt, running: c.State?.Running },
      })),
    };
  }

  async bindKind(
    root: string,
    source: string,
    readOnly: boolean,
    dataBindPaths: readonly string[],
    signal?: AbortSignal,
  ): Promise<DockerPlanMount['kind']> {
    signal?.throwIfAborted();
    if (resolve(root) === resolve(source)) return 'project-code';
    if (within(root, source)) {
      if (dataBindPaths.some((path) => resolve(path) === resolve(source))) return 'project-bind';
      try {
        const result = await this.executor.run({
          argv: ['git', 'ls-files', '-z', '--', `:(literal)${relative(root, source)}`],
          mode: 'pipe',
          cwd: root,
          timeout: 10_000,
          outputLimits: { maxBytes: 4096 },
        });
        signal?.throwIfAborted();
        if (result.success) {
          const tracked =
            result.truncated ||
            result.stdout
              .split('\0')
              .some(
                (path) => path && !['.gitkeep', '.keep', '.gitignore'].includes(basename(path)),
              );
          return tracked ? 'project-code' : 'project-bind';
        }
      } catch {
        signal?.throwIfAborted();
        // An unavailable git uses the bind's write permission, never cached classification.
      }
      return readOnly ? 'project-code' : 'project-bind';
    }
    if (within(this.homePath(), source)) return 'home-bind';
    return readOnly ? 'readonly-external-bind' : 'external-bind';
  }

  async exportRate(
    client: DockerEngineClient,
    imageId: string,
    signal?: AbortSignal,
  ): Promise<number | null> {
    const started = performance.now();
    const stream = await client.stream('GET', `/images/${encodeURIComponent(imageId)}/get`, {
      signal,
    });
    let bytes = 0;
    try {
      for await (const chunk of stream) {
        bytes += chunk.length;
        if (bytes >= 16 * 1024 * 1024) break;
      }
    } finally {
      stream.destroy();
    }
    return bytes > 0 ? bytes / Math.max(0.001, (performance.now() - started) / 1000) : null;
  }
}

export type DockerAvailabilityReason =
  | 'remote-docker-host'
  | 'unsupported-endpoint'
  | 'no-socket'
  | 'no-socket-access'
  | 'rootless'
  | 'docker-desktop'
  | 'unavailable';
export class DockerAvailabilityError extends DockerEngineError {
  constructor(
    readonly reason: DockerAvailabilityReason,
    message: string,
  ) {
    super('unavailable', message);
  }
}
function availability(error: unknown, reason: DockerAvailabilityReason): DockerAvailabilityError {
  return new DockerAvailabilityError(
    reason,
    error instanceof DockerEngineError ? error.message : 'Home Docker is unavailable.',
  );
}
async function socketAvailability(socket: string, error: unknown): Promise<DockerEngineError> {
  if (!(error instanceof DockerEngineError) || error.code !== 'unavailable')
    return availability(error, 'unavailable');
  try {
    await access(socket, constants.R_OK | constants.W_OK);
    return availability(error, 'unavailable');
  } catch (accessError) {
    const code = (accessError as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM')
      return new DockerAvailabilityError(
        'no-socket-access',
        `This user cannot access the Docker socket ${socket}.`,
      );
    if (code === 'ENOENT')
      return new DockerAvailabilityError('no-socket', `No Docker socket at ${socket}.`);
    return availability(error, 'unavailable');
  }
}
function baseItem(id: string, name: string, kind: DockerPlanItem['kind']): DockerPlanItem {
  return {
    id,
    name,
    kind,
    composeProject: null,
    linkedReasons: [],
    defaultSelected: false,
    selectedMode: null,
    choices: [],
    temporary: false,
    images: [],
    mounts: [],
    writerGroup: [],
    alsoStops: [],
    blockers: [],
    warnings: [],
    notes: [],
    writableLayer: { bytes: 0, unknown: false },
    targetAction: kind === 'compose-project' ? 'data-only' : 'create',
  };
}
function explicitlyNamed(inspect: Container, mount: Mount): boolean {
  const binds = inspect.HostConfig.Binds;
  if (
    Array.isArray(binds) &&
    binds.some(
      (bind) => typeof bind === 'string' && bind.split(':')[0] === mount.Name && bind.includes(':'),
    )
  )
    return true;
  const mounts = inspect.HostConfig.Mounts;
  return (
    Array.isArray(mounts) &&
    mounts.some(
      (value) =>
        value &&
        typeof value === 'object' &&
        value.Type === 'volume' &&
        value.Source === mount.Name,
    )
  );
}
/**
 * Writers of data the import copies: a shared volume, or overlapping project or
 * home binds. Binds outside the home are never copied, and two read-only sides
 * cannot change the data under each other.
 */
function sharesData(a: DockerPlanItem, b: DockerPlanItem): boolean {
  const copied = (mount: DockerPlanMount) => COPYABLE_MOUNT_KINDS.includes(mount.kind);
  const writer = (mount: DockerPlanMount) =>
    copied(mount) || (mount.kind === 'project-code' && !mount.readOnly);
  return a.mounts.some((x) =>
    b.mounts.some((y) => {
      if (x.readOnly && y.readOnly) return false;
      if (!(copied(x) && writer(y)) && !(copied(y) && writer(x))) return false;
      const xv = isVolumeMount(x.kind);
      const yv = isVolumeMount(y.kind);
      return xv && yv
        ? x.source === y.source
        : !xv && !yv && (within(x.source, y.source) || within(y.source, x.source));
    }),
  );
}
