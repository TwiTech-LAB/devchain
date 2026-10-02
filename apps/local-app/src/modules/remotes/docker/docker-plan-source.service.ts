import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
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
  projectDockerCreate,
  type DockerContainerInspect,
} from '../../core/controllers/docker-settings';
import { COMPOSE_PROJECT_LABEL, type DockerInspectTimes } from '../host/host-docker.dto';
import type { DockerDataHolder } from './docker-data-groups';
import { measureDockerBind, within } from './docker-plan-files';
import {
  COPYABLE_MOUNT_KINDS,
  DOCKER_TEMPORARY_NOTE,
  DOCKER_WRITABLE_LAYER_NOTE,
  isVolumeMount,
  type DockerPlanItem,
  type DockerPlanImage,
  type DockerPlanMount,
  type DockerPlanSize,
} from './docker-plan.dto';

interface Mount {
  Type: string;
  Name?: string;
  Source: string;
  Destination: string;
  RW: boolean;
  Driver?: string;
}
interface Container extends DockerContainerInspect, DockerInspectTimes {
  Id: string;
  Name: string;
  Mounts: Mount[];
}
interface Volume {
  Name: string;
  Driver: string;
  Labels?: Record<string, string> | null;
}
interface ComposeConfig {
  name: string;
  services?: Record<string, { image?: string; build?: unknown }>;
  volumes?: Record<string, { name?: string; external?: boolean }>;
}
export interface DockerSourceScan {
  holders: DockerDataHolder[];
  items: DockerPlanItem[];
  homePath: string;
  uid: number | null;
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
  /**
   * The disk usage and folder sizes of the last scan. The disk-usage answer walks
   * every image, volume and build-cache entry, which takes seconds on a busy engine.
   */
  private recent: {
    at: number;
    usage: DockerDiskUsage;
    folders: Map<string, DockerPlanSize>;
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
  socket(): Promise<string> {
    return resolveDockerSocket();
  }
  homePath(): string {
    return homedir();
  }
  uid(): number | null {
    return process.getuid?.() ?? null;
  }
  measure(path: string, signal?: AbortSignal): Promise<DockerPlanSize> {
    return measureDockerBind(path, undefined, signal);
  }

  async compose(root: string): Promise<ComposeConfig | null> {
    let file: string | undefined;
    for (const name of [
      'compose.yaml',
      'compose.yml',
      'docker-compose.yml',
      'docker-compose.yaml',
    ]) {
      if (
        await access(join(root, name)).then(
          () => true,
          () => false,
        )
      ) {
        file = name;
        break;
      }
    }
    if (!file) return null;
    return new Promise((resolveConfig, reject) => {
      execFile(
        'docker',
        ['compose', '--project-directory', root, 'config', '--format', 'json'],
        { cwd: root, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
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
    });
  }

  /**
   * `reuse` takes the disk usage and folder sizes of a scan less than two minutes
   * old; containers, images and Compose are always read again.
   */
  async scan(
    client: DockerEngineClient,
    root: string,
    signal?: AbortSignal,
    { reuse = false }: { reuse?: boolean } = {},
  ): Promise<DockerSourceScan> {
    const recent = reuse && this.recent && reusable(this.recent.at) ? this.recent : null;
    const [listed, usage, volumes, composeAttempt] = await Promise.all([
      client.json<Array<{ Id: string }>>('GET', '/containers/json?all=true', undefined, { signal }),
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
    const inspects = await Promise.all(
      listed.map((entry) =>
        client.json<Container>(
          'GET',
          `/containers/${encodeURIComponent(entry.Id)}/json`,
          undefined,
          { signal },
        ),
      ),
    );
    for (const inspect of inspects) {
      const item = baseItem(inspect.Id, inspect.Name.replace(/^\//, ''), 'container');
      const labels = (inspect.Config.Labels ?? {}) as Record<string, string>;
      item.composeProject = labels[COMPOSE_PROJECT_LABEL] ?? null;
      item.temporary = inspect.HostConfig.AutoRemove === true;
      if (item.temporary) item.notes.push(DOCKER_TEMPORARY_NOTE);
      item.notes.push(DOCKER_WRITABLE_LAYER_NOTE);
      for (const key of [
        `${COMPOSE_PROJECT_LABEL}.working_dir`,
        `${COMPOSE_PROJECT_LABEL}.config_files`,
      ]) {
        if (labels[key]?.split(',').some((path) => path.startsWith('/') && within(root, path)))
          item.linkedReasons.push(key);
      }
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
      item.writableLayer = size(usage.Containers?.find((c) => c.Id === inspect.Id)?.SizeRw);
      const user = String(inspect.Config.User ?? '').split(':')[0];
      if (this.uid() !== null && user === String(this.uid()))
        item.warnings.push({ code: 'home-uid', message: 'Container runs as the home user uid.' });
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
          const kind = this.bindKind(root, source, !mount.RW);
          if (kind === 'project-bind') item.linkedReasons.push(`bind:${source}`);
          // Only binds the import copies are measured: walking an unrelated
          // container's `/` read-only mount can take longer than every plan.
          const copyable = COPYABLE_MOUNT_KINDS.includes(kind);
          if (copyable && !bindCache.has(source))
            bindCache.set(source, await this.measure(source, signal));
          item.mounts.push({
            kind,
            source,
            destination: mount.Destination,
            readOnly: !mount.RW,
            size: copyable ? (bindCache.get(source) ?? unknownSize()) : unknownSize(),
          });
        }
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
    this.recent = { at: recent?.at ?? Date.now(), usage, folders };
    return {
      items,
      homePath: this.homePath(),
      uid: this.uid(),
      holders: inspects.map((c) => ({
        volumes: (c.Mounts ?? []).filter((m) => m.Type === 'volume').map((m) => m.Name ?? m.Source),
        bindPaths: (c.Mounts ?? []).filter((m) => m.Type === 'bind').map((m) => m.Source),
        metadata: { created: c.Created, startedAt: c.State?.StartedAt, running: c.State?.Running },
      })),
    };
  }

  private bindKind(root: string, source: string, readOnly: boolean): DockerPlanMount['kind'] {
    if (within(root, source)) return 'project-bind';
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
  return a.mounts.some(
    (x) =>
      copied(x) &&
      b.mounts.some((y) => {
        if (!copied(y) || (x.readOnly && y.readOnly)) return false;
        const xv = isVolumeMount(x.kind);
        const yv = isVolumeMount(y.kind);
        return xv && yv
          ? x.source === y.source
          : !xv && !yv && (within(x.source, y.source) || within(y.source, x.source));
      }),
  );
}
