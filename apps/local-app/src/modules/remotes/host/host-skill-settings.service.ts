import { Inject, Injectable } from '@nestjs/common';
import { ConflictError, NotFoundError } from '../../../common/errors/error-types';
import type { HostSkillSettings, HostSkillSettingsStatus } from '@devchain/shared';
import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { createLogger } from '../../../common/logging/logger';
import { SettingsService } from '../../settings/services/settings.service';
import type { HomePushedSkillSource } from '../../settings/local/delegates/skills-settings.delegate';
import { LOCAL_SOURCE_CONTENT_HASH_FILE } from '../../skills/adapters/local-skill-source.adapter';
import { SkillSourceLifecycleService } from '../../skills/services/skill-source-lifecycle.service';
import type { LocalSkillSource } from '../../storage/models/domain.models';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import { unpackHomeSkillContent, swapHomeSkillContent } from './host-skill-content';

const logger = createLogger('HostSkillSettingsService');
type Community = HostSkillSettings['communitySources'][number];
type Local = HostSkillSettings['localSources'][number];
const sameRepo = (a: Community, b: Community): boolean =>
  a.repoOwner === b.repoOwner && a.repoName === b.repoName;
const sameDefinition = (a: Community, b: Community): boolean =>
  sameRepo(a, b) && a.branch === b.branch;
const anotherDefinition = (): ConflictError =>
  new ConflictError('Host source has another definition');

@Injectable()
export class HostSkillSettingsService {
  private appliedBody: HostSkillSettings | null = null;
  private queued: HostSkillSettings | null = null;
  private applying: HostSkillSettings | null = null;
  private appliedRevision: string | null = null;
  private skipped: HostSkillSettingsStatus['skipped'] = [];
  private draining = false;
  private drainCompletion: Promise<void> = Promise.resolve();
  private completeDrain: (() => void) | null = null;
  private work: Promise<unknown> = Promise.resolve();

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly settings: SettingsService,
    private readonly lifecycle: SkillSourceLifecycleService,
  ) {}

  managedRoot(): string {
    return join(homedir(), '.devchain', 'home-skill-sources');
  }
  private managedPath(name: string): string {
    return join(this.managedRoot(), name);
  }

  /** The newest body: queued, else applying, else the last one applied. */
  private get latest(): HostSkillSettings | null {
    return this.queued ?? this.applying ?? this.appliedBody;
  }

  accept(body: HostSkillSettings): void {
    this.queued = body;
    if (!this.draining) {
      this.draining = true;
      this.drainCompletion = new Promise((resolve) => {
        this.completeDrain = resolve;
      });
      setImmediate(() => void this.drain());
    }
  }

  async status(): Promise<HostSkillSettingsStatus> {
    const needsContent: HostSkillSettingsStatus['needsContent'] = [];
    const owned = this.settings.getHomePushedSkillSources();
    for (const source of this.latest?.localSources ?? []) {
      if (await this.hasContent(source)) continue;
      const { free } = await this.lookupLocalNameForHome(
        source.name,
        owned.some((entry) => entry.name === source.name && entry.kind === 'local'),
      );
      // A name the host cannot give home would end in a 409 upload every poll;
      // the check reads current storage so removing the conflict relists it.
      if (free) needsContent.push({ name: source.name, contentHash: source.contentHash });
    }
    return {
      appliedRevision: this.appliedRevision,
      pendingRevision: (this.queued ?? this.applying)?.revision ?? null,
      skipped: this.skipped,
      needsContent,
    };
  }

  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const result = this.work.then(run);
    this.work = result.catch(() => undefined);
    return result;
  }

  private async drain(): Promise<void> {
    try {
      while (this.queued) {
        const body = this.queued;
        this.queued = null;
        this.applying = body;
        try {
          await this.exclusive(() => this.apply(body));
          this.appliedRevision = body.revision;
          this.appliedBody = body;
        } catch {
          logger.warn(
            { revision: body.revision },
            'Host skill settings apply failed; home can retry',
          );
        } finally {
          this.applying = null;
        }
      }
    } finally {
      this.draining = false;
      this.completeDrain?.();
      this.completeDrain = null;
    }
  }

  private async afterPendingApply(run: () => Promise<void>): Promise<void> {
    // Creation seeds project rows, so pending home rows must be inserted before an upload creates a source.
    for (;;) {
      await this.drainCompletion;
      const completed = await this.exclusive(async () => {
        if (this.draining) return false;
        await run();
        return true;
      });
      if (completed) return;
    }
  }

  private async hasContent(source: Local): Promise<boolean> {
    try {
      return (
        (await fs.readFile(
          join(this.managedPath(source.name), LOCAL_SOURCE_CONTENT_HASH_FILE),
          'utf8',
        )) === source.contentHash &&
        (await fs.stat(join(this.managedPath(source.name), 'skills'))).isDirectory()
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private async apply(body: HostSkillSettings): Promise<void> {
    const retry = this.appliedRevision === body.revision;
    const retryNames = new Set(this.skipped.map((source) => source.name));
    const owned = new Map(
      this.settings.getHomePushedSkillSources().map((source) => [source.name, source]),
    );
    const skipped: HostSkillSettingsStatus['skipped'] = [];
    const failed = new Set<string>();
    const attempt = async (
      name: string,
      kind: 'community' | 'local',
      run: () => Promise<void>,
    ): Promise<void> => {
      try {
        await run();
      } catch (error) {
        failed.add(name);
        skipped.push({
          name,
          kind,
          reason: error instanceof Error ? error.message : 'Source apply failed',
        });
      }
    };
    const communities = await this.lifecycle.listCommunitySources();
    const locals = await this.lifecycle.listLocalSources();
    for (const source of communities) {
      if (retry && !retryNames.has(source.name)) continue;
      const wanted = body.communitySources.find((entry) => entry.name === source.name);
      const previous = owned.get(source.name);
      const changed = previous && (!wanted || !sameDefinition(source, wanted));
      const duplicate =
        !previous &&
        body.communitySources.some(
          (entry) => entry.name !== source.name && sameRepo(source, entry),
        );
      if (changed || duplicate)
        await attempt(source.name, 'community', async () => {
          await this.lifecycle.deleteCommunitySource(source.id);
          owned.delete(source.name);
        });
    }
    for (const source of locals) {
      if (retry && !retryNames.has(source.name)) continue;
      const wanted = body.localSources.find((entry) => entry.name === source.name);
      const previous = owned.get(source.name);
      const changed =
        previous &&
        (previous.kind !== 'local' || !wanted || previous.homeFolderPath !== wanted.folderPath);
      const duplicate =
        !previous && body.localSources.some((entry) => entry.folderPath === source.folderPath);
      if (changed || duplicate)
        await attempt(source.name, 'local', async () => {
          await this.lifecycle.deleteLocalSource(source.id);
          if (previous?.kind === 'local') await this.removeManagedCopy(source.name);
          owned.delete(source.name);
        });
    }
    for (const previous of owned.values()) {
      if (
        previous.kind === 'local' &&
        !locals.some((source) => source.name === previous.name) &&
        !body.localSources.some(
          (source) =>
            source.name === previous.name && source.folderPath === previous.homeFolderPath,
        )
      ) {
        await attempt(previous.name, 'local', async () => {
          await this.removeManagedCopy(previous.name);
          owned.delete(previous.name);
        });
      }
    }
    this.settings.setHomePushedSkillSources([...owned.values()]);
    if (!retry) {
      const current = this.settings.getStoredSkillSourcesEnabled();
      this.settings.mergeSkillSourcesEnabled(body.sourcesEnabled);
      this.syncSourcesTurnedOn(current);
    }
    const presentProjectIds = await this.resolvePresentProjectIds(body.projectSourceSwitches);
    for (const row of body.projectSourceSwitches) {
      if (!presentProjectIds.has(row.projectId)) {
        logger.debug(
          { projectId: row.projectId, sourceName: row.sourceName },
          'Skipping home skill switch for a project this host no longer holds',
        );
        continue;
      }
      await this.storage.setSourceProjectEnabled(row.projectId, row.sourceName, row.enabled, {
        onlyIfMissing: true,
      });
    }
    for (const source of body.communitySources) {
      if (failed.has(source.name) || (retry && !retryNames.has(source.name))) continue;
      await attempt(source.name, 'community', async () => {
        const existing = await this.storage.getCommunitySkillSourceByName(source.name);
        if (existing && !sameDefinition(existing, source)) throw anotherDefinition();
        if (!existing)
          await this.lifecycle.createCommunitySource(
            { ...source, existingProjects: { mode: 'all' } },
            { deferInitialSync: true },
          );
        owned.set(source.name, { name: source.name, kind: 'community' });
      });
    }
    for (const source of body.localSources) {
      if (failed.has(source.name)) continue;
      await attempt(source.name, 'local', async () => {
        const existing = await this.assertLocalNameFree(
          source.name,
          owned.get(source.name)?.kind === 'local',
        );
        owned.set(source.name, {
          name: source.name,
          kind: 'local',
          homeFolderPath: source.folderPath,
          contentHash: source.contentHash,
        });
        if (!existing && (await this.hasContent(source)))
          await this.createManagedLocalSource(source.name);
      });
    }
    this.settings.setHomePushedSkillSources([...owned.values()]);
    this.skipped = skipped;
  }

  /**
   * Home keeps sending switch rows for bindings that are still 'detaching' or
   * 'failed' after this host released the project, and such a row would trip
   * the switch table's foreign key and fail the whole apply. Existence is
   * resolved once per apply for the body's distinct project ids, so rows for
   * released projects are skipped instead of fatal.
   */
  private async resolvePresentProjectIds(
    rows: HostSkillSettings['projectSourceSwitches'],
  ): Promise<Set<string>> {
    const present = new Set<string>();
    for (const projectId of new Set(rows.map((row) => row.projectId))) {
      try {
        await this.storage.getProject(projectId);
        present.add(projectId);
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
      }
    }
    return present;
  }

  private removeManagedCopy(name: string): Promise<void> {
    return this.lifecycle.enqueueExclusiveJob(() =>
      fs.rm(this.managedPath(name), { recursive: true, force: true }),
    );
  }

  private async createManagedLocalSource(name: string): Promise<void> {
    await this.lifecycle.createLocalSource(
      { name, folderPath: this.managedPath(name), existingProjects: { mode: 'all' } },
      { deferInitialSync: true },
    );
  }

  /**
   * Home may manage a local source name only when no community source uses it
   * and any existing local source is home's own managed copy. Returns whether
   * the name is free and that copy when it exists.
   */
  private async lookupLocalNameForHome(
    name: string,
    ownedAsLocal: boolean,
  ): Promise<{ free: boolean; managedCopy: LocalSkillSource | null }> {
    const existing = await this.storage.getLocalSkillSourceByName(name);
    if (existing && (!ownedAsLocal || existing.folderPath !== this.managedPath(name)))
      return { free: false, managedCopy: null };
    if (await this.storage.getCommunitySkillSourceByName(name))
      return { free: false, managedCopy: null };
    return { free: true, managedCopy: existing };
  }

  /** Same rule as `lookupLocalNameForHome`; throws instead when the name is taken. */
  private async assertLocalNameFree(
    name: string,
    ownedAsLocal: boolean,
  ): Promise<LocalSkillSource | null> {
    const { free, managedCopy } = await this.lookupLocalNameForHome(name, ownedAsLocal);
    if (!free) throw anotherDefinition();
    return managedCopy;
  }

  /**
   * A write that turned a global source switch on must start that source's
   * sync: sync skips a disabled source, and nothing else repairs a source
   * whose first sync ran while it was off. Callers pass the stored switch map
   * (`getStoredSkillSourcesEnabled`) they read before their write, so a legacy
   * "off" of an always-enabled source also starts a sync.
   */
  syncSourcesTurnedOn(before: Record<string, boolean>): void {
    const current = this.settings.getSkillSourcesEnabled();
    for (const [name, previouslyEnabled] of Object.entries(before)) {
      if (previouslyEnabled === false && current[name] !== false) {
        this.lifecycle.enqueueDeferredSync(name, 'builtin');
      }
    }
  }

  private assertContentCurrent(name: string, contentHash: string): Local {
    const source = this.latest?.localSources.find(
      (entry) => entry.name === name && entry.contentHash === contentHash,
    );
    if (!source) throw new ConflictError('Local source or content hash is no longer current');
    return source;
  }

  async upload(
    name: string,
    contentHash: string,
    stream: Readable,
  ): Promise<{ name: string; contentHash: string }> {
    this.assertContentCurrent(name, contentHash);
    const temporary = await unpackHomeSkillContent(stream, this.managedRoot());
    try {
      await fs.writeFile(join(temporary, LOCAL_SOURCE_CONTENT_HASH_FILE), contentHash);
      await this.afterPendingApply(async () => {
        const source = this.assertContentCurrent(name, contentHash);
        const owned = this.settings.getHomePushedSkillSources();
        const existing = await this.assertLocalNameFree(
          name,
          owned.some((entry) => entry.name === name && entry.kind === 'local'),
        );
        await this.lifecycle.enqueueExclusiveJob(() =>
          swapHomeSkillContent(
            temporary,
            this.managedPath(name),
            () => {
              this.assertContentCurrent(name, contentHash);
            },
            async () => {
              if (existing) this.lifecycle.enqueueDeferredSync(name, 'local');
              else await this.createManagedLocalSource(name);
              const record: HomePushedSkillSource = {
                name,
                kind: 'local',
                homeFolderPath: source.folderPath,
                contentHash,
              };
              this.settings.setHomePushedSkillSources([
                ...owned.filter((entry) => entry.name !== name),
                record,
              ]);
            },
          ),
        );
        this.skipped = this.skipped.filter((entry) => entry.name !== name);
      });
      return { name, contentHash };
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }
}
