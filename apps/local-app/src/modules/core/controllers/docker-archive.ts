import { Readable } from 'node:stream';
import { DockerEngineClient, DockerEngineError, isDockerNotFound } from './docker-engine.client';

/** Labels a journaled helper with its journal token. */
export const DOCKER_ARCHIVE_HELPER_LABEL = 'dev.devchain.archive-helper';

export interface DockerArchiveMount {
  Type: 'bind' | 'volume';
  Source: string;
  Target: string;
  ReadOnly?: boolean;
}
export interface DockerHelperMount {
  Type: string;
  Name?: string;
  Destination: string;
}
/** The only started helper: it empties one bind as root, with no shell and no network. */
export const DOCKER_BIND_CLEAR_COMMAND = {
  Entrypoint: ['find'],
  Cmd: ['/target', '-mindepth', '1', '-delete'],
  User: '0:0',
} as const;
export type DockerHelperCommand = typeof DOCKER_BIND_CLEAR_COMMAND;
export interface DockerArchiveHelper {
  id: string;
  ownedVolumeIds: string[];
  pendingInventory?: { protectedIds: string[]; explicitTargets: string[] };
}

export class DockerArchiveHelperError extends DockerEngineError {
  constructor(readonly helper: DockerArchiveHelper) {
    super(
      'unavailable',
      'Archive helper cleanup is pending; retain its ownership record and retry cleanup',
    );
    this.name = 'DockerArchiveHelperError';
  }
}

export async function inventoryDockerArchiveHelper(
  client: DockerEngineClient,
  helper: DockerArchiveHelper,
  signal?: AbortSignal,
): Promise<void> {
  const pending = helper.pendingInventory;
  if (!pending) return;
  const inspect = await client.json<{ Mounts: DockerHelperMount[] }>(
    'GET',
    `/containers/${encodeURIComponent(helper.id)}/json`,
    undefined,
    { signal },
  );
  helper.ownedVolumeIds = [
    ...new Set(
      inspect.Mounts.filter(
        (mount) =>
          mount.Type === 'volume' &&
          mount.Name &&
          !pending.protectedIds.includes(mount.Name) &&
          !pending.explicitTargets.includes(mount.Destination),
      ).map((mount) => mount.Name!),
    ),
  ];
  delete helper.pendingInventory;
}

/** The returned inventory must be retained until cleanup, including across retries. */
export async function createDockerArchiveHelper(
  client: DockerEngineClient,
  image: string,
  mounts: DockerArchiveMount[],
  signal?: AbortSignal,
  lifecycle?: {
    name: string;
    token: string;
    record: (helper: DockerArchiveHelper) => Promise<void>;
  },
  command?: DockerHelperCommand,
): Promise<DockerArchiveHelper> {
  if (
    !mounts.length ||
    mounts.some((mount) => !mount.Source || !mount.Target.startsWith('/')) ||
    new Set(mounts.map((mount) => mount.Target)).size !== mounts.length
  ) {
    throw new DockerEngineError(
      'unsupported',
      'Archive helper mounts must have explicit sources and unique absolute targets',
    );
  }
  const before = await client.json<{ Volumes: Array<{ Name: string }> | null }>(
    'GET',
    '/volumes',
    undefined,
    { signal },
  );
  const protectedIds = new Set([
    ...(before.Volumes ?? []).map((volume) => volume.Name),
    ...mounts.filter((mount) => mount.Type === 'volume').map((mount) => mount.Source),
  ]);
  // Require existing volumes: Docker create otherwise silently creates a named source.
  const existing = new Set((before.Volumes ?? []).map((volume) => volume.Name));
  if (mounts.some((mount) => mount.Type === 'volume' && !existing.has(mount.Source))) {
    throw new DockerEngineError('not-found', 'Archive helper source volume does not exist');
  }
  if (signal?.aborted) throw new DockerEngineError('cancelled', 'Docker request cancelled');
  const helper: DockerArchiveHelper = {
    id: lifecycle?.name ?? '',
    ownedVolumeIds: [],
    pendingInventory: {
      protectedIds: [...protectedIds],
      explicitTargets: mounts.map((mount) => mount.Target),
    },
  };
  await lifecycle?.record(helper);
  // Once sent, create must return its ID before cancellation can clean it up safely.
  const created = await client.json<{ Id: string }>(
    'POST',
    `/containers/create${lifecycle ? `?name=${encodeURIComponent(lifecycle.name)}` : ''}`,
    {
      Image: image,
      Cmd: command ? [...command.Cmd] : ['devchain-archive-helper'],
      Entrypoint: command ? [...command.Entrypoint] : [],
      ...(command ? { User: command.User } : {}),
      ...(lifecycle ? { Labels: { [DOCKER_ARCHIVE_HELPER_LABEL]: lifecycle.token } } : {}),
      HostConfig: {
        // Even never-started helpers seed empty volumes unless copying is disabled.
        Mounts: mounts.map((mount) =>
          mount.Type === 'volume' ? { ...mount, VolumeOptions: { NoCopy: true } } : mount,
        ),
        NetworkMode: 'none',
        AutoRemove: false,
        ...(command ? { ReadonlyRootfs: true } : {}),
      },
    },
  );
  helper.id = created.Id;
  await lifecycle?.record(helper);
  try {
    // Inventory is deliberately not cancellable: cancellation must not lose ownership records.
    await inventoryDockerArchiveHelper(client, helper);
    await lifecycle?.record(helper);
    if (signal?.aborted) throw new DockerEngineError('cancelled', 'Docker request cancelled');
    return helper;
  } catch (error) {
    if (lifecycle || helper.pendingInventory) throw new DockerArchiveHelperError(helper);
    try {
      await cleanupDockerArchiveHelper(client, helper);
    } catch {
      throw new DockerArchiveHelperError(helper);
    }
    throw error;
  }
}

export async function cleanupDockerArchiveHelper(
  client: DockerEngineClient,
  helper: DockerArchiveHelper,
): Promise<void> {
  await inventoryDockerArchiveHelper(client, helper);
  const remove = async (path: string) => {
    try {
      await client.json('DELETE', path);
    } catch (error) {
      if (!isDockerNotFound(error)) throw error;
    }
  };
  await remove(`/containers/${encodeURIComponent(helper.id)}`);
  for (const id of helper.ownedVolumeIds) await remove(`/volumes/${encodeURIComponent(id)}`);
}

export function readDockerArchive(
  client: DockerEngineClient,
  helperId: string,
  signal?: AbortSignal,
): Promise<Readable> {
  return client.stream('GET', `/containers/${encodeURIComponent(helperId)}/archive?path=/data`, {
    signal,
  });
}
export async function writeDockerArchive(
  client: DockerEngineClient,
  helperId: string,
  archive: Readable,
  signal?: AbortSignal,
): Promise<void> {
  const response = await client.stream(
    'PUT',
    `/containers/${encodeURIComponent(helperId)}/archive?copyUIDGID=true&path=/`,
    {
      body: archive,
      headers: { 'Content-Type': 'application/x-tar' },
      signal,
    },
  );
  for await (const chunk of response) {
    void chunk;
  }
}
