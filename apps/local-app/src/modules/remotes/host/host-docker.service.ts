import { projectCompose } from '../docker/docker-project-compose';
import { DockerArchiveJournal } from '../../core/controllers/docker-archive-journal';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isIPv4 } from 'node:net';
import { basename, join, resolve, dirname, isAbsolute, normalize } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from '../../../common/errors/error-types';
import { assertVmHomePath, inside, nearestExisting } from '../../../common/filesystem/vm-home-path';
import {
  DockerEngineClient,
  DockerEngineError,
  changeDockerContainerState,
  isDockerNotFound,
  optionalDockerJson,
  selectDockerApiVersion,
  DockerVersion,
} from '../../core/controllers/docker-engine.client';
import {
  dockerArchiveLayout,
  readDockerArchive,
  writeDockerArchive,
} from '../../core/controllers/docker-archive';
import { dockerFilesystem } from '../../core/controllers/docker-runtime';
import {
  dockerImageMetadata,
  type DockerImageInspectMetadata,
} from '../../core/controllers/docker-image-metadata';
import {
  ipv4Ranges,
  overlappingIPv4Range,
  projectDockerCreate,
  DockerSettings,
} from '../../core/controllers/docker-settings';
import {
  COMPOSE_PROJECT_LABEL,
  DOCKER_PROJECT_LABEL,
  DockerArchiveRequest,
  DockerContainerCreate,
  DockerNetworkCreate,
  DockerVolumeCreate,
  DockerVolumeHolder,
  DockerCapacityResult,
  DockerHolderMetadata,
  DockerInspectTimes,
  DockerScanResult,
  DockerArchiveWriteResult,
  DockerBindPrepare,
  DockerImageLoadResult,
} from './host-docker.dto';
import { HOST_IPV4_ROUTES, readHostIPv4Routes, type HostIPv4RouteReader } from './host-ipv4-routes';

type Labels = Record<string, string>;
type Volume = { Name: string; Labels?: Labels };
type MatchedImage = { ref: string; id: string; metadata: Record<string, unknown> };
type Container = {
  Id: string;
  Config: { Labels?: Labels };
  Mounts?: Array<{ Type: string; Name?: string }>;
};

@Injectable()
export class HostDockerService {
  constructor(
    private readonly archives: DockerArchiveJournal,
    @Optional()
    @Inject(HOST_IPV4_ROUTES)
    private readonly routes: HostIPv4RouteReader = readHostIPv4Routes,
  ) {}
  async version(signal?: AbortSignal): Promise<DockerVersion> {
    return (await DockerEngineClient.connect(signal)).version(signal);
  }
  private async engine(signal?: AbortSignal, apiVersion?: string): Promise<DockerEngineClient> {
    const client = await DockerEngineClient.connect(signal);
    if (apiVersion)
      client.apiVersion = selectDockerApiVersion(await client.version(signal), {
        ApiVersion: apiVersion,
        MinAPIVersion: apiVersion,
      });
    return client;
  }

  async scan(
    paths: string[],
    signal?: AbortSignal,
    apiVersion?: string,
    holderVolumes?: string[],
    networkNames?: string[],
  ): Promise<DockerScanResult> {
    const client = await this.engine(signal, apiVersion);
    const info = client.connectedInfo ?? (await client.info(signal));
    if (!info.Architecture)
      throw new DockerEngineError('invalid-response', 'Docker architecture is unavailable');
    const containers = await client.json<
      Array<{
        Id: string;
        ImageID?: string;
        Names: string[];
        Labels?: Labels;
        Mounts?: Array<{ Type: string; Name?: string; Source?: string; Destination: string }>;
      }>
    >('GET', '/containers/json?all=true', undefined, { signal });
    const volumes = await client.json<{
      Volumes: Array<{ Name: string; Driver: string; Labels?: Labels }> | null;
    }>('GET', '/volumes', undefined, { signal });
    let networks: DockerScanResult['networks'];
    let routes: DockerScanResult['routes'];
    if (networkNames) {
      const listed = await client.json<
        Array<{ Name: string; IPAM?: { Config?: Array<{ Subnet?: string }> } }>
      >('GET', '/networks', undefined, { signal });
      networks = await Promise.all(
        listed.map(async (network) => {
          const subnets = ipv4Ranges(network.IPAM?.Config).map((range) => range.Subnet);
          if (!networkNames.includes(network.Name)) return { name: network.Name, subnets };
          const inspect = await client.json<{
            Containers?: Record<string, { Name: string; IPv4Address?: string }>;
          }>('GET', `/networks/${encodeURIComponent(network.Name)}`, undefined, { signal });
          const addresses = Object.entries(inspect.Containers ?? {}).flatMap(
            ([containerId, endpoint]) => {
              const address = endpoint.IPv4Address?.split('/')[0];
              return address && isIPv4(address)
                ? [{ address, containerId, containerName: endpoint.Name.replace(/^\//, '') }]
                : [];
            },
          );
          return { name: network.Name, subnets, addresses };
        }),
      );
      routes = await this.routes(signal);
    }
    const existence: DockerScanResult['paths'] = [];
    for (const path of paths) {
      signal?.throwIfAborted();
      try {
        const stats = await stat(path);
        existence.push(
          stats.isFile() ? { path, exists: true, file: true } : { path, exists: true },
        );
      } catch (error) {
        existence.push(
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? { path, exists: false }
            : { path, unknown: true },
        );
      }
    }
    const metadata = new Map<string, DockerHolderMetadata>();
    if (holderVolumes) {
      const holders = containers.filter((container) =>
        container.Mounts?.some(
          (m) =>
            (m.Type === 'volume' && m.Name && holderVolumes.includes(m.Name)) ||
            (m.Type === 'bind' &&
              m.Source &&
              paths.some((p) => inside(p, m.Source!) || inside(m.Source!, p))),
        ),
      );
      await Promise.all(
        holders.map(async (container) => {
          try {
            const inspect = await client.json<DockerInspectTimes>(
              'GET',
              `/containers/${encodeURIComponent(container.Id)}/json`,
              undefined,
              { signal },
            );
            metadata.set(container.Id, {
              created: inspect.Created,
              startedAt: inspect.State?.StartedAt,
              running: inspect.State?.Running,
            });
          } catch {
            signal?.throwIfAborted();
            metadata.set(container.Id, {});
          }
        }),
      );
    }
    signal?.throwIfAborted();
    return {
      architecture: info.Architecture,
      containers: containers.map((container) => ({
        id: container.Id,
        ...(container.ImageID ? { image: container.ImageID } : {}),
        ...(metadata.has(container.Id) && { metadata: metadata.get(container.Id) }),
        name: container.Names[0]?.replace(/^\//, '') ?? container.Id,
        labels: container.Labels ?? {},
        mounts: (container.Mounts ?? []).map((mount) => ({
          type: mount.Type,
          ...(mount.Name ? { name: mount.Name } : {}),
          ...(mount.Source ? { source: mount.Source } : {}),
          destination: mount.Destination,
        })),
      })),
      volumes: (volumes.Volumes ?? []).map((volume) => ({
        name: volume.Name,
        driver: volume.Driver,
        labels: volume.Labels ?? {},
      })),
      paths: existence,
      ...(networks ? { networks, routes } : {}),
    };
  }

  async capacity(paths: string[], signal?: AbortSignal): Promise<DockerCapacityResult> {
    const home = homedir();
    if (
      paths.some(
        (path) =>
          !isAbsolute(path) ||
          normalize(path) !== path ||
          path.includes('\0') ||
          !inside(path, home),
      )
    )
      throw new AppError(
        'Capacity paths must be absolute normalized paths under VM home',
        'DOCKER_BIND_OUTSIDE_HOME',
        403,
      );
    const results: DockerCapacityResult['paths'] = [];
    // Resolved once; if it cannot be resolved, every path reports unknown, as before.
    const canonicalHome = await realpath(home).catch(() => null);
    for (const path of paths) {
      signal?.throwIfAborted();
      try {
        if (canonicalHome === null) throw new Error();
        const resolved = await realpath(await nearestExisting(path, home));
        if (!inside(resolved, canonicalHome)) throw new Error();
        const sample = await dockerFilesystem(resolved);
        if (!sample || !Number.isFinite(sample.freeBytes) || sample.freeBytes < 0)
          throw new Error();
        results.push({ ...sample, path });
      } catch {
        results.push({ path, unknown: true });
      }
    }
    signal?.throwIfAborted();
    return { paths: results };
  }

  async imagesPresent(
    ids: string[],
    signal?: AbortSignal,
    apiVersion?: string,
  ): Promise<{ ids: string[] }> {
    const client = await this.engine(signal, apiVersion);
    const present: string[] = [];
    for (const id of new Set(ids)) {
      try {
        await client.json('GET', `/images/${encodeURIComponent(id)}/json`, undefined, { signal });
        present.push(id);
      } catch (error) {
        if (!isDockerNotFound(error)) throw error;
      }
    }
    return { ids: present };
  }

  async matchImages(
    refs: string[],
    signal?: AbortSignal,
    apiVersion?: string,
  ): Promise<{ images: MatchedImage[] }> {
    const client = await this.engine(signal, apiVersion);
    const images: MatchedImage[] = [];
    for (const ref of new Set(refs)) {
      const image = await optionalDockerJson<DockerImageInspectMetadata & { Id: string }>(
        client,
        `/images/${encodeURIComponent(ref)}/json`,
        signal,
      );
      if (image) images.push({ ref, id: image.Id, metadata: dockerImageMetadata(image) });
    }
    return { images };
  }

  async loadImage(
    body: Readable,
    signal?: AbortSignal,
    apiVersion?: string,
  ): Promise<DockerImageLoadResult> {
    const client = await this.engine(signal, apiVersion);
    const references = await uploadToEngine(body, (toEngine) =>
      this.loadReferences(client, toEngine, signal),
    );
    const images = new Map<string, { id: string; layers: string[]; references: string[] }>();
    for (const reference of references) {
      const inspect = await optionalDockerJson<{
        Id: string;
        RootFS?: { Layers?: string[] };
      }>(client, `/images/${encodeURIComponent(reference)}/json`, signal);
      // A reference the engine no longer resolves is skipped; the caller decides
      // what an empty list means.
      if (!inspect?.Id) continue;
      const image = images.get(inspect.Id) ?? {
        id: inspect.Id,
        layers: inspect.RootFS?.Layers ?? [],
        references: [],
      };
      if (!image.references.includes(reference)) image.references.push(reference);
      images.set(inspect.Id, image);
    }
    return { images: [...images.values()] };
  }

  /** The tags and IDs the engine names as it loads the archive. */
  private async loadReferences(
    client: DockerEngineClient,
    archive: Readable,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const response = await client.stream('POST', '/images/load?quiet=1', {
      body: archive,
      headers: { 'Content-Type': 'application/x-tar' },
      signal,
    });
    const references: string[] = [];
    let line = '';
    const consume = (value: string) => {
      if (!value.trim()) return;
      let message: { error?: unknown; errorDetail?: unknown; stream?: unknown };
      try {
        message = JSON.parse(value);
      } catch {
        throw new DockerEngineError('invalid-response', 'Invalid Docker image load response');
      }
      if (message.error || message.errorDetail)
        throw new DockerEngineError('engine-error', 'Docker image load failed');
      if (typeof message.stream !== 'string') return;
      // Both image stores print these lines, also with quiet=1: the text after the
      // prefix is a tag, or the ID the engine gave an untagged image — the only way
      // to learn an ID that differs from the archive's on a containerd-store engine.
      for (const prefix of ['Loaded image: ', 'Loaded image ID: ']) {
        if (!message.stream.startsWith(prefix)) continue;
        const reference = message.stream.slice(prefix.length).replace(/\n$/, '');
        if (reference) references.push(reference);
      }
    };
    try {
      for await (const chunk of response) {
        line += chunk.toString('utf8');
        let newline: number;
        while ((newline = line.indexOf('\n')) >= 0) {
          consume(line.slice(0, newline));
          line = line.slice(newline + 1);
        }
        if (line.length > 1024 * 1024)
          throw new DockerEngineError(
            'invalid-response',
            'Docker image load response exceeds limit',
          );
      }
      consume(line);
    } finally {
      response.destroy();
    }
    return references;
  }

  async saveImage(id: string, signal?: AbortSignal, apiVersion?: string): Promise<Readable> {
    const client = await this.engine(signal, apiVersion);
    return client.stream('GET', `/images/${encodeURIComponent(id)}/get`, { signal });
  }

  async createVolume(
    input: DockerVolumeCreate,
    signal?: AbortSignal,
    apiVersion?: string,
  ): Promise<Volume> {
    const client = await this.engine(signal, apiVersion);
    const old = await optionalDockerJson<Volume>(
      client,
      `/volumes/${encodeURIComponent(input.name)}`,
      signal,
    );
    if (old) {
      this.requireOwner(old.Labels, input.projectId, true);
      return { Name: old.Name, Labels: old.Labels };
    }
    const created = await client.json<Volume>(
      'POST',
      '/volumes/create',
      { Name: input.name, Labels: { ...input.labels, [DOCKER_PROJECT_LABEL]: input.projectId } },
      { signal },
    );
    this.requireOwner(created.Labels, input.projectId, true);
    return { Name: created.Name, Labels: created.Labels };
  }

  async createNetwork(
    input: DockerNetworkCreate,
    signal?: AbortSignal,
    apiVersion?: string,
  ): Promise<{ Id: string; created: boolean }> {
    const client = await this.engine(signal, apiVersion);
    const old = await optionalDockerJson<{ Id: string; Labels?: Labels }>(
      client,
      `/networks/${encodeURIComponent(input.name)}`,
      signal,
    );
    if (old) {
      // A shared network serves every project that names it, whichever import made it.
      if (!input.shared) this.requireOwner(old.Labels, input.projectId, true);
      return { Id: old.Id, created: false };
    }
    if (input.ipam) {
      const overlap = overlappingIPv4Range(
        input.ipam.Config.map((range) => range.Subnet),
        await this.routes(signal),
      );
      if (overlap)
        throw new AppError(
          `Network ${input.name} home range overlaps VM on-link route ${overlap}. Change the network range on the PC, then connect again.`,
          'DOCKER_NETWORK_ROUTE_OVERLAP',
          409,
        );
    }
    const created = await client.json<{ Id: string }>(
      'POST',
      '/networks/create',
      {
        Name: input.name,
        Driver: 'bridge',
        Internal: input.internal,
        Attachable: input.attachable,
        Options: input.options,
        ...(input.ipam ? { IPAM: input.ipam } : {}),
        // No project owns a shared network, so no project can delete it.
        Labels: input.shared
          ? input.labels
          : { ...input.labels, [DOCKER_PROJECT_LABEL]: input.projectId },
      },
      { signal },
    );
    return { Id: created.Id, created: true };
  }

  async createContainer(
    input: DockerContainerCreate,
    signal?: AbortSignal,
    apiVersion?: string,
  ): Promise<{ Id: string }> {
    const { HostConfig = {}, NetworkingConfig = {}, ...config } = input.config;
    if (typeof config.Image !== 'string')
      throw new AppError('Container image is required', 'DOCKER_INVALID_SETTINGS', 400);
    const network = NetworkingConfig as { EndpointsConfig?: Record<string, DockerSettings> };
    if (Object.keys(network).some((key) => key !== 'EndpointsConfig'))
      throw new AppError('Unsupported network settings', 'DOCKER_INVALID_SETTINGS', 400);
    const projected = projectDockerCreate({
      Config: config,
      HostConfig: HostConfig as DockerSettings,
      Image: config.Image,
      NetworkSettings: { Networks: network.EndpointsConfig },
    });
    projected.Labels = {
      ...(config.Labels as Labels | undefined),
      [DOCKER_PROJECT_LABEL]: input.projectId,
    };
    const client = await this.engine(signal, apiVersion);
    return client.json(
      'POST',
      `/containers/create?name=${encodeURIComponent(input.name)}`,
      projected,
      { signal },
    );
  }

  async holders(
    name: string,
    signal?: AbortSignal,
    apiVersion?: string,
  ): Promise<{ holders: DockerVolumeHolder[] }> {
    const client = await this.engine(signal, apiVersion);
    const containers = await client.json<
      Array<{ Id: string; Labels?: Labels; Mounts?: Array<{ Type: string; Name?: string }> }>
    >(
      'GET',
      `/containers/json?all=true&filters=${encodeURIComponent(JSON.stringify({ volume: [name] }))}`,
      undefined,
      { signal },
    );
    return {
      holders: containers
        .filter((container) =>
          container.Mounts?.some((mount) => mount.Type === 'volume' && mount.Name === name),
        )
        .map((container) => ({ id: container.Id, labels: container.Labels ?? {} })),
    };
  }

  async remove(
    kind: 'volumes' | 'containers' | 'networks',
    id: string,
    projectId: string,
    signal?: AbortSignal,
    apiVersion?: string,
    projectRoot?: string,
  ): Promise<void> {
    await this.validateProjectRoot(projectRoot);
    const client = await this.engine(signal, apiVersion);
    const resource = await client.json<Container & { Labels?: Labels }>(
      'GET',
      `/${kind}/${encodeURIComponent(id)}${kind === 'containers' ? '/json' : ''}`,
      undefined,
      { signal },
    );
    const labels = kind === 'containers' ? resource.Config.Labels : resource.Labels;
    if (labels?.[DOCKER_PROJECT_LABEL] !== projectId) {
      if (
        kind !== 'containers' ||
        labels?.[DOCKER_PROJECT_LABEL] !== undefined ||
        !(await this.composeHolder(client, resource, projectId, signal, projectRoot))
      )
        this.requireOwner(labels, projectId);
    }
    const exactId = kind === 'volumes' ? id : resource.Id;
    if (!exactId)
      throw new DockerEngineError('invalid-response', 'Docker resource identity is missing');
    // A graceful stop first: removing a running database container with force kills it mid-write.
    if (kind === 'containers') await changeDockerContainerState(client, exactId, 'stop', signal);
    await client.json('DELETE', `/${kind}/${encodeURIComponent(exactId)}`, undefined, { signal });
  }

  /** The digest covers the bytes received, so the sender can verify the whole transfer. */
  async writeArchive(
    input: DockerArchiveRequest,
    body: Readable,
    signal?: AbortSignal,
    apiVersion?: string,
  ): Promise<DockerArchiveWriteResult> {
    const client = await this.engine(signal, apiVersion);
    const source = await this.archiveSource(client, input, signal);
    const layout = dockerArchiveLayout(input.mountType, source);
    const helper = await this.archives.create(client, input.image, [layout.mount], signal);
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      // The digest covers the whole upload, also the bytes after the engine stopped reading.
      await uploadToEngine(
        body,
        (toEngine) => writeDockerArchive(client, helper.id, toEngine, signal, layout.writePath),
        (chunk) => {
          hash.update(chunk);
          bytes += chunk.length;
        },
      );
    } finally {
      await this.archives.cleanup(client, helper);
    }
    return { sha256: hash.digest('hex'), bytes };
  }

  /**
   * Creates bind destinations as this (the VM) user. `replace` empties a data
   * subtree first, so a reconnect leaves no VM-only files; the caller chooses
   * only subtrees it owns, and the home folder itself is never replaced.
   * `copyUIDGID=false` preserves archive owners, so emptying runs as root in the clear helper.
   * A single `file` gets only its folder: the restore writes the file and replaces
   * whatever is at its path.
   */
  async prepareBinds(
    input: DockerBindPrepare,
    signal?: AbortSignal,
    apiVersion?: string,
  ): Promise<void> {
    for (const { path, replace, image, file } of input.paths) {
      signal?.throwIfAborted();
      const { existing, resolved } = await assertVmHomePath(path, {
        code: 'DOCKER_BIND_OUTSIDE_HOME',
        message: 'Bind paths must be under the VM home',
        linkMessage: 'Bind paths must not be links',
      });
      if (file) {
        await mkdir(dirname(path), { recursive: true });
        continue;
      }
      if (replace && existing === path) {
        if (!(await lstat(resolved)).isDirectory()) await rm(path, { force: true });
        // A folder this user cannot list (a service's 0700 data folder) is not empty.
        else if (
          !(await readdir(resolved).then(
            (entries) => entries.length === 0,
            () => false,
          ))
        )
          await this.clearBind(path, resolved, image!, signal, apiVersion);
      }
      await mkdir(path, { recursive: true });
    }
  }

  private async clearBind(
    path: string,
    target: string,
    image: string,
    signal?: AbortSignal,
    apiVersion?: string,
  ): Promise<void> {
    try {
      await this.archives.clearBind(await this.engine(signal, apiVersion), image, target, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new AppError(
        `The VM folder ${path} could not be emptied for the fresh copy. Empty it on the VM (for example, sudo rm -rf ${path}/*) and press Retry, or Cancel.`,
        'DOCKER_BIND_CLEAR_FAILED',
        422,
      );
    }
  }

  /** Stops the project's DevChain-labelled containers; nothing else on the engine. */
  async stopProject(
    projectId: string,
    signal?: AbortSignal,
    apiVersion?: string,
  ): Promise<{ stopped: string[] }> {
    const client = await this.engine(signal, apiVersion);
    const filters = JSON.stringify({
      label: [`${DOCKER_PROJECT_LABEL}=${projectId}`],
      status: ['running', 'restarting', 'paused'],
    });
    const running = await client.json<Array<{ Id: string; Labels?: Labels }>>(
      'GET',
      `/containers/json?filters=${encodeURIComponent(filters)}`,
      undefined,
      { signal },
    );
    const stopped: string[] = [];
    for (const container of running) {
      if (container.Labels?.[DOCKER_PROJECT_LABEL] !== projectId) continue;
      await changeDockerContainerState(client, container.Id, 'stop', signal);
      stopped.push(container.Id);
    }
    return { stopped };
  }

  /**
   * Stops a container with the project's DevChain label, project-root Compose
   * labels, or a Compose project that owns an imported volume.
   */
  async stopContainer(
    id: string,
    projectId: string,
    signal?: AbortSignal,
    apiVersion?: string,
    projectRoot?: string,
  ): Promise<void> {
    await this.validateProjectRoot(projectRoot);
    const client = await this.engine(signal, apiVersion);
    const container = await client.json<Container>(
      'GET',
      `/containers/${encodeURIComponent(id)}/json`,
      undefined,
      { signal },
    );
    const labels = container.Config.Labels ?? {};
    if (labels[DOCKER_PROJECT_LABEL] !== projectId) {
      const owned =
        labels[DOCKER_PROJECT_LABEL] === undefined &&
        (await this.composeOwnsProjectVolume(client, labels, projectId, signal, projectRoot));
      if (!owned) this.requireOwner(labels, projectId);
    }
    await changeDockerContainerState(client, container.Id, 'stop', signal);
  }

  async readArchive(
    input: DockerArchiveRequest,
    signal?: AbortSignal,
    apiVersion?: string,
  ): Promise<Readable> {
    const client = await this.engine(signal, apiVersion);
    const source = await this.archiveSource(client, input, signal);
    const layout = dockerArchiveLayout(input.mountType, source);
    const helper = await this.archives.create(
      client,
      input.image,
      [{ ...layout.mount, ReadOnly: true }],
      signal,
    );
    let archive: Readable;
    try {
      archive = await readDockerArchive(client, helper.id, signal, layout.readPath);
    } catch (error) {
      await this.archives.cleanup(client, helper);
      throw error;
    }
    const output = new PassThrough();
    void (async () => {
      try {
        await pipeline(archive, output, { end: false });
        await this.archives.cleanup(client, helper);
        output.end();
      } catch {
        await this.archives.cleanup(client, helper).catch(() => undefined);
        output.destroy(new DockerEngineError('unavailable', 'Docker archive transfer failed'));
      }
    })();
    return output;
  }

  private async validateProjectRoot(root: string | undefined): Promise<void> {
    if (root === undefined) return;
    const code = 'DOCKER_PROJECT_ROOT_INVALID';
    if (!isAbsolute(root) || normalize(root) !== root || root.includes('\0'))
      throw new AppError('Project root must be an absolute, normalized path', code, 400);
    try {
      await assertVmHomePath(root, {
        code,
        message: 'Project root must be below the VM home and cannot be the home itself',
        linkMessage: 'Project root must not be a link',
      });
    } catch (error) {
      if (error instanceof AppError) throw new AppError(error.message, code, 400);
      throw error;
    }
  }

  private requireOwner(labels: Labels | undefined, projectId: string, conflict = false): void {
    if (labels?.[DOCKER_PROJECT_LABEL] !== projectId)
      throw new AppError(
        'Docker resource is not owned by this imported project',
        'DOCKER_OWNERSHIP_REQUIRED',
        conflict ? 409 : 403,
      );
  }
  /** Compose labels link to this project, or its Compose project owns an imported volume. */
  private async composeOwnsProjectVolume(
    client: DockerEngineClient,
    labels: Labels,
    projectId: string,
    signal?: AbortSignal,
    projectRoot?: string,
  ): Promise<boolean> {
    if (projectRoot && projectCompose(labels, projectRoot, projectId)) return true;
    const compose = labels[COMPOSE_PROJECT_LABEL];
    if (!compose) return false;
    const { Volumes } = await client.json<{ Volumes: Volume[] | null }>(
      'GET',
      `/volumes?filters=${encodeURIComponent(JSON.stringify({ label: [`${DOCKER_PROJECT_LABEL}=${projectId}`] }))}`,
      undefined,
      { signal },
    );
    return (
      Volumes?.some(
        (volume) =>
          volume.Labels?.[DOCKER_PROJECT_LABEL] === projectId &&
          volume.Labels?.[COMPOSE_PROJECT_LABEL] === compose,
      ) ?? false
    );
  }

  private async composeHolder(
    client: DockerEngineClient,
    container: Container,
    projectId: string,
    signal?: AbortSignal,
    projectRoot?: string,
  ): Promise<boolean> {
    if (projectRoot && projectCompose(container.Config.Labels ?? {}, projectRoot, projectId))
      return true;
    const compose = container.Config.Labels?.[COMPOSE_PROJECT_LABEL];
    if (!compose) return false;
    for (const mount of container.Mounts ?? []) {
      if (mount.Type !== 'volume' || !mount.Name) continue;
      const volume = await client.json<Volume>(
        'GET',
        `/volumes/${encodeURIComponent(mount.Name)}`,
        undefined,
        { signal },
      );
      if (
        volume.Labels?.[DOCKER_PROJECT_LABEL] === projectId &&
        volume.Labels?.[COMPOSE_PROJECT_LABEL] === compose
      )
        return true;
    }
    return false;
  }
  private async archiveSource(
    client: DockerEngineClient,
    input: DockerArchiveRequest,
    signal?: AbortSignal,
  ): Promise<string> {
    if (input.mountType === 'volume') {
      const volume = await client.json<Volume>(
        'GET',
        `/volumes/${encodeURIComponent(input.source)}`,
        undefined,
        { signal },
      );
      this.requireOwner(volume.Labels, input.projectId);
      return volume.Name;
    }
    try {
      // A restored file need not exist yet; its folder must.
      const file = input.mountType === 'file';
      const requested = resolve(input.source);
      const [home, resolved] = await Promise.all([
        realpath(homedir()),
        realpath(file ? dirname(requested) : requested),
      ]);
      if (!inside(resolved, home)) throw new Error();
      return file ? join(resolved, basename(requested)) : resolved;
    } catch {
      throw new AppError(
        'Bind archive paths must exist under the VM home',
        'DOCKER_BIND_OUTSIDE_HOME',
        403,
      );
    }
  }
}

/**
 * Sends an upload to the engine through a buffer, never the request itself. The
 * engine may answer at the tar's end marker and stop reading: the rest of the
 * upload is still read, so the request ends normally and the engine's answer is
 * the outcome. Piping the request straight in would end it early, which aborts
 * the request and turns the engine's answer into "cancelled".
 */
async function uploadToEngine<T>(
  body: Readable,
  send: (toEngine: Readable) => Promise<T>,
  onChunk?: (chunk: Buffer) => void,
): Promise<T> {
  const toEngine = new PassThrough();
  const received = (async () => {
    for await (const chunk of body as AsyncIterable<Buffer>) {
      onChunk?.(chunk);
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
    const [answer] = await Promise.all([
      send(toEngine).catch((error: unknown) => {
        body.destroy();
        throw error;
      }),
      received,
    ]);
    return answer;
  } catch (error) {
    toEngine.destroy();
    await received.catch(() => undefined);
    throw error;
  }
}
