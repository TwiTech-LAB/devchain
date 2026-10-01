import { Inject, Injectable } from '@nestjs/common';
import { STORAGE_SERVICE, type RemoteStorage } from '../../storage/interfaces/storage.interface';
import { generateHostApiKey } from '../host-api-key';

export function remoteAuthorization(key: string | null | undefined): Record<string, string> {
  return key ? { authorization: `Bearer ${key}` } : {};
}

@Injectable()
export class RemoteApiKeyService {
  private readonly memo = new Map<string, Promise<string | null>>();

  constructor(@Inject(STORAGE_SERVICE) private readonly storage: RemoteStorage) {}

  get(remoteId: string): Promise<string | null> {
    const memoized = this.memo.get(remoteId);
    if (memoized) return memoized;
    const pending = this.storage.readRemoteApiKey(remoteId);
    this.memo.set(remoteId, pending);
    void pending.catch(() => {
      if (this.memo.get(remoteId) === pending) this.memo.delete(remoteId);
    });
    return pending;
  }

  async getOrCreate(remoteId: string): Promise<string> {
    const existing = await this.get(remoteId);
    if (existing) return existing;
    await this.save(remoteId, generateHostApiKey(), true);
    return (await this.get(remoteId))!;
  }

  async save(remoteId: string, key: string, onlyIfAbsent = false): Promise<void> {
    try {
      await this.storage.saveRemoteApiKey(remoteId, key, onlyIfAbsent);
    } finally {
      this.memo.delete(remoteId);
    }
  }

  async headers(remoteId: string): Promise<Record<string, string>> {
    return remoteAuthorization(await this.get(remoteId));
  }
}
