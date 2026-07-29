/**
 * ProjectsService.createFromTemplate — behavior suite (real in-memory storage).
 *
 * Rearchitected for Task 8: the create path no longer calls the (deleted)
 * `storage.createProjectWithTemplate`. It now runs `storage.runInTransaction` →
 * `createProjectShell` + the template-codec pipeline (real per-entity storage methods),
 * then post-tx codecs (watchers, subscribers, teams, scheduledEpics, projectSettings,
 * presets, providerSettings, providerModels, providerEfforts), then template metadata +
 * preset application.
 *
 * These tests exercise the genuine ProjectsService/create-helper behavior that the
 * template round-trip contract suite does NOT cover. They call `createFromTemplateWithHelper`
 * directly (identical to the sibling contract spec) against a REAL `LocalStorageService`
 * on an in-memory better-sqlite3 DB + real `SettingsService`/`TeamsStore`, and assert by
 * querying the persisted result — NOT by inspecting internal pipeline mock calls.
 *
 * The only mocked collaborators are true externals: `unifiedTemplateService` (template
 * content/source/version) and jest-spy wrappers around the real `teamsService.createTeam` /
 * `watchersService.createWatcher` seams so we can assert the exact arguments the create path
 * resolves for those services.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { join } from 'path';

import { LocalStorageService } from '../../storage/local/local-storage.service';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import { SettingsService } from '../../settings/services/settings.service';
import { TeamsStore } from '../../teams/storage/teams.store';
import { ValidationError, NotFoundError } from '../../../common/errors/error-types';

import { createFromTemplateWithHelper } from '../helpers/template-loader';
import { computeFamilyAlternativesFromStorage } from '../helpers/profile-mapping.helpers';
import { applyAgentConfigs, applyPresetWithHelper } from '../helpers/project-presets.helpers';
import {
  applyProjectSettingsWithHelper,
  createSubscribersFromPayloadWithHelper,
  createWatchersFromPayloadWithHelper,
  normalizeProfileOptions,
} from '../helpers/project-runtime.helpers';
import { deriveSlugFromPath } from '../helpers/template-file.helpers';
import { getNextRunAt } from '../../scheduled-epics/helpers/cron-helpers';

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

// ---------------------------------------------------------------------------
// Harness: real :memory: SQLite + real storage-backed services.
// ---------------------------------------------------------------------------

interface Harness {
  sqlite: Database.Database;
  storage: StorageService;
  settings: SettingsService;
  teamsStore: TeamsStore;
}

function createHarness(): Harness {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  const db: BetterSQLite3Database = drizzle(sqlite);
  sqlite.pragma('foreign_keys = OFF');
  migrate(db, { migrationsFolder: join(__dirname, '../../../..', 'drizzle') });
  sqlite.pragma('foreign_keys = ON');

  const storage = new LocalStorageService(db) as unknown as StorageService;
  const settings = new SettingsService(db, new EventEmitter2());
  const teamsStore = new TeamsStore(db);
  return { sqlite, storage, settings, teamsStore };
}

/** Thin, real, storage-backed adapter matching the teamsService deps shape. */
function teamsAdapter(teamsStore: TeamsStore) {
  return {
    listTeams: (projectId: string, options?: { limit?: number }) =>
      teamsStore.listTeams(projectId, options),
    getTeam: (id: string) => teamsStore.getTeam(id),
    createTeam: (data: Parameters<TeamsStore['createTeam']>[0]) => teamsStore.createTeam(data),
    deleteTeamsByProject: (projectId: string) => teamsStore.deleteTeamsByProject(projectId),
    deleteTeamsByIds: (ids: string[]) => teamsStore.deleteTeamsByIds(ids),
  };
}

type AnyRec = Record<string, unknown>;

interface UnifiedMock {
  getTemplate: jest.Mock;
  getTemplateFromFilePath: jest.Mock;
}

/** Build a UnifiedTemplateService mock resolving `template` from a registry/bundled slug. */
function bundledUnified(
  template: AnyRec,
  opts: { source?: 'bundled' | 'registry'; version?: string | null } = {},
): UnifiedMock {
  return {
    getTemplate: jest.fn(async () => ({
      content: template,
      source: opts.source ?? 'bundled',
      version: opts.version ?? null,
    })),
    getTemplateFromFilePath: jest.fn(() => {
      throw new Error('getTemplateFromFilePath not expected in this test');
    }),
  };
}

/** Build a UnifiedTemplateService mock resolving `template` from a file path. */
function fileUnified(template: AnyRec, version: string | null = null): UnifiedMock {
  return {
    getTemplate: jest.fn(() => {
      throw new Error('getTemplate not expected in this test');
    }),
    getTemplateFromFilePath: jest.fn(() => ({
      content: template,
      source: 'file' as const,
      version,
    })),
  };
}

interface DepsBundle {
  deps: unknown;
  createTeam: jest.Mock;
  deleteTeamsByIds: jest.Mock;
  createWatcher: jest.Mock;
  refreshScheduleWindow: jest.Mock;
}

/**
 * Wire the create-from-template deps to the real services, with jest-spy wrappers around the
 * true-external seams (teams createTeam, watchers createWatcher, schedule refresh).
 */
function buildDeps(h: Harness, unified: UnifiedMock): DepsBundle {
  const adapter = teamsAdapter(h.teamsStore);
  const createTeam = jest.fn((data: Parameters<typeof adapter.createTeam>[0]) =>
    adapter.createTeam(data),
  );
  const deleteTeamsByIds = jest.fn((ids: string[]) => adapter.deleteTeamsByIds(ids));
  const teamsService = { ...adapter, createTeam, deleteTeamsByIds };

  const createWatcher = jest.fn((data: Parameters<StorageService['createWatcher']>[0]) =>
    h.storage.createWatcher(data),
  );
  const watchersService = { createWatcher };

  const refreshScheduleWindow = jest.fn();

  const deps = {
    storage: h.storage,
    settings: h.settings,
    unifiedTemplateService: unified,
    deriveSlugFromPath,
    computeFamilyAlternatives: (profiles: never, agents: never, selected?: string[]) =>
      computeFamilyAlternativesFromStorage(h.storage, profiles, agents, undefined, selected),
    normalizeProfileOptions,
    applyProjectSettings: (
      projectId: string,
      projectSettings: never,
      maps: never,
      archiveStatusId: string | null,
    ) =>
      applyProjectSettingsWithHelper(projectId, projectSettings, maps, archiveStatusId, h.settings),
    createWatchersFromPayload: (projectId: string, watchers: never, maps: never) =>
      createWatchersFromPayloadWithHelper(projectId, watchers, maps, watchersService as never),
    createSubscribersFromPayload: (projectId: string, subscribers: never) =>
      createSubscribersFromPayloadWithHelper(projectId, subscribers, h.storage),
    applyPreset: (projectId: string, presetName: string, nameMaps?: never) =>
      applyPresetWithHelper(
        projectId,
        presetName,
        { storage: h.storage, settings: h.settings },
        nameMaps,
      ),
    applyAgentConfigs: (projectId: string, agentConfigs: never, nameMaps?: never) =>
      applyAgentConfigs(projectId, agentConfigs, { storage: h.storage }, nameMaps),
    teamsService: teamsService as never,
    watchersService: watchersService as never,
    scheduledEpicsRefresh: { refreshScheduleWindow },
    computeNextRunAt: getNextRunAt,
  };

  return { deps, createTeam, deleteTeamsByIds, createWatcher, refreshScheduleWindow };
}

// ---------------------------------------------------------------------------
// Shared setup helpers.
// ---------------------------------------------------------------------------

async function seedClaudeProvider(
  h: Harness,
  binPath: string | null = null,
): Promise<{ id: string }> {
  // Force a null autoCompactThreshold so providerSettings can import the template default.
  return h.storage.createProvider({ name: 'claude', binPath, autoCompactThreshold: null });
}

async function getProfileByName(h: Harness, projectId: string, name: string) {
  const { items } = await h.storage.listAgentProfiles({ projectId });
  return items.find((p) => p.name === name);
}

async function getAgentByName(h: Harness, projectId: string, name: string) {
  const { items } = await h.storage.listAgents(projectId, { limit: 10000 });
  return items.find((a) => a.name === name);
}

async function getConfigByName(h: Harness, profileId: string, name: string) {
  const configs = await h.storage.listProfileProviderConfigsByProfile(profileId);
  return configs.find((c) => c.name.trim().toLowerCase() === name.trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// Fixture builders (schema-valid ExportSchema payloads).
// ---------------------------------------------------------------------------

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_ID = '22222222-2222-4222-8222-222222222222';
const STATUS_ID = '33333333-3333-4333-8333-333333333333';

/** Minimal empty-but-valid template (no profiles → no provider required). */
function emptyTemplate(manifest?: AnyRec): AnyRec {
  return {
    version: 1,
    prompts: [],
    profiles: [],
    agents: [],
    statuses: [],
    ...(manifest ? { _manifest: manifest } : {}),
  };
}

/** A single-profile/agent/status template that needs the claude provider. */
function claudeTemplate(extra: AnyRec = {}): AnyRec {
  return {
    version: 1,
    prompts: [],
    profiles: [
      {
        id: PROFILE_ID,
        name: 'Test Profile',
        provider: { name: 'claude' },
        instructions: null,
        temperature: null,
        maxTokens: null,
      },
    ],
    agents: [{ id: AGENT_ID, name: 'Test Agent', profileId: PROFILE_ID, description: null }],
    statuses: [{ id: STATUS_ID, label: 'To Do', color: '#3b82f6', position: 0 }],
    ...extra,
  };
}

describe('ProjectsService.createFromTemplate (real storage)', () => {
  let h: Harness;

  beforeEach(() => {
    h = createHarness();
  });

  afterEach(() => {
    h.sqlite.close();
  });

  // -------------------------------------------------------------------------
  // Validation & template loading.
  // -------------------------------------------------------------------------
  describe('validation & loading', () => {
    it('throws ValidationError for invalid template content', async () => {
      const unified = bundledUnified({ invalid: 'content without required fields' } as AnyRec);
      const { deps } = buildDeps(h, unified);

      await expect(
        createFromTemplateWithHelper(
          { name: 'Test Project', rootPath: '/test/a', slug: 'bad-template' },
          deps as never,
        ),
      ).rejects.toThrow(ValidationError);

      await expect(
        createFromTemplateWithHelper(
          { name: 'Test Project', rootPath: '/test/b', slug: 'bad-template' },
          deps as never,
        ),
      ).rejects.toThrow('Invalid template format');
    });

    it('propagates ValidationError for slug with path traversal attempt', async () => {
      const unified = bundledUnified(emptyTemplate());
      unified.getTemplate.mockRejectedValue(
        new ValidationError(
          'Invalid template slug: must contain only alphanumeric characters and hyphens',
          { slug: '../../../etc/passwd' },
        ),
      );
      const { deps } = buildDeps(h, unified);

      await expect(
        createFromTemplateWithHelper(
          { name: 'Test Project', rootPath: '/test', slug: '../../../etc/passwd' },
          deps as never,
        ),
      ).rejects.toThrow(ValidationError);
    });

    it('propagates ValidationError for slug with special characters', async () => {
      const invalidSlugs = [
        'template;rm -rf /',
        'template`whoami`',
        'template$PATH',
        'template@host',
      ];

      for (const slug of invalidSlugs) {
        const unified = bundledUnified(emptyTemplate());
        unified.getTemplate.mockRejectedValue(
          new ValidationError('Invalid template slug', { slug }),
        );
        const { deps } = buildDeps(h, unified);

        await expect(
          createFromTemplateWithHelper(
            { name: 'Test Project', rootPath: '/test', slug },
            deps as never,
          ),
        ).rejects.toThrow(ValidationError);
      }
    });

    it('propagates NotFoundError for missing template', async () => {
      const unified = bundledUnified(emptyTemplate());
      unified.getTemplate.mockRejectedValue(new NotFoundError('Template', 'nonexistent-template'));
      const { deps } = buildDeps(h, unified);

      await expect(
        createFromTemplateWithHelper(
          { name: 'Test Project', rootPath: '/test', slug: 'nonexistent-template' },
          deps as never,
        ),
      ).rejects.toThrow(NotFoundError);
    });

    it('accepts valid slugs and creates a project from an empty template', async () => {
      const validSlugs = ['valid-template', 'template-123', 'ABC123', 'my-template-v1'];

      for (const slug of validSlugs) {
        const unified = bundledUnified(emptyTemplate());
        const { deps } = buildDeps(h, unified);

        const result = await createFromTemplateWithHelper(
          { name: `Project ${slug}`, rootPath: `/test/${slug}`, slug },
          deps as never,
        );

        expect(result).toMatchObject({ success: true, project: { name: `Project ${slug}` } });
      }
    });

    it('reports actual prompt counts and maps when template creation imports every prompt type', async () => {
      const template = emptyTemplate();
      template.prompts = [
        {
          id: '11111111-1111-4111-8111-111111111111',
          title: 'System',
          content: 'system',
          version: 1,
          tags: ['scope:shared', 'type:system'],
        },
        {
          id: '22222222-2222-4222-8222-222222222222',
          title: 'Legacy',
          content: 'legacy',
          version: 1,
          tags: ['scope:legacy'],
        },
        {
          id: '33333333-3333-4333-8333-333333333333',
          title: 'Custom',
          content: 'custom',
          version: 1,
          tags: ['type:custom'],
        },
      ];
      const { deps } = buildDeps(h, bundledUnified(template));

      const result = (await createFromTemplateWithHelper(
        { name: 'Prompt Project', rootPath: '/test/prompts', slug: 'prompt-template' },
        deps as never,
      )) as AnyRec;
      const project = result.project as { id: string };
      const prompts = await h.storage.listPrompts({ projectId: project.id });

      expect(result).toMatchObject({
        success: true,
        imported: { prompts: 3 },
        promptTransfer: { imported: 3, deleted: 0, preserved: 0, skipped: 0 },
        mappings: {
          promptIdMap: {
            '11111111-1111-4111-8111-111111111111': expect.any(String),
            '22222222-2222-4222-8222-222222222222': expect.any(String),
            '33333333-3333-4333-8333-333333333333': expect.any(String),
          },
        },
      });
      expect(prompts.items).toHaveLength(3);
      expect(prompts.items.map((prompt) => prompt.title).sort()).toEqual([
        'Custom',
        'Legacy',
        'System',
      ]);
      expect(prompts.items.find((prompt) => prompt.title === 'Custom')?.tags).toContain(
        'type:custom',
      );
    });

    it('creates a project whose profile references an incoming Custom prompt', async () => {
      await seedClaudeProvider(h);
      const template = claudeTemplate({
        prompts: [
          {
            id: '44444444-4444-4444-8444-444444444444',
            title: 'Private SOP',
            content: 'private',
            version: 1,
            tags: ['type:custom'],
          },
        ],
        profiles: [
          {
            id: PROFILE_ID,
            name: 'Test Profile',
            provider: { name: 'claude' },
            instructions: 'Follow [[prompt:Private SOP]].',
            temperature: null,
            maxTokens: null,
          },
        ],
      });
      const { deps } = buildDeps(h, bundledUnified(template));
      const createProjectShell = jest.spyOn(h.storage, 'createProjectShell');

      const result = await createFromTemplateWithHelper(
        { name: 'Unsafe Project', rootPath: '/test/unsafe', slug: 'unsafe' },
        deps as never,
      );

      expect(result).toMatchObject({
        success: true,
        promptTransfer: { imported: 1, skipped: 0 },
      });
      expect(result).not.toHaveProperty('promptReferenceValidation');
      expect(createProjectShell).toHaveBeenCalled();
      expect((await h.storage.listProjects()).items).toHaveLength(1);
    });

    it('passes the pre-generated projectId to createProjectShell when provided', async () => {
      const projectId = '44444444-4444-4444-8444-444444444444';
      const unified = bundledUnified(emptyTemplate());
      const { deps } = buildDeps(h, unified);

      const result = (await createFromTemplateWithHelper(
        { name: 'Test Project', rootPath: '/test', slug: 'my-template', projectId },
        deps as never,
      )) as AnyRec;

      const project = result.project as AnyRec;
      expect(project.id).toBe(projectId);
      // Project row was really persisted under that id.
      const persisted = await h.storage.getProject(projectId);
      expect(persisted.name).toBe('Test Project');
    });

    it('passes the version to UnifiedTemplateService.getTemplate when provided', async () => {
      const unified = bundledUnified(emptyTemplate(), { source: 'registry', version: '1.2.0' });
      const { deps } = buildDeps(h, unified);

      await createFromTemplateWithHelper(
        { name: 'Test Project', rootPath: '/test', slug: 'my-template', version: '1.2.0' },
        deps as never,
      );

      expect(unified.getTemplate).toHaveBeenCalledWith('my-template', '1.2.0');
    });
  });

  // -------------------------------------------------------------------------
  // Template metadata recording.
  // -------------------------------------------------------------------------
  describe('template metadata', () => {
    it('records installedVersion from _manifest.version for a bundled template', async () => {
      const unified = bundledUnified(
        emptyTemplate({ slug: 'bundled-template', name: 'Bundled Template', version: '1.1.0' }),
        { source: 'bundled', version: null },
      );
      const { deps } = buildDeps(h, unified);

      const result = (await createFromTemplateWithHelper(
        { name: 'Test Project', rootPath: '/test', slug: 'bundled-template' },
        deps as never,
      )) as AnyRec;

      const meta = h.settings.getProjectTemplateMetadata((result.project as AnyRec).id as string);
      expect(meta).toMatchObject({
        templateSlug: 'bundled-template',
        source: 'bundled',
        installedVersion: '1.1.0',
        registryUrl: null,
      });
      expect(typeof meta?.installedAt).toBe('string');
    });

    it('records installedVersion null for a bundled template without a _manifest version', async () => {
      const unified = bundledUnified(emptyTemplate(), { source: 'bundled', version: null });
      const { deps } = buildDeps(h, unified);

      const result = (await createFromTemplateWithHelper(
        { name: 'Test Project', rootPath: '/test', slug: 'legacy-template' },
        deps as never,
      )) as AnyRec;

      const meta = h.settings.getProjectTemplateMetadata((result.project as AnyRec).id as string);
      expect(meta).toMatchObject({
        templateSlug: 'legacy-template',
        source: 'bundled',
        installedVersion: null,
        registryUrl: null,
      });
    });

    it('records source=registry with the registry url and version', async () => {
      const unified = bundledUnified(emptyTemplate(), { source: 'registry', version: '1.2.0' });
      const { deps } = buildDeps(h, unified);
      const registryUrl = h.settings.getRegistryConfig().url;

      const result = (await createFromTemplateWithHelper(
        { name: 'Test Project', rootPath: '/test', slug: 'my-registry-template', version: '1.2.0' },
        deps as never,
      )) as AnyRec;

      const meta = h.settings.getProjectTemplateMetadata((result.project as AnyRec).id as string);
      expect(meta).toMatchObject({
        templateSlug: 'my-registry-template',
        source: 'registry',
        installedVersion: '1.2.0',
        registryUrl,
      });
    });

    it('calls getTemplateFromFilePath and records source=file when templatePath is provided', async () => {
      const unified = fileUnified(
        emptyTemplate({ slug: 'file-template', name: 'File Template', version: '2.0.0' }),
        '2.0.0',
      );
      const { deps } = buildDeps(h, unified);

      const result = (await createFromTemplateWithHelper(
        { name: 'Test Project', rootPath: '/test', templatePath: '/path/to/template.json' },
        deps as never,
      )) as AnyRec;

      expect(unified.getTemplateFromFilePath).toHaveBeenCalledWith('/path/to/template.json');
      expect(unified.getTemplate).not.toHaveBeenCalled();

      const meta = h.settings.getProjectTemplateMetadata((result.project as AnyRec).id as string);
      expect(meta).toMatchObject({
        templateSlug: 'file-template',
        source: 'file',
        installedVersion: '2.0.0',
        registryUrl: null,
      });
    });

    it('derives the slug from the filename when _manifest.slug is absent', async () => {
      const unified = fileUnified(emptyTemplate(), null);
      const { deps } = buildDeps(h, unified);

      const result = (await createFromTemplateWithHelper(
        {
          name: 'Test Project',
          rootPath: '/test',
          templatePath: '/path/to/my-custom-template.json',
        },
        deps as never,
      )) as AnyRec;

      const meta = h.settings.getProjectTemplateMetadata((result.project as AnyRec).id as string);
      expect(meta).toMatchObject({
        templateSlug: 'my-custom-template',
        source: 'file',
        installedVersion: null,
      });
    });

    it('uses _manifest.slug over the filename for a file-based template', async () => {
      const unified = fileUnified(
        emptyTemplate({ slug: 'manifest-defined-slug', name: 'Manifest', version: '1.5.0' }),
        '1.5.0',
      );
      const { deps } = buildDeps(h, unified);

      const result = (await createFromTemplateWithHelper(
        {
          name: 'Test Project',
          rootPath: '/test',
          templatePath: '/path/to/different-filename.json',
        },
        deps as never,
      )) as AnyRec;

      const meta = h.settings.getProjectTemplateMetadata((result.project as AnyRec).id as string);
      expect(meta).toMatchObject({
        templateSlug: 'manifest-defined-slug',
        source: 'file',
        installedVersion: '1.5.0',
      });
    });
  });

  // -------------------------------------------------------------------------
  // Watcher integration (startWatcher seam + scope resolution).
  // -------------------------------------------------------------------------
  describe('watchers', () => {
    const watcher = (over: AnyRec = {}): AnyRec => ({
      name: 'Watcher',
      description: null,
      enabled: false,
      scope: 'all',
      scopeFilterName: null,
      pollIntervalMs: 5000,
      viewportLines: 100,
      condition: { type: 'contains', pattern: 'test' },
      cooldownMs: 10000,
      cooldownMode: 'time',
      eventName: 'test-event',
      ...over,
    });

    it('creates (starts) enabled watchers via the watchers service seam', async () => {
      await seedClaudeProvider(h);
      const unified = bundledUnified(
        claudeTemplate({
          watchers: [watcher({ name: 'Enabled Watcher', enabled: true, eventName: 'ev-enabled' })],
        }),
      );
      const { deps, createWatcher } = buildDeps(h, unified);

      const result = (await createFromTemplateWithHelper(
        { name: 'Test Project', rootPath: '/test', slug: 'watcher-test' },
        deps as never,
      )) as AnyRec;

      expect(createWatcher).toHaveBeenCalledTimes(1);
      expect(createWatcher).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Enabled Watcher', enabled: true }),
      );
      expect((result.imported as AnyRec).watchers).toBe(1);
    });

    it('creates disabled watchers without starting them (enabled:false passed through)', async () => {
      const unified = bundledUnified({
        version: 1,
        prompts: [],
        profiles: [],
        agents: [],
        statuses: [],
        watchers: [watcher({ name: 'Disabled Watcher', enabled: false, eventName: 'ev-disabled' })],
      });
      const { deps, createWatcher } = buildDeps(h, unified);

      await createFromTemplateWithHelper(
        { name: 'Test Project', rootPath: '/test', slug: 'disabled-watcher-test' },
        deps as never,
      );

      expect(createWatcher).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Disabled Watcher', enabled: false }),
      );
    });

    it('falls back to scope "all" when scopeFilterName cannot be resolved', async () => {
      const unified = bundledUnified({
        version: 1,
        prompts: [],
        profiles: [],
        agents: [],
        statuses: [],
        watchers: [
          watcher({
            name: 'Unresolvable Scope',
            scope: 'agent',
            scopeFilterName: 'NonExistent Agent',
            eventName: 'ev-unresolved',
          }),
        ],
      });
      const { deps, createWatcher } = buildDeps(h, unified);

      await createFromTemplateWithHelper(
        { name: 'Test Project', rootPath: '/test', slug: 'unresolved-scope-test' },
        deps as never,
      );

      expect(createWatcher).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'all', scopeFilterId: null }),
      );
    });

    it('allows duplicate watcher eventName values across template watchers', async () => {
      const unified = bundledUnified({
        version: 1,
        prompts: [],
        profiles: [],
        agents: [],
        statuses: [],
        watchers: [
          watcher({ name: 'Watcher A', eventName: 'duplicate-event' }),
          watcher({ name: 'Watcher B', eventName: 'duplicate-event' }),
        ],
      });
      const { deps, createWatcher } = buildDeps(h, unified);

      const result = (await createFromTemplateWithHelper(
        { name: 'Test Project', rootPath: '/test', slug: 'duplicate-event-test' },
        deps as never,
      )) as AnyRec;

      expect(result.success).toBe(true);
      expect((result.imported as AnyRec).watchers).toBe(2);
      expect(createWatcher).toHaveBeenCalledTimes(2);
      expect(createWatcher).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ eventName: 'duplicate-event' }),
      );
      expect(createWatcher).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ eventName: 'duplicate-event' }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Scheduled epics.
  // -------------------------------------------------------------------------
  describe('scheduled epics', () => {
    it('creates scheduled epics with resolved status/agent references', async () => {
      await seedClaudeProvider(h);
      const template = {
        version: 1,
        prompts: [],
        profiles: [
          {
            id: PROFILE_ID,
            name: 'Builder Profile',
            provider: { name: 'claude' },
            instructions: null,
            temperature: null,
            maxTokens: null,
          },
        ],
        agents: [{ id: AGENT_ID, name: 'Coder', profileId: PROFILE_ID, description: null }],
        statuses: [{ id: STATUS_ID, label: 'Backlog', color: '#6c757d', position: 1 }],
        scheduledEpics: [
          {
            name: 'Daily Planning',
            cronExpression: '0 9 * * 1-5',
            timezone: 'America/New_York',
            enabled: false,
            titleTemplate: 'Daily planning {{date}}',
            descriptionTemplate: 'Create planning context for {{date}}',
            templateStatusLabel: 'Backlog',
            templateAgentName: 'Coder',
            templateTags: ['planning', 'daily'],
            allowOverlap: false,
            missedRunPolicy: 'skip' as const,
          },
        ],
      };
      const { deps, refreshScheduleWindow } = buildDeps(h, bundledUnified(template));

      const result = (await createFromTemplateWithHelper(
        {
          name: 'Template Project',
          rootPath: '/test/template-project',
          slug: 'scheduled-template',
        },
        deps as never,
      )) as AnyRec;

      const projectId = (result.project as AnyRec).id as string;
      const backlog = (await h.storage.listStatuses(projectId)).items.find(
        (s) => s.label === 'Backlog',
      );
      const coder = await getAgentByName(h, projectId, 'Coder');

      const { items: schedules } = await h.storage.listScheduledEpics(projectId, { limit: 100 });
      expect(schedules).toHaveLength(1);
      expect(schedules[0]).toMatchObject({
        name: 'Daily Planning',
        cronExpression: '0 9 * * 1-5',
        timezone: 'America/New_York',
        enabled: false,
        templateStatusId: backlog!.id,
        templateAgentId: coder!.id,
        templateTags: ['planning', 'daily'],
        missedRunPolicy: 'skip',
      });
      expect(schedules[0].nextRunAt).toEqual(expect.any(String));
      expect(refreshScheduleWindow).toHaveBeenCalledTimes(1);
      expect((result.imported as AnyRec).scheduledEpics).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // providerSettings — legacy normalization and post-upgrade env safety.
  // -------------------------------------------------------------------------
  describe('providerSettings legacy compatibility', () => {
    it('imports a pre-split Claude template with the established default fallback', async () => {
      const provider = await seedClaudeProvider(h);
      const template = claudeTemplate({
        providerSettings: [
          {
            name: 'claude',
            autoCompactThreshold: 50,
            oneMillionContextEnabled: true,
          },
        ],
      });
      const { deps } = buildDeps(h, bundledUnified(template));

      await createFromTemplateWithHelper(
        { name: 'Test Project', rootPath: '/test', slug: 'my-template' },
        deps as never,
      );

      const updated = await h.storage.getProvider(provider.id);
      expect(updated.autoCompactThreshold).toBe(95);
    });

    it('cannot restore the seeded-away exact provider window during a later import', async () => {
      const provider = await seedClaudeProvider(h);
      const template = claudeTemplate({
        providerSettings: [
          {
            name: 'claude',
            env: {
              CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
              CLAUDE_CODE_DISABLE_1M_CONTEXT: '1',
              KEEP: 'value',
            },
          },
        ],
      });
      const { deps } = buildDeps(h, bundledUnified(template));

      await createFromTemplateWithHelper(
        { name: 'Test Project', rootPath: '/test', slug: 'my-template' },
        deps as never,
      );

      const updated = await h.storage.getProvider(provider.id);
      expect(updated.env).toEqual({
        CLAUDE_CODE_DISABLE_1M_CONTEXT: '1',
        KEEP: 'value',
      });
    });
  });

  // -------------------------------------------------------------------------
  // Team seeding (via teamsService.createTeam).
  // -------------------------------------------------------------------------
  describe('team seeding', () => {
    const tProfileId = 'aaaaaaaa-1111-4111-8111-111111111111';
    const tAgentA = 'aaaaaaaa-2222-4222-8222-222222222222';
    const tAgentB = 'aaaaaaaa-3333-4333-8333-333333333333';

    /** Two agents on a claude profile carrying the given provider configs. */
    function teamTemplate(
      teams: AnyRec[],
      providerConfigs: AnyRec[] = [
        { name: 'local', providerName: 'claude', options: null, env: null },
      ],
    ): AnyRec {
      return {
        version: 1,
        prompts: [],
        profiles: [
          {
            id: tProfileId,
            name: 'Default Profile',
            provider: { name: 'claude' },
            instructions: null,
            temperature: null,
            maxTokens: null,
            providerConfigs,
          },
        ],
        agents: [
          { id: tAgentA, name: 'Lead Agent', profileId: tProfileId, description: null },
          { id: tAgentB, name: 'Worker Agent', profileId: tProfileId, description: null },
        ],
        statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
        teams,
      };
    }

    async function createTeams(teams: AnyRec[], providerConfigs?: AnyRec[], input: AnyRec = {}) {
      await seedClaudeProvider(h);
      const bundle = buildDeps(h, bundledUnified(teamTemplate(teams, providerConfigs)));
      const result = (await createFromTemplateWithHelper(
        { name: 'Team Project', rootPath: '/test/teams', slug: 'team-seed-test', ...input },
        bundle.deps as never,
      )) as AnyRec;
      return { result, ...bundle };
    }

    async function getPersistedTeam(projectId: string, teamName: string) {
      const { items } = await h.teamsStore.listTeams(projectId);
      const summary = items.find((team) => team.name === teamName);
      expect(summary).toBeDefined();
      return h.teamsStore.getTeam(summary!.id);
    }

    it('seeds one team from the template', async () => {
      const { result, createTeam } = await createTeams([
        {
          name: 'Dev Team',
          description: 'Main dev team',
          teamLeadAgentName: 'Lead Agent',
          memberAgentNames: ['Lead Agent', 'Worker Agent'],
          profileNames: ['Default Profile'],
          profileSelections: [{ profileName: 'Default Profile', configNames: ['local'] }],
        },
      ]);

      expect(createTeam).toHaveBeenCalledTimes(1);
      expect(createTeam).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: (result.project as AnyRec).id,
          name: 'Dev Team',
          description: 'Main dev team',
        }),
      );
    });

    it('seeds two teams from the template', async () => {
      const { createTeam } = await createTeams([
        {
          name: 'Team Alpha',
          teamLeadAgentName: 'Lead Agent',
          memberAgentNames: ['Lead Agent', 'Worker Agent'],
        },
        {
          name: 'Team Beta',
          teamLeadAgentName: 'Worker Agent',
          memberAgentNames: ['Worker Agent'],
        },
      ]);

      expect(createTeam).toHaveBeenCalledTimes(2);
      expect(createTeam).toHaveBeenCalledWith(expect.objectContaining({ name: 'Team Alpha' }));
      expect(createTeam).toHaveBeenCalledWith(expect.objectContaining({ name: 'Team Beta' }));
    });

    it('skips a team when its lead agent is missing (non-fatal)', async () => {
      const { result, createTeam } = await createTeams([
        {
          name: 'Bad Team',
          teamLeadAgentName: 'Nonexistent Agent',
          memberAgentNames: ['Nonexistent Agent'],
        },
      ]);

      expect(result.success).toBe(true);
      expect(createTeam).not.toHaveBeenCalled();
    });

    it('creates the project normally when the template has zero teams', async () => {
      const { result, createTeam } = await createTeams([]);

      expect(result.success).toBe(true);
      expect(createTeam).not.toHaveBeenCalled();
    });

    it('persists genuine allow-all so the team sees selected and unselected provider configs', async () => {
      await h.storage.createProvider({ name: 'codex', binPath: null });
      const { result, createTeam } = await createTeams(
        [
          {
            name: 'AllowAll Team',
            teamLeadAgentName: 'Lead Agent',
            memberAgentNames: ['Lead Agent'],
            profileNames: ['Default Profile'],
          },
        ],
        [
          { name: 'claude-cfg', providerName: 'claude', options: null, env: null },
          { name: 'codex-cfg', providerName: 'codex', options: null, env: null },
        ],
        { selectedProviderNames: ['claude'] },
      );

      expect(createTeam).toHaveBeenCalledTimes(1);
      expect(createTeam.mock.calls[0][0].profileConfigSelections).toBeUndefined();
      const projectId = (result.project as AnyRec).id as string;
      const persisted = await getPersistedTeam(projectId, 'AllowAll Team');
      const availableConfigs = await h.teamsStore.listConfigsForTeam(persisted!.id);
      expect(availableConfigs.map((config) => config.name).sort()).toEqual([
        'claude-cfg',
        'codex-cfg',
      ]);
    });

    it('persists a restricted subset so the team sees only the selected config', async () => {
      await h.storage.createProvider({ name: 'codex', binPath: null });
      const { result } = await createTeams(
        [
          {
            name: 'Restricted Team',
            teamLeadAgentName: 'Lead Agent',
            memberAgentNames: ['Lead Agent'],
            profileNames: ['Default Profile'],
            profileSelections: [{ profileName: 'Default Profile', configNames: ['claude-cfg'] }],
          },
        ],
        [
          { name: 'claude-cfg', providerName: 'claude', options: null, env: null },
          { name: 'codex-cfg', providerName: 'codex', options: null, env: null },
        ],
        { selectedProviderNames: ['claude'] },
      );

      const projectId = (result.project as AnyRec).id as string;
      const persisted = await getPersistedTeam(projectId, 'Restricted Team');
      const availableConfigs = await h.teamsStore.listConfigsForTeam(persisted!.id);
      expect(availableConfigs.map((config) => config.name)).toEqual(['claude-cfg']);
    });

    it('prunes skipped provider configs from team profileSelections', async () => {
      const { result, createTeam } = await createTeams(
        [
          {
            name: 'Dev Team',
            teamLeadAgentName: 'Lead Agent',
            memberAgentNames: ['Lead Agent', 'Worker Agent'],
            profileNames: ['Default Profile'],
            profileSelections: [{ profileName: 'Default Profile', configNames: ['local', 'agy3'] }],
          },
        ],
        [
          { name: 'local', providerName: 'claude', options: null, env: null },
          { name: 'agy3', providerName: 'agy', options: null, env: null },
        ],
      );

      const projectId = (result.project as AnyRec).id as string;
      const profile = await getProfileByName(h, projectId, 'Default Profile');
      const localConfig = await getConfigByName(h, profile!.id, 'local');

      expect(createTeam).toHaveBeenCalledTimes(1);
      expect(createTeam.mock.calls[0][0].profileConfigSelections).toEqual([
        { profileId: profile!.id, configIds: [localConfig!.id] },
      ]);
    });

    it('persists no permission when every config in a restricted subset is skipped', async () => {
      const { result, createTeam } = await createTeams(
        [
          {
            name: 'Dev Team',
            teamLeadAgentName: 'Lead Agent',
            memberAgentNames: ['Lead Agent', 'Worker Agent'],
            profileNames: ['Default Profile'],
            profileSelections: [{ profileName: 'Default Profile', configNames: ['agy3'] }],
          },
        ],
        // local keeps agents creatable; agy3 (provider agy) is filtered out.
        [
          { name: 'local', providerName: 'claude', options: null, env: null },
          { name: 'agy3', providerName: 'agy', options: null, env: null },
        ],
      );

      expect(createTeam).toHaveBeenCalledTimes(1);
      const callArgs = createTeam.mock.calls[0][0];
      expect(callArgs.profileIds).toEqual([]);
      expect(callArgs.profileConfigSelections).toBeUndefined();
      const projectId = (result.project as AnyRec).id as string;
      const persisted = await getPersistedTeam(projectId, 'Dev Team');
      expect(persisted!.profileIds).toEqual([]);
      expect(await h.teamsStore.listConfigsForTeam(persisted!.id)).toEqual([]);
    });

    it('rejects an unknown config name instead of silently broadening team access', async () => {
      const { result, createTeam } = await createTeams([
        {
          name: 'Malformed Team',
          teamLeadAgentName: 'Lead Agent',
          memberAgentNames: ['Lead Agent'],
          profileNames: ['Default Profile'],
          profileSelections: [{ profileName: 'Default Profile', configNames: ['mystery-cfg'] }],
        },
      ]);

      expect(result.success).toBe(true);
      expect(createTeam).not.toHaveBeenCalled();
      const projectId = (result.project as AnyRec).id as string;
      expect((await h.teamsStore.listTeams(projectId)).items).toEqual([]);
    });

    it('passes maxMembers and maxConcurrentTasks to createTeam', async () => {
      const { createTeam } = await createTeams([
        {
          name: 'Capped Team',
          teamLeadAgentName: 'Lead Agent',
          memberAgentNames: ['Lead Agent'],
          maxMembers: 8,
          maxConcurrentTasks: 3,
        },
      ]);

      expect(createTeam).toHaveBeenCalledWith(
        expect.objectContaining({ maxMembers: 8, maxConcurrentTasks: 3 }),
      );
    });

    it('remaps team profileNames via profileNameRemapMap for family-mapped templates', async () => {
      const codexProfileId = 'bbbbbbbb-1111-4111-8111-111111111111';
      const claudeProfileId = 'bbbbbbbb-2222-4222-8222-222222222222';
      const fmAgentId = 'bbbbbbbb-3333-4333-8333-333333333333';
      await seedClaudeProvider(h);

      const template = {
        version: 1,
        prompts: [],
        profiles: [
          {
            id: codexProfileId,
            name: 'Coder Codex',
            provider: { name: 'codex' },
            familySlug: 'coder',
          },
          {
            id: claudeProfileId,
            name: 'Coder Claude',
            provider: { name: 'claude' },
            familySlug: 'coder',
          },
        ],
        agents: [{ id: fmAgentId, name: 'Coder', profileId: codexProfileId, description: null }],
        statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
        teams: [
          {
            name: 'Dev Team',
            teamLeadAgentName: 'Coder',
            memberAgentNames: ['Coder'],
            profileNames: ['Coder Codex'],
          },
        ],
      };
      const { deps, createTeam } = buildDeps(h, bundledUnified(template));

      const result = (await createFromTemplateWithHelper(
        {
          name: 'Family Test',
          rootPath: '/test',
          slug: 'family-test',
          familyProviderMappings: { coder: 'claude' },
        },
        deps as never,
      )) as AnyRec;

      const projectId = (result.project as AnyRec).id as string;
      const claudeProfile = await getProfileByName(h, projectId, 'Coder Claude');

      expect(createTeam).toHaveBeenCalledTimes(1);
      expect(createTeam.mock.calls[0][0].profileIds).toContain(claudeProfile!.id);
    });

    it('applies teamOverrides with override > template precedence', async () => {
      const { createTeam } = await createTeams(
        [
          {
            name: 'Dev Team',
            teamLeadAgentName: 'Lead Agent',
            memberAgentNames: ['Lead Agent'],
            maxMembers: 5,
          },
        ],
        undefined,
        {
          teamOverrides: [{ teamName: 'Dev Team', maxMembers: 8, allowTeamLeadCreateAgents: true }],
        },
      );

      expect(createTeam).toHaveBeenCalledTimes(1);
      expect(createTeam).toHaveBeenCalledWith(
        expect.objectContaining({ maxMembers: 8, allowTeamLeadCreateAgents: true }),
      );
    });

    it('ignores an unknown teamName in teamOverrides without error', async () => {
      const { result, createTeam } = await createTeams(
        [{ name: 'Real Team', teamLeadAgentName: 'Lead Agent', memberAgentNames: ['Lead Agent'] }],
        undefined,
        { teamOverrides: [{ teamName: 'Nonexistent Team', maxMembers: 9 }] },
      );

      expect(result.success).toBe(true);
      expect(createTeam).toHaveBeenCalledTimes(1);
      expect(createTeam).toHaveBeenCalledWith(expect.objectContaining({ name: 'Real Team' }));
    });

    it('uses override profileNames to remove a profile from the team (Rule 3)', async () => {
      const profileAId = 'cccccccc-1111-4111-8111-111111111111';
      const profileBId = 'cccccccc-2222-4222-8222-222222222222';
      const rule3AgentId = 'cccccccc-3333-4333-8333-333333333333';
      await seedClaudeProvider(h);

      const template = {
        version: 1,
        prompts: [],
        profiles: [
          {
            id: profileAId,
            name: 'ProfileA',
            provider: { name: 'claude' },
            providerConfigs: [{ name: 'a-cfg', providerName: 'claude', options: null, env: null }],
          },
          {
            id: profileBId,
            name: 'ProfileB',
            provider: { name: 'claude' },
            providerConfigs: [{ name: 'b-cfg', providerName: 'claude', options: null, env: null }],
          },
        ],
        agents: [
          { id: rule3AgentId, name: 'Lead Agent', profileId: profileAId, description: null },
        ],
        statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
        teams: [
          {
            name: 'Dev Team',
            teamLeadAgentName: 'Lead Agent',
            memberAgentNames: ['Lead Agent'],
            profileNames: ['ProfileA', 'ProfileB'],
          },
        ],
      };
      const { deps, createTeam } = buildDeps(h, bundledUnified(template));

      const result = (await createFromTemplateWithHelper(
        {
          name: 'Rule3 Test',
          rootPath: '/test',
          slug: 'rule3-test',
          teamOverrides: [{ teamName: 'Dev Team', profileNames: ['ProfileB'] }],
        },
        deps as never,
      )) as AnyRec;

      const projectId = (result.project as AnyRec).id as string;
      const profileB = await getProfileByName(h, projectId, 'ProfileB');

      expect(createTeam).toHaveBeenCalledTimes(1);
      expect(createTeam.mock.calls[0][0].profileIds).toEqual([profileB!.id]);
    });

    it('preserves template profileNames when override profileNames is undefined', async () => {
      const { result, createTeam } = await createTeams(
        [
          {
            name: 'Dev Team',
            teamLeadAgentName: 'Lead Agent',
            memberAgentNames: ['Lead Agent'],
            profileNames: ['Default Profile'],
          },
        ],
        undefined,
        { teamOverrides: [{ teamName: 'Dev Team', maxMembers: 8 }] },
      );

      const projectId = (result.project as AnyRec).id as string;
      const profile = await getProfileByName(h, projectId, 'Default Profile');

      expect(createTeam).toHaveBeenCalledTimes(1);
      expect(createTeam.mock.calls[0][0].profileIds).toEqual([profile!.id]);
    });

    it('applies profileNameRemapMap to override profileSelections', async () => {
      const codexProfileId = 'dddddddd-1111-4111-8111-111111111111';
      const claudeProfileId = 'dddddddd-2222-4222-8222-222222222222';
      const fmAgentId = 'dddddddd-3333-4333-8333-333333333333';
      await seedClaudeProvider(h);

      const template = {
        version: 1,
        prompts: [],
        profiles: [
          {
            id: codexProfileId,
            name: 'Coder Codex',
            provider: { name: 'codex' },
            familySlug: 'coder',
          },
          {
            id: claudeProfileId,
            name: 'Coder Claude',
            provider: { name: 'claude' },
            familySlug: 'coder',
            providerConfigs: [
              { name: 'claude-local', providerName: 'claude', options: null, env: null },
            ],
          },
        ],
        agents: [{ id: fmAgentId, name: 'Coder', profileId: codexProfileId, description: null }],
        statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
        teams: [
          {
            name: 'Dev Team',
            teamLeadAgentName: 'Coder',
            memberAgentNames: ['Coder'],
            profileNames: ['Coder Codex'],
          },
        ],
      };
      const { deps, createTeam } = buildDeps(h, bundledUnified(template));

      const result = (await createFromTemplateWithHelper(
        {
          name: 'Family Override Test',
          rootPath: '/test',
          slug: 'family-override',
          familyProviderMappings: { coder: 'claude' },
          teamOverrides: [
            {
              teamName: 'Dev Team',
              profileSelections: [{ profileName: 'Coder Codex', configNames: ['claude-local'] }],
            },
          ],
        },
        deps as never,
      )) as AnyRec;

      const projectId = (result.project as AnyRec).id as string;
      const claudeProfile = await getProfileByName(h, projectId, 'Coder Claude');

      expect(createTeam).toHaveBeenCalledTimes(1);
      expect(createTeam.mock.calls[0][0].profileIds).toContain(claudeProfile!.id);
    });

    it('preserves allow-all when the override has empty configNames', async () => {
      const { createTeam } = await createTeams(
        [
          {
            name: 'AllowAll Override',
            teamLeadAgentName: 'Lead Agent',
            memberAgentNames: ['Lead Agent'],
            profileNames: ['Default Profile'],
            profileSelections: [{ profileName: 'Default Profile', configNames: ['local'] }],
          },
        ],
        undefined,
        {
          teamOverrides: [
            {
              teamName: 'AllowAll Override',
              profileSelections: [{ profileName: 'Default Profile', configNames: [] }],
            },
          ],
        },
      );

      expect(createTeam).toHaveBeenCalledTimes(1);
      const selections = createTeam.mock.calls[0][0].profileConfigSelections;
      expect(!selections || selections.length === 0).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Family-provider mappings.
  // -------------------------------------------------------------------------
  describe('familyProviderMappings', () => {
    const profileId1 = 'eeeeeeee-1111-4111-8111-111111111111';
    const profileId2 = 'eeeeeeee-2222-4222-8222-222222222222';
    const fmAgentId = 'eeeeeeee-3333-4333-8333-333333333333';

    it('reports which families need a mapping when the default provider is missing', async () => {
      await seedClaudeProvider(h); // codex is NOT installed
      const profiles = [
        { id: profileId1, name: 'Coder Codex', provider: { name: 'codex' }, familySlug: 'coder' },
        { id: profileId2, name: 'Coder Claude', provider: { name: 'claude' }, familySlug: 'coder' },
      ];
      const agents = [{ id: fmAgentId, name: 'Coder', profileId: profileId1 }];

      const familyResult = await computeFamilyAlternativesFromStorage(h.storage, profiles, agents);

      expect(familyResult.alternatives.some((alt) => !alt.defaultProviderAvailable)).toBe(true);
      expect(familyResult.missingProviders).toContain('codex');
      expect(familyResult.canImport).toBe(true);
      expect(familyResult.alternatives).toHaveLength(1);
      expect(familyResult.alternatives[0].familySlug).toBe('coder');
      expect(familyResult.alternatives[0].availableProviders).toContain('claude');
    });

    it('creates the remapped (claude, not codex) profile when a mapping is provided', async () => {
      await seedClaudeProvider(h);
      const template = {
        version: 1,
        prompts: [],
        profiles: [
          { id: profileId1, name: 'Coder Codex', provider: { name: 'codex' }, familySlug: 'coder' },
          {
            id: profileId2,
            name: 'Coder Claude',
            provider: { name: 'claude' },
            familySlug: 'coder',
          },
        ],
        agents: [
          {
            id: fmAgentId,
            name: 'Coder',
            profileId: profileId1,
            modelOverride: 'anthropic/claude-sonnet-4-5',
          },
        ],
        statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
      };
      const { deps } = buildDeps(h, bundledUnified(template));

      const result = (await createFromTemplateWithHelper(
        {
          name: 'Test Project',
          rootPath: '/test',
          slug: 'test-template',
          familyProviderMappings: { coder: 'claude' },
        },
        deps as never,
      )) as AnyRec;

      expect(result.success).toBe(true);
      const projectId = (result.project as AnyRec).id as string;

      const { items: profiles } = await h.storage.listAgentProfiles({ projectId });
      expect(profiles.map((p) => p.name)).toEqual(['Coder Claude']);

      const agent = await getAgentByName(h, projectId, 'Coder');
      expect(agent).toMatchObject({ modelOverride: 'anthropic/claude-sonnet-4-5' });
      // The created agent points at the claude profile.
      expect(agent!.profileId).toBe(profiles[0].id);
    });

    it('proceeds normally when all default providers are available', async () => {
      await seedClaudeProvider(h);
      const template = {
        version: 1,
        prompts: [],
        profiles: [
          {
            id: profileId1,
            name: 'Coder Claude',
            provider: { name: 'claude' },
            familySlug: 'coder',
          },
        ],
        agents: [{ id: fmAgentId, name: 'Coder', profileId: profileId1 }],
        statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
      };
      const { deps } = buildDeps(h, bundledUnified(template));

      const result = (await createFromTemplateWithHelper(
        { name: 'Test Project', rootPath: '/test', slug: 'test-template' },
        deps as never,
      )) as AnyRec;

      expect(result.success).toBe(true);
      expect(result.providerMappingRequired).toBeUndefined();
    });

    it('auto-selects the sole available provider when exactly one alternative exists', async () => {
      await seedClaudeProvider(h); // codex missing, claude available
      const template = {
        version: 1,
        prompts: [],
        profiles: [
          { id: profileId1, name: 'Coder Codex', provider: { name: 'codex' }, familySlug: 'coder' },
          {
            id: profileId2,
            name: 'Coder Claude',
            provider: { name: 'claude' },
            familySlug: 'coder',
          },
        ],
        agents: [{ id: fmAgentId, name: 'Coder', profileId: profileId1 }],
        statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
      };
      const { deps } = buildDeps(h, bundledUnified(template));

      const result = (await createFromTemplateWithHelper(
        { name: 'Test Project', rootPath: '/test', slug: 'test-template' }, // no mappings
        deps as never,
      )) as AnyRec;

      expect(result.success).toBe(true);
      expect(result.providerMappingRequired).toBeUndefined();

      const projectId = (result.project as AnyRec).id as string;
      const { items: profiles } = await h.storage.listAgentProfiles({ projectId });
      expect(profiles.map((p) => p.name)).toEqual(['Coder Claude']);

      const agent = await getAgentByName(h, projectId, 'Coder');
      expect(agent!.modelOverride).toBeNull();
    });

    it('returns providerMappingRequired (canImport:false) when no alternatives are available', async () => {
      // No providers installed at all.
      const template = {
        version: 1,
        prompts: [],
        profiles: [
          {
            id: profileId1,
            name: 'Special Profile',
            provider: { name: 'special-provider' },
            familySlug: 'special',
          },
        ],
        agents: [{ id: fmAgentId, name: 'Special Agent', profileId: profileId1 }],
        statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
      };
      const { deps } = buildDeps(h, bundledUnified(template));

      const result = (await createFromTemplateWithHelper(
        {
          name: 'Test Project',
          rootPath: '/test',
          slug: 'test-template',
          familyProviderMappings: { special: 'anything' },
        },
        deps as never,
      )) as AnyRec;

      expect(result.success).toBe(false);
      expect(result.providerMappingRequired).toBeDefined();
      expect((result.providerMappingRequired as AnyRec).canImport).toBe(false);
    });

    it('remaps a profile-scope watcher when its target profile is family-substituted', async () => {
      await seedClaudeProvider(h);
      const template = {
        version: 1,
        prompts: [],
        profiles: [
          { id: profileId1, name: 'Coder Codex', provider: { name: 'codex' }, familySlug: 'coder' },
          {
            id: profileId2,
            name: 'Coder Claude',
            provider: { name: 'claude' },
            familySlug: 'coder',
          },
        ],
        agents: [{ id: fmAgentId, name: 'Coder', profileId: profileId1 }],
        statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
        watchers: [
          {
            id: 'ffffffff-1111-4111-8111-111111111111',
            name: 'Test Watcher',
            enabled: true,
            scope: 'profile' as const,
            scopeFilterName: 'Coder Codex', // original (pre-substitution) profile
            pollIntervalMs: 1000,
            viewportLines: 50,
            condition: { type: 'contains' as const, pattern: 'error' },
            cooldownMs: 5000,
            cooldownMode: 'time' as const,
            eventName: 'test-event',
          },
        ],
      };
      const { deps, createWatcher } = buildDeps(h, bundledUnified(template));

      const result = (await createFromTemplateWithHelper(
        {
          name: 'Test Project',
          rootPath: '/test',
          slug: 'test-template',
          familyProviderMappings: { coder: 'claude' },
        },
        deps as never,
      )) as AnyRec;

      const projectId = (result.project as AnyRec).id as string;
      const claudeProfile = await getProfileByName(h, projectId, 'Coder Claude');

      expect(createWatcher).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'profile', scopeFilterId: claudeProfile!.id }),
      );
    });

    it('falls back to the first available config when the agent providerConfigName is unavailable', async () => {
      await seedClaudeProvider(h);
      const template = {
        version: 1,
        prompts: [],
        profiles: [
          {
            id: profileId1,
            name: 'Coder Claude',
            provider: { name: 'claude' },
            familySlug: 'coder',
            providerConfigs: [
              { name: 'opus', providerName: 'claude', options: null, env: null },
              { name: 'gpt-high', providerName: 'codex', options: null, env: null }, // codex missing → skipped
            ],
          },
        ],
        agents: [
          {
            id: fmAgentId,
            name: 'Coder',
            profileId: profileId1,
            providerConfigName: 'gpt-high', // unavailable → fall back to opus
            modelOverride: 'openai/gpt-5',
          },
        ],
        statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
      };
      const { deps } = buildDeps(h, bundledUnified(template));

      const result = (await createFromTemplateWithHelper(
        { name: 'Test Project', rootPath: '/test', slug: 'test-template' },
        deps as never,
      )) as AnyRec;

      expect(result.success).toBe(true);
      const projectId = (result.project as AnyRec).id as string;
      const profile = await getProfileByName(h, projectId, 'Coder Claude');
      const opusConfig = await getConfigByName(h, profile!.id, 'opus');
      const agent = await getAgentByName(h, projectId, 'Coder');

      // gpt-high config was never created (codex unavailable); the agent falls back to opus,
      // and its verbatim modelOverride is preserved.
      expect(agent!.providerConfigId).toBe(opusConfig!.id);
      expect(agent!.modelOverride).toBe('openai/gpt-5');
      expect(await getConfigByName(h, profile!.id, 'gpt-high')).toBeUndefined();
    });

    it('preserves modelOverride when the create path applies a preset that omits modelOverride', async () => {
      await seedClaudeProvider(h);
      const initialModelOverride = 'anthropic/claude-sonnet-4-5';
      const template = {
        version: 1,
        prompts: [],
        profiles: [
          {
            id: profileId1,
            name: 'Coder Claude',
            provider: { name: 'claude' },
            familySlug: 'coder',
            providerConfigs: [{ name: 'opus', providerName: 'claude', options: null, env: null }],
          },
        ],
        agents: [
          {
            id: fmAgentId,
            name: 'Coder',
            profileId: profileId1,
            providerConfigName: 'opus',
            modelOverride: initialModelOverride,
          },
        ],
        statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
        presets: [
          { name: 'balanced', agentConfigs: [{ agentName: 'Coder', providerConfigName: 'opus' }] },
        ],
      };
      const { deps } = buildDeps(h, bundledUnified(template));

      const result = (await createFromTemplateWithHelper(
        { name: 'Test Project', rootPath: '/test', slug: 'test-template', presetName: 'balanced' },
        deps as never,
      )) as AnyRec;

      expect(result.success).toBe(true);
      const projectId = (result.project as AnyRec).id as string;
      const profile = await getProfileByName(h, projectId, 'Coder Claude');
      const opusConfig = await getConfigByName(h, profile!.id, 'opus');
      const agent = await getAgentByName(h, projectId, 'Coder');

      // The preset selects the opus config but must NOT clobber the agent's modelOverride.
      expect(agent!.providerConfigId).toBe(opusConfig!.id);
      expect(agent!.modelOverride).toBe(initialModelOverride);
      expect(h.settings.getProjectActivePreset(projectId)).toBe('balanced');
    });

    it('applies agentOverrides on the create path and NEVER marks an active preset', async () => {
      await seedClaudeProvider(h);
      const template = {
        version: 1,
        prompts: [],
        profiles: [
          {
            id: profileId1,
            name: 'Coder Claude',
            provider: { name: 'claude' },
            familySlug: 'coder',
            providerConfigs: [
              { name: 'opus', providerName: 'claude', options: null, env: null },
              { name: 'sonnet', providerName: 'claude', options: null, env: null },
            ],
          },
        ],
        agents: [
          {
            id: fmAgentId,
            name: 'Coder',
            profileId: profileId1,
            providerConfigName: 'opus', // template default
          },
        ],
        statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
      };
      const { deps } = buildDeps(h, bundledUnified(template));

      const result = (await createFromTemplateWithHelper(
        {
          name: 'Test Project',
          rootPath: '/test',
          slug: 'test-template',
          // Wizard/API path: re-point Coder to the sonnet config + set a model override.
          agentOverrides: [
            {
              agentName: 'Coder',
              providerConfigName: 'sonnet',
              modelOverride: 'anthropic/claude-sonnet-4-5',
            },
          ],
        },
        deps as never,
      )) as AnyRec;

      expect(result.success).toBe(true);
      const projectId = (result.project as AnyRec).id as string;
      const profile = await getProfileByName(h, projectId, 'Coder Claude');
      const sonnetConfig = await getConfigByName(h, profile!.id, 'sonnet');
      const agent = await getAgentByName(h, projectId, 'Coder');

      expect(agent!.providerConfigId).toBe(sonnetConfig!.id);
      expect(agent!.modelOverride).toBe('anthropic/claude-sonnet-4-5');
      // The agentOverrides path must never set an active preset.
      expect(h.settings.getProjectActivePreset(projectId)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Transient Step-1 provider selection metadata.
  // -------------------------------------------------------------------------
  describe('selectedProviderNames (wizard selection metadata)', () => {
    const spProfileId = 'a1a1a1a1-1111-4111-8111-111111111111';
    const spAgentId = 'a1a1a1a1-2222-4222-8222-222222222222';

    it('creates providerConfigs for an installed-but-deselected provider (deselection does not block persistence)', async () => {
      await seedClaudeProvider(h);
      await h.storage.createProvider({ name: 'codex', binPath: null });

      const template = {
        version: 1,
        prompts: [],
        profiles: [
          {
            id: spProfileId,
            name: 'Coder',
            provider: { name: 'claude' },
            providerConfigs: [
              { name: 'claude-cfg', providerName: 'claude', options: null, env: null },
              { name: 'codex-cfg', providerName: 'codex', options: null, env: null },
            ],
          },
        ],
        agents: [
          {
            id: spAgentId,
            name: 'Coder',
            profileId: spProfileId,
            providerConfigName: 'claude-cfg',
            description: null,
          },
        ],
        statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
      };
      const { deps } = buildDeps(h, bundledUnified(template));

      const result = (await createFromTemplateWithHelper(
        {
          name: 'Provider Selection Project',
          rootPath: '/test/provider-selection',
          slug: 'provider-selection-test',
          // codex is installed but deselected. Deselection narrows only wizard family choices — the
          // config is still backed by an installed provider, so it must be persisted.
          selectedProviderNames: ['claude'],
        },
        deps as never,
      )) as AnyRec;

      expect(result.success).toBe(true);
      const projectId = (result.project as AnyRec).id as string;
      const profile = await getProfileByName(h, projectId, 'Coder');

      expect(await getConfigByName(h, profile!.id, 'claude-cfg')).toBeDefined();
      // codex is installed (just deselected) → its config IS created from the full installed map.
      expect(await getConfigByName(h, profile!.id, 'codex-cfg')).toBeDefined();
    });

    it('preserves behavior when the Step-1 choices cover the needed provider', async () => {
      await seedClaudeProvider(h);
      const { deps } = buildDeps(h, bundledUnified(claudeTemplate()));

      const result = (await createFromTemplateWithHelper(
        {
          name: 'BackCompat Project',
          rootPath: '/test/backcompat',
          slug: 'backcompat-test',
          selectedProviderNames: ['claude'],
        },
        deps as never,
      )) as AnyRec;

      expect(result.success).toBe(true);
      const projectId = (result.project as AnyRec).id as string;
      expect(await getProfileByName(h, projectId, 'Test Profile')).toBeDefined();
      expect(await getAgentByName(h, projectId, 'Test Agent')).toBeDefined();
    });

    it('[red-team] maps a family to a config-only provider and selects the owning profile/config', async () => {
      await seedClaudeProvider(h);
      await h.storage.createProvider({ name: 'gemini', binPath: null });

      const claudeProfileId = 'b2b2b2b2-1111-4111-8111-111111111111';
      const codexProfileId = 'b2b2b2b2-2222-4222-8222-222222222222';
      const rtAgentId = 'b2b2b2b2-3333-4333-8333-333333333333';

      // gemini exists ONLY inside the codex profile's providerConfigs (config-only provider).
      const template = {
        version: 1,
        prompts: [],
        profiles: [
          {
            id: claudeProfileId,
            name: 'Claude Coder',
            provider: { name: 'claude' },
            familySlug: 'coder',
          },
          {
            id: codexProfileId,
            name: 'Codex Coder',
            provider: { name: 'codex' },
            familySlug: 'coder',
            providerConfigs: [
              { name: 'gemini-cfg', providerName: 'gemini', options: null, env: null },
            ],
          },
        ],
        agents: [{ id: rtAgentId, name: 'Coder', profileId: claudeProfileId, description: null }],
        statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
      };
      const { deps } = buildDeps(h, bundledUnified(template));

      const result = (await createFromTemplateWithHelper(
        {
          name: 'RedTeam Project',
          rootPath: '/test/redteam',
          slug: 'redteam-test',
          familyProviderMappings: { coder: 'gemini' }, // config-only provider
        },
        deps as never,
      )) as AnyRec;

      expect(result.success).toBe(true);
      const projectId = (result.project as AnyRec).id as string;

      const codexProfile = await getProfileByName(h, projectId, 'Codex Coder');
      const agent = await getAgentByName(h, projectId, 'Coder');
      const geminiConfig = await getConfigByName(h, codexProfile!.id, 'gemini-cfg');

      // The mapping actually took effect: the gemini-config owner (Codex Coder) is the ONLY
      // profile created for the family (the claude default sibling is dropped — one profile per
      // family), the agent points at it, and its resolved config is the gemini one.
      expect(codexProfile).toBeDefined();
      expect(await getProfileByName(h, projectId, 'Claude Coder')).toBeUndefined();
      expect(agent!.profileId).toBe(codexProfile!.id);
      expect(geminiConfig).toBeDefined();
      expect(agent!.providerConfigId).toBe(geminiConfig!.id);
    });
  });

  // -------------------------------------------------------------------------
  // Binding eligibility: an installed-but-deselected config is persisted but is
  // never an agent's binding target (create path).
  // -------------------------------------------------------------------------
  describe('installed/selected binding eligibility', () => {
    const beProfileId = 'c1c1c1c1-1111-4111-8111-111111111111';
    const beAgentId = 'c1c1c1c1-2222-4222-8222-222222222222';

    /** One profile whose configs list the DESELECTED provider first, then the selected one. */
    function deselectedFirstTemplate(agentExtra: AnyRec = {}): AnyRec {
      return {
        version: 1,
        prompts: [],
        profiles: [
          {
            id: beProfileId,
            name: 'Coder',
            provider: { name: 'claude' },
            providerConfigs: [
              // codex is installed but deselected; listed FIRST so the pre-fix same-profile
              // fallback (full map, first match) would wrongly pick it.
              { name: 'codex-cfg', providerName: 'codex', options: null, env: null },
              { name: 'claude-cfg', providerName: 'claude', options: null, env: null },
            ],
          },
        ],
        agents: [
          {
            id: beAgentId,
            name: 'Coder',
            profileId: beProfileId,
            description: null,
            ...agentExtra,
          },
        ],
        statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
      };
    }

    it('binds an UNPINNED agent to the selection-eligible config, not the deselected config listed first', async () => {
      await seedClaudeProvider(h);
      await h.storage.createProvider({ name: 'codex', binPath: null });
      const { deps } = buildDeps(h, bundledUnified(deselectedFirstTemplate()));

      const result = (await createFromTemplateWithHelper(
        {
          name: 'Elig Unpinned',
          rootPath: '/test/elig-unpinned',
          slug: 'elig-unpinned',
          selectedProviderNames: ['claude'], // codex deselected
        },
        deps as never,
      )) as AnyRec;

      expect(result.success).toBe(true);
      const projectId = (result.project as AnyRec).id as string;
      const profile = await getProfileByName(h, projectId, 'Coder');
      const claudeCfg = await getConfigByName(h, profile!.id, 'claude-cfg');
      const codexCfg = await getConfigByName(h, profile!.id, 'codex-cfg');
      const agent = await getAgentByName(h, projectId, 'Coder');

      // Both configs persist (both providers installed), but binding uses the eligible map only.
      expect(codexCfg).toBeDefined();
      expect(claudeCfg).toBeDefined();
      expect(agent!.providerConfigId).toBe(claudeCfg!.id);
    });

    it('falls back to a selection-eligible config when an agent is PINNED to a deselected config', async () => {
      await seedClaudeProvider(h);
      await h.storage.createProvider({ name: 'codex', binPath: null });
      const { deps } = buildDeps(
        h,
        bundledUnified(deselectedFirstTemplate({ providerConfigName: 'codex-cfg' })),
      );

      const result = (await createFromTemplateWithHelper(
        {
          name: 'Elig Pinned',
          rootPath: '/test/elig-pinned',
          slug: 'elig-pinned',
          selectedProviderNames: ['claude'],
        },
        deps as never,
      )) as AnyRec;

      expect(result.success).toBe(true);
      const projectId = (result.project as AnyRec).id as string;
      const profile = await getProfileByName(h, projectId, 'Coder');
      const claudeCfg = await getConfigByName(h, profile!.id, 'claude-cfg');
      const codexCfg = await getConfigByName(h, profile!.id, 'codex-cfg');
      const agent = await getAgentByName(h, projectId, 'Coder');

      // The pinned codex-cfg is not selection-eligible, so the explicit lookup misses and the
      // same-profile fallback resolves to the eligible claude-cfg — never the deselected config.
      expect(codexCfg).toBeDefined();
      expect(agent!.providerConfigId).toBe(claudeCfg!.id);
    });

    it('remaps a template-pinned deselected config through an eligible wizard override', async () => {
      await seedClaudeProvider(h);
      await h.storage.createProvider({ name: 'codex', binPath: null });
      const { deps } = buildDeps(
        h,
        bundledUnified(deselectedFirstTemplate({ providerConfigName: 'codex-cfg' })),
      );

      const result = (await createFromTemplateWithHelper(
        {
          name: 'Elig Override',
          rootPath: '/test/elig-override',
          slug: 'elig-override',
          selectedProviderNames: ['claude'],
          agentOverrides: [
            {
              agentName: 'Coder',
              providerConfigName: 'claude-cfg',
              modelOverride: 'claude-selected-model',
            },
          ],
        },
        deps as never,
      )) as AnyRec;

      expect(result.success).toBe(true);
      const projectId = (result.project as AnyRec).id as string;
      const profile = await getProfileByName(h, projectId, 'Coder');
      const claudeCfg = await getConfigByName(h, profile!.id, 'claude-cfg');
      const agent = await getAgentByName(h, projectId, 'Coder');

      expect(agent!.providerConfigId).toBe(claudeCfg!.id);
      expect(agent!.modelOverride).toBe('claude-selected-model');
    });

    it('does NOT apply a preset that selects a deselected config (preset resolves against the eligible map)', async () => {
      await seedClaudeProvider(h);
      await h.storage.createProvider({ name: 'codex', binPath: null });
      const template = deselectedFirstTemplate({ providerConfigName: 'claude-cfg' });
      template.presets = [
        { name: 'p', agentConfigs: [{ agentName: 'Coder', providerConfigName: 'codex-cfg' }] },
      ];
      const { deps } = buildDeps(h, bundledUnified(template));

      const result = (await createFromTemplateWithHelper(
        {
          name: 'Elig Preset',
          rootPath: '/test/elig-preset',
          slug: 'elig-preset',
          selectedProviderNames: ['claude'],
          presetName: 'p',
        },
        deps as never,
      )) as AnyRec;

      expect(result.success).toBe(true);
      const projectId = (result.project as AnyRec).id as string;
      const profile = await getProfileByName(h, projectId, 'Coder');
      const claudeCfg = await getConfigByName(h, profile!.id, 'claude-cfg');
      const agent = await getAgentByName(h, projectId, 'Coder');

      // The preset's codex-cfg selection is not selection-eligible → not bound; the agent stays on
      // the eligible claude-cfg.
      expect(agent!.providerConfigId).toBe(claudeCfg!.id);
    });

    it('keeps an installed-but-deselected provider-scoped watcher at scope:"provider" with the provider id', async () => {
      await seedClaudeProvider(h);
      const codex = await h.storage.createProvider({ name: 'codex', binPath: null });
      const template = {
        version: 1,
        prompts: [],
        profiles: [
          { id: beProfileId, name: 'Coder', provider: { name: 'claude' }, familySlug: 'coder' },
        ],
        agents: [{ id: beAgentId, name: 'Coder', profileId: beProfileId }],
        statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
        watchers: [
          {
            id: 'c1c1c1c1-3333-4333-8333-333333333333',
            name: 'Codex Watcher',
            enabled: true,
            scope: 'provider' as const,
            scopeFilterName: 'codex', // installed but deselected
            pollIntervalMs: 1000,
            viewportLines: 50,
            condition: { type: 'contains' as const, pattern: 'error' },
            cooldownMs: 5000,
            cooldownMode: 'time' as const,
            eventName: 'test-event',
          },
        ],
      };
      const { deps, createWatcher } = buildDeps(h, bundledUnified(template));

      const result = (await createFromTemplateWithHelper(
        {
          name: 'Watcher Elig',
          rootPath: '/test/watcher-elig',
          slug: 'watcher-elig',
          selectedProviderNames: ['claude'], // codex deselected
        },
        deps as never,
      )) as AnyRec;

      expect(result.success).toBe(true);
      // The watcher resolves against the FULL installed map, so a deselected-but-installed provider
      // keeps provider scope + its id rather than silently broadening to scope:'all'.
      expect(createWatcher).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'provider', scopeFilterId: codex.id }),
      );
    });
  });
});
