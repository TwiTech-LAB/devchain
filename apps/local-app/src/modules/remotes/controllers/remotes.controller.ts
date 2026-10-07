import { RemoteFileSyncService } from '../sync/remote-file-sync.service';
import type { FileSyncFailedCounts } from '../sync/remote-file-sync.dto';
import { Body, Controller, Delete, Get, Inject, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { createLogger } from '../../../common/logging/logger';
import { getEnvConfig } from '../../../common/config/env.config';
import {
  ListResult,
  RemoteStorage,
  STORAGE_SERVICE,
} from '../../storage/interfaces/storage.interface';
import type {
  Remote,
  RemoteOperation,
  RemoteProjectBinding,
} from '../../storage/models/domain.models';
import { REMOTE_HEALTH_PORT, type RemoteHealthPort } from '../ports/remote-health.port';
import {
  CreateRemoteSchema,
  UpdateRemoteNameSchema,
  type RemoteListItemDto,
  type RemoteLoginsDto,
  type RemoteStatsHistoryDto,
} from '../dtos/remote.dto';
import { CLAIM_IDENTITY_KINDS, matchesHomePath } from '../home-identity';
import { reportedVmUserMismatch } from '../vm-user-identity';
import {
  PROVIDER_AUTH_CHOICES,
  claimEntryIds,
  type ClaimProviderState,
} from '../operations/claim.operation';
import { RemotesService } from '../services/remotes.service';

const logger = createLogger('RemotesController');

const RemoteIdSchema = z.string().uuid();

/** The per-provider choice and entry ids of a claim-kind record; nothing else leaves it. */
function recordedLogins(operation: RemoteOperation): RemoteLoginsDto {
  const providerAuth = operation.details.providerAuth;
  if (!providerAuth || typeof providerAuth !== 'object') return {};
  const logins: RemoteLoginsDto = {};
  for (const [provider, state] of Object.entries(providerAuth as Record<string, unknown>)) {
    const claimState = state as ClaimProviderState | null;
    if (!claimState || !PROVIDER_AUTH_CHOICES.includes(claimState.choice)) continue;
    logins[provider] = { choice: claimState.choice, entryIds: claimEntryIds(claimState) };
  }
  return logins;
}

@Controller('api/remotes')
export class RemotesController {
  constructor(
    // Read-CRUD exception (development-standards.md): storage is injected for the
    // list routes and the history route's existence check only; every write goes
    // through RemotesService.
    @Inject(STORAGE_SERVICE) private readonly storage: RemoteStorage,
    @Inject(REMOTE_HEALTH_PORT) private readonly remoteHealth: RemoteHealthPort,
    private readonly remotes: RemotesService,
    private readonly files: RemoteFileSyncService,
  ) {}

  @Get()
  async listRemotes(): Promise<ListResult<RemoteListItemDto>> {
    logger.info('GET /api/remotes');
    const result = await this.storage.listRemotes();
    return {
      ...result,
      items: await Promise.all(result.items.map((remote) => this.withHealth(remote))),
    };
  }

  @Get('bindings')
  async listBindings(): Promise<{
    items: (RemoteProjectBinding & {
      fileSyncWarning?: string;
      fileSyncProblem?: ReturnType<RemoteFileSyncService['problem']>;
      fileSyncFailed?: FileSyncFailedCounts;
    })[];
  }> {
    logger.info('GET /api/remotes/bindings');
    const items = await this.storage.listRemoteProjectBindings();
    return {
      items: items.map((binding) => {
        const warning = this.files.warning(binding.projectId);
        const failed = this.files.failedCounts(binding.projectId);
        return warning && binding.state === 'remote'
          ? {
              ...binding,
              fileSyncWarning: warning,
              fileSyncProblem: this.files.problem(binding.projectId),
              ...(failed && { fileSyncFailed: failed }),
            }
          : binding;
      }),
    };
  }

  @Get(':id/stats/history')
  async getStatsHistory(@Param('id') id: string): Promise<RemoteStatsHistoryDto> {
    logger.info({ remoteId: id }, 'GET /api/remotes/:id/stats/history');
    const remoteId = RemoteIdSchema.parse(id);
    // Unknown ids 404 through the storage NotFoundError; a known remote that has
    // not produced a sample yet legitimately returns an empty list.
    await this.storage.getRemote(remoteId);
    return {
      intervalMs: getEnvConfig().REMOTES_HEALTH_INTERVAL_MS,
      samples: this.remoteHealth.getStatsHistory(remoteId),
    };
  }

  @Post()
  createRemote(@Body() body: unknown): Promise<Remote> {
    logger.info('POST /api/remotes');
    const data = CreateRemoteSchema.parse(body);
    return this.remotes.create(data).then((remote) => {
      // Not awaited: an unreachable address would hold the create answer for the
      // poll timeout, and the next poll would catch up anyway.
      this.remoteHealth.refresh(remote.id).catch((error: unknown) => {
        logger.warn({ err: error, remoteId: remote.id }, 'Health refresh after create failed');
      });
      return remote;
    });
  }

  @Patch(':id')
  updateRemoteName(@Param('id') id: string, @Body() body: unknown): Promise<Remote> {
    logger.info({ remoteId: id }, 'PATCH /api/remotes/:id');
    const remoteId = RemoteIdSchema.parse(id);
    const { name } = UpdateRemoteNameSchema.parse(body);
    return this.remotes.rename(remoteId, name);
  }

  @Delete(':id')
  async deleteRemote(@Param('id') id: string): Promise<void> {
    logger.info({ remoteId: id }, 'DELETE /api/remotes/:id');
    const remoteId = RemoteIdSchema.parse(id);
    await this.remotes.delete(remoteId);
  }

  private async withHealth(remote: Remote): Promise<RemoteListItemDto> {
    const health = this.remoteHealth.getState(remote.id);
    const [[latest], [loginsRecord]] = await Promise.all([
      this.storage.listRemoteOperations({ remoteId: remote.id, limit: 1 }),
      this.storage.listRemoteOperations({
        remoteId: remote.id,
        states: ['done'],
        kinds: CLAIM_IDENTITY_KINDS,
        limit: 1,
      }),
    ]);
    return {
      ...remote,
      online: health.online,
      apiKeyRejected: health.apiKeyRejected ?? false,
      version: health.version,
      versionMatches: health.versionMatches,
      uid: health.uid,
      gid: health.gid,
      dockerUserMismatch: reportedVmUserMismatch(health),
      providerEnvOverrides: health.providerEnvOverrides,
      cliVersions: health.cliVersions,
      providerClis: health.providerClis,
      stats: health.stats,
      docker: health.docker,
      lastSeenAt: health.lastSeenAt,
      powerState: health.powerState,
      homePath: health.homePath,
      homePathMatches: matchesHomePath(health.homePath),
      lastOperation: latest
        ? { id: latest.id, kind: latest.kind, state: latest.state, updatedAt: latest.updatedAt }
        : null,
      logins: loginsRecord ? recordedLogins(loginsRecord) : null,
      // Legacy claim-kind records can predate this field; only a string leaves it.
      userName:
        loginsRecord && typeof loginsRecord.details.userName === 'string'
          ? loginsRecord.details.userName
          : null,
    };
  }
}
