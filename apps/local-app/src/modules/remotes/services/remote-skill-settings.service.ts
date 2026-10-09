import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  HostSkillSettingsSchema,
  type HostSkillSettings,
  type HostSkillSettingsStatus,
} from '@devchain/shared';
import { createLogger } from '../../../common/logging/logger';
import { SettingsService } from '../../settings/services/settings.service';
import { LocalSkillSourceAdapter } from '../../skills/adapters/local-skill-source.adapter';
import {
  STORAGE_SERVICE,
  type StorageService,
  type SkillSourceStorage,
} from '../../storage/interfaces/storage.interface';
import {
  effectiveSourceSwitches,
  registeredSourceNames,
} from '../../storage/local/helpers/skill-source-switches';
import { RemoteHostClient } from '../operations/remote-host.client';
import { HomeSkillArchiveTooLargeError, prepareHomeSkillArchive } from './home-skill-archive';

const logger = createLogger('RemoteSkillSettingsService');
const RETRY_INTERVAL_MS = 5 * 60_000;
const UPLOAD_TIMEOUT_MS = 60_000;
type GlobalSettings = Pick<
  HostSkillSettings,
  'communitySources' | 'localSources' | 'sourcesEnabled'
> & { unavailable: Set<string> };
export type SkillSettingsPollCycle = () => Promise<GlobalSettings>;
type RemoteLogState = { revision: string; keys: Set<string> };

@Injectable()
export class RemoteSkillSettingsService implements OnModuleDestroy {
  private readonly pushing = new Set<string>();
  private readonly uploading = new Map<string, AbortController>();
  private readonly lastPush = new Map<string, { revision: string; at: number }>();
  private readonly skippedRevision = new Map<string, string>();
  private readonly logged = new Map<string, RemoteLogState>();
  /**
   * A 20 MB refusal memo per source name, shared across remotes: every host
   * counts the same bytes, so one refusal stops the per-poll pack for all of
   * them. The time window, not the hash, must retry a shrink — the content
   * hash skips dotfiles and files directly in skills/, which the archive
   * still packs.
   */
  private readonly oversizedRefusals = new Map<string, { contentHash: string; at: number }>();
  private stopped = false;

  constructor(
    @Inject(STORAGE_SERVICE)
    private readonly storage: SkillSourceStorage &
      Pick<StorageService, 'listRemoteProjectBindings'>,
    private readonly settings: SettingsService,
    private readonly host: RemoteHostClient,
  ) {}

  createPollCycle(): SkillSettingsPollCycle {
    let snapshot: Promise<GlobalSettings> | undefined;
    return () => (snapshot ??= this.buildGlobalSettings());
  }

  prune(remoteIds: Set<string>): void {
    for (const id of this.logged.keys()) if (!remoteIds.has(id)) this.logged.delete(id);
    for (const id of this.skippedRevision.keys())
      if (!remoteIds.has(id)) this.skippedRevision.delete(id);
    for (const id of this.lastPush.keys()) if (!remoteIds.has(id)) this.lastPush.delete(id);
    for (const [id, controller] of this.uploading) if (!remoteIds.has(id)) controller.abort();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    for (const controller of this.uploading.values()) controller.abort();
  }

  async pushIfChanged(remoteId: string, cycle: SkillSettingsPollCycle): Promise<void> {
    if (this.stopped || this.pushing.has(remoteId)) return;
    this.pushing.add(remoteId);
    try {
      const global = await cycle();
      const body = await this.buildBody(remoteId, global);
      if (this.logged.get(remoteId)?.revision !== body.revision)
        this.logged.set(remoteId, { revision: body.revision, keys: new Set() });
      if (this.stopped) return;
      const status = await this.host.getSkillSettingsStatus(remoteId);
      if (this.stopped) return;
      if (
        status.skipped.length &&
        status.appliedRevision !== null &&
        this.skippedRevision.get(remoteId) !== status.appliedRevision
      ) {
        this.skippedRevision.set(remoteId, status.appliedRevision);
        logger.debug(
          { remoteId, revision: status.appliedRevision, skipped: status.skipped },
          'Host skipped skill sources',
        );
      }
      for (const name of global.unavailable)
        this.logOnce(
          remoteId,
          body.revision,
          `unavailable:${name}`,
          { sourceName: name },
          'Local skill folder is unavailable',
        );
      const last = this.lastPush.get(remoteId);
      const retryDue =
        status.appliedRevision === body.revision &&
        status.pendingRevision === null &&
        status.skipped.length > 0 &&
        (!last || last.revision !== body.revision || Date.now() - last.at >= RETRY_INTERVAL_MS);
      if (
        status.pendingRevision !== body.revision &&
        (status.appliedRevision !== body.revision || retryDue)
      ) {
        this.lastPush.set(remoteId, { revision: body.revision, at: Date.now() });
        await this.host.putSkillSettings(remoteId, body);
      }
      this.startUploads(remoteId, body, global.unavailable, status.needsContent);
    } catch (error) {
      logger.debug(
        { remoteId, error: error instanceof Error ? error.message : String(error) },
        'Skill settings push failed; next poll will retry',
      );
    } finally {
      this.pushing.delete(remoteId);
    }
  }

  private async buildGlobalSettings(): Promise<GlobalSettings> {
    const [community, local] = await Promise.all([
      this.storage.listCommunitySkillSources(),
      this.storage.listLocalSkillSources(),
    ]);
    const communitySources = community
      .map(({ name, repoOwner, repoName, branch }) => ({ name, repoOwner, repoName, branch }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const unavailable = new Set<string>();
    const localSources = await Promise.all(
      local
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(async (source) => {
          let contentHash: string;
          try {
            contentHash = await new LocalSkillSourceAdapter(source).getLatestCommit();
          } catch {
            // A distinct stable marker keeps the host requesting content while the folder is unreadable.
            contentHash = 'unavailable';
            unavailable.add(source.name);
          }
          return { name: source.name, folderPath: source.folderPath, contentHash };
        }),
    );
    const registered = registeredSourceNames([
      ...community.map((source) => source.name),
      ...local.map((source) => source.name),
    ]).sort();
    return {
      communitySources,
      localSources,
      sourcesEnabled: effectiveSourceSwitches(this.settings.getSkillSourcesEnabled(), registered),
      unavailable,
    };
  }

  private async buildBody(remoteId: string, global: GlobalSettings): Promise<HostSkillSettings> {
    const bindings = await this.storage.listRemoteProjectBindings();
    const projectIds = bindings
      .filter(
        (binding) =>
          binding.remoteId === remoteId &&
          (binding.state === 'remote' ||
            binding.state === 'detaching' ||
            (binding.state === 'failed' && binding.hostCursor !== null)),
      )
      .map((binding) => binding.projectId)
      .sort();
    const projectSourceSwitches = (
      await Promise.all(
        projectIds.map(async (projectId) =>
          (await this.storage.listSourceProjectEnabled(projectId)).map((row) => ({
            projectId,
            ...row,
          })),
        ),
      )
    )
      .flat()
      .sort(
        (a, b) =>
          a.projectId.localeCompare(b.projectId) || a.sourceName.localeCompare(b.sourceName),
      );
    const data = {
      communitySources: global.communitySources,
      localSources: global.localSources,
      sourcesEnabled: global.sourcesEnabled,
      projectIds,
      projectSourceSwitches,
    };
    const revision = createHash('sha256').update(JSON.stringify(data)).digest('hex');
    return HostSkillSettingsSchema.parse({ revision, ...data });
  }

  private startUploads(
    remoteId: string,
    body: HostSkillSettings,
    unavailable: Set<string>,
    needed: HostSkillSettingsStatus['needsContent'],
  ): void {
    if (this.stopped || this.uploading.has(remoteId)) return;
    const sources = body.localSources.filter(
      (source) =>
        !unavailable.has(source.name) &&
        needed.some(
          (entry) => entry.name === source.name && entry.contentHash === source.contentHash,
        ) &&
        !this.oversizeRefused(source.name, source.contentHash),
    );
    if (!sources.length) return;
    const controller = new AbortController();
    this.uploading.set(remoteId, controller);
    void this.uploadSources(remoteId, body.revision, sources, controller.signal)
      .catch((error) =>
        logger.debug({ remoteId, error: String(error) }, 'Local skill uploads failed'),
      )
      .finally(() => {
        this.uploading.delete(remoteId);
      });
  }

  private async uploadSources(
    remoteId: string,
    revision: string,
    sources: HostSkillSettings['localSources'],
    signal: AbortSignal,
  ): Promise<void> {
    for (const source of sources) {
      if (signal.aborted) return;
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, UPLOAD_TIMEOUT_MS);
      timer.unref?.();
      let archive: Awaited<ReturnType<typeof prepareHomeSkillArchive>> | undefined;
      try {
        archive = await prepareHomeSkillArchive(source.folderPath, controller.signal);
        await this.host.uploadSkillSourceContent(
          remoteId,
          source.name,
          source.contentHash,
          archive.stream,
          controller.signal,
        );
      } catch (error) {
        if (error instanceof HomeSkillArchiveTooLargeError) {
          this.oversizedRefusals.set(source.name, {
            contentHash: source.contentHash,
            at: Date.now(),
          });
          this.logOnce(
            remoteId,
            revision,
            `oversized:${source.name}`,
            { sourceName: source.name },
            'Local skill source exceeds 20 MB; upload skipped',
          );
        } else if (!archive)
          this.logOnce(
            remoteId,
            revision,
            `unavailable:${source.name}`,
            { sourceName: source.name },
            'Local skill folder is unavailable',
          );
        else
          logger.debug(
            {
              remoteId,
              sourceName: source.name,
              error: error instanceof Error ? error.message : String(error),
            },
            'Local skill upload failed; next poll will retry',
          );
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        await archive?.dispose();
      }
    }
  }

  private logOnce(
    remoteId: string,
    revision: string,
    key: string,
    details: Record<string, unknown>,
    message: string,
  ): void {
    const state = this.logged.get(remoteId);
    if (state?.revision !== revision) return;
    if (state.keys.has(key)) return;
    state.keys.add(key);
    logger.debug({ remoteId, revision, ...details }, message);
  }

  private oversizeRefused(name: string, contentHash: string): boolean {
    const refused = this.oversizedRefusals.get(name);
    return (
      refused !== undefined &&
      refused.contentHash === contentHash &&
      Date.now() - refused.at < RETRY_INTERVAL_MS
    );
  }
}
