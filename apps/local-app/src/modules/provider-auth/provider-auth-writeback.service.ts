import { RemoteApiKeyService } from '../remotes/auth/remote-api-key.service';
import { remoteFetch, requireRemoteTls } from '../remotes/transport/remote-tls';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { createLogger } from '../../common/logging/logger';
import {
  STORAGE_SERVICE,
  type ProviderAuthStorage,
  type RemoteStorage,
} from '../storage/interfaces/storage.interface';
import type { ProviderAuthFamilyReport } from './provider-auth-watcher.service';
import { ProviderAuthVaultService } from './provider-auth-vault.service';

const logger = createLogger('ProviderAuthWriteback');

// Same bound as the health poll: a hung host must not delay the next poll.
const REQUEST_TIMEOUT_MS = 3000;

const FamiliesResponseSchema = z.array(
  z
    .object({
      provider: z.string().min(1).max(32),
      files: z
        .array(
          z.object({
            path: z.string().min(1).max(512),
            contentBase64: z.string(),
            mtime: z.number().nonnegative(),
          }),
        )
        .min(1),
    })
    .strict(),
);

export interface PulledFamilyStatus {
  provider: string;
  entryId: string;
  lastWritebackAt: string | null;
}

export interface PullFamiliesResult {
  /** True when the host answered; false means the report is the last stored one. */
  pulled: boolean;
  families: PulledFamilyStatus[];
}

/**
 * Home's side of the family write-back: pulls changed login files from each
 * host on the health poll and refreshes the checked-out vault entries. The
 * `since` mtime filter keeps a poll cheap — content crosses only when a file
 * changed. `pullFamiliesNow` is the pre-destroy pull of the reset and delete
 * paths: with the host down it reports the last stored payload's write-back
 * time instead.
 */
@Injectable()
export class ProviderAuthWritebackService {
  /** remoteId → the newest family mtime home has stored (in-memory; a restart re-pulls). */
  private readonly lastSeenMtimes = new Map<string, number>();

  private readonly pauses = new Map<string, string>();
  /** remoteId → the newest queued pull; each pull waits for the one before it. */
  private readonly tails = new Map<string, Promise<unknown>>();

  async pause(remoteId: string, operationId: string): Promise<void> {
    this.pauses.set(operationId, remoteId);
    await this.tails.get(remoteId)?.catch(() => undefined);
  }

  resume(operationId: string): void {
    const remoteId = this.pauses.get(operationId);
    this.pauses.delete(operationId);
    if (remoteId) this.lastSeenMtimes.delete(remoteId);
  }

  private async isPaused(remoteId: string): Promise<boolean> {
    if ([...this.pauses.values()].includes(remoteId)) return true;
    const operations = await this.storage.listRemoteOperations({
      remoteId,
      kinds: ['update_logins'],
      states: ['running', 'failed'],
    });
    return (
      operations.some((operation) => operation.details.writebackPaused === true) ||
      [...this.pauses.values()].includes(remoteId)
    );
  }

  private track<T>(remoteId: string, work: () => Promise<T>): Promise<T> {
    // A slower, older response must never overwrite a newer family snapshot.
    const previous = this.tails.get(remoteId) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(work);
    this.tails.set(remoteId, pending);
    return pending.finally(() => {
      if (this.tails.get(remoteId) === pending) this.tails.delete(remoteId);
    });
  }

  constructor(
    @Inject(STORAGE_SERVICE)
    private readonly storage: ProviderAuthStorage & RemoteStorage,
    private readonly vault: ProviderAuthVaultService,
    private readonly apiKeys: RemoteApiKeyService,
  ) {}

  /** One health-poll tick. Silent on every tolerated outcome: older hosts answer
   *  404, plain instances 409, and a write-back failure must never mark a remote offline. */
  pullIfChanged(remoteId: string, baseUrl: string, certificate: string): Promise<void> {
    return this.track(remoteId, async () => {
      try {
        if (await this.isPaused(remoteId)) return;
        // Write-back only updates families checked out to this remote; with none
        // there is nothing to pull, so the poll skips the host request.
        if ((await this.vault.familiesOfRemote(remoteId)).length === 0) return;
        await this.pull(remoteId, baseUrl, certificate);
      } catch (error) {
        logger.debug({ err: error, remoteId }, 'Family write-back pull skipped');
      }
    });
  }

  /**
   * The synchronous pull before a reset or delete: newest content when the
   * host answers; with the host down the vault keeps the last stored payload
   * and the result carries its `lastWritebackAt`.
   */
  pullFamiliesNow(remoteId: string): Promise<PullFamiliesResult> {
    return this.track(remoteId, () => this.pullFamiliesUnpaused(remoteId));
  }

  private async pullFamiliesUnpaused(remoteId: string): Promise<PullFamiliesResult> {
    if (await this.isPaused(remoteId)) {
      return { pulled: false, families: await this.vault.familiesOfRemote(remoteId) };
    }
    const remote = await this.storage.getRemote(remoteId);
    let pulled = false;
    try {
      if (remote.baseUrl) {
        const { baseUrl, certificate } = requireRemoteTls(remote);
        await this.pull(remoteId, baseUrl, certificate);
        pulled = true;
      }
    } catch (error) {
      logger.warn(
        { err: error, remoteId },
        'Families pull before reset/delete used the last report',
      );
    }
    return { pulled, families: await this.vault.familiesOfRemote(remoteId) };
  }

  private async pull(remoteId: string, baseUrl: string, certificate: string): Promise<void> {
    const since = this.lastSeenMtimes.get(remoteId) ?? 0;
    const families = await this.fetchFamilies(remoteId, baseUrl, certificate, since);
    if (families.length === 0) return;
    let newest = since;
    for (const family of families) {
      for (const file of family.files) {
        newest = Math.max(newest, file.mtime);
      }
    }
    await this.vault.writeBackFamilies(remoteId, families);
    this.lastSeenMtimes.set(remoteId, newest);
  }

  /**
   * Empty when nothing changed. Throws when the host refuses the request (an
   * older version answers 404, a plain instance 409) or answers an unexpected
   * body: that is not a pull, so `pullFamiliesNow` reports `pulled: false` and
   * a release or destroy never claims content it did not receive.
   */
  private async fetchFamilies(
    remoteId: string,
    baseUrl: string,
    certificate: string,
    sinceMs: number,
  ): Promise<ProviderAuthFamilyReport[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timeout.unref?.();
    // File times have a fraction of a millisecond, and older hosts accept only whole
    // numbers. Rounding up still skips the file already stored.
    const since = Math.ceil(sinceMs);
    try {
      const response = await remoteFetch(
        `${baseUrl.replace(/\/+$/, '')}/api/host/provider-auth/families?since=${since}`,
        { signal: controller.signal, headers: await this.apiKeys.headers(remoteId) },
        certificate,
      );
      if (!response.ok) {
        throw new Error(`Families request answered ${response.status}`);
      }
      const parsed = FamiliesResponseSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) {
        throw new Error('Families answer had an unexpected shape');
      }
      return parsed.data;
    } finally {
      clearTimeout(timeout);
    }
  }
}
