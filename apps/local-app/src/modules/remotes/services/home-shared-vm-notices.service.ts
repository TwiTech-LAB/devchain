import { Inject, Injectable } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import {
  REALTIME_BROADCASTER,
  type RealtimeBroadcaster,
} from '../../realtime/ports/realtime-broadcaster.port';
import type { RemoteNoticeDto } from '../dtos/remote-notices.dto';
import { RemoteHostClient } from '../operations/remote-host.client';
import { RemoteForcedDetachService } from './remote-forced-detach.service';

const logger = createLogger('HomeSharedVmNoticesService');

@Injectable()
export class HomeSharedVmNoticesService {
  private readonly notices = new Map<string, RemoteNoticeDto[]>();
  private readonly versions = new Map<string, number>();

  constructor(
    private readonly host: RemoteHostClient,
    private readonly forcedDetach: RemoteForcedDetachService,
    @Inject(REALTIME_BROADCASTER) private readonly broadcaster: RealtimeBroadcaster,
  ) {}

  list(): RemoteNoticeDto[] {
    return Array.from(this.notices.values()).flat();
  }

  async poll(remoteId: string): Promise<void> {
    const results = await Promise.allSettled([
      this.fetchNotices(remoteId),
      this.forcedDetach.flush(remoteId),
    ]);
    for (const result of results) {
      if (result.status === 'rejected')
        logger.debug({ remoteId, error: String(result.reason) }, 'Shared VM notice polling failed');
    }
  }

  async dismiss(remoteId: string, id: string): Promise<void> {
    await this.host.sharedVmDismiss(remoteId, id);
    this.versions.set(remoteId, (this.versions.get(remoteId) ?? 0) + 1);
    this.commit(
      remoteId,
      (this.notices.get(remoteId) ?? []).filter((notice) => notice.id !== id),
    );
  }

  prune(remoteIds: ReadonlySet<string>): void {
    for (const remoteId of new Set([...this.notices.keys(), ...this.versions.keys()])) {
      if (!remoteIds.has(remoteId)) {
        this.notices.delete(remoteId);
        this.versions.delete(remoteId);
      }
    }
  }

  private async fetchNotices(remoteId: string): Promise<void> {
    const version = (this.versions.get(remoteId) ?? 0) + 1;
    this.versions.set(remoteId, version);
    const notices = await this.host.sharedVmNotices(remoteId);
    if (this.versions.get(remoteId) !== version) return;
    this.commit(
      remoteId,
      notices.map((notice) => ({ ...notice, remoteId })),
    );
  }

  private commit(remoteId: string, notices: RemoteNoticeDto[]): void {
    const previous = this.notices.get(remoteId) ?? [];
    this.notices.set(remoteId, notices);
    if (JSON.stringify(previous) !== JSON.stringify(notices))
      this.broadcaster.broadcastEvent('remotes', 'notices', { remoteId });
  }
}
