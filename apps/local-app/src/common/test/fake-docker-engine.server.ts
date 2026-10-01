import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

type Labels = Record<string, string>;
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
  State: { Running: boolean; StartedAt?: string };
  /** The raw create body, for assertions on what the VM received. */
  created?: Record<string, unknown>;
}

/**
 * A stateful Docker Engine over a Unix socket: containers, volumes, networks,
 * images and archive I/O. Volume and bind data are opaque byte strings, so a
 * test can follow data across engines without real tar handling.
 */
export class FakeDockerEngine {
  readonly containers = new Map<string, FakeContainer>();
  readonly volumes = new Map<string, { labels: Labels; driver: string }>();
  readonly networks = new Map<string, { labels: Labels; driver: string; internal: boolean }>();
  readonly images = new Map<string, { architecture: string; tags: string[]; size: number }>();
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

  constructor(readonly engineId: string) {}

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
    if (path === '/system/df')
      return json({
        Containers: [...this.containers.values()].map((c) => ({ Id: c.Id, SizeRw: 7 })),
        Images: [...this.images].map(([Id, image]) => ({ Id, Size: image.size })),
        Volumes: [...this.volumes.keys()].map((Name) => ({
          Name,
          UsageData: { Size: this.data.get(Name)?.length ?? 0, RefCount: 0 },
        })),
      });

    if (path === '/images/load' && method === 'POST') {
      const text = (await body()).toString('utf8');
      const match = /^IMAGE:([^\n]+)\n/.exec(text);
      if (!match) return json({ error: 'bad archive' });
      const [id, tags] = match[1].split('|');
      this.images.set(id, { architecture: 'amd64', tags: tags ? tags.split(',') : [], size: 1 });
      return json({ stream: `Loaded image ID: ${id}\n` });
    }
    if (path === '/images/get') {
      const names = url.searchParams.getAll('names');
      const entry = [...this.images].find(
        ([id, image]) => names.includes(id) || image.tags.some((t) => names.includes(t)),
      );
      if (!entry) return json({}, 404);
      const [id, image] = entry;
      return void res.end(
        `IMAGE:${id}|${image.tags.filter((t) => names.includes(t)).join(',')}\n${'x'.repeat(image.size)}`,
      );
    }
    const image = path.match(/^\/images\/(.+)\/json$/);
    if (image) {
      const entry = [...this.images].find(
        ([id, value]) => id === image[1] || value.tags.includes(image[1]),
      );
      return entry
        ? json({ Id: entry[0], Architecture: entry[1].architecture, RepoTags: entry[1].tags })
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

    if (path === '/networks/create') {
      const input = JSON.parse((await body()).toString('utf8'));
      this.networks.set(input.Name, {
        labels: input.Labels ?? {},
        driver: input.Driver ?? 'bridge',
        internal: input.Internal === true,
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
        const { created: _created, ...inspect } = found;
        return json(inspect);
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
        if (method === 'GET') return void res.end(this.data.get(key) ?? Buffer.alloc(0));
        this.data.set(key, await body());
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

  private holders(volume: string): FakeContainer[] {
    return [...this.containers.values()].filter((c) =>
      c.Mounts.some((m) => m.Type === 'volume' && m.Name === volume),
    );
  }
}
