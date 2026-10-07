import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

type Labels = Record<string, string>;
type FakeImage = {
  architecture: string;
  tags: string[];
  size: number;
  layers?: string[];
  metadata?: Record<string, unknown>;
};
/** The line that names a single file in a fake archive. */
export const FILE_ENTRY = 'FILE:';
export interface FakeMount {
  Type: 'volume' | 'bind';
  Name?: string;
  Source: string;
  Destination: string;
  RW: boolean;
}
export interface FakeContainer {
  Id: string;
  Name: string;
  Image: string;
  Config: Record<string, unknown> & { Labels?: Labels };
  HostConfig: Record<string, unknown>;
  NetworkSettings?: { Networks?: Record<string, Record<string, unknown>> };
  Mounts: FakeMount[];
  /** Inspect metadata the change check reads; absent unless a test sets it. */
  Created?: string;
  SizeRw?: number;
  SizeRootFs?: number;
  State: { Running: boolean; StartedAt?: string };
  /** The raw create body, for assertions on what the VM received. */
  created?: Record<string, unknown>;
}
export interface FakeDockerEngineOptions {
  /**
   * `containerd` registers a loaded image under an ID derived from its manifest,
   * not the config-digest ID the save archive carries — the behavior that makes
   * cross-store image IDs differ on real engines.
   */
  imageStore?: 'classic' | 'containerd';
}

/**
 * A stateful Docker Engine over a Unix socket: containers, volumes, networks,
 * images and archive I/O. Volume and bind data are opaque byte strings, so a
 * test can follow data across engines without real tar handling. A single
 * file travels as `FILE:<name>` on its own line before its bytes.
 */
export class FakeDockerEngine {
  readonly containers = new Map<string, FakeContainer>();
  readonly volumes = new Map<string, { labels: Labels; driver: string }>();
  readonly networks = new Map<
    string,
    {
      labels: Labels;
      driver: string;
      internal: boolean;
      ipam?: { Config: Array<{ Subnet: string; Gateway?: string; IPRange?: string }> };
    }
  >();
  readonly images = new Map<string, FakeImage>();
  /** Data by volume name or bind path. */
  readonly data = new Map<string, Buffer>();
  readonly calls: string[] = [];
  /** Returns true when it answered the request itself. */
  intercept?: (method: string, path: string, res: ServerResponse) => boolean;
  /** Exit code of the bind clear helper (`find /target -mindepth 1 -delete`). */
  clearExitCode = 0;
  /** The request takes effect but its answer is lost (the connection drops). */
  loseResponse?: (method: string, path: string, search: URLSearchParams) => boolean;
  private server?: Server;
  private sequence = 0;
  private readonly imageStore: 'classic' | 'containerd';

  constructor(
    readonly engineId: string,
    options: FakeDockerEngineOptions = {},
  ) {
    this.imageStore = options.imageStore ?? 'classic';
  }

  async listen(socket: string): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        res.statusCode = 500;
        res.end('{}');
      });
    });
    this.server.listen(socket);
    await once(this.server, 'listening');
  }
  async close(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  addContainer(
    container: Omit<FakeContainer, 'State'> & { running?: boolean; startedAt?: string },
  ): void {
    const { running, startedAt, ...rest } = container;
    this.containers.set(container.Id, {
      ...rest,
      State: { Running: running ?? false, ...(startedAt && { StartedAt: startedAt }) },
    });
  }

  private find(idOrName: string): FakeContainer | undefined {
    return (
      this.containers.get(idOrName) ??
      [...this.containers.values()].find((c) => c.Name === `/${idOrName}`)
    );
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url!, 'http://engine');
    const method = req.method!;
    const path = decodeURIComponent(url.pathname).replace(/^\/v\d+\.\d+/, '');
    this.calls.push(`${method} ${path}`);
    if (this.intercept?.(method, path, res)) return;
    const lost = () => {
      if (!this.loseResponse?.(method, path, url.searchParams)) return false;
      req.socket.destroy();
      return true;
    };
    const json = (value: unknown, status = 200) => {
      if (lost()) return;
      res.statusCode = status;
      res.end(JSON.stringify(value));
    };
    const empty = (status = 204) => {
      if (lost()) return;
      res.statusCode = status;
      res.end();
    };
    const body = async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks);
    };

    if (path === '/info')
      return json({
        ID: this.engineId,
        Architecture: 'x86_64',
        Driver: 'overlay2',
        DockerRootDir: '/var/lib/docker',
        SecurityOptions: [],
      });
    if (path === '/version') return json({ ApiVersion: '1.47', MinAPIVersion: '1.24' });
    if (path === '/system/df') {
      const types = url.searchParams.getAll('type');
      const includes = (type: string) => !types.length || types.includes(type);
      return json({
        ...(includes('container') && {
          Containers: [...this.containers.values()].map((c) => ({
            Id: c.Id,
            SizeRw: c.SizeRw ?? 7,
          })),
        }),
        ...(includes('image') && {
          Images: [...this.images].map(([Id, image]) => ({ Id, Size: image.size })),
        }),
        ...(includes('volume') && {
          Volumes: [...this.volumes.keys()].map((Name) => ({
            Name,
            UsageData: { Size: this.data.get(Name)?.length ?? 0, RefCount: 0 },
          })),
        }),
        ...(includes('build-cache') && { BuildCache: [] }),
      });
    }

    if (path === '/images/load' && method === 'POST') {
      const text = (await body()).toString('utf8');
      const matches = [...text.matchAll(/^IMAGE:([^\n]+)\n/gm)];
      if (!matches.length) return json({ error: 'bad archive' });
      const lines: string[] = [];
      for (const match of matches) {
        const [id, tags = '', layers = '', metadata = ''] = match[1].split('|');
        const loadedTags = tags ? tags.split(',') : [];
        // A containerd-store engine keeps the manifest digest as the image ID, so a
        // loaded image lands under an ID the archive never carried.
        const registeredId =
          this.imageStore === 'containerd'
            ? 'sha256:' + createHash('sha256').update(`manifest:${id}`).digest('hex')
            : id;
        // A loaded tag moves to the loaded image, as on a real engine.
        for (const [otherId, other] of this.images)
          if (otherId !== registeredId)
            other.tags = other.tags.filter((tag) => !loadedTags.includes(tag));
        this.images.set(registeredId, {
          architecture: 'amd64',
          tags: loadedTags,
          layers: layers ? layers.split(',') : [],
          size: 1,
          ...(metadata && {
            metadata: JSON.parse(Buffer.from(metadata, 'base64').toString('utf8')),
          }),
        });
        for (const tag of loadedTags)
          lines.push(JSON.stringify({ stream: `Loaded image: ${tag}\n` }));
        if (!loadedTags.length)
          lines.push(JSON.stringify({ stream: `Loaded image ID: ${registeredId}\n` }));
      }
      if (lost()) return;
      res.statusCode = 200;
      return void res.end(lines.join('\n') + '\n');
    }
    if (path === '/images/get') {
      const names = url.searchParams.getAll('names');
      const entries = [...this.images].filter(
        ([id, image]) => names.includes(id) || image.tags.some((t) => names.includes(t)),
      );
      if (!entries.length) return json({}, 404);
      return void res.end(
        entries
          .map(
            ([id, image]) =>
              `IMAGE:${id}|${image.tags.filter((t) => names.includes(t)).join(',')}|${(image.layers ?? []).join(',')}|${Buffer.from(JSON.stringify(image.metadata ?? {})).toString('base64')}\n${'x'.repeat(image.size)}`,
          )
          .join('\n'),
      );
    }
    const image = path.match(/^\/images\/(.+)\/json$/);
    if (image) {
      const entry = this.findImage(image[1]);
      return entry
        ? json({
            Id: entry[0],
            Os: 'linux',
            Architecture: entry[1].architecture,
            Variant: '',
            Created: '2026-01-01T00:00:00Z',
            Config: {},
            ...entry[1].metadata,
            RepoTags: entry[1].tags,
            RootFS: { Type: 'layers', Layers: entry[1].layers ?? [] },
          })
        : json({ message: 'No such image' }, 404);
    }

    if (path === '/volumes' && method === 'GET')
      return json({
        Volumes: [...this.volumes].map(([Name, v]) => ({
          Name,
          Driver: v.driver,
          Labels: v.labels,
        })),
      });
    if (path === '/volumes/create') {
      const input = JSON.parse((await body()).toString('utf8'));
      if (!this.volumes.has(input.Name))
        this.volumes.set(input.Name, { labels: input.Labels ?? {}, driver: 'local' });
      return json({ Name: input.Name, Labels: this.volumes.get(input.Name)!.labels }, 201);
    }
    const volume = path.match(/^\/volumes\/(.+)$/);
    if (volume) {
      const name = volume[1];
      const found = this.volumes.get(name);
      if (!found) return json({ message: 'no such volume' }, 404);
      if (method === 'DELETE') {
        if (this.holders(name).length) return json({ message: 'volume is in use' }, 409);
        this.volumes.delete(name);
        this.data.delete(name);
        return empty();
      }
      return json({
        Name: name,
        Driver: found.driver,
        Labels: found.labels,
        CreatedAt: '2026-01-01T00:00:00Z',
        Mountpoint: `/var/lib/docker/volumes/${name}/_data`,
      });
    }

    if (path === '/networks' && method === 'GET')
      return json(
        [...this.networks].map(([Name, network]) => ({
          Name,
          IPAM: network.ipam ?? { Config: [] },
        })),
      );
    if (path === '/networks/create') {
      const input = JSON.parse((await body()).toString('utf8'));
      this.networks.set(input.Name, {
        labels: input.Labels ?? {},
        driver: input.Driver ?? 'bridge',
        internal: input.Internal === true,
        ...(input.IPAM ? { ipam: input.IPAM } : {}),
      });
      return json({ Id: input.Name }, 201);
    }
    const network = path.match(/^\/networks\/(.+)$/);
    if (network) {
      const found = this.networks.get(network[1]);
      if (!found) return json({ message: 'no such network' }, 404);
      if (method === 'DELETE') {
        this.networks.delete(network[1]);
        return empty();
      }
      return json({
        Id: network[1],
        Name: network[1],
        Driver: found.driver,
        Internal: found.internal,
        Attachable: false,
        Labels: found.labels,
        Options: {},
        ...(found.ipam ? { IPAM: found.ipam } : {}),
        Containers: Object.fromEntries(
          [...this.containers].flatMap(([id, container]) => {
            const address = container.NetworkSettings?.Networks?.[network[1]]?.IPAddress;
            return typeof address === 'string' && address
              ? [[id, { Name: container.Name, IPv4Address: `${address}/16` }]]
              : [];
          }),
        ),
      });
    }

    if (path === '/containers/json') {
      const filters = JSON.parse(url.searchParams.get('filters') ?? '{}') as Record<
        string,
        string[]
      >;
      const list = [...this.containers.values()].filter((c) => {
        if (!url.searchParams.get('all') && !filters.status && !c.State.Running) return false;
        if (filters.volume && !this.holders(filters.volume[0]).includes(c)) return false;
        if (filters.status && !(c.State.Running && filters.status.includes('running')))
          return false;
        return (filters.label ?? []).every((label) => {
          const [key, value] = label.split('=');
          return c.Config.Labels?.[key] === value;
        });
      });
      return json(
        list.map((c) => ({
          Id: c.Id,
          ImageID: c.Image,
          Names: [c.Name],
          Labels: c.Config.Labels ?? {},
          State: c.State.Running ? 'running' : 'created',
          Mounts: c.Mounts,
        })),
      );
    }
    if (path === '/containers/create') {
      const input = JSON.parse((await body()).toString('utf8')) as Record<string, unknown>;
      const name = url.searchParams.get('name') ?? `anon-${++this.sequence}`;
      if (this.find(name)) return json({ message: 'Conflict. The name is in use' }, 409);
      const requestedImage = String(input.Image);
      // Real engines refuse a create whose image reference they never registered.
      if (!this.findImage(requestedImage)) return json({ message: 'No such image' }, 404);
      const host = (input.HostConfig ?? {}) as {
        Binds?: string[];
        Mounts?: Array<{ Type: string; Source: string; Target: string; ReadOnly?: boolean }>;
      };
      const mounts: FakeMount[] = [];
      for (const bind of host.Binds ?? []) {
        const [source, target, options = ''] = bind.split(':');
        const isVolume = !source.startsWith('/');
        if (isVolume && !this.volumes.has(source))
          this.volumes.set(source, { labels: {}, driver: 'local' });
        mounts.push({
          Type: isVolume ? 'volume' : 'bind',
          ...(isVolume ? { Name: source } : {}),
          Source: source,
          Destination: target,
          RW: !options.split(',').includes('ro'),
        });
      }
      for (const mount of host.Mounts ?? []) {
        if (mount.Type === 'volume' && !this.volumes.has(mount.Source))
          this.volumes.set(mount.Source, { labels: {}, driver: 'local' });
        mounts.push({
          Type: mount.Type as 'volume' | 'bind',
          ...(mount.Type === 'volume' ? { Name: mount.Source } : {}),
          Source: mount.Source,
          Destination: mount.Target,
          RW: mount.ReadOnly !== true,
        });
      }
      const id = `${this.engineId}-${++this.sequence}`;
      this.containers.set(id, {
        Id: id,
        Name: `/${name}`,
        Image: String(input.Image),
        Config: { Labels: (input.Labels as Labels) ?? {} },
        HostConfig: host,
        Mounts: mounts,
        State: { Running: false },
        created: input,
      });
      return json({ Id: id }, 201);
    }
    const container = path.match(/^\/containers\/([^/]+)(?:\/(json|archive|stop|start|wait))?$/);
    if (container) {
      const found = this.find(container[1]);
      if (!found) return json({ message: 'No such container' }, 404);
      const action = container[2];
      if (action === 'json') {
        const { created: _created, SizeRw, SizeRootFs, ...inspect } = found;
        return json({
          ...inspect,
          ...(url.searchParams.get('size') === 'true' && {
            SizeRw: SizeRw ?? 7,
            ...(SizeRootFs !== undefined && { SizeRootFs }),
          }),
        });
      }
      if (action === 'stop') {
        if (!found.State.Running) return empty(304);
        found.State.Running = false;
        if (found.HostConfig.AutoRemove === true) this.containers.delete(found.Id);
        return empty();
      }
      if (action === 'start') {
        if (found.State.Running) return empty(304);
        found.State.Running = true;
        // Root inside the clear helper empties the bound folder or volume and keeps it.
        const target = found.Mounts.find((m) => m.Destination === '/target');
        if ((found.created?.Entrypoint as string[] | undefined)?.[0] === 'find' && target) {
          if (this.clearExitCode === 0 && target.Type === 'volume') this.data.delete(target.Name!);
          else if (this.clearExitCode === 0) {
            for (const entry of await readdir(target.Source))
              await rm(join(target.Source, entry), { recursive: true, force: true });
            this.data.delete(target.Source);
          }
        }
        return empty();
      }
      if (action === 'wait') {
        found.State.Running = false;
        return json({ StatusCode: this.clearExitCode });
      }
      if (action === 'archive') {
        const mount = found.Mounts.find((m) => m.Destination === '/data');
        if (!mount) return json({ message: 'no /data mount' }, 404);
        const key = mount.Type === 'volume' ? mount.Name! : mount.Source;
        const at = url.searchParams.get('path') ?? '/data';
        if (method === 'GET') {
          if (at === '/data') return void res.end(this.data.get(key) ?? Buffer.alloc(0));
          // A single file is read from its folder's mount and keeps its own name.
          const name = at.slice('/data/'.length);
          const file = this.data.get(join(mount.Source, name));
          if (!file) return json({ message: `Could not find the file ${at}` }, 404);
          return void res.end(Buffer.concat([Buffer.from(`${FILE_ENTRY}${name}\n`), file]));
        }
        const archive = await body();
        const header = archive.subarray(0, Math.max(archive.indexOf('\n'), 0)).toString();
        const name = header.startsWith(FILE_ENTRY) ? header.slice(FILE_ENTRY.length) : null;
        if (at === '/' && name === null) {
          this.data.set(key, archive);
          return empty(200);
        }
        // As the real engine: a file cannot replace the mounted `/data` itself.
        if (at === '/') return json({ message: 'RemoveAll data: device or resource busy' }, 500);
        if (name === null) return json({ message: `Unexpected archive at ${at}` }, 400);
        this.data.set(join(mount.Source, name), archive.subarray(header.length + 1));
        return empty(200);
      }
      if (method === 'DELETE') {
        if (found.State.Running && url.searchParams.get('force') !== 'true')
          return json({ message: 'container is running' }, 409);
        this.containers.delete(found.Id);
        return empty();
      }
    }
    json({ message: 'not found' }, 404);
  }

  private findImage(ref: string): [string, FakeImage] | undefined {
    return [...this.images].find(([id, value]) => id === ref || value.tags.includes(ref));
  }

  private holders(volume: string): FakeContainer[] {
    return [...this.containers.values()].filter((c) =>
      c.Mounts.some((m) => m.Type === 'volume' && m.Name === volume),
    );
  }
}
