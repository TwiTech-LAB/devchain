// Real journal files plus a deterministic engine double exercise restart/provenance boundaries cheaply.
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DockerArchiveJournal } from './docker-archive-journal';
import { DockerEngineClient, DockerEngineError } from './docker-engine.client';
import { HostDockerRecoveryService } from '../../remotes/host/host-docker-recovery.service';

type Volume = { Name: string; CreatedAt: string; Driver: string; Mountpoint: string };
type Container = {
  Id: string;
  Name: string;
  Config: { Labels: Record<string, string> };
  Mounts: Array<{ Type: string; Name: string; Destination: string }>;
  State?: { Running: boolean };
  created?: Record<string, unknown>;
};
let directory: string;
let journal: DockerArchiveJournal;
let client: DockerEngineClient;
let containers: Map<string, Container>;
let volumes: Map<string, Volume>;
let nextId: number;
let failDelete: boolean;
let failInventory: number;
let outcome: 'normal' | 'lost-found' | 'lost-absent' | 'reject';
let held: Set<string>;
let gate: Promise<void> | undefined;
let started: (() => void) | undefined;
let exitCode: number;
let hangWait: boolean;
let calls: string[];
const mount = [{ Type: 'volume' as const, Source: 'protected', Target: '/data' }];
const makeVolume = (Name: string): Volume => ({
  Name,
  CreatedAt: '2026-01-01T00:00:00Z',
  Driver: 'local',
  Mountpoint: `/volumes/${Name}`,
});
const records = async () =>
  (await readdir(journal.directory)).filter((name) => name.endsWith('.json'));

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'docker-journal-'));
  journal = new DockerArchiveJournal(directory);
  containers = new Map();
  volumes = new Map([['protected', makeVolume('protected')]]);
  nextId = 0;
  failDelete = false;
  failInventory = 0;
  outcome = 'normal';
  held = new Set();
  gate = undefined;
  started = undefined;
  exitCode = 0;
  hangWait = false;
  calls = [];
  client = {
    info: jest.fn(async () => ({ ID: 'engine-id', Driver: 'overlay2', DockerRootDir: '/docker' })),
    json: jest.fn(
      async (
        method: string,
        path: string,
        body?: Record<string, unknown>,
        options?: { signal?: AbortSignal },
      ) => {
        const url = new URL(path, 'http://engine');
        calls.push(`${method} ${path}`);
        if (url.pathname === '/volumes') return { Volumes: [...volumes.values()] };
        if (url.pathname === '/containers/create') {
          started?.();
          if (gate) await gate;
          if (outcome === 'reject') throw new DockerEngineError('not-found', 'No image', 404);
          if (outcome === 'lost-absent')
            throw new DockerEngineError('unavailable', 'Connection failed');
          const Id = `helper-${++nextId}`;
          const Name = url.searchParams.get('name')!;
          const owned = `owned-${Id}`;
          volumes.set(owned, makeVolume(owned));
          containers.set(Id, {
            Id,
            Name,
            created: body,
            State: { Running: false },
            Config: { Labels: body!.Labels as Record<string, string> },
            Mounts: [
              { Type: 'volume', Name: 'protected', Destination: '/data' },
              { Type: 'volume', Name: owned, Destination: '/image-volume' },
            ],
          });
          if (outcome === 'lost-found')
            throw new DockerEngineError('unavailable', 'Connection failed');
          return { Id };
        }
        if (url.pathname === '/containers/json') {
          const filters = JSON.parse(url.searchParams.get('filters')!);
          if (filters.label) {
            const [key, token] = filters.label[0].split('=');
            return [...containers.values()]
              .filter((item) => item.Config.Labels[key] === token)
              .map((item) => ({ Id: item.Id, Labels: item.Config.Labels }));
          }
          const volume = filters.volume[0];
          return held.has(volume) ? [{ Id: 'unrelated-holder' }] : [];
        }
        const lifecycle = url.pathname.match(/^\/containers\/([^/]+)\/(start|wait)$/);
        if (lifecycle) {
          const value = containers.get(lifecycle[1]);
          if (!value) throw new DockerEngineError('not-found', 'Missing', 404);
          if (lifecycle[2] === 'start') {
            value.State = { Running: true };
            return;
          }
          if (hangWait)
            return new Promise((_resolve, reject) =>
              options?.signal?.addEventListener('abort', () =>
                reject(new DockerEngineError('cancelled', 'Docker request cancelled')),
              ),
            );
          value.State = { Running: false };
          return { StatusCode: exitCode };
        }
        const container = url.pathname.match(/^\/containers\/([^/]+)(\/json)?$/);
        if (container) {
          const value = [...containers.values()].find(
            (item) => item.Id === container[1] || item.Name === container[1],
          );
          if (!value) throw new DockerEngineError('not-found', 'Missing', 404);
          if (method === 'DELETE') {
            if (failDelete) throw new DockerEngineError('unavailable', 'Connection failed');
            if (value.State?.Running && url.searchParams.get('force') !== 'true')
              throw new DockerEngineError('conflict', 'Running', 409);
            containers.delete(value.Id);
            return;
          }
          if (failInventory > 0) {
            failInventory--;
            throw new DockerEngineError('unavailable', 'Connection failed');
          }
          return value;
        }
        if (url.pathname.startsWith('/volumes/')) {
          const name = url.pathname.slice('/volumes/'.length);
          const value = volumes.get(name);
          if (!value) throw new DockerEngineError('not-found', 'Missing', 404);
          if (method === 'DELETE') {
            if (failDelete) throw new DockerEngineError('unavailable', 'Connection failed');
            volumes.delete(name);
            return;
          }
          return value;
        }
        throw new Error('Unexpected fake engine route');
      },
    ),
  } as unknown as DockerEngineClient;
});
afterEach(async () => {
  jest.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

it('journals a cleanup failure and recovers from a fresh instance at startup', async () => {
  const helper = await journal.create(client, 'service-image', mount);
  const files = await records();
  expect(files).toHaveLength(1);
  expect((await stat(join(journal.directory, files[0]))).mode & 0o777).toBe(0o600);
  const record = JSON.parse(await readFile(join(journal.directory, files[0]), 'utf8'));
  expect(Object.keys(record).sort()).toEqual([
    'createdAt',
    'engineId',
    'helper',
    'protectedVolumeIds',
    'token',
    'volumes',
  ]);
  expect(record.protectedVolumeIds).toContain('protected');
  expect(record.helper.ownedVolumeIds).toEqual(['owned-helper-1']);
  failDelete = true;
  await expect(journal.cleanup(client, helper)).rejects.toMatchObject({ code: 'unavailable' });
  expect(await records()).toHaveLength(1);
  failDelete = false;
  jest.spyOn(DockerEngineClient, 'connect').mockResolvedValue(client);
  await new HostDockerRecoveryService(new DockerArchiveJournal(directory)).onModuleInit();
  expect(await records()).toEqual([]);
  expect(containers.size).toBe(0);
  expect([...volumes.keys()]).toEqual(['protected']);
});

it('recovers pending inventory before the next archive helper is created', async () => {
  failInventory = 1;
  await expect(journal.create(client, 'service-image', mount)).rejects.toMatchObject({
    code: 'unavailable',
  });
  const [file] = await records();
  const record = JSON.parse(await readFile(join(journal.directory, file), 'utf8'));
  expect(record.helper.pendingInventory.protectedIds).toContain('protected');
  const next = await journal.create(client, 'service-image', mount);
  expect(containers.has('helper-1')).toBe(false);
  expect(volumes.has('owned-helper-1')).toBe(false);
  expect(volumes.has('protected')).toBe(true);
  await journal.cleanup(client, next);
  expect(await records()).toEqual([]);
});

it('retains newly held owned volumes and ignores replacements with different identity', async () => {
  const helper = await journal.create(client, 'service-image', mount);
  held.add('owned-helper-1');
  await journal.cleanup(client, helper);
  expect(containers.size).toBe(0);
  expect(volumes.has('owned-helper-1')).toBe(true);
  expect((await new DockerArchiveJournal(directory).reconcile(client)).pending).toBe(1);
  held.clear();
  const original = volumes.get('owned-helper-1')!;
  volumes.set(original.Name, { ...original, CreatedAt: '2026-02-02T00:00:00Z' });
  expect((await journal.reconcile(client)).pending).toBe(1);
  expect(volumes.has(original.Name)).toBe(true);
  volumes.set(original.Name, original);
  await journal.reconcile(client);
  expect(await records()).toEqual([]);
  expect([...volumes.keys()]).toEqual(['protected']);
});

it('resolves a lost create response by name and token, retaining token mismatches', async () => {
  outcome = 'lost-found';
  await expect(journal.create(client, 'service-image', mount)).rejects.toMatchObject({
    code: 'unavailable',
  });
  const labels = containers.get('helper-1')!.Config.Labels;
  const token = labels['dev.devchain.archive-helper'];
  labels['dev.devchain.archive-helper'] = 'unrelated';
  expect((await journal.reconcile(client)).pending).toBe(1);
  expect(containers.size).toBe(1);
  labels['dev.devchain.archive-helper'] = token;
  await journal.reconcile(client);
  expect(containers.size).toBe(0);
  expect(await records()).toEqual([]);
  expect([...volumes.keys()]).toEqual(['protected']);
});

it('retains absent intents during grace without blocking imports, then expires only unresolved absent intents', async () => {
  outcome = 'lost-absent';
  await expect(journal.create(client, 'service-image', mount)).rejects.toMatchObject({
    code: 'unavailable',
  });
  const [file] = await records();
  expect((await journal.reconcile(client)).pending).toBe(1);
  outcome = 'normal';
  const next = await journal.create(client, 'service-image', mount);
  await journal.cleanup(client, next);
  expect(await records()).toEqual([file]);
  const path = join(journal.directory, file);
  const record = JSON.parse(await readFile(path, 'utf8'));
  record.createdAt = new Date(Date.now() - 16 * 60_000).toISOString();
  await writeFile(path, JSON.stringify(record));
  const warning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
  expect((await journal.reconcile(client)).pending).toBe(0);
  expect(warning).toHaveBeenCalledWith(`Expired absent Docker helper intent ${record.token}`, {
    code: 'DOCKER_HELPER_INTENT_EXPIRED',
  });
});

it('clears definitive create rejection immediately', async () => {
  outcome = 'reject';
  await expect(journal.create(client, 'missing-image', mount)).rejects.toMatchObject({
    code: 'unavailable',
  });
  expect(await records()).toEqual([]);
});

it('protects active intent names and returned helper IDs from concurrent reconciliation', async () => {
  let release!: () => void;
  gate = new Promise<void>((resolve) => (release = resolve));
  const creating = new Promise<void>((resolve) => (started = resolve));
  const result = journal.create(client, 'service-image', mount);
  await creating;
  expect((await new DockerArchiveJournal(directory).reconcile(client)).pending).toBe(1);
  release();
  const helper = await result;
  await new DockerArchiveJournal(directory).reconcile(client);
  expect(containers.has(helper.id)).toBe(true);
  await journal.cleanup(client, helper);
  expect(await records()).toEqual([]);
});

it('never ages out a known helper with incomplete inventory or a held owned-volume record', async () => {
  failInventory = 1;
  await expect(journal.create(client, 'service-image', mount)).rejects.toMatchObject({
    code: 'unavailable',
  });
  const [file] = await records();
  const path = join(journal.directory, file);
  let record = JSON.parse(await readFile(path, 'utf8'));
  record.createdAt = '2000-01-01T00:00:00Z';
  await writeFile(path, JSON.stringify(record));
  const container = containers.get('helper-1')!;
  containers.delete('helper-1');
  expect((await journal.reconcile(client)).pending).toBe(1);
  containers.set('helper-1', container);
  held.add('owned-helper-1');
  await journal.reconcile(client);
  record = JSON.parse(await readFile(path, 'utf8'));
  expect(record.helper.pendingInventory).toBeUndefined();
  expect((await journal.reconcile(client)).pending).toBe(1);
  expect(volumes.has('owned-helper-1')).toBe(true);
});

it('discovers an uncertain helper by token after it was renamed', async () => {
  outcome = 'lost-found';
  await expect(journal.create(client, 'service-image', mount)).rejects.toMatchObject({
    code: 'unavailable',
  });
  containers.get('helper-1')!.Name = 'renamed-helper';
  await journal.reconcile(client);
  expect(containers.size).toBe(0);
  expect(await records()).toEqual([]);
  expect([...volumes.keys()]).toEqual(['protected']);
});

it('aborts stalled startup inventory and releases the journal lock for a retry', async () => {
  failInventory = 1;
  await expect(journal.create(client, 'service-image', mount)).rejects.toMatchObject({
    code: 'unavailable',
  });
  const original = client.json;
  let inspections = 0;
  let reached!: () => void;
  const stalled = new Promise<void>((resolve) => {
    reached = resolve;
  });
  client.json = jest.fn(async (...args: Parameters<typeof original>) => {
    if (args[1] === '/containers/helper-1/json' && ++inspections === 2) {
      reached();
      const signal = args[3]?.signal;
      expect(signal).toBeDefined();
      await new Promise((_, reject) => {
        if (signal!.aborted) reject(new DockerEngineError('cancelled', 'Cancelled'));
        else
          signal!.addEventListener(
            'abort',
            () => reject(new DockerEngineError('cancelled', 'Cancelled')),
            { once: true },
          );
      });
    }
    return original.apply(client, args);
  }) as typeof original;
  const controller = new AbortController();
  jest.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
  jest.spyOn(DockerEngineClient, 'connect').mockResolvedValue(client);
  const startup = new HostDockerRecoveryService(new DockerArchiveJournal(directory)).onModuleInit();
  await stalled;
  controller.abort();
  await startup;
  expect(await records()).toHaveLength(1);
  const record = JSON.parse(await readFile(join(journal.directory, (await records())[0]), 'utf8'));
  expect(record.helper.pendingInventory).toBeDefined();
  client.json = original;
  await journal.reconcile(client);
  expect(await records()).toEqual([]);
  expect([...volumes.keys()]).toEqual(['protected']);
});

describe('bind clear helper', () => {
  const folder = '/home/vm-user/project/data';

  it('empties the folder as root with no shell, network or extra privilege, then removes it by exact ID', async () => {
    await journal.clearBind(client, 'service-image', folder);
    const [create] = calls.filter((call) => call.startsWith('POST /containers/create'));
    expect(create).toMatch(/name=devchain-archive-/);
    const helperId = 'helper-1';
    expect(calls.filter((call) => call.includes(`/containers/${helperId}`))).toEqual([
      `GET /containers/${helperId}/json`,
      `POST /containers/${helperId}/start`,
      `POST /containers/${helperId}/wait?condition=not-running`,
      `GET /containers/${helperId}/json`,
      `DELETE /containers/${helperId}`,
    ]);
    const body = (client.json as jest.Mock).mock.calls.find(([, path]) =>
      String(path).startsWith('/containers/create'),
    )![2] as Record<string, unknown>;
    expect(body).toMatchObject({
      Image: 'service-image',
      Entrypoint: ['find'],
      Cmd: ['/target', '-mindepth', '1', '-delete'],
      User: '0:0',
      Labels: { 'dev.devchain.archive-helper': expect.any(String) },
    });
    expect(body.HostConfig).toEqual({
      Mounts: [{ Type: 'bind', Source: folder, Target: '/target' }],
      NetworkMode: 'none',
      AutoRemove: false,
      ReadonlyRootfs: true,
    });
    expect(containers.size).toBe(0);
    expect(volumes.has('owned-helper-1')).toBe(false);
    expect(await journal.hasPending()).toBe(false);
  });

  it('fails on a non-zero exit and still removes the helper', async () => {
    exitCode = 1;
    await expect(journal.clearBind(client, 'distroless-image', folder)).rejects.toMatchObject({
      code: 'engine-error',
    });
    expect(containers.size).toBe(0);
    expect(await journal.hasPending()).toBe(false);
  });

  it('force-removes a helper still running when the bounded wait expires', async () => {
    hangWait = true;
    await expect(
      journal.clearBind(client, 'service-image', folder, undefined, 50),
    ).rejects.toBeInstanceOf(DockerEngineError);
    expect(calls).toContain('DELETE /containers/helper-1?force=true');
    expect(containers.size).toBe(0);
    expect(await journal.hasPending()).toBe(false);
  });

  it('recovers a running clear helper from the journal after a failed removal', async () => {
    hangWait = true;
    failDelete = true;
    await expect(
      journal.clearBind(client, 'service-image', folder, undefined, 50),
    ).rejects.toBeDefined();
    expect(containers.get('helper-1')?.State?.Running).toBe(true);
    expect(await records()).toHaveLength(1);

    failDelete = false;
    expect(await new DockerArchiveJournal(directory).reconcile(client)).toEqual({ pending: 0 });
    expect(calls).toContain('DELETE /containers/helper-1?force=true');
    expect(containers.size).toBe(0);
    expect(volumes.has('owned-helper-1')).toBe(false);
  });
});
