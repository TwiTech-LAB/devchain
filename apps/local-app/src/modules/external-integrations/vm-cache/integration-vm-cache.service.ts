import { Inject, Injectable } from '@nestjs/common';
import {
  HostIntegrationCredentialsSchema,
  type HostIntegrationsCacheUnavailable,
  type HostIntegrationsPush,
  type HostIntegrationsPutResult,
  type HostIntegrationsStatus,
} from '@devchain/shared';
import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { getEnvConfig } from '../../../common/config/env.config';
import { ValidationError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import { isClaimedHost } from '../../remotes/host-api-key';
import { RuntimeDirectoryService } from '../../runtime-directory/runtime-directory.service';
import {
  STORAGE_SERVICE,
  type IntegrationStorage,
  type ProjectHostStorage,
} from '../../storage/interfaces/storage.interface';
import type {
  IntegrationConnection,
  IntegrationCredentials,
} from '../../storage/models/domain.models';
import { deliveredRows, hostIntegrationsRevision } from './integration-push-revision';

const logger = createLogger('IntegrationVmCacheService');

/** In the systemd runtime directory, next to the Vault cache and outside the swept folders. */
export const INTEGRATIONS_VM_CACHE_FILE = 'integrations-cache.json';

const CacheFileSchema = z.object({
  version: z.literal(1),
  secrets: z.record(
    z.object({ generation: z.number().int(), credentials: HostIntegrationCredentialsSchema }),
  ),
});
type CacheFile = z.infer<typeof CacheFileSchema>;

type CacheStorage = Pick<
  IntegrationStorage,
  | 'listIntegrationConnections'
  | 'replaceDeliveredIntegrationConnections'
  | 'readExternalLinkSyncState'
> &
  Pick<ProjectHostStorage, 'releaseProject'>;

type CacheDirectory =
  | { readonly path: string; readonly unavailable: null }
  | { readonly path: null; readonly unavailable: HostIntegrationsCacheUnavailable };

export type CachedCredentialsRead =
  | { readonly state: 'ready'; readonly credentials: IntegrationCredentials }
  | { readonly state: 'missing' }
  | { readonly state: 'unavailable'; readonly reason: HostIntegrationsCacheUnavailable };

/**
 * A claimed VM's copy of home's integration connections: metadata in the DB with empty
 * credentials, credentials only in a 0600 file in the unit's tmpfs `$RUNTIME_DIRECTORY`.
 * A credential serves only its connection id at its generation. Never log a credential.
 */
@Injectable()
export class IntegrationVmCacheService {
  private applying: Promise<unknown> = Promise.resolve();

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: CacheStorage,
    private readonly runtimeDirectory: RuntimeDirectoryService,
  ) {}

  isClaimedHost(): boolean {
    return isClaimedHost(getEnvConfig().DEVCHAIN_HOST_ETC_DIR);
  }

  /** Pushes and releases run one at a time, so a push never sees half a release. */
  apply(push: HostIntegrationsPush): Promise<HostIntegrationsPutResult> {
    return this.serialize(() => this.applyNow(push));
  }

  /**
   * Releases a frozen project with its delivered connections. The credentials go first:
   * a failed release then leaves rows without credentials, which home's next push
   * refills, never credentials without rows. A later push that still names the project
   * (home keeps it while `detaching`) brings back neither.
   */
  releaseProject(projectId: string): Promise<void> {
    return this.serialize(async () => {
      const directory = await this.directory();
      if (directory.path) {
        const released = new Set(
          (await this.storage.listIntegrationConnections(projectId)).map(({ id }) => id),
        );
        const cached = (await readCache(directory.path))?.secrets ?? {};
        await this.writeSecrets(
          directory.path,
          Object.fromEntries(Object.entries(cached).filter(([id]) => !released.has(id))),
        );
      }
      await this.storage.releaseProject(projectId, { deleteIntegrationConnections: true });
    });
  }

  async status(): Promise<HostIntegrationsStatus> {
    const rows = deliveredRows(await this.storage.listIntegrationConnections());
    const links = await this.storage.readExternalLinkSyncState();
    const directory = await this.directory();
    const cached = directory.path ? (await readCache(directory.path))?.secrets : undefined;
    return {
      appliedRevision: hostIntegrationsRevision(rows),
      cacheReady:
        directory.unavailable === null &&
        rows.every((row) => cached?.[row.id]?.generation === row.generation),
      cacheUnavailable: directory.unavailable,
      seededProjectIds: links.seededProjectIds,
      pendingReceipts: links.pendingReceipts,
    };
  }

  async readCredentials(
    connection: Pick<IntegrationConnection, 'id' | 'generation'>,
  ): Promise<CachedCredentialsRead> {
    const directory = await this.directory();
    if (directory.path === null) return { state: 'unavailable', reason: directory.unavailable };
    const cached = (await readCache(directory.path))?.secrets[connection.id];
    if (cached?.generation !== connection.generation) return { state: 'missing' };
    return { state: 'ready', credentials: cached.credentials };
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.applying.then(work);
    this.applying = run.catch(() => undefined);
    return run;
  }

  private async applyNow(push: HostIntegrationsPush): Promise<HostIntegrationsPutResult> {
    if (hostIntegrationsRevision(push.connections) !== push.revision) {
      throw new ValidationError('The integrations push revision does not match its connections.', {
        code: 'INTEGRATIONS_PUSH_REVISION_MISMATCH',
      });
    }
    const links = {
      seed: push.seed,
      ackedReceiptIds: push.acks?.map((ack) => ack.receiptId),
    };
    const directory = await this.directory();
    let applied: Awaited<ReturnType<CacheStorage['replaceDeliveredIntegrationConnections']>>;
    if (!directory.path) {
      if (push.secrets?.length) {
        logger.warn(
          { reason: directory.unavailable },
          'Dropped pushed integration credentials: no memory-only runtime directory',
        );
      }
      applied = await this.storage.replaceDeliveredIntegrationConnections(push.connections, links);
    } else {
      // Revocations reach the file before the rows, so a failed DB write never keeps a
      // credential home dropped. An omitted credential keeps the cached one.
      const previous = (await readCache(directory.path))?.secrets ?? {};
      const kept = keepMatching(previous, push.connections);
      await this.writeSecrets(directory.path, kept);
      applied = await this.storage.replaceDeliveredIntegrationConnections(push.connections, links);
      // Credentials are added only for rows the VM now holds: never for a released project.
      const pushed: CacheFile['secrets'] = Object.fromEntries(
        (push.secrets ?? []).map((secret) => [
          secret.connectionId,
          { generation: secret.generation, credentials: secret.credentials },
        ]),
      );
      await this.writeSecrets(
        directory.path,
        keepMatching({ ...kept, ...pushed }, applied.connections),
      );
    }
    logger.info(
      {
        connections: push.connections.length,
        secrets: push.secrets?.length ?? 0,
        seeded: push.seed?.length ?? 0,
        acks: push.acks?.length ?? 0,
      },
      'Applied the integrations push from home',
    );
    return { revision: push.revision, seededProjectIds: applied.seededProjectIds };
  }

  private async writeSecrets(directory: string, secrets: CacheFile['secrets']): Promise<void> {
    const file = join(directory, INTEGRATIONS_VM_CACHE_FILE);
    if (Object.keys(secrets).length === 0) {
      await rm(file, { force: true });
      return;
    }
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify({ version: 1, secrets } satisfies CacheFile), {
        mode: 0o600,
        flag: 'wx',
      });
      await rename(temp, file);
    } finally {
      await rm(temp, { force: true });
    }
  }

  private async directory(): Promise<CacheDirectory> {
    const systemd = await this.runtimeDirectory.resolveSystemd();
    if (!systemd) return { path: null, unavailable: 'runtime_directory_missing' };
    if (!systemd.tmpfs) return { path: null, unavailable: 'runtime_directory_not_tmpfs' };
    return { path: systemd.path, unavailable: null };
  }
}

/** The cached credentials of `connections`, each only at its connection's generation. */
function keepMatching(
  secrets: CacheFile['secrets'],
  connections: readonly Pick<IntegrationConnection, 'id' | 'generation'>[],
): CacheFile['secrets'] {
  const kept: CacheFile['secrets'] = {};
  for (const { id, generation } of connections) {
    if (secrets[id]?.generation === generation) kept[id] = secrets[id];
  }
  return kept;
}

/** A missing or unreadable cache reads as empty: home pushes again on its next poll. */
async function readCache(directory: string): Promise<CacheFile | null> {
  let text: string;
  try {
    text = await readFile(join(directory, INTEGRATIONS_VM_CACHE_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn({ code: (error as NodeJS.ErrnoException).code }, 'Integrations cache unreadable');
    }
    return null;
  }
  try {
    return CacheFileSchema.parse(JSON.parse(text));
  } catch {
    logger.warn('Integrations cache is not valid; waiting for the next push from home');
    return null;
  }
}
