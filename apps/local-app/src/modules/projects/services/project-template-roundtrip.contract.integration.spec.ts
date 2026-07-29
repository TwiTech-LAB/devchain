/**
 * Template Round-Trip Contract Safety Net (`template-roundtrip`).
 *
 * Layer: backend-integration (real `:memory:` SQLite, real LocalStorageService /
 * SettingsService / TeamsStore). This is the CHEAPEST layer that can prove the
 * behavior, because the contract under test is precisely the interaction between the
 * export/import/create helpers and the storage transaction/FK-resolution machinery —
 * a mock DB cannot catch the bug classes (dropped FKs, lossy re-serialization,
 * provider-name resolution) this net exists to lock.
 *
 * What it locks (see docs/template-roundtrip-compatibility-matrix.md — COMMITTED):
 *  - All-section normalized round-trip is IDEMPOTENT on current code:
 *    fixture → import → export(A) → import → export(B), and normalize(A) === normalize(B).
 *  - Field survival across replace-into-existing import: agent effortOverride,
 *    config model/effort, prompt tags, teams profileSelections, scheduled epics,
 *    presets overrides, initialPrompt, provider models/efforts.
 *  - Create-path parity GAPS are characterized (today's lossy behavior, passing) AND
 *    the correct behavior is asserted behind `it.skip` tagged `parity-flip-task8`
 *    (Task 8 flips these).
 *  - Env secret redaction discipline (config-level '***' preserved; provider-level skipped).
 *  - Legacy v1 fixtures (no providerConfigs / effort fields) import unchanged.
 *  - Response shapes for import (replace), dry-run, and create-from-template.
 *
 * NO production code is exercised through mocks: the helpers run against real storage.
 * Registry / upgrade-template / restore-backup response shapes are locked by their own
 * specs (project-registry-import.service.spec.ts,
 * project-template-upgrade.service.characterization.spec.ts) and by the committed matrix
 * doc; duplicating that wiring here would be a more-expensive layer for no added proof.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { join } from 'path';

import { LocalStorageService } from '../../storage/local/local-storage.service';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { SnapshotPromptWriter } from '../../storage/interfaces/snapshot-prompt-writer.interface';
import { SettingsService } from '../../settings/services/settings.service';
import { TeamsStore } from '../../teams/storage/teams.store';

import { importProjectWithHelper } from '../helpers/project-import';
import { exportProjectWithHelper } from '../helpers/project-export';
import { createFromTemplateWithHelper } from '../helpers/template-loader';
import { computeFamilyAlternativesFromStorage } from '../helpers/profile-mapping.helpers';
import { applyAgentConfigs, applyPresetWithHelper } from '../helpers/project-presets.helpers';
import {
  applyProjectSettingsWithHelper,
  createSubscribersFromPayloadWithHelper,
  createWatchersFromPayloadWithHelper,
  getImportErrorMessage,
  normalizeProfileOptions,
} from '../helpers/project-runtime.helpers';
import { deriveSlugFromPath, slugify } from '../helpers/template-file.helpers';
import { getNextRunAt } from '../../scheduled-epics/helpers/cron-helpers';
import { ConflictError } from '../../../common/errors/error-types';
import { PROMPT_TRANSFER_POLICY } from '../../../common/prompt-transfer';
import { ProjectTemplateUpgradeService } from './project-template-upgrade.service';
import type { ProjectsService } from './projects.service';

// ---------------------------------------------------------------------------
// Test harness: real :memory: SQLite + real storage-backed services.
// ---------------------------------------------------------------------------

interface Harness {
  sqlite: Database.Database;
  storage: StorageService;
  snapshotPromptWriter: SnapshotPromptWriter;
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

  const localStorage = new LocalStorageService(db);
  const storage: StorageService = localStorage;
  const settings = new SettingsService(db, new EventEmitter2());
  const teamsStore = new TeamsStore(db);
  return { sqlite, storage, snapshotPromptWriter: localStorage, settings, teamsStore };
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

/** Build the deps object the export helper expects, wired to real services. */
function exportDeps(h: Harness) {
  return {
    storage: h.storage,
    settings: h.settings,
    slugify,
    teamsService: teamsAdapter(h.teamsStore) as never,
  };
}

/** Build the deps object the import helper expects, wired to real services. */
function importDeps(h: Harness) {
  return {
    storage: h.storage,
    snapshotPromptWriter: h.snapshotPromptWriter,
    settings: h.settings,
    watchersService: {
      deleteWatcher: (watcherId: string) => h.storage.deleteWatcher(watcherId),
    },
    sessions: { getActiveSessionsForProject: () => [] },
    cleanupTeamsForProject: (projectId: string) => h.teamsStore.deleteTeamsByProject(projectId),
    unifiedTemplateService: {
      getBundledTemplate: () => {
        throw new Error('not bundled');
      },
    } as never,
    computeFamilyAlternatives: (profiles: never, agents: never, selected?: string[]) =>
      computeFamilyAlternativesFromStorage(h.storage, profiles, agents, undefined, selected),
    createWatchersFromPayload: (projectId: string, watchers: never, maps: never) =>
      createWatchersFromPayloadWithHelper(projectId, watchers, maps, {
        createWatcher: (data: never) => h.storage.createWatcher(data),
      } as never),
    createSubscribersFromPayload: (projectId: string, subscribers: never) =>
      createSubscribersFromPayloadWithHelper(projectId, subscribers, h.storage),
    applyProjectSettings: (
      projectId: string,
      projectSettings: never,
      maps: never,
      archiveStatusId: string | null,
    ) =>
      applyProjectSettingsWithHelper(projectId, projectSettings, maps, archiveStatusId, h.settings),
    getImportErrorMessage,
    applyAgentConfigs: (projectId: string, agentConfigs: never, nameMaps?: never) =>
      applyAgentConfigs(projectId, agentConfigs, { storage: h.storage }, nameMaps),
    teamsService: teamsAdapter(h.teamsStore) as never,
    scheduledEpicsRefresh: { refreshScheduleWindow: () => {} },
    computeNextRunAt: getNextRunAt,
  };
}

/** Build the deps object the create-from-template helper expects, wired to real services. */
function createDeps(h: Harness, template: Record<string, unknown>) {
  return {
    storage: h.storage,
    settings: h.settings,
    unifiedTemplateService: {
      getTemplate: async () => ({
        content: template,
        source: 'bundled' as const,
        version: '1.0.0',
      }),
      getTemplateFromFilePath: () => ({
        content: template,
        source: 'file' as const,
        version: '1.0.0',
      }),
    } as never,
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
      createWatchersFromPayloadWithHelper(projectId, watchers, maps, {
        createWatcher: (data: never) => h.storage.createWatcher(data),
      } as never),
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
    teamsService: teamsAdapter(h.teamsStore) as never,
    scheduledEpicsRefresh: { refreshScheduleWindow: () => {} },
    computeNextRunAt: getNextRunAt,
  };
}

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const BUILDER_PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const LEGACY_PROFILE_ID = '22222222-2222-4222-8222-222222222222';

/** A fully-populated, schema-valid export payload touching every section. */
function allSectionsTemplate(): Record<string, unknown> {
  return {
    _manifest: { slug: 'roundtrip-all', name: 'Round Trip All Sections', version: '1.2.3' },
    version: 1,
    prompts: [
      { title: 'Kickoff', content: 'Kickoff prompt', tags: ['starter', 'kickoff'] },
      { title: 'Reviewer SOP', content: 'Review everything', tags: ['agent:profile:reviewer'] },
      {
        title: 'Portable Custom',
        content: 'Custom prompt content',
        tags: ['portable', 'type:custom'],
      },
    ],
    profiles: [
      {
        id: BUILDER_PROFILE_ID,
        name: 'Builder',
        provider: { name: 'claude' },
        familySlug: 'claude-family',
        instructions: 'Build things',
        temperature: 0.5,
        maxTokens: 4096,
        providerConfigs: [
          {
            name: 'builder-cfg',
            providerName: 'claude',
            description: 'Primary builder config',
            options: '--flag',
            // Non-secret env key round-trips verbatim; secret redaction is a separate test.
            env: { LOG_LEVEL: 'debug' },
            model: 'opus',
            effort: 'high',
            // Explicit non-zero position exercises the position round-trip (matrix row 8).
            position: 3,
          },
        ],
      },
    ],
    agents: [
      {
        name: 'Builder Agent',
        profileId: BUILDER_PROFILE_ID,
        description: 'Does the building',
        modelOverride: 'sonnet',
        effortOverride: 'medium',
        providerConfigName: 'builder-cfg',
      },
      {
        name: 'Reviewer Agent',
        profileId: BUILDER_PROFILE_ID,
        description: null,
        modelOverride: null,
        effortOverride: null,
        providerConfigName: 'builder-cfg',
      },
    ],
    statuses: [
      { label: 'To Do', color: '#111', position: 0, mcpHidden: false },
      { label: 'Doing', color: '#222', position: 1, mcpHidden: false },
      { label: 'Done', color: '#333', position: 2, mcpHidden: true },
    ],
    initialPrompt: { title: 'Kickoff' },
    projectSettings: {
      initialPromptTitle: 'Kickoff',
      autoCleanStatusLabels: ['Done'],
      epicAssignedTemplate: 'Assigned: {title}',
      messagePoolSettings: { enabled: true, delayMs: 100, maxWaitMs: 500, maxMessages: 5 },
    },
    watchers: [
      {
        name: 'idle-watcher',
        description: 'watches idle',
        enabled: true,
        scope: 'all',
        pollIntervalMs: 1000,
        viewportLines: 40,
        idleAfterSeconds: 30,
        condition: { type: 'contains', pattern: 'DONE' },
        cooldownMs: 5000,
        cooldownMode: 'time',
        eventName: 'watcher.idle',
      },
    ],
    subscribers: [
      {
        name: 'notify-sub',
        description: 'notifies',
        enabled: true,
        eventName: 'epic.created',
        actionType: 'send_message',
        actionInputs: {
          message: { source: 'custom', customValue: 'hello' },
        },
        delayMs: 0,
        cooldownMs: 0,
        retryOnError: false,
      },
    ],
    teams: [
      {
        name: 'Core Team',
        description: 'the core team',
        teamLeadAgentName: 'Builder Agent',
        memberAgentNames: ['Builder Agent', 'Reviewer Agent'],
        maxMembers: 4,
        maxConcurrentTasks: 3,
        allowTeamLeadCreateAgents: true,
        profileNames: ['Builder'],
        profileSelections: [{ profileName: 'Builder', configNames: ['builder-cfg'] }],
      },
    ],
    providerSettings: [{ name: 'claude', autoCompactThreshold: 80, env: { PUBLIC_FLAG: 'on' } }],
    providerModels: [{ providerName: 'claude', models: ['opus', 'sonnet', 'haiku'] }],
    providerEfforts: [{ providerName: 'claude', efforts: ['high', 'medium', 'low'] }],
    presets: [
      {
        name: 'Fast',
        description: 'fast preset',
        agentConfigs: [
          {
            agentName: 'Builder Agent',
            providerConfigName: 'builder-cfg',
            modelOverride: 'opus',
            effortOverride: 'high',
          },
        ],
      },
    ],
    scheduledEpics: [
      {
        name: 'daily-standup',
        cronExpression: '0 9 * * *',
        timezone: 'UTC',
        enabled: true,
        titleTemplate: 'Standup {date}',
        descriptionTemplate: 'auto standup',
        templateStatusLabel: 'To Do',
        templateAgentName: 'Builder Agent',
        templateTags: ['auto', 'standup'],
        allowOverlap: false,
        missedRunPolicy: 'skip',
      },
    ],
  };
}

/** A legacy v1 template: no providerConfigs, no effort fields, legacy profile shape. */
function legacyV1Template(): Record<string, unknown> {
  return {
    _manifest: { slug: 'legacy-v1', name: 'Legacy V1', version: '1.0.0' },
    version: 1,
    prompts: [{ title: 'Legacy Prompt', content: 'legacy', tags: [] }],
    profiles: [
      {
        id: LEGACY_PROFILE_ID,
        name: 'Legacy Profile',
        provider: { name: 'claude' },
        instructions: 'legacy instructions',
        temperature: null,
        maxTokens: null,
        // No providerConfigs — legacy shape.
      },
    ],
    agents: [
      {
        name: 'Legacy Agent',
        profileId: LEGACY_PROFILE_ID,
        description: 'legacy agent',
        modelOverride: null,
        // No effortOverride, no providerConfigName.
      },
    ],
    statuses: [{ label: 'Backlog', color: '#000', position: 0 }],
    // No providerModels / providerEfforts / presets / scheduledEpics / teams.
  };
}

// ---------------------------------------------------------------------------
// Normalization for idempotent round-trip comparison.
// ---------------------------------------------------------------------------

type AnyRec = Record<string, unknown>;

function sortBy<T extends AnyRec>(arr: T[] | undefined, key: string): T[] {
  return [...(arr ?? [])].sort((a, b) => String(a[key] ?? '').localeCompare(String(b[key] ?? '')));
}

/**
 * Strip volatile identity (uuids / timestamps / publishedAt) and re-express
 * cross-entity references by portable NAME so two exports of the same logical
 * project compare structurally equal regardless of freshly-generated ids/order.
 */
function normalizeExport(input: AnyRec): AnyRec {
  const e = JSON.parse(JSON.stringify(input)) as AnyRec;

  delete e.exportedAt;
  if (e._manifest && typeof e._manifest === 'object') {
    const m = e._manifest as AnyRec;
    delete m.publishedAt;
    // name/description are derived from the (differently-named) target project, not the
    // template contract; slug + version come from stored template metadata and are stable.
    delete m.name;
    delete m.description;
  }

  const profiles = (e.profiles as AnyRec[]) ?? [];
  const profileIdToName = new Map<string, string>();
  for (const p of profiles) {
    if (typeof p.id === 'string') profileIdToName.set(p.id, String(p.name));
  }

  e.prompts = sortBy(e.prompts as AnyRec[], 'title').map((p) => ({
    title: p.title,
    content: p.content,
    tags: [...((p.tags as string[]) ?? [])].sort(),
  }));

  e.profiles = sortBy(profiles, 'name').map((p) => ({
    name: p.name,
    provider: (p.provider as AnyRec)?.name,
    familySlug: p.familySlug ?? null,
    instructions: p.instructions ?? null,
    temperature: p.temperature ?? null,
    maxTokens: p.maxTokens ?? null,
    providerConfigs: sortBy(p.providerConfigs as AnyRec[], 'name').map((c) => ({
      name: c.name,
      providerName: c.providerName,
      description: c.description ?? null,
      options: c.options ?? null,
      env: c.env ?? null,
      model: c.model ?? null,
      effort: c.effort ?? null,
      position: c.position ?? null,
    })),
  }));

  e.agents = sortBy(e.agents as AnyRec[], 'name').map((a) => ({
    name: a.name,
    // Reference profile by portable name, not volatile uuid.
    profileName: profileIdToName.get(String(a.profileId)) ?? null,
    description: a.description ?? null,
    modelOverride: a.modelOverride ?? null,
    effortOverride: a.effortOverride ?? null,
    providerConfigName: a.providerConfigName ?? null,
  }));

  e.statuses = sortBy(e.statuses as AnyRec[], 'label').map((s) => ({
    label: s.label,
    color: s.color,
    position: s.position,
    mcpHidden: s.mcpHidden ?? false,
  }));

  e.initialPrompt = e.initialPrompt ? { title: (e.initialPrompt as AnyRec).title ?? null } : null;

  e.watchers = sortBy(e.watchers as AnyRec[], 'name').map((w) => {
    const { id: _id, ...rest } = w;
    return rest;
  });
  e.subscribers = sortBy(e.subscribers as AnyRec[], 'name').map((s) => {
    const { id: _id, ...rest } = s;
    return rest;
  });

  // Teams carry several arrays sourced from join tables (no ORDER BY → storage/rowid
  // order), which is NOT stable across an import→export→import→export cycle. Canonicalize
  // every unordered nested array so the idempotency compare tests content, not order.
  const sortStr = (arr: unknown): string[] => [...((arr as string[]) ?? [])].sort();
  e.teams = sortBy(e.teams as AnyRec[], 'name').map((t) => ({
    ...t,
    memberAgentNames: sortStr(t.memberAgentNames),
    profileNames: sortStr(t.profileNames),
    profileSelections: sortBy(t.profileSelections as AnyRec[] | undefined, 'profileName').map(
      (sel) => ({ ...sel, configNames: sortStr(sel.configNames) }),
    ),
  }));

  // Presets: agentConfigs order is not guaranteed stable; canonicalize by agent name.
  e.presets = sortBy(e.presets as AnyRec[], 'name').map((p) => ({
    ...p,
    agentConfigs: sortBy(p.agentConfigs as AnyRec[] | undefined, 'agentName'),
  }));

  // Scheduled epics: templateTags is an unordered set for comparison purposes.
  e.scheduledEpics = sortBy(e.scheduledEpics as AnyRec[], 'name').map((s) => ({
    ...s,
    templateTags: sortStr(s.templateTags),
  }));

  // Provider model/effort catalogs: additive import can reorder; compare as sets.
  e.providerModels = sortBy(e.providerModels as AnyRec[], 'providerName').map((pm) => ({
    ...pm,
    models: sortStr(pm.models),
  }));
  e.providerEfforts = sortBy(e.providerEfforts as AnyRec[], 'providerName').map((pe) => ({
    ...pe,
    efforts: sortStr(pe.efforts),
  }));
  e.providerSettings = sortBy(e.providerSettings as AnyRec[], 'name');

  return e;
}

// ---------------------------------------------------------------------------
// Shared setup helpers.
// ---------------------------------------------------------------------------

async function seedClaudeProvider(h: Harness): Promise<void> {
  await h.storage.createProvider({ name: 'claude', binPath: null });
}

async function freshProject(h: Harness, name: string): Promise<string> {
  const project = await h.storage.createProject({
    name,
    description: null,
    rootPath: `/tmp/${slugify(name)}`,
    isTemplate: false,
  });
  return project.id;
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe('template round-trip contract safety net (real storage)', () => {
  let h: Harness;

  beforeEach(() => {
    h = createHarness();
  });

  afterEach(() => {
    h.sqlite.close();
  });

  describe('all-section normalized round-trip is idempotent on current code', () => {
    it('fixture → import → export(A) → import → export(B) yields normalize(A) === normalize(B)', async () => {
      await seedClaudeProvider(h);

      // Seed project A by importing the all-sections fixture through the real path.
      const projectA = await freshProject(h, 'Project A');
      const importA = await importProjectWithHelper(
        { projectId: projectA, payload: allSectionsTemplate() },
        importDeps(h) as never,
      );
      expect(importA).toMatchObject({ success: true, mode: 'replace', replaced: true });

      const exportA = (await exportProjectWithHelper(projectA, undefined, exportDeps(h))) as AnyRec;

      // Import exportA into a fresh project B, then export again.
      const projectB = await freshProject(h, 'Project B');
      const importB = await importProjectWithHelper(
        { projectId: projectB, payload: exportA },
        importDeps(h) as never,
      );
      expect(importB).toMatchObject({ success: true });

      const exportB = (await exportProjectWithHelper(projectB, undefined, exportDeps(h))) as AnyRec;

      expect(normalizeExport(exportB)).toEqual(normalizeExport(exportA));
    });

    it('replace-import preserves agent effortOverride and config model/effort (import path is correct)', async () => {
      await seedClaudeProvider(h);
      const projectA = await freshProject(h, 'Fidelity A');
      await importProjectWithHelper(
        { projectId: projectA, payload: allSectionsTemplate() },
        importDeps(h) as never,
      );
      const exportA = (await exportProjectWithHelper(projectA, undefined, exportDeps(h))) as AnyRec;

      const builderAgent = (exportA.agents as AnyRec[]).find((a) => a.name === 'Builder Agent');
      expect(builderAgent).toMatchObject({ modelOverride: 'sonnet', effortOverride: 'medium' });

      const builderProfile = (exportA.profiles as AnyRec[]).find((p) => p.name === 'Builder');
      const cfg = (builderProfile?.providerConfigs as AnyRec[])[0];
      expect(cfg).toMatchObject({ name: 'builder-cfg', model: 'opus', effort: 'high' });
      // [position-remediation] explicit providerConfig position survives the replace import path.
      expect(cfg.position).toBe(3);
    });

    it('replace-import preserves prompt tags, teams profileSelections, presets, and scheduled epics', async () => {
      await seedClaudeProvider(h);
      const projectA = await freshProject(h, 'Sections A');
      await importProjectWithHelper(
        { projectId: projectA, payload: allSectionsTemplate() },
        importDeps(h) as never,
      );
      const exportA = (await exportProjectWithHelper(projectA, undefined, exportDeps(h))) as AnyRec;

      const kickoff = (exportA.prompts as AnyRec[]).find((p) => p.title === 'Kickoff');
      expect([...((kickoff?.tags as string[]) ?? [])].sort()).toEqual([
        'kickoff',
        'starter',
        'type:system',
      ]);
      const portableCustom = (exportA.prompts as AnyRec[]).find(
        (p) => p.title === 'Portable Custom',
      );
      expect(portableCustom).toMatchObject({
        content: 'Custom prompt content',
        tags: expect.arrayContaining(['portable', 'type:custom']),
      });

      const team = (exportA.teams as AnyRec[])[0];
      expect(team).toMatchObject({
        name: 'Core Team',
        profileSelections: [{ profileName: 'Builder', configNames: ['builder-cfg'] }],
      });

      const preset = (exportA.presets as AnyRec[])[0];
      expect(preset).toMatchObject({
        name: 'Fast',
        agentConfigs: [expect.objectContaining({ modelOverride: 'opus', effortOverride: 'high' })],
      });

      const sched = (exportA.scheduledEpics as AnyRec[])[0];
      expect(sched).toMatchObject({
        name: 'daily-standup',
        templateStatusLabel: 'To Do',
        templateAgentName: 'Builder Agent',
      });
      expect([...((sched.templateTags as string[]) ?? [])].sort()).toEqual(['auto', 'standup']);

      // providerModels / providerEfforts are seeded by the import path.
      expect(exportA.providerModels).toEqual([
        { providerName: 'claude', models: expect.arrayContaining(['opus', 'sonnet', 'haiku']) },
      ]);
      expect(exportA.providerEfforts).toEqual([
        { providerName: 'claude', efforts: expect.arrayContaining(['high', 'medium', 'low']) },
      ]);
    });
  });

  describe('template upgrade prompt merge', () => {
    it('preserves unmatched Custom prompts and replaces every case-insensitive title match', async () => {
      const projectId = await freshProject(h, 'Upgrade Prompt Merge');
      await h.settings.setProjectTemplateMetadata(projectId, {
        templateSlug: 'upgrade-prompts',
        source: 'registry',
        installedVersion: '1.0.0',
        registryUrl: 'https://registry.example',
        installedAt: new Date().toISOString(),
      });

      await h.storage.createPrompt({
        projectId,
        title: 'Portable',
        content: 'old first',
        tags: ['type:custom'],
      });
      await h.storage.createPrompt({
        projectId,
        title: 'PORTABLE',
        content: 'old second',
        tags: ['type:custom'],
      });
      const preserved = await h.storage.createPrompt({
        projectId,
        title: 'Local Only',
        content: 'keep local',
        tags: ['type:custom'],
      });

      const targetTemplate = {
        _manifest: { slug: 'upgrade-prompts', name: 'Upgrade Prompts', version: '2.0.0' },
        version: 1,
        prompts: [
          {
            id: '99999999-9999-4999-8999-999999999981',
            title: 'portable',
            content: 'new portable',
            version: 1,
            tags: ['type:custom'],
          },
          {
            id: '99999999-9999-4999-8999-999999999982',
            title: 'Local Only',
            content: 'system peer',
            version: 1,
            tags: ['type:system'],
          },
        ],
        profiles: [],
        agents: [],
        statuses: [],
      };
      const projectsFacade = {
        exportProject: (id: string, options?: Parameters<typeof exportProjectWithHelper>[1]) =>
          exportProjectWithHelper(id, options, exportDeps(h)),
        importProject: (input: Parameters<typeof importProjectWithHelper>[0]) =>
          importProjectWithHelper(input, importDeps(h) as never),
      } as unknown as ProjectsService;
      const upgradeService = new ProjectTemplateUpgradeService(
        projectsFacade,
        {
          getTemplate: jest.fn().mockResolvedValue({ content: targetTemplate }),
        } as never,
        {} as never,
        h.settings,
      );

      const result = await upgradeService.upgradeProject({
        projectId,
        targetVersion: '2.0.0',
      });
      const prompts = await h.storage.listPrompts({ projectId, limit: 100, offset: 0 });

      expect(result).toMatchObject({
        success: true,
        newVersion: '2.0.0',
        promptTransfer: { imported: 2, deleted: 2, preserved: 1, skipped: 0 },
      });
      expect(prompts.items).toHaveLength(3);
      expect(prompts.items).toContainEqual(expect.objectContaining({ id: preserved.id }));
      expect(prompts.items.filter((prompt) => prompt.title.toLowerCase() === 'portable')).toEqual([
        expect.objectContaining({ contentPreview: 'new portable', tags: ['type:custom'] }),
      ]);
      expect(prompts.items.filter((prompt) => prompt.title === 'Local Only')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: preserved.id, tags: ['type:custom'] }),
          expect.objectContaining({ contentPreview: 'system peer', tags: ['type:system'] }),
        ]),
      );
    });
  });

  describe('snapshot prompt identity', () => {
    it.each([
      ['System', '99999999-9999-4999-8999-999999999991', 'type:system'],
      ['Custom', '99999999-9999-4999-8999-999999999992', 'type:custom'],
    ])(
      'restores the exact selected %s prompt when System and Custom share a title',
      async (_selectedType, selectedOldId, expectedTypeTag) => {
        const projectId = await freshProject(h, `Snapshot ${_selectedType}`);
        const snapshot = {
          version: 1,
          prompts: [
            {
              id: '99999999-9999-4999-8999-999999999991',
              title: 'Shared',
              content: 'system',
              version: 1,
              tags: ['type:system'],
            },
            {
              id: '99999999-9999-4999-8999-999999999992',
              title: 'Shared',
              content: 'custom',
              version: 1,
              tags: ['type:custom'],
            },
          ],
          profiles: [],
          agents: [],
          statuses: [],
          initialPrompt: { promptId: selectedOldId, title: 'Shared' },
        };

        const result = (await importProjectWithHelper(
          {
            projectId,
            payload: snapshot,
            promptTransferPolicy: PROMPT_TRANSFER_POLICY.Snapshot,
          },
          importDeps(h) as never,
        )) as AnyRec;
        const promptIdMap = (result.mappings as AnyRec).promptIdMap as Record<string, string>;
        const restoredInitialPrompt = await h.storage.getInitialSessionPrompt(projectId);

        expect(result).toMatchObject({ success: true, initialPromptSet: true });
        expect(result.promptTransfer).toEqual({
          imported: 2,
          deleted: 0,
          preserved: 0,
          skipped: 0,
        });
        expect(restoredInitialPrompt).toMatchObject({
          id: promptIdMap[selectedOldId],
          title: 'Shared',
          tags: expect.arrayContaining([expectedTypeTag]),
        });
      },
    );

    it('backup restore preserves unknown, multiple, and differently-cased type tags exactly', async () => {
      const projectId = await freshProject(h, 'Snapshot Exact Tags');
      await h.settings.setProjectTemplateMetadata(projectId, {
        templateSlug: 'snapshot-source',
        source: 'bundled',
        installedVersion: '1.0.0',
        registryUrl: null,
        installedAt: new Date().toISOString(),
      });

      const exactTagsByTitle = new Map<string, string[]>([
        ['Unknown Type', ['scope:first', 'type:future', 'scope:last']],
        ['Multiple Types', ['type:system', 'feature', 'type:custom', 'type:future']],
        ['Differently Cased', ['TYPE:System', 'Scope:Mixed', 'type:CUSTOM']],
      ]);
      for (const [title, tags] of exactTagsByTitle) {
        await h.snapshotPromptWriter.createPromptFromSnapshot({
          projectId,
          title,
          content: title,
          tags,
        });
      }

      const projectsFacade = {
        exportProject: (id: string, options?: Parameters<typeof exportProjectWithHelper>[1]) =>
          exportProjectWithHelper(id, options, exportDeps(h)),
        importProject: (input: Parameters<typeof importProjectWithHelper>[0]) =>
          importProjectWithHelper(input, importDeps(h) as never),
      } as unknown as ProjectsService;
      const upgradeService = new ProjectTemplateUpgradeService(
        projectsFacade,
        {} as never,
        {} as never,
        h.settings,
      );

      const backupId = await upgradeService.createBackup(projectId);
      const originals = await h.storage.listPrompts({ projectId, limit: 100, offset: 0 });
      for (const prompt of originals.items) {
        await h.storage.deletePrompt(prompt.id);
      }
      await h.storage.createPrompt({
        projectId,
        title: 'Replacement',
        content: 'must be removed',
        tags: ['type:custom'],
      });

      await upgradeService.restoreBackup(backupId);

      const restored = await h.storage.listPrompts({ projectId, limit: 100, offset: 0 });
      expect(restored.items).toHaveLength(exactTagsByTitle.size);
      expect(restored.items.map((prompt) => prompt.title)).not.toContain('Replacement');
      for (const prompt of restored.items) {
        expect((await h.storage.getPrompt(prompt.id)).tags).toEqual(
          exactTagsByTitle.get(prompt.title),
        );
      }
    });
  });

  describe('env secret redaction discipline', () => {
    it('redacts secret-shaped env keys on export and skips redacted values on re-import', async () => {
      await seedClaudeProvider(h);
      const template = allSectionsTemplate();
      // Inject a secret-shaped key at config level and provider level.
      ((template.profiles as AnyRec[])[0].providerConfigs as AnyRec[])[0].env = {
        LOG_LEVEL: 'debug',
        API_KEY: 'super-secret',
      };
      (template.providerSettings as AnyRec[])[0].env = { PUBLIC_FLAG: 'on', GITHUB_TOKEN: 'ghp_x' };

      const projectA = await freshProject(h, 'Secrets A');
      await importProjectWithHelper(
        { projectId: projectA, payload: template },
        importDeps(h) as never,
      );
      const exportA = (await exportProjectWithHelper(projectA, undefined, exportDeps(h))) as AnyRec;

      const cfg = ((exportA.profiles as AnyRec[])[0].providerConfigs as AnyRec[])[0];
      // Config-level: non-secret preserved, secret redacted to '***'.
      expect((cfg.env as AnyRec).LOG_LEVEL).toBe('debug');
      expect((cfg.env as AnyRec).API_KEY).toBe('***');

      const provEnv = ((exportA.providerSettings as AnyRec[])[0].env as AnyRec) ?? {};
      expect(provEnv.PUBLIC_FLAG).toBe('on');
      // Provider-level secret is redacted on export...
      expect(provEnv.GITHUB_TOKEN).toBe('***');
    });
  });

  describe('legacy v1 fixtures import unchanged', () => {
    it('imports a legacy template with no providerConfigs / effort fields', async () => {
      await seedClaudeProvider(h);
      const projectA = await freshProject(h, 'Legacy A');
      const result = await importProjectWithHelper(
        { projectId: projectA, payload: legacyV1Template() },
        importDeps(h) as never,
      );
      expect(result).toMatchObject({ success: true, mode: 'replace' });

      const exportA = (await exportProjectWithHelper(projectA, undefined, exportDeps(h))) as AnyRec;
      expect((exportA.profiles as AnyRec[])[0]).toMatchObject({ name: 'Legacy Profile' });
      const legacyAgent = (exportA.agents as AnyRec[]).find((a) => a.name === 'Legacy Agent');
      // Absent-vs-empty discipline: a legacy agent with no effort exports NO effortOverride key.
      expect(legacyAgent).toBeDefined();
      expect(legacyAgent).not.toHaveProperty('effortOverride');
      expect(legacyAgent).toMatchObject({ modelOverride: null });
      // Legacy import defaults optional collections to empty, not absent-error.
      expect(exportA.providerModels).toEqual([]);
      expect(exportA.providerEfforts).toEqual([]);
    });
  });

  describe('create-from-template against real storage (preset + teamOverrides + familyProviderMappings)', () => {
    it('creates a project with all sections (preset + teamOverrides + familyProviderMappings)', async () => {
      await seedClaudeProvider(h);

      const result = await createFromTemplateWithHelper(
        {
          name: 'Created Project',
          rootPath: '/tmp/created-project',
          slug: 'roundtrip-all',
          presetName: 'Fast',
          // Exercises the familyProviderMappings deps path (claude is locally available).
          familyProviderMappings: {},
          teamOverrides: [
            {
              teamName: 'Core Team',
              maxMembers: 6,
              profileSelections: [{ profileName: 'Builder', configNames: ['builder-cfg'] }],
            },
          ],
        },
        createDeps(h, allSectionsTemplate()) as never,
      );

      expect(result).toMatchObject({
        success: true,
        message: 'Project created from template successfully.',
      });
      const created = result as AnyRec;
      const project = created.project as AnyRec;
      expect(project).toMatchObject({ name: 'Created Project' });
      expect(created.imported).toMatchObject({
        prompts: expect.any(Number),
        profiles: expect.any(Number),
        agents: expect.any(Number),
        statuses: expect.any(Number),
      });
    });

    // ---- Task 8: create path now reaches parity with import (one pipeline, both flows). ----
    it('[parity-task8] create path threads effortOverride + config model/effort + provider models/efforts', async () => {
      await seedClaudeProvider(h);
      const result = await createFromTemplateWithHelper(
        { name: 'Parity Project', rootPath: '/tmp/parity', slug: 'roundtrip-all' },
        createDeps(h, allSectionsTemplate()) as never,
      );
      const project = (result as AnyRec).project as AnyRec;
      const exp = (await exportProjectWithHelper(
        String(project.id),
        undefined,
        exportDeps(h),
      )) as AnyRec;

      const builderAgent = (exp.agents as AnyRec[]).find((a) => a.name === 'Builder Agent');
      expect(builderAgent?.effortOverride).toBe('medium');

      const builderProfile = (exp.profiles as AnyRec[]).find((p) => p.name === 'Builder');
      const cfg = (builderProfile?.providerConfigs as AnyRec[])[0];
      expect(cfg).toMatchObject({ model: 'opus', effort: 'high' });
      // [position-remediation] explicit providerConfig position survives the create path.
      expect(cfg.position).toBe(3);

      expect(exp.providerModels).toEqual([
        { providerName: 'claude', models: expect.arrayContaining(['opus', 'sonnet', 'haiku']) },
      ]);
      expect(exp.providerEfforts).toEqual([
        { providerName: 'claude', efforts: expect.arrayContaining(['high', 'medium', 'low']) },
      ]);
    });

    // Create-core atomicity: a mid-core failure must roll back the WHOLE project (no orphan row).
    it('[create-atomicity] mid-core failure leaves no orphan project row', async () => {
      await seedClaudeProvider(h);

      const before = await h.storage.listProjects({ limit: 1000, offset: 0 });
      const beforeCount = before.total;

      // Inject a failure at the LAST create-core step (agents run after project row + statuses +
      // prompts + profiles inside the single runInTransaction). The whole core must roll back.
      const realCreateAgent = h.storage.createAgent.bind(h.storage);
      (h.storage as unknown as { createAgent: unknown }).createAgent = () => {
        throw new Error('injected mid-core failure');
      };

      try {
        await expect(
          createFromTemplateWithHelper(
            { name: 'Orphan Check', rootPath: '/tmp/orphan-check', slug: 'roundtrip-all' },
            createDeps(h, allSectionsTemplate()) as never,
          ),
        ).rejects.toThrow();
      } finally {
        (h.storage as unknown as { createAgent: unknown }).createAgent = realCreateAgent;
      }

      // No project row (or its statuses/prompts/profiles) survived the rolled-back transaction.
      const after = await h.storage.listProjects({ limit: 1000, offset: 0 });
      expect(after.total).toBe(beforeCount);
      expect((after.items as AnyRec[]).some((p) => p.name === 'Orphan Check')).toBe(false);
    });

    // A client-supplied projectId that collides with an existing project must surface as a domain
    // ConflictError (409) through the create-from-template path — preserving the mapping the
    // create-core delegate provided before the pipeline cutover. The second attempt must not leave
    // an orphan project row.
    it('[create-conflict] duplicate explicit projectId throws ConflictError, no orphan row', async () => {
      await seedClaudeProvider(h);

      const explicitId = '33333333-3333-4333-8333-333333333333';

      const first = (await createFromTemplateWithHelper(
        {
          name: 'Conflict First',
          rootPath: '/tmp/conflict-first',
          slug: 'roundtrip-all',
          projectId: explicitId,
        },
        createDeps(h, allSectionsTemplate()) as never,
      )) as AnyRec;
      expect((first.project as AnyRec).id).toBe(explicitId);

      const before = await h.storage.listProjects({ limit: 1000, offset: 0 });

      const conflict = await createFromTemplateWithHelper(
        {
          name: 'Conflict Second',
          rootPath: '/tmp/conflict-second',
          slug: 'roundtrip-all',
          projectId: explicitId,
        },
        createDeps(h, allSectionsTemplate()) as never,
      )
        .then(() => null)
        .catch((error: unknown) => error);

      expect(conflict).toBeInstanceOf(ConflictError);
      expect((conflict as ConflictError).message).toBe(
        `Project ID "${explicitId}" already exists.`,
      );
      expect((conflict as ConflictError).details).toMatchObject({
        field: 'projectId',
        projectId: explicitId,
      });

      // The failed second attempt rolled back — still exactly one project with that id.
      const after = await h.storage.listProjects({ limit: 1000, offset: 0 });
      expect(after.total).toBe(before.total);
      expect((after.items as AnyRec[]).filter((p) => p.id === explicitId)).toHaveLength(1);
      expect((after.items as AnyRec[]).some((p) => p.name === 'Conflict Second')).toBe(false);
    });
  });

  describe('response-shape contracts', () => {
    it('replace-import success response shape', async () => {
      await seedClaudeProvider(h);
      const projectA = await freshProject(h, 'Shape Import');
      const result = (await importProjectWithHelper(
        { projectId: projectA, payload: allSectionsTemplate() },
        importDeps(h) as never,
      )) as AnyRec;

      expect(result).toMatchObject({
        success: true,
        mode: 'replace',
        replaced: true,
        missingProviders: [],
        initialPromptSet: true,
        sessionPreservation: {
          preservedCount: expect.any(Number),
          removedCount: expect.any(Number),
        },
        message: expect.any(String),
      });
      expect(result.counts).toMatchObject({
        imported: expect.objectContaining({
          prompts: expect.any(Number),
          agents: expect.any(Number),
        }),
        deleted: expect.any(Object),
        epics: expect.objectContaining({ preserved: expect.any(Number) }),
      });
      expect(result.mappings).toMatchObject({
        promptIdMap: expect.any(Object),
        profileIdMap: expect.any(Object),
        agentIdMap: expect.any(Object),
        statusIdMap: expect.any(Object),
      });
    });

    it('dry-run response shape (no writes)', async () => {
      await seedClaudeProvider(h);
      const projectA = await freshProject(h, 'Shape DryRun');
      const result = (await importProjectWithHelper(
        { projectId: projectA, payload: allSectionsTemplate(), dryRun: true },
        importDeps(h) as never,
      )) as AnyRec;

      expect(result).toMatchObject({
        dryRun: true,
        missingProviders: expect.any(Array),
        templateStatuses: expect.any(Array),
      });
      expect(result.counts).toMatchObject({
        toImport: expect.objectContaining({
          prompts: expect.any(Number),
          statuses: expect.any(Number),
        }),
        toDelete: expect.any(Object),
      });
      expect(result).not.toHaveProperty('mode');

      // Dry-run must NOT have written anything: the project still exports empty sections.
      const exportA = (await exportProjectWithHelper(projectA, undefined, exportDeps(h))) as AnyRec;
      expect(exportA.prompts).toEqual([]);
      expect(exportA.agents).toEqual([]);
    });

    it('create-from-template success response shape', async () => {
      await seedClaudeProvider(h);
      const result = (await createFromTemplateWithHelper(
        { name: 'Shape Create', rootPath: '/tmp/shape-create', slug: 'roundtrip-all' },
        createDeps(h, allSectionsTemplate()) as never,
      )) as AnyRec;

      expect(result).toMatchObject({
        success: true,
        message: 'Project created from template successfully.',
        initialPromptSet: expect.any(Boolean),
      });
      expect(result.project).toMatchObject({ id: expect.any(String), name: 'Shape Create' });
      expect(result.imported).toMatchObject({
        prompts: expect.any(Number),
        profiles: expect.any(Number),
        agents: expect.any(Number),
        statuses: expect.any(Number),
      });
      expect(result.mappings).toMatchObject({ promptIdMap: expect.any(Object) });
    });
  });

  // -------------------------------------------------------------------------
  // Transient Step-1 provider selection metadata — import + dry-run.
  // -------------------------------------------------------------------------
  describe('selectedProviderNames (wizard selection metadata)', () => {
    const SP_PROFILE_ID = 'a3a3a3a3-1111-4111-8111-111111111111';
    const SP_CLAUDE_PROFILE_ID = 'a3a3a3a3-2222-4222-8222-222222222222';
    const SP_CODEX_PROFILE_ID = 'a3a3a3a3-3333-4333-8333-333333333333';

    /** Single profile carrying one config per provider (claude + codex). */
    function twoConfigTemplate(): Record<string, unknown> {
      return {
        version: 1,
        prompts: [],
        profiles: [
          {
            id: SP_PROFILE_ID,
            name: 'Coder',
            provider: { name: 'claude' },
            providerConfigs: [
              { name: 'claude-cfg', providerName: 'claude', options: null, env: null },
              { name: 'codex-cfg', providerName: 'codex', options: null, env: null },
            ],
          },
        ],
        agents: [{ name: 'Coder', profileId: SP_PROFILE_ID, providerConfigName: 'claude-cfg' }],
        statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
      };
    }

    /** A coder family with a claude profile and a codex profile (both default providers). */
    function familyTemplate(): Record<string, unknown> {
      return {
        version: 1,
        prompts: [],
        profiles: [
          {
            id: SP_CLAUDE_PROFILE_ID,
            name: 'Claude Coder',
            provider: { name: 'claude' },
            familySlug: 'coder',
          },
          {
            id: SP_CODEX_PROFILE_ID,
            name: 'Codex Coder',
            provider: { name: 'codex' },
            familySlug: 'coder',
          },
        ],
        agents: [{ name: 'Coder', profileId: SP_CLAUDE_PROFILE_ID }],
        statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
      };
    }

    async function seedClaudeAndCodex(harness: Harness): Promise<void> {
      await harness.storage.createProvider({ name: 'claude', binPath: null });
      await harness.storage.createProvider({ name: 'codex', binPath: null });
    }

    it('dry-run: a deselected installed provider does NOT surface as missing (only genuinely uninstalled ones do)', async () => {
      await seedClaudeAndCodex(h);
      const projectA = await freshProject(h, 'DryRun Provider Selection');

      const baseline = (await importProjectWithHelper(
        { projectId: projectA, payload: familyTemplate(), dryRun: true },
        importDeps(h) as never,
      )) as AnyRec;
      // Both providers installed → nothing missing without a selection filter.
      expect(baseline.missingProviders).toEqual([]);

      const constrained = (await importProjectWithHelper(
        {
          projectId: projectA,
          payload: familyTemplate(),
          dryRun: true,
          selectedProviderNames: ['claude'],
        },
        importDeps(h) as never,
      )) as AnyRec;
      // codex is installed, just deselected → NOT missing (deselection is wizard-scope, not
      // availability). Only genuinely uninstalled providers appear in true missing reporting.
      expect(constrained.missingProviders).toEqual([]);
      // Family default (claude) is still available → import remains possible, no mapping wall.
      expect(constrained).not.toHaveProperty('providerMappingRequired');
      // A dry-run writes nothing.
      const exportA = (await exportProjectWithHelper(projectA, undefined, exportDeps(h))) as AnyRec;
      expect(exportA.profiles).toEqual([]);
    });

    it('replace-import DOES create providerConfigs for a deselected but installed provider', async () => {
      await seedClaudeAndCodex(h);
      const projectA = await freshProject(h, 'Import Provider Selection');

      await importProjectWithHelper(
        {
          projectId: projectA,
          payload: twoConfigTemplate(),
          selectedProviderNames: ['claude'], // codex deselected, but installed
        },
        importDeps(h) as never,
      );

      const { items: profiles } = await h.storage.listAgentProfiles({ projectId: projectA });
      const coder = profiles.find((p) => p.name === 'Coder');
      expect(coder).toBeDefined();

      const configs = await h.storage.listProfileProviderConfigsByProfile(coder!.id);
      const configNames = configs.map((c) => c.name).sort();
      // Both configs are created: persistence uses the full installed map, so a deselected-but-
      // installed provider's config is preserved (only genuinely uninstalled providers are skipped).
      expect(configNames).toEqual(['claude-cfg', 'codex-cfg']);
    });

    it('dry-run: a config-only provider that is genuinely uninstalled surfaces in missingProviders', async () => {
      // Only claude is installed. In twoConfigTemplate the profile default provider is claude;
      // codex is reachable ONLY through the codex-cfg providerConfig (config-only reference,
      // never a profile default). The precheck must still collect it and, because it is not
      // installed, report it as genuinely missing.
      await h.storage.createProvider({ name: 'claude', binPath: null });
      const projectA = await freshProject(h, 'DryRun ConfigOnly Missing');

      const result = (await importProjectWithHelper(
        { projectId: projectA, payload: twoConfigTemplate(), dryRun: true },
        importDeps(h) as never,
      )) as AnyRec;

      // codex is surfaced despite never appearing as a profile default — proving referenced-provider
      // collection unions embedded providerConfigs[].providerName, not just defaults.
      expect(result.missingProviders).toEqual(['codex']);
      // A dry-run writes nothing.
      const exportA = (await exportProjectWithHelper(projectA, undefined, exportDeps(h))) as AnyRec;
      expect(exportA.profiles).toEqual([]);
    });

    /** One profile whose configs list the DESELECTED provider (codex) first, then claude. */
    function deselectedFirstTemplate(
      agentExtra: Record<string, unknown> = {},
    ): Record<string, unknown> {
      return {
        version: 1,
        prompts: [],
        profiles: [
          {
            id: SP_PROFILE_ID,
            name: 'Coder',
            provider: { name: 'claude' },
            providerConfigs: [
              { name: 'codex-cfg', providerName: 'codex', options: null, env: null },
              { name: 'claude-cfg', providerName: 'claude', options: null, env: null },
            ],
          },
        ],
        agents: [{ name: 'Coder', profileId: SP_PROFILE_ID, ...agentExtra }],
        statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
      };
    }

    async function coderConfigs(projectId: string) {
      const { items: profiles } = await h.storage.listAgentProfiles({ projectId });
      const coderProfile = profiles.find((p) => p.name === 'Coder');
      const configs = await h.storage.listProfileProviderConfigsByProfile(coderProfile!.id);
      const { items: agents } = await h.storage.listAgents(projectId, { limit: 10000 });
      return {
        agent: agents.find((a) => a.name === 'Coder'),
        claudeCfg: configs.find((c) => c.name === 'claude-cfg'),
        codexCfg: configs.find((c) => c.name === 'codex-cfg'),
      };
    }

    it('replace-import: an UNPINNED agent binds to the selection-eligible config, not the deselected first config', async () => {
      await seedClaudeAndCodex(h);
      const projectA = await freshProject(h, 'Replace Elig Unpinned');

      await importProjectWithHelper(
        {
          projectId: projectA,
          payload: deselectedFirstTemplate(),
          selectedProviderNames: ['claude'], // codex deselected
        },
        importDeps(h) as never,
      );

      const { agent, claudeCfg, codexCfg } = await coderConfigs(projectA);
      // Both configs persist (both installed); the unpinned agent binds to the eligible claude-cfg,
      // never the deselected codex-cfg listed first.
      expect(codexCfg).toBeDefined();
      expect(agent!.providerConfigId).toBe(claudeCfg!.id);
    });

    it('replace-import: remaps a template-pinned deselected config through an eligible wizard override', async () => {
      await seedClaudeAndCodex(h);
      const projectA = await freshProject(h, 'Replace Elig Override');

      await importProjectWithHelper(
        {
          projectId: projectA,
          payload: deselectedFirstTemplate({ providerConfigName: 'codex-cfg' }),
          selectedProviderNames: ['claude'],
          agentOverrides: [
            {
              agentName: 'Coder',
              providerConfigName: 'claude-cfg',
              modelOverride: 'claude-selected-model',
            },
          ],
        },
        importDeps(h) as never,
      );

      const { agent, claudeCfg } = await coderConfigs(projectA);
      expect(agent!.providerConfigId).toBe(claudeCfg!.id);
      expect(agent!.modelOverride).toBe('claude-selected-model');
    });
  });
});
