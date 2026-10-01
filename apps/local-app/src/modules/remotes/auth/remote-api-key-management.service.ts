import { Inject, Injectable } from '@nestjs/common';
import { AppError, ConflictError } from '../../../common/errors/error-types';
import { STORAGE_SERVICE, type RemoteStorage } from '../../storage/interfaces/storage.interface';
import {
  HOST_API_KEY_REJECTED,
  generateHostApiKey,
  hashHostApiKey,
  isHostApiKeyRejection,
} from '../host-api-key';
import { RemoteHealthService } from '../services/remote-health.service';
import { RemoteApiKeyService, remoteAuthorization } from './remote-api-key.service';
import { remoteFetch, requireRemoteTls } from '../transport/remote-tls';

@Injectable()
export class RemoteApiKeyManagementService {
  /** Remotes with an API key change in progress. */
  private readonly busy = new Set<string>();

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: RemoteStorage,
    private readonly keys: RemoteApiKeyService,
    private readonly health: RemoteHealthService,
  ) {}

  /**
   * Checks an address before it is registered, over a connection pinned to
   * `certificate`. With a key, the VM must accept it; without one, the VM must
   * not require one. Fails when the VM does not answer.
   */
  async validate(baseUrl: string, certificate: string, key?: string): Promise<void> {
    if (key !== undefined) {
      await this.verify(baseUrl, certificate, key);
      return;
    }
    const response = await this.request(`${baseUrl}/api/host/stats`, { headers: {} }, certificate);
    if (response.status !== 401) {
      await response.body?.cancel();
      return;
    }
    if (await isHostApiKeyRejection(response)) {
      throw new AppError(
        'This VM requires an API key. Enter the key from the VM.',
        HOST_API_KEY_REJECTED,
        401,
      );
    }
  }

  private async verify(baseUrl: string, certificate: string, key: string): Promise<void> {
    const response = await this.request(
      `${baseUrl}/api/host/stats`,
      { headers: remoteAuthorization(key) },
      certificate,
    );
    await response.body?.cancel();
    if (response.status === 401) {
      throw new AppError('The VM refused this key.', HOST_API_KEY_REJECTED, 401);
    }
    if (!response.ok)
      throw new AppError('Could not verify the VM API key.', 'HOST_API_KEY_CHECK_FAILED', 502);
  }

  enter(remoteId: string, key: string): Promise<void> {
    return this.exclusive(remoteId, async () => {
      const remote = await this.storage.getRemote(remoteId);
      if (!remote.baseUrl) throw new ConflictError('This VM has no address yet.');
      const { baseUrl, certificate } = requireRemoteTls(remote);
      await this.verify(baseUrl, certificate, key);
      try {
        await this.keys.save(remoteId, key);
      } catch {
        throw new AppError('Could not save the VM API key.', 'HOST_API_KEY_SAVE_FAILED', 500);
      }
      await this.health.refresh(remoteId);
    });
  }

  reset(remoteId: string): Promise<void> {
    return this.exclusive(remoteId, async () => {
      const remote = await this.storage.getRemote(remoteId);
      const state = this.health.getState(remoteId);
      if (!remote.baseUrl || !state.online || state.apiKeyRejected) {
        throw new ConflictError('The VM must be online with an accepted API key.');
      }
      const { baseUrl, certificate } = requireRemoteTls(remote);
      const key = generateHostApiKey();
      const response = await this.request(
        `${baseUrl}/api/host/api-key`,
        {
          method: 'POST',
          headers: { ...(await this.keys.headers(remoteId)), 'content-type': 'application/json' },
          body: JSON.stringify({ sha256: hashHostApiKey(key) }),
        },
        certificate,
      );
      await response.body?.cancel();
      if (response.status !== 204) {
        if (response.status === 401) this.health.rejectApiKey(remoteId);
        throw new AppError('The VM could not reset its API key.', 'HOST_API_KEY_RESET_FAILED', 502);
      }
      try {
        await this.keys.save(remoteId, key);
      } catch {
        this.health.rejectApiKey(remoteId);
        throw new AppError(
          'The VM changed its key, but this PC could not save it. Run devchain host api-key reset on the VM, then use Enter API key.',
          'HOST_API_KEY_SAVE_FAILED',
          500,
        );
      }
      await this.health.refresh(remoteId);
    });
  }

  /** Runs one API key change per remote at a time. */
  private async exclusive(remoteId: string, change: () => Promise<void>): Promise<void> {
    if (this.busy.has(remoteId)) throw new ConflictError('An API key change is already running.');
    this.busy.add(remoteId);
    try {
      await change();
    } finally {
      this.busy.delete(remoteId);
    }
  }

  private async request(url: string, init: RequestInit, certificate: string): Promise<Response> {
    try {
      return await remoteFetch(
        url,
        { ...(init as object), signal: AbortSignal.timeout(3000) },
        certificate,
      );
    } catch {
      throw new AppError(
        'Could not reach the VM to check its API key.',
        'HOST_API_KEY_REQUEST_FAILED',
        502,
      );
    }
  }
}
