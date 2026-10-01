import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  DockerEngineClient,
  DockerEngineError,
  isDockerNotFound,
  optionalDockerJson,
} from './docker-engine.client';
import {
  createDockerArchiveHelper,
  DOCKER_ARCHIVE_HELPER_LABEL,
  DOCKER_BIND_CLEAR_COMMAND,
  DockerArchiveHelper,
  DockerArchiveMount,
  DockerHelperCommand,
  inventoryDockerArchiveHelper,
} from './docker-archive';

interface VolumeIdentity {
  Name: string;
  CreatedAt: string;
  Driver: string;
  Mountpoint: string;
}
interface JournalEntry {
  token: string;
  engineId: string;
  createdAt: string;
  helper: DockerArchiveHelper;
  protectedVolumeIds: string[];
  volumes: Record<string, VolumeIdentity>;
}
export interface JournaledDockerHelper extends DockerArchiveHelper {
  journalKey: string;
}
const active = new Map<string, Set<string>>();
const locks = new Map<string, Promise<unknown>>();
const tokenPattern = /^[a-f0-9-]{36}$/;
/** The engine behind one client keeps its ID; asked once per client. */
const engineIds = new WeakMap<DockerEngineClient, string>();
const BIND_CLEAR_TIMEOUT_MS = 30 * 60_000;

/** Engine-local cleanup records only; never store service settings or archive data here. */
export class DockerArchiveJournal {
  readonly directory: string;
  constructor(dataDirectory = process.env.DB_PATH || join(homedir(), '.devchain')) {
    this.directory = join(dataDirectory, 'docker-helper-journal');
  }

  async hasPending(): Promise<boolean> {
    return (await this.entries()).length > 0;
  }

  async create(
    client: DockerEngineClient,
    image: string,
    mounts: DockerArchiveMount[],
    signal?: AbortSignal,
    command?: DockerHelperCommand,
  ): Promise<JournaledDockerHelper> {
    await this.reconcile(client, signal);
    const engineId = await this.engineId(client, signal);
    const token = randomUUID();
    const held = active.get(this.directory) ?? new Set<string>();
    active.set(this.directory, held);
    held.add(token);
    const entry: JournalEntry = {
      token,
      engineId,
      createdAt: new Date().toISOString(),
      helper: { id: '', ownedVolumeIds: [] },
      protectedVolumeIds: [],
      volumes: {},
    };
    const save = this.saver(entry);
    try {
      const helper = await createDockerArchiveHelper(
        client,
        image,
        mounts,
        signal,
        {
          name: `devchain-archive-${token}`,
          token,
          record: async (helper) => {
            entry.helper = structuredClone(helper);
            if (helper.pendingInventory)
              entry.protectedVolumeIds = [...helper.pendingInventory.protectedIds];
            await save();
            if (!helper.pendingInventory) {
              await this.identities(client, entry);
              await save();
            }
          },
        },
        command,
      );
      return { ...helper, journalKey: token };
    } catch (error) {
      held.delete(token);
      // Definite create rejection cannot have created this intent's helper. Transport failure is ambiguous.
      if (
        error instanceof DockerEngineError &&
        error.status &&
        error.status >= 400 &&
        error.status < 500 &&
        entry.helper.id === `devchain-archive-${token}`
      ) {
        await this.drop(token);
      }
      throw new DockerEngineError(
        signal?.aborted ? 'cancelled' : 'unavailable',
        'Docker archive helper failed; cleanup is retained locally',
      );
    }
  }

  async cleanup(client: DockerEngineClient, helper: JournaledDockerHelper): Promise<void> {
    try {
      await this.exclusive(async () => {
        const entry = (await this.entries()).find((entry) => entry.token === helper.journalKey);
        if (!entry) return;
        if (entry.engineId !== (await this.engineId(client)))
          throw new DockerEngineError('unavailable', 'Docker helper belongs to a different engine');
        await this.clean(client, entry);
      });
    } finally {
      active.get(this.directory)?.delete(helper.journalKey);
    }
  }

  /**
   * Empties one bind folder, keeping the folder itself, with the started clear
   * helper. It is journaled like the archive helpers and removed by exact ID.
   */
  clearBind(
    client: DockerEngineClient,
    image: string,
    source: string,
    signal?: AbortSignal,
    timeoutMs = BIND_CLEAR_TIMEOUT_MS,
  ): Promise<void> {
    return this.clear(client, image, 'bind', source, signal, timeoutMs);
  }

  /** `clearBind` for a bind folder or a volume; the volume itself is kept. */
  async clear(
    client: DockerEngineClient,
    image: string,
    type: DockerArchiveMount['Type'],
    source: string,
    signal?: AbortSignal,
    timeoutMs = BIND_CLEAR_TIMEOUT_MS,
  ): Promise<void> {
    const helper = await this.create(
      client,
      image,
      [{ Type: type, Source: source, Target: '/target' }],
      signal,
      DOCKER_BIND_CLEAR_COMMAND,
    );
    try {
      const id = encodeURIComponent(helper.id);
      await client.json('POST', `/containers/${id}/start`, undefined, { signal });
      const bounded = AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(timeoutMs),
      ]);
      const result = await client.json<{ StatusCode?: number }>(
        'POST',
        `/containers/${id}/wait?condition=not-running`,
        undefined,
        { signal: bounded },
      );
      if (result.StatusCode !== 0)
        throw new DockerEngineError('engine-error', 'The bind clear helper did not finish cleanly');
    } finally {
      await this.cleanup(client, helper);
    }
  }

  async reconcile(client: DockerEngineClient, signal?: AbortSignal): Promise<{ pending: number }> {
    return this.exclusive(async () => {
      const entries = await this.entries();
      if (!entries.length) return { pending: 0 };
      const engineId = await this.engineId(client, signal);
      for (const entry of entries) {
        if (entry.engineId !== engineId || active.get(this.directory)?.has(entry.token)) continue;
        try {
          await this.clean(client, entry, signal);
        } catch {
          /* The durable record remains retryable. */
        }
      }
      return { pending: (await this.entries()).length };
    });
  }

  private async clean(
    client: DockerEngineClient,
    entry: JournalEntry,
    signal?: AbortSignal,
  ): Promise<void> {
    let inspect = await optionalDockerJson<{
      Id: string;
      Config: { Labels?: Record<string, string> };
      State?: { Running?: boolean };
    }>(client, `/containers/${encodeURIComponent(entry.helper.id)}/json`, signal);
    if (
      entry.helper.id === `devchain-archive-${entry.token}` &&
      inspect?.Config.Labels?.[DOCKER_ARCHIVE_HELPER_LABEL] !== entry.token
    ) {
      const matches = await client.json<Array<{ Id: string; Labels?: Record<string, string> }>>(
        'GET',
        `/containers/json?all=true&filters=${encodeURIComponent(JSON.stringify({ label: [`${DOCKER_ARCHIVE_HELPER_LABEL}=${entry.token}`] }))}`,
        undefined,
        { signal },
      );
      const verified = matches.filter(
        (item) => item.Labels?.[DOCKER_ARCHIVE_HELPER_LABEL] === entry.token,
      );
      if (verified.length > 1) return;
      if (verified.length === 1)
        inspect = await optionalDockerJson(
          client,
          `/containers/${encodeURIComponent(verified[0].Id)}/json`,
          signal,
        );
    }
    if (inspect) {
      if (inspect.Config.Labels?.[DOCKER_ARCHIVE_HELPER_LABEL] !== entry.token) return;
      // As read from the journal; only a change is written back.
      const save = this.saver(entry, JSON.stringify(entry));
      entry.helper.id = inspect.Id;
      await save();
      if (entry.helper.pendingInventory) {
        await inventoryDockerArchiveHelper(client, entry.helper, signal);
        await save();
      }
      await this.identities(client, entry, signal);
      await save();
      // Only the bind clear helper ever runs; an interrupted one is still running.
      const force = inspect.State?.Running ? '?force=true' : '';
      await client.json(
        'DELETE',
        `/containers/${encodeURIComponent(inspect.Id)}${force}`,
        undefined,
        { signal },
      );
    } else if (entry.helper.pendingInventory) {
      // Only unresolved create intents expire; known helpers and held volumes never age out.
      if (
        entry.helper.id === `devchain-archive-${entry.token}` &&
        Date.now() - Date.parse(entry.createdAt) >= 15 * 60_000
      ) {
        await this.drop(entry.token);
        process.emitWarning(`Expired absent Docker helper intent ${entry.token}`, {
          code: 'DOCKER_HELPER_INTENT_EXPIRED',
        });
      }
      return;
    }
    let remains = false;
    for (const id of entry.helper.ownedVolumeIds) {
      if (entry.protectedVolumeIds.includes(id)) {
        remains = true;
        continue;
      }
      const volume = await optionalDockerJson<VolumeIdentity>(
        client,
        `/volumes/${encodeURIComponent(id)}`,
        signal,
      );
      if (!volume) continue;
      const recorded = entry.volumes[id];
      if (!recorded || !this.sameVolume(recorded, volume)) {
        remains = true;
        continue;
      }
      const holders = await client.json<unknown[]>(
        'GET',
        `/containers/json?all=true&filters=${encodeURIComponent(JSON.stringify({ volume: [id] }))}`,
        undefined,
        { signal },
      );
      if (holders.length) {
        remains = true;
        continue;
      }
      try {
        await client.json('DELETE', `/volumes/${encodeURIComponent(id)}`, undefined, { signal });
      } catch (error) {
        if (!isDockerNotFound(error)) throw error;
      }
    }
    if (!remains) await this.drop(entry.token);
  }
  private sameVolume(a: VolumeIdentity, b: VolumeIdentity): boolean {
    return (
      a.Name === b.Name &&
      a.CreatedAt === b.CreatedAt &&
      a.Driver === b.Driver &&
      a.Mountpoint === b.Mountpoint
    );
  }
  private async identities(
    client: DockerEngineClient,
    entry: JournalEntry,
    signal?: AbortSignal,
  ): Promise<void> {
    for (const id of entry.helper.ownedVolumeIds) {
      if (entry.volumes[id] || entry.protectedVolumeIds.includes(id)) continue;
      const value = await client.json<VolumeIdentity>(
        'GET',
        `/volumes/${encodeURIComponent(id)}`,
        undefined,
        { signal },
      );
      if (value.Name !== id || !value.CreatedAt || !value.Driver || !value.Mountpoint)
        throw new DockerEngineError('invalid-response', 'Docker volume identity is incomplete');
      entry.volumes[id] = {
        Name: value.Name,
        CreatedAt: value.CreatedAt,
        Driver: value.Driver,
        Mountpoint: value.Mountpoint,
      };
    }
  }
  private async engineId(client: DockerEngineClient, signal?: AbortSignal): Promise<string> {
    const known = engineIds.get(client);
    if (known) return known;
    const info = await client.info(signal);
    if (!info.ID)
      throw new DockerEngineError('invalid-response', 'Docker engine identity is missing');
    engineIds.set(client, info.ID);
    return info.ID;
  }
  private async entries(): Promise<JournalEntry[]> {
    try {
      const files = await readdir(this.directory);
      const entries: JournalEntry[] = [];
      for (const file of files.filter(
        (file) => tokenPattern.test(file.replace(/\.json$/, '')) && file.endsWith('.json'),
      )) {
        const entry = JSON.parse(
          await readFile(join(this.directory, file), 'utf8'),
        ) as JournalEntry;
        if (
          entry.token !== file.slice(0, -5) ||
          !entry.engineId ||
          !entry.helper?.id ||
          !Array.isArray(entry.helper.ownedVolumeIds) ||
          !Array.isArray(entry.protectedVolumeIds) ||
          !entry.volumes
        )
          throw new Error();
        entries.push(entry);
      }
      return entries;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new DockerEngineError('unavailable', 'Docker helper cleanup journal cannot be read');
    }
  }
  /** Writes the entry only when it changed since `saved`, what the journal already holds. */
  private saver(entry: JournalEntry, saved?: string): () => Promise<void> {
    return async () => {
      const serialized = JSON.stringify(entry);
      if (serialized === saved) return;
      await this.write(entry);
      saved = serialized;
    };
  }
  private async write(entry: JournalEntry): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `${entry.token}.${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(entry));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, join(this.directory, `${entry.token}.json`));
    const directory = await open(this.directory, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  private async drop(token: string): Promise<void> {
    try {
      await unlink(join(this.directory, `${token}.json`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const previous = locks.get(this.directory) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    locks.set(this.directory, next);
    try {
      return await next;
    } finally {
      if (locks.get(this.directory) === next) locks.delete(this.directory);
    }
  }
}
