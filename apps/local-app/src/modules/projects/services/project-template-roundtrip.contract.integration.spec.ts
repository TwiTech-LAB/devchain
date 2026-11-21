import { createTestDatabase } from '../../../common/test/test-database.helper';
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
 *  - Create-path parity for agent overrides, provider-config fields, and provider catalogs.
 *  - Env secret redaction discipline (config-level '***' preserved; provider-level skipped).
 *  - Legacy v1 fixtures (no providerConfigs / effort fields) import unchanged.
 *  - Response shapes for import (replace), dry-run, and create-from-template.
 *  - Configured upgrade selection, status-count parity, established-data retention, and
 *    automatic recovery of raw profile secrets plus active-preset sidecar state.
 *
 * Every state mutation runs through the production helpers against real storage. Upgrade-only
 * network/preview/session boundaries are deterministic in-process adapters so the contract
 * remains fast and cannot call external services.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { LocalStorageService } from '../../storage/local/local-storage.service';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { SnapshotPromptWriter } from '../../storage/interfaces/snapshot-prompt-writer.interface';
import { SettingsService } from '../../settings/services/settings.service';
import { TeamsStore } from '../../teams/storage/teams.store';

import { importProjectWithHelper } from '../helpers/project-import';
import { captureSnapshotEpicAssignments } from '../helpers/snapshot-epic-assignments';
import { exportProjectWithHelper } from '../helpers/project-export';
import { createFromTemplateWithHelper } from '../helpers/template-loader';
import { computeFamilyAlternativesFromStorage } from '../helpers/profile-mapping.helpers';
import {
  applyAgentConfigs,
  applyPresetWithHelper,
  type ApplyPresetNameMaps,
} from '../helpers/project-presets.helpers';
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
import { createProjectWriteGateStub } from '../../storage/write-gate/testing/project-write-gate.stub';

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
  const sqlite = createTestDatabase().sqlite;
  sqlite.pragma('journal_mode = WAL');
  const db: BetterSQLite3Database = drizzle(sqlite);
  sqlite.pragma('foreign_keys = OFF');
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
    listTeams: async (projectId: string, options?: { limit?: number }) => {
      const result = await teamsStore.listTeams(projectId, options);
      return {
        ...result,
        items: result.items.map((team) => ({ ...team, teamLeadAgentName: null })),
      };
    },
    getTeam: (id: string) => teamsStore.getTeam(id),
    updateTeam: (id: string, data: Parameters<TeamsStore['updateTeam']>[1]) =>
      teamsStore.updateTeam(id, data),
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
  const teamsService = teamsAdapter(h.teamsStore);
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
    applyPreset: (
      projectId: string,
      presetName: string,
      nameMaps: ApplyPresetNameMaps,
      skipTeamNames: ReadonlySet<string>,
    ) =>
      applyPresetWithHelper(
        projectId,
        presetName,
        { storage: h.storage, settings: h.settings, teamsService },
        nameMaps,
        skipTeamNames,
      ),
    teamsService,
    scheduledEpicsRefresh: { refreshScheduleWindow: () => {} },
    computeNextRunAt: getNextRunAt,
  };
}

/** Build the deps object the create-from-template helper expects, wired to real services. */
function createDeps(h: Harness, template: Record<string, unknown>) {
  const teamsService = teamsAdapter(h.teamsStore);
  return {
    storage: h.storage,
    settings: h.settings,
    unifiedTemplateService: {
      getTemplate: async () => ({
        content: template,
        source: 'bundled' as const,
        version: String((template._manifest as AnyRec | undefined)?.version ?? '1.0.0'),
      }),
      getTemplateFromFilePath: () => ({
        content: template,
        source: 'file' as const,
        version: String((template._manifest as AnyRec | undefined)?.version ?? '1.0.0'),
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
    applyPreset: (
      projectId: string,
      presetName: string,
      nameMaps: ApplyPresetNameMaps,
      skipTeamNames: ReadonlySet<string>,
    ) =>
      applyPresetWithHelper(
        projectId,
        presetName,
        { storage: h.storage, settings: h.settings, teamsService },
        nameMaps,
        skipTeamNames,
      ),
    applyAgentConfigs: (projectId: string, agentConfigs: never, nameMaps?: never) =>
      applyAgentConfigs(projectId, agentConfigs, { storage: h.storage }, nameMaps),
    teamsService: teamsService as never,
    scheduledEpicsRefresh: { refreshScheduleWindow: () => {} },
    computeNextRunAt: getNextRunAt,
  };
}

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const BUILDER_PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const LEGACY_PROFILE_ID = '22222222-2222-4222-8222-222222222222';
const CURRENT_WORKER_PROFILE_ID = '33333333-3333-4333-8333-333333333333';
const TARGET_CLAUDE_PROFILE_ID = '44444444-4444-4444-8444-444444444444';
const TARGET_CODEX_PROFILE_ID = '55555555-5555-4555-8555-555555555555';
const TARGET_WORKER_AGENT_ID = '66666666-6666-4666-8666-666666666666';

/** A fully-populated, schema-valid export payload touching every section. */
const presetTeamConfigs = [
  {
    teamName: 'Core Team',
    profileSelections: [{ profileName: 'Builder', configNames: ['builder-cfg'] }],
  },
];

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
        isProjectOwner: true,
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
        teamConfigs: presetTeamConfigs,
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

function templateWithTeamClearingPreset() {
  const template = allSectionsTemplate();
  const [preset] = template.presets as AnyRec[];
  return {
    ...template,
    presets: [{ ...preset, teamConfigs: [{ teamName: 'Core Team', profileSelections: [] }] }],
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

function configuredUpgradeSourceTemplate(): Record<string, unknown> {
  return {
    _manifest: { slug: 'configured-upgrade', name: 'Configured Upgrade', version: '1.0.0' },
    version: 1,
    prompts: [
      {
        title: 'Current System',
        content: 'replace this system prompt',
        tags: ['type:system'],
      },
      {
        title: 'Local Knowledge',
        content: 'preserve this established custom prompt',
        tags: ['type:custom', 'local'],
      },
    ],
    profiles: [
      {
        id: CURRENT_WORKER_PROFILE_ID,
        name: 'Current Worker',
        provider: { name: 'claude' },
        familySlug: 'worker-family',
        providerConfigs: [
          {
            name: 'claude-current',
            providerName: 'claude',
            env: { API_KEY: 'profile-secret-verbatim', LOG_LEVEL: 'debug' },
            model: 'current-model',
            effort: 'low',
          },
        ],
      },
    ],
    agents: [
      {
        name: 'Worker',
        profileId: CURRENT_WORKER_PROFILE_ID,
        providerConfigName: 'claude-current',
      },
    ],
    statuses: [
      { label: 'Ready', color: '#111111', position: 0 },
      { label: 'Legacy', color: '#222222', position: 1 },
      { label: 'Unused', color: '#333333', position: 2 },
    ],
    presets: [
      {
        name: 'Current Preset',
        agentConfigs: [
          {
            agentName: 'Worker',
            providerConfigName: 'claude-current',
            modelOverride: 'current-model',
            effortOverride: 'low',
          },
        ],
      },
    ],
  };
}

function configuredUpgradeTargetTemplate(): Record<string, unknown> {
  return {
    _manifest: { slug: 'configured-upgrade', name: 'Configured Upgrade', version: '2.0.0' },
    version: 1,
    prompts: [
      {
        title: 'Target System',
        content: 'target system prompt',
        tags: ['type:system'],
      },
    ],
    profiles: [
      {
        id: TARGET_CLAUDE_PROFILE_ID,
        name: 'Claude Target',
        provider: { name: 'claude' },
        familySlug: 'worker-family',
        providerConfigs: [
          { name: 'claude-target', providerName: 'claude', model: 'claude-default' },
        ],
      },
      {
        id: TARGET_CODEX_PROFILE_ID,
        name: 'Codex Target',
        provider: { name: 'codex' },
        familySlug: 'worker-family',
        providerConfigs: [{ name: 'codex-target', providerName: 'codex', model: 'codex-default' }],
      },
    ],
    agents: [
      {
        id: TARGET_WORKER_AGENT_ID,
        name: 'Worker',
        profileId: TARGET_CLAUDE_PROFILE_ID,
        providerConfigName: 'claude-target',
      },
    ],
    statuses: [
      { label: 'Ready', color: '#abcdef', position: 0 },
      { label: 'Done', color: '#00ff00', position: 1 },
    ],
    teams: [
      {
        name: 'Target Squad',
        teamLeadAgentName: 'Worker',
        memberAgentNames: ['Worker'],
        maxMembers: 8,
        maxConcurrentTasks: 6,
        allowTeamLeadCreateAgents: true,
        profileNames: ['Claude Target'],
        profileSelections: [{ profileName: 'Claude Target', configNames: ['claude-target'] }],
      },
    ],
    presets: [
      {
        name: 'Target Preset',
        agentConfigs: [
          {
            agentName: 'Worker',
            providerConfigName: 'codex-target',
            modelOverride: 'gpt-target',
            effortOverride: 'high',
          },
        ],
      },
    ],
  };
}

/** The configured upgrade target with two teams whose template order is not their name order. */
function twoTeamUpgradeTargetTemplate(): Record<string, unknown> {
  return {
    ...configuredUpgradeTargetTemplate(),
    teams: [
      { name: 'Planning', teamLeadAgentName: 'Worker', memberAgentNames: ['Worker'] },
      { name: 'Builders', memberAgentNames: ['Worker'] },
    ],
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
    isProjectOwner: a.isProjectOwner ?? false,
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

/** Hold Date at `iso`; promises and timers stay real. Call jest.useRealTimers() after. */
function freezeDate(iso: string): void {
  jest.useFakeTimers({
    now: new Date(iso),
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  });
}

async function seedClaudeProvider(h: Harness): Promise<void> {
  await h.storage.createProvider({ name: 'claude', binPath: null });
}

async function seedConfiguredUpgradeProviders(h: Harness): Promise<void> {
  await seedClaudeProvider(h);
  await h.storage.createProvider({ name: 'codex', binPath: null });
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

async function seedConfiguredUpgradeSource(
  h: Harness,
  projectName: string,
  activePreset: string | null,
) {
  await seedConfiguredUpgradeProviders(h);
  const projectId = await freshProject(h, projectName);
  const imported = await importProjectWithHelper(
    { projectId, payload: configuredUpgradeSourceTemplate() },
    importDeps(h) as never,
  );
  expect(imported).toMatchObject({ success: true });
  await h.settings.setProjectActivePreset(projectId, activePreset);

  const statuses = await h.storage.listStatuses(projectId, { limit: 100, offset: 0 });
  const legacyStatus = statuses.items.find((status) => status.label === 'Legacy');
  const worker = (await h.storage.listAgents(projectId, { limit: 100, offset: 0 })).items.find(
    (agent) => agent.name === 'Worker',
  );
  if (!legacyStatus || !worker) {
    throw new Error('Configured upgrade source fixture failed to seed');
  }
  const epic = await h.storage.createEpicForProject(projectId, {
    title: 'Established Epic',
    description: 'must survive replacement',
    statusId: legacyStatus.id,
    agentId: worker.id,
  });

  return { projectId, legacyStatusId: legacyStatus.id, epicId: epic.id };
}

function configuredUpgradeControls(legacyStatusId: string) {
  return {
    selectedProviderNames: ['codex'],
    familyProviderMappings: { 'worker-family': 'codex' },
    presetName: 'Target Preset',
    teamOverrides: [
      {
        teamName: 'Target Squad',
        allowTeamLeadCreateAgents: false,
        maxMembers: 3,
        maxConcurrentTasks: 1,
        profileNames: ['Codex Target'],
        profileSelections: [{ profileName: 'Codex Target', configNames: ['codex-target'] }],
      },
    ],
    statusMappings: { [legacyStatusId]: 'Done' },
  };
}

function captureSnapshotAssignments(h: Harness): ProjectsService['captureSnapshotEpicAssignments'] {
  return (projectId, agents) => captureSnapshotEpicAssignments(projectId, agents, h.storage);
}

function createRealStorageUpgradeService(
  h: Harness,
  targetTemplate: Record<string, unknown>,
  options: {
    sessions?: { getActiveSessionsForProject: (projectId: string) => unknown[] };
    failAfterFirstMutation?: boolean;
    beforeForwardEpicRemap?: () => Promise<void>;
  } = {},
) {
  const sessions = options.sessions ?? { getActiveSessionsForProject: () => [] };
  let importCalls = 0;
  let lastUpgradeImportResult: unknown;
  const projectsFacade = {
    captureSnapshotEpicAssignments: captureSnapshotAssignments(h),
    exportProject: (id: string, exportOptions?: Parameters<typeof exportProjectWithHelper>[1]) =>
      exportProjectWithHelper(id, exportOptions, exportDeps(h)),
    setupPreview: jest.fn().mockResolvedValue({}),
    importProject: async (input: Parameters<typeof importProjectWithHelper>[0]) => {
      importCalls++;
      const deps = importDeps(h);
      const beforeRemap = options.beforeForwardEpicRemap;
      const teams = teamsAdapter(h.teamsStore);
      const teamsService =
        importCalls === 1 && beforeRemap
          ? {
              ...teams,
              createTeam: async (data: Parameters<TeamsStore['createTeam']>[0]) => {
                await beforeRemap();
                return teams.createTeam(data);
              },
            }
          : teams;
      const result = await importProjectWithHelper(input, {
        ...deps,
        sessions,
        teamsService,
      } as never);
      if (importCalls === 1) {
        lastUpgradeImportResult = result;
        if (options.failAfterFirstMutation && 'success' in result && result.success) {
          throw new Error('Injected failure after target mutation');
        }
      }
      return result;
    },
  } as unknown as ProjectsService;

  const service = new ProjectTemplateUpgradeService(
    projectsFacade,
    { getOrDownloadTemplate: jest.fn().mockResolvedValue({ content: targetTemplate }) } as never,
    {} as never,
    h.settings,
    sessions as never,
    createProjectWriteGateStub() as never,
  );

  return {
    service,
    projectsFacade,
    getLastUpgradeImportResult: () => lastUpgradeImportResult,
  };
}

const PRESERVATION_CONTROLS = {
  selectedProviderNames: ['claude', 'codex'],
  familyProviderMappings: { 'specialist-family': 'claude' },
  preserveTeamSetup: {
    agentOptions: [{ agentName: 'Local Specialist', configName: 'fable', providerName: 'claude' }],
  },
};

const PRESERVATION_ADDITIONS = {
  addMembers: [{ teamName: 'Planning', agentName: 'Template Planner' }],
  addTeams: ['Dispatch'],
};

function planningTemplates() {
  const manifest = { slug: 'planning', name: 'Planning' };
  const planner = {
    id: BUILDER_PROFILE_ID,
    name: 'Planner',
    provider: { name: 'claude' },
    providerConfigs: [{ name: 'standard', providerName: 'claude' }],
  };
  const claudeSpecialist = {
    id: TARGET_CLAUDE_PROFILE_ID,
    name: 'Specialist',
    familySlug: 'specialist-family',
    provider: { name: 'claude' },
  };
  const codexSpecialist = {
    id: TARGET_CODEX_PROFILE_ID,
    name: 'Specialist (Codex)',
    familySlug: 'specialist-family',
    provider: { name: 'codex' },
    providerConfigs: [{ name: 'codex-specialist', providerName: 'codex' }],
  };
  const planning = {
    name: 'Planning',
    allowTeamLeadCreateAgents: true,
    maxMembers: 8,
    maxConcurrentTasks: 5,
    profileNames: ['Planner'],
    profileSelections: [{ profileName: 'Planner', configNames: ['standard'] }],
  };
  const plannerAgent = (name: string) => ({
    name,
    profileId: planner.id,
    providerConfigName: 'standard',
  });
  const statuses = [{ label: 'Ready', color: '#111111', position: 0 }];
  return {
    source: {
      _manifest: { ...manifest, version: '1.0.0' },
      statuses,
      profiles: [
        planner,
        {
          ...claudeSpecialist,
          providerConfigs: [
            { name: 'fable5', providerName: 'claude', model: 'original-default', effort: 'low' },
          ],
        },
      ],
      agents: [
        { ...plannerAgent('Lead'), description: 'Current planning lead', isProjectOwner: true },
        plannerAgent('Reviewer'),
        {
          name: 'Local Specialist',
          profileId: claudeSpecialist.id,
          providerConfigName: 'fable5',
          modelOverride: 'local-model',
          effortOverride: 'high',
        },
      ],
      teams: [
        {
          ...planning,
          teamLeadAgentName: 'Lead',
          memberAgentNames: ['Lead', 'Reviewer', 'Local Specialist'],
        },
      ],
    },
    target: {
      _manifest: { ...manifest, version: '2.0.0' },
      statuses,
      profiles: [
        planner,
        codexSpecialist,
        {
          ...claudeSpecialist,
          providerConfigs: [
            { name: 'fable', providerName: 'claude', model: 'target-default', effort: 'medium' },
          ],
        },
      ],
      agents: [
        plannerAgent('Reviewer'),
        plannerAgent('Template Planner'),
        plannerAgent('Dispatcher'),
        plannerAgent('Standalone'),
      ],
      teams: [
        {
          ...planning,
          allowTeamLeadCreateAgents: false,
          maxMembers: 3,
          maxConcurrentTasks: 2,
          teamLeadAgentName: 'Template Planner',
          memberAgentNames: ['Template Planner', 'Reviewer'],
        },
        { name: 'Dispatch', teamLeadAgentName: 'Dispatcher', memberAgentNames: ['Dispatcher'] },
      ],
    },
  };
}

async function seedPlanningProject(h: Harness) {
  const { source, target } = planningTemplates();
  await seedConfiguredUpgradeProviders(h);
  const projectId = await freshProject(h, 'Preserved Planning');
  expect(
    await importProjectWithHelper({ projectId, payload: source }, importDeps(h) as never),
  ).toMatchObject({ success: true });
  const worker = await h.storage.getAgentByName(projectId, 'Local Specialist');
  const [status] = (await h.storage.listStatuses(projectId)).items;
  const epic = await h.storage.createEpicForProject(projectId, {
    title: 'Local planning work',
    statusId: status.id,
    agentId: worker.id,
  });
  const timestamp = '2026-01-01T00:00:00.000Z';
  h.sqlite
    .prepare(
      `INSERT INTO sessions (id, agent_id, epic_id, status, started_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('specialist-session', worker.id, epic.id, 'stopped', timestamp, timestamp, timestamp);
  return { projectId, target, worker, epic };
}

function specialistSession(h: Harness) {
  return h.sqlite.prepare('SELECT * FROM sessions WHERE id = ?').get('specialist-session');
}

async function applyPreservation(
  h: Harness,
  operation: 'import' | 'upgrade',
  projectId: string,
  target: Record<string, unknown>,
  controls: Pick<
    Parameters<typeof importProjectWithHelper>[0],
    'preserveTeamSetup' | 'selectedProviderNames' | 'familyProviderMappings'
  >,
) {
  return operation === 'import'
    ? importProjectWithHelper({ projectId, payload: target, ...controls }, importDeps(h) as never)
    : createRealStorageUpgradeService(h, target).service.upgradeProject({
        projectId,
        targetVersion: '2.0.0',
        ...controls,
      });
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
    it('preserves normalized exports through replace and create round-trips', async () => {
      await seedClaudeProvider(h);

      // Seed project A by importing the all-sections fixture through the real path.
      const projectA = await freshProject(h, 'Project A');
      const importA = await importProjectWithHelper(
        {
          projectId: projectA,
          payload: {
            ...allSectionsTemplate(),
            vaultAccess: { mode: 'families', familySlugs: ['claude-family'] },
          },
        },
        importDeps(h) as never,
      );
      expect(importA).toMatchObject({ success: true, mode: 'replace', replaced: true });
      await h.settings.updateProjectPreset(projectA, 'Fast', { name: 'User Fast' });

      const exportA = (await exportProjectWithHelper(projectA, undefined, exportDeps(h))) as AnyRec;
      expect(exportA.vaultAccess).toEqual({ mode: 'families', familySlugs: ['claude-family'] });

      // Import exportA into a fresh project B, then export again.
      const projectB = await freshProject(h, 'Project B');
      const importB = await importProjectWithHelper(
        { projectId: projectB, payload: exportA },
        importDeps(h) as never,
      );
      expect(importB).toMatchObject({ success: true });

      const exportB = (await exportProjectWithHelper(projectB, undefined, exportDeps(h))) as AnyRec;

      const [exportedPreset] = exportA.presets as AnyRec[];
      expect({
        exportedTeamConfigs: exportedPreset.teamConfigs,
        hasExportedOrigin: Object.hasOwn(exportedPreset, 'origin'),
        importedTeamConfigs: h.settings.getProjectPresets(projectB)[0]?.teamConfigs,
      }).toEqual({
        exportedTeamConfigs: presetTeamConfigs,
        hasExportedOrigin: false,
        importedTeamConfigs: presetTeamConfigs,
      });
      expect(normalizeExport(exportB)).toEqual(normalizeExport(exportA));

      const createResult = (await createFromTemplateWithHelper(
        { name: 'Project C', rootPath: '/tmp/project-c', slug: 'roundtrip-all' },
        createDeps(h, exportA) as never,
      )) as AnyRec;
      const exportC = (await exportProjectWithHelper(
        String((createResult.project as AnyRec).id),
        undefined,
        exportDeps(h),
      )) as AnyRec;

      expect(normalizeExport(exportC)).toEqual(normalizeExport(exportA));
    });

    it('preserves a compound subscriber filter through two real import/export cycles', async () => {
      await seedClaudeProvider(h);
      const template = allSectionsTemplate();
      const compoundFilter = {
        combinator: 'or',
        filters: [
          { field: 'agentName', operator: 'equals', value: 'Coder' },
          { field: 'title', operator: 'contains', value: 'urgent' },
        ],
      };
      (template.subscribers as AnyRec[])[0].eventFilter = compoundFilter;

      const projectA = await freshProject(h, 'Compound A');
      await importProjectWithHelper(
        { projectId: projectA, payload: template },
        importDeps(h) as never,
      );
      const exportA = (await exportProjectWithHelper(projectA, undefined, exportDeps(h))) as AnyRec;

      const projectB = await freshProject(h, 'Compound B');
      await importProjectWithHelper(
        { projectId: projectB, payload: exportA },
        importDeps(h) as never,
      );
      const exportB = (await exportProjectWithHelper(projectB, undefined, exportDeps(h))) as AnyRec;

      expect((exportA.subscribers as AnyRec[])[0].eventFilter).toEqual(compoundFilter);
      expect((exportB.subscribers as AnyRec[])[0].eventFilter).toEqual(compoundFilter);
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
      expect(builderAgent).toMatchObject({
        modelOverride: 'sonnet',
        effortOverride: 'medium',
        isProjectOwner: true,
      });
      const reviewerAgent = (exportA.agents as AnyRec[]).find((a) => a.name === 'Reviewer Agent');
      expect(reviewerAgent).not.toHaveProperty('isProjectOwner');

      const builderProfile = (exportA.profiles as AnyRec[]).find((p) => p.name === 'Builder');
      const cfg = (builderProfile?.providerConfigs as AnyRec[])[0];
      expect(cfg).toMatchObject({ name: 'builder-cfg', model: 'opus', effort: 'high' });
      // [position-remediation] explicit providerConfig position survives the replace import path.
      expect(cfg.position).toBe(3);
    });

    it('rejects multiple owners before a replace import mutates existing agents', async () => {
      await seedClaudeProvider(h);
      const projectId = await freshProject(h, 'Owner Validation');
      await importProjectWithHelper(
        { projectId, payload: allSectionsTemplate() },
        importDeps(h) as never,
      );

      const invalidTemplate = allSectionsTemplate();
      for (const agent of invalidTemplate.agents as AnyRec[]) {
        agent.isProjectOwner = true;
      }

      await expect(
        importProjectWithHelper({ projectId, payload: invalidTemplate }, importDeps(h) as never),
      ).rejects.toThrow('At most one agent can be designated as project owner');

      const agents = await h.storage.listAgents(projectId, { limit: 100, offset: 0 });
      expect(agents.items).toHaveLength(2);
      expect(agents.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'Builder Agent', isProjectOwner: true }),
          expect.objectContaining({ name: 'Reviewer Agent', isProjectOwner: false }),
        ]),
      );
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
        maxMembers: 4,
        maxConcurrentTasks: 3,
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
        captureSnapshotEpicAssignments: captureSnapshotAssignments(h),
        exportProject: (id: string, options?: Parameters<typeof exportProjectWithHelper>[1]) =>
          exportProjectWithHelper(id, options, exportDeps(h)),
        importProject: (input: Parameters<typeof importProjectWithHelper>[0]) =>
          importProjectWithHelper(input, importDeps(h) as never),
        setupPreview: jest.fn().mockResolvedValue({}),
      } as unknown as ProjectsService;
      const upgradeService = new ProjectTemplateUpgradeService(
        projectsFacade,
        {
          getOrDownloadTemplate: jest.fn().mockResolvedValue({ content: targetTemplate }),
        } as never,
        {} as never,
        h.settings,
        { getActiveSessionsForProject: jest.fn().mockReturnValue([]) } as never,
        createProjectWriteGateStub() as never,
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

  describe('team order after a template import or upgrade', () => {
    // A fast PC creates a template's teams in one millisecond. Real storage is the cheapest
    // layer that runs the replace import and the upgrade into TeamsStore with that clock.
    afterEach(() => {
      jest.useRealTimers();
    });

    async function expectTemplateTeamOrder(projectId: string): Promise<void> {
      const listed = await h.teamsStore.listTeams(projectId, { limit: 100, offset: 0 });
      expect(listed.items.map((team) => team.name)).toEqual(['Planning', 'Builders']);
      const mobile = await h.teamsStore.listTeamsWithMembers(projectId);
      expect(mobile.map(({ team }) => team.name)).toEqual(['Planning', 'Builders']);
    }

    it('lists teams in template order after an import into an existing project', async () => {
      const { projectId, legacyStatusId } = await seedConfiguredUpgradeSource(
        h,
        'Team Order Import',
        null,
      );
      const { teamOverrides: _teamOverrides, ...controls } =
        configuredUpgradeControls(legacyStatusId);
      freezeDate('2026-10-02T08:00:00.000Z');

      const result = await importProjectWithHelper(
        { projectId, payload: twoTeamUpgradeTargetTemplate(), ...controls },
        importDeps(h) as never,
      );

      expect(result).toMatchObject({ success: true, mode: 'replace' });
      await expectTemplateTeamOrder(projectId);
    });

    it('lists teams in template order after a template upgrade', async () => {
      const { projectId, legacyStatusId } = await seedConfiguredUpgradeSource(
        h,
        'Team Order Upgrade',
        null,
      );
      const { teamOverrides: _teamOverrides, ...controls } =
        configuredUpgradeControls(legacyStatusId);
      const { service } = createRealStorageUpgradeService(h, twoTeamUpgradeTargetTemplate());
      freezeDate('2026-10-02T08:00:00.000Z');

      const result = await service.upgradeProject({
        projectId,
        targetVersion: '2.0.0',
        ...controls,
      });

      expect(result).toMatchObject({ success: true, newVersion: '2.0.0' });
      await expectTemplateTeamOrder(projectId);
    });
  });

  describe('configured template upgrade and recovery', () => {
    it.each([
      {
        phase: 'before epic remapping',
        early: true,
        error: 'Import failed: Injected failure before epic remapping',
      },
      {
        phase: 'after target mutation',
        early: false,
        error: 'Injected failure after target mutation',
      },
    ])(
      'restores the Planning roster and epic assignment after a failed Keep upgrade $phase',
      async ({ early, error }) => {
        const { projectId, target, worker, epic } = await seedPlanningProject(h);
        let failedBeforeRemap = false;
        const { service, getLastUpgradeImportResult } = createRealStorageUpgradeService(h, target, {
          failAfterFirstMutation: !early,
          beforeForwardEpicRemap: early
            ? async () => {
                const forwardWorker = await h.storage.getAgentByName(projectId, worker.name);
                expect(forwardWorker.id).not.toBe(worker.id);
                expect(await h.storage.getEpic(epic.id)).toMatchObject({ agentId: null });
                failedBeforeRemap = true;
                throw new Error('Injected failure before epic remapping');
              }
            : undefined,
        });
        await h.settings.setProjectActivePreset(projectId, 'Original planning preset');
        const before = (await exportProjectWithHelper(
          projectId,
          undefined,
          exportDeps(h),
        )) as AnyRec;

        const result = await service.upgradeProject({
          projectId,
          targetVersion: '2.0.0',
          ...PRESERVATION_CONTROLS,
          preserveTeamSetup: {
            ...PRESERVATION_CONTROLS.preserveTeamSetup,
            ...PRESERVATION_ADDITIONS,
            teamPermissions: [
              { teamName: 'Planning', allowTeamLeadCreateAgents: false, profiles: [] },
            ],
          },
        });

        expect(failedBeforeRemap).toBe(early);
        if (!early)
          expect(getLastUpgradeImportResult()).toMatchObject({
            success: true,
            preservationPlan: {
              teams: expect.arrayContaining([
                expect.objectContaining({
                  name: 'Planning',
                  allowTeamLeadCreateAgents: false,
                  permissions: [],
                  memberAgentNames: expect.arrayContaining(['Template Planner']),
                }),
                expect.objectContaining({ name: 'Dispatch' }),
              ]),
              agents: expect.arrayContaining([
                expect.objectContaining({
                  name: worker.name,
                  option: { configName: 'fable', providerName: 'claude' },
                  model: { value: 'target-default', source: 'template-option' },
                  effort: { value: 'medium', source: 'template-option' },
                }),
              ]),
            },
          });
        expect(result).toEqual({
          success: false,
          error,
          restored: true,
        });
        expect(service.getProjectBackups(projectId)).toEqual([]);
        const { items: teams } = await h.teamsStore.listTeams(projectId);
        expect(teams).toEqual([
          expect.objectContaining({
            name: 'Planning',
            maxMembers: 8,
            maxConcurrentTasks: 5,
            allowTeamLeadCreateAgents: true,
          }),
        ]);
        const restoredWorker = await h.storage.getAgentByName(projectId, worker.name);
        expect(restoredWorker).toMatchObject({
          modelOverride: 'local-model',
          effortOverride: 'high',
        });
        expect(
          await h.storage.getProfileProviderConfig(restoredWorker.providerConfigId),
        ).toMatchObject({
          name: 'fable5',
          model: 'original-default',
          effort: 'low',
        });
        expect(specialistSession(h)).toMatchObject({
          agent_id: restoredWorker.id,
          epic_id: epic.id,
        });
        expect(restoredWorker.id).not.toBe(worker.id);
        expect(await h.storage.getEpic(epic.id)).toMatchObject({ agentId: restoredWorker.id });
        expect(h.settings.getProjectActivePreset(projectId)).toBe('Original planning preset');
        expect(h.settings.getProjectTemplateMetadata(projectId)).toMatchObject({
          installedVersion: '1.0.0',
        });
        const after = (await exportProjectWithHelper(
          projectId,
          undefined,
          exportDeps(h),
        )) as AnyRec;
        expect(normalizeExport(after)).toEqual(normalizeExport(before));
      },
    );

    it('reattaches an epic to its retained worker after deleting the old agent and mapping its status', async () => {
      // SQLite clears the assignment on agent deletion, and status mapping changes the
      // epic version that the subsequent assignment write must use.
      const { projectId, legacyStatusId, epicId } = await seedConfiguredUpgradeSource(
        h,
        'Preserved Epic Assignment',
        null,
      );
      const worker = await h.storage.getAgentByName(projectId, 'Worker');
      await h.teamsStore.createTeam({
        projectId,
        name: 'Planning',
        teamLeadAgentId: worker.id,
        memberAgentIds: [worker.id],
      });
      const result = await importProjectWithHelper(
        {
          projectId,
          preserveTeamSetup: {},
          statusMappings: { [legacyStatusId]: 'Done' },
          payload: {
            ...configuredUpgradeSourceTemplate(),
            agents: [],
            statuses: [{ label: 'Done', color: '#333333', position: 0 }],
          },
        },
        importDeps(h) as never,
      );

      expect(result).toMatchObject({
        success: true,
        counts: { epics: { agentRemapped: 1, agentCleared: 0 } },
      });
      const newWorker = await h.storage.getAgentByName(projectId, 'Worker');
      expect(newWorker.id).not.toBe(worker.id);
      const done = (await h.storage.listStatuses(projectId)).items.find(
        ({ label }) => label === 'Done',
      );
      expect(await h.storage.getEpic(epicId)).toMatchObject({
        agentId: newWorker.id,
        statusId: done!.id,
      });
    });

    it('applies explicit provider, preset, team, and status selections while preserving established data', async () => {
      const { projectId, legacyStatusId, epicId } = await seedConfiguredUpgradeSource(
        h,
        'Configured Upgrade Success',
        'Current Preset',
      );
      const controls = configuredUpgradeControls(legacyStatusId);
      const statusesBefore = await h.storage.listStatuses(projectId, { limit: 100, offset: 0 });
      const readyBefore = statusesBefore.items.find((status) => status.label === 'Ready')!;
      const unusedBefore = statusesBefore.items.find((status) => status.label === 'Unused')!;

      const dryRun = (await importProjectWithHelper(
        {
          projectId,
          payload: configuredUpgradeTargetTemplate(),
          dryRun: true,
          ...controls,
        },
        importDeps(h) as never,
      )) as AnyRec & { counts: { toDelete: { statuses: number } } };
      expect(dryRun).toMatchObject({
        dryRun: true,
        readiness: { ready: true, issues: [] },
        unmatchedStatuses: [expect.objectContaining({ id: legacyStatusId, epicCount: 1 })],
        counts: { toDelete: { statuses: 1 } },
      });

      const targetTemplate = configuredUpgradeTargetTemplate();
      const { service, getLastUpgradeImportResult } = createRealStorageUpgradeService(
        h,
        targetTemplate,
      );
      const result = await service.upgradeProject({
        projectId,
        targetVersion: '2.0.0',
        ...controls,
      });

      expect(result).toEqual({
        success: true,
        newVersion: '2.0.0',
        promptTransfer: { imported: 1, deleted: 1, preserved: 1, skipped: 0 },
      });
      expect(getLastUpgradeImportResult()).toMatchObject({
        success: true,
        counts: { deleted: { statuses: dryRun.counts.toDelete.statuses } },
      });

      const profiles = await h.storage.listAgentProfiles({ projectId, limit: 100, offset: 0 });
      expect(profiles.items).toEqual([
        expect.objectContaining({ name: 'Codex Target', familySlug: 'worker-family' }),
      ]);
      const codexProfile = profiles.items[0];
      const configs = await h.storage.listProfileProviderConfigsByProfile(codexProfile.id);
      expect(configs).toEqual([
        expect.objectContaining({ name: 'codex-target', providerName: 'codex' }),
      ]);
      const agents = await h.storage.listAgents(projectId, { limit: 100, offset: 0 });
      expect(agents.items).toEqual([
        expect.objectContaining({
          name: 'Worker',
          profileId: codexProfile.id,
          providerConfigId: configs[0].id,
          modelOverride: 'gpt-target',
          effortOverride: 'high',
        }),
      ]);
      expect(h.settings.getProjectActivePreset(projectId)).toBe('Target Preset');

      const teams = await h.teamsStore.listTeams(projectId, { limit: 100, offset: 0 });
      expect(teams.items).toEqual([
        expect.objectContaining({
          name: 'Target Squad',
          allowTeamLeadCreateAgents: false,
          maxMembers: 3,
          maxConcurrentTasks: 1,
        }),
      ]);
      const team = await h.teamsStore.getTeam(teams.items[0].id);
      expect(team).toMatchObject({
        profileIds: [codexProfile.id],
        profileConfigSelections: [{ profileId: codexProfile.id, configIds: [configs[0].id] }],
      });

      const statusesAfter = await h.storage.listStatuses(projectId, { limit: 100, offset: 0 });
      expect(statusesAfter.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: readyBefore.id, label: 'Ready', color: '#abcdef' }),
          expect.objectContaining({ id: unusedBefore.id, label: 'Unused' }),
          expect.objectContaining({ label: 'Done' }),
        ]),
      );
      expect(statusesAfter.items.map((status) => status.label)).not.toContain('Legacy');
      const doneStatus = statusesAfter.items.find((status) => status.label === 'Done')!;
      const epicAfter = await h.storage.getEpic(epicId);
      expect(epicAfter).toMatchObject({
        id: epicId,
        title: 'Established Epic',
        description: 'must survive replacement',
        statusId: doneStatus.id,
      });
      const prompts = await h.storage.listPrompts({ projectId, limit: 100, offset: 0 });
      expect(prompts.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ title: 'Target System', tags: ['type:system'] }),
          expect.objectContaining({
            title: 'Local Knowledge',
            contentPreview: 'preserve this established custom prompt',
            tags: expect.arrayContaining(['type:custom', 'local']),
          }),
        ]),
      );
    });

    it.each([
      ['a non-null active preset', 'Current Preset'],
      ['a null active preset', null],
    ])(
      'restores raw profile secrets and %s after a post-mutation failure',
      async (_caseName, activePreset) => {
        const { projectId, legacyStatusId } = await seedConfiguredUpgradeSource(
          h,
          `Configured Recovery ${activePreset ?? 'Null'}`,
          activePreset,
        );
        const savedPresets = [
          ...h.settings.getProjectPresets(projectId),
          {
            name: 'Target Preset',
            origin: 'user' as const,
            agentConfigs: [{ agentName: 'Worker', providerConfigName: 'claude-current' }],
          },
        ];
        await h.settings.setProjectPresets(projectId, savedPresets);
        const targetTemplate = configuredUpgradeTargetTemplate();
        targetTemplate.statuses = [
          { label: 'Ready', color: '#aaaaaa', position: 0 },
          { label: 'Legacy', color: '#bbbbbb', position: 1 },
          { label: 'Unused', color: '#cccccc', position: 2 },
        ];
        targetTemplate.vaultAccess = { mode: 'all' };
        await h.storage.setVaultFamilyAccess(projectId, {
          mode: 'families',
          familySlugs: ['worker-family'],
        });
        const { statusMappings: _statusMappings, ...controls } =
          configuredUpgradeControls(legacyStatusId);
        const { service } = createRealStorageUpgradeService(h, targetTemplate, {
          failAfterFirstMutation: true,
        });

        const publicBefore = (await exportProjectWithHelper(
          projectId,
          undefined,
          exportDeps(h),
        )) as AnyRec;
        expect(
          (((publicBefore.profiles as AnyRec[])[0].providerConfigs as AnyRec[])[0].env as AnyRec)
            .API_KEY,
        ).toBe('***');

        const result = await service.upgradeProject({
          projectId,
          targetVersion: '2.0.0',
          ...controls,
        });

        expect(result).toEqual({
          success: false,
          error: 'Injected failure after target mutation',
          restored: true,
        });
        expect(service.getProjectBackups(projectId)).toEqual([]);
        const restoredProfiles = await h.storage.listAgentProfiles({
          projectId,
          limit: 100,
          offset: 0,
        });
        expect(restoredProfiles.items).toEqual([
          expect.objectContaining({ name: 'Current Worker' }),
        ]);
        const restoredConfigs = await h.storage.listProfileProviderConfigsByProfile(
          restoredProfiles.items[0].id,
        );
        expect(restoredConfigs).toEqual([
          expect.objectContaining({
            name: 'claude-current',
            env: { API_KEY: 'profile-secret-verbatim', LOG_LEVEL: 'debug' },
          }),
        ]);
        expect(h.settings.getProjectActivePreset(projectId)).toBe(activePreset);
        expect(h.settings.getProjectPresets(projectId)).toEqual(savedPresets);
        expect(await h.storage.listVaultFamilyAccess({ projectId })).toEqual([
          expect.objectContaining({ familySlug: 'worker-family' }),
        ]);

        const publicAfter = (await exportProjectWithHelper(
          projectId,
          undefined,
          exportDeps(h),
        )) as AnyRec;
        expect(
          (((publicAfter.profiles as AnyRec[])[0].providerConfigs as AnyRec[])[0].env as AnyRec)
            .API_KEY,
        ).toBe('***');
      },
    );

    it('returns a non-mutating race outcome and discards the backup when a session starts during backup', async () => {
      const { projectId, legacyStatusId } = await seedConfiguredUpgradeSource(
        h,
        'Configured Upgrade Session Race',
        'Current Preset',
      );
      const before = (await exportProjectWithHelper(projectId, undefined, exportDeps(h))) as AnyRec;
      let sessionChecks = 0;
      const sessions = {
        getActiveSessionsForProject: () => {
          sessionChecks++;
          return sessionChecks === 1 ? [] : [{ id: 'late-session', agentId: 'late-agent' }];
        },
      };
      const { service } = createRealStorageUpgradeService(h, configuredUpgradeTargetTemplate(), {
        sessions,
      });

      const result = await service.upgradeProject({
        projectId,
        targetVersion: '2.0.0',
        ...configuredUpgradeControls(legacyStatusId),
      });

      expect(result).toEqual({
        success: false,
        mutationStarted: false,
        error: 'Import aborted: active agent sessions detected',
        readiness: {
          ready: false,
          issues: [
            {
              code: 'active_sessions',
              message: 'Import aborted: active agent sessions detected',
              details: {
                activeSessions: [{ id: 'late-session', agentId: 'late-agent' }],
              },
            },
          ],
        },
      });
      expect(sessionChecks).toBe(2);
      expect(service.getProjectBackups(projectId)).toEqual([]);
      expect(result).not.toHaveProperty('backupId');
      expect(result).not.toHaveProperty('restored');
      const after = (await exportProjectWithHelper(projectId, undefined, exportDeps(h))) as AnyRec;
      expect(normalizeExport(after)).toEqual(normalizeExport(before));
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
        captureSnapshotEpicAssignments: captureSnapshotAssignments(h),
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
        { getActiveSessionsForProject: jest.fn().mockReturnValue([]) } as never,
        createProjectWriteGateStub() as never,
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

    it('backup restore retains the project owner designation', async () => {
      await seedClaudeProvider(h);
      const projectId = await freshProject(h, 'Snapshot Owner');
      const allSections = allSectionsTemplate();
      const ownerTemplate = {
        version: 1,
        profiles: allSections.profiles,
        agents: allSections.agents,
        statuses: [],
      };
      await h.settings.setProjectTemplateMetadata(projectId, {
        templateSlug: 'snapshot-owner',
        source: 'bundled',
        installedVersion: '1.0.0',
        registryUrl: null,
        installedAt: new Date().toISOString(),
      });
      await importProjectWithHelper({ projectId, payload: ownerTemplate }, importDeps(h) as never);

      const projectsFacade = {
        captureSnapshotEpicAssignments: captureSnapshotAssignments(h),
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
        { getActiveSessionsForProject: jest.fn().mockReturnValue([]) } as never,
        createProjectWriteGateStub() as never,
      );

      const backupId = await upgradeService.createBackup(projectId);
      const before = await h.storage.listAgents(projectId, { limit: 100, offset: 0 });
      const owner = before.items.find((agent) => agent.isProjectOwner);
      expect(owner?.name).toBe('Builder Agent');
      await h.storage.updateAgent(owner!.id, { isProjectOwner: false });

      await upgradeService.restoreBackup(backupId);

      const restored = await h.storage.listAgents(projectId, { limit: 100, offset: 0 });
      expect(restored.items.filter((agent) => agent.isProjectOwner)).toEqual([
        expect.objectContaining({ name: 'Builder Agent' }),
      ]);
    });
  });

  describe('env secret redaction discipline', () => {
    it('redacts config-level secrets on export and never exports provider-level env', async () => {
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
      h.sqlite
        .prepare(
          `INSERT INTO vault_entries
             (id, project_id, name, kind, description, value_ciphertext, created_at, updated_at)
           VALUES ('vault-1', ?, 'VAULT_CANARY_NAME', 'secret', 'd', 'vault-canary-ciphertext', 'T', 'T')`,
        )
        .run(projectA);
      h.sqlite
        .prepare(
          `INSERT INTO vault_family_access (id, project_id, family_slug, created_at)
           VALUES ('vault-access-1', ?, 'vault-access-canary', 'T'),
                  ('vault-access-2', ?, 'claude-family', 'T')`,
        )
        .run(projectA, projectA);
      h.sqlite
        .prepare(
          `INSERT INTO vault_use_family_approvals
             (id, entry_id, project_id, family_slug, created_at)
           VALUES ('vault-approval-1', 'vault-1', ?, 'vault-approval-canary', 'T')`,
        )
        .run(projectA);
      const exportA = (await exportProjectWithHelper(projectA, undefined, exportDeps(h))) as AnyRec;
      // Vault entries and approvals never travel in a template or export, not even redacted.
      expect(JSON.stringify(exportA)).not.toMatch(
        /VAULT_CANARY_NAME|vault-canary-ciphertext|vault-approval-canary/,
      );
      // Access rides only for families a current profile has.
      expect(exportA.vaultAccess).toEqual({ mode: 'families', familySlugs: ['claude-family'] });
      expect(JSON.stringify(exportA)).not.toContain('vault-access-canary');

      const cfg = ((exportA.profiles as AnyRec[])[0].providerConfigs as AnyRec[])[0];
      // Config-level: non-secret preserved, secret redacted to '***'.
      expect((cfg.env as AnyRec).LOG_LEVEL).toBe('debug');
      expect((cfg.env as AnyRec).API_KEY).toBe('***');

      // Provider-level env never exports, secret or not (it is machine-local).
      for (const row of (exportA.providerSettings as AnyRec[]) ?? []) {
        expect(row).not.toHaveProperty('env');
      }
      expect(JSON.stringify(exportA)).not.toMatch(/PUBLIC_FLAG|GITHUB_TOKEN/);
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
      expect(legacyAgent).not.toHaveProperty('isProjectOwner');
      expect(legacyAgent).toMatchObject({ modelOverride: null });
      const storedAgents = await h.storage.listAgents(projectA, { limit: 100, offset: 0 });
      expect(storedAgents.items.some((agent) => agent.isProjectOwner)).toBe(false);
      // Legacy import defaults optional collections to empty, not absent-error.
      expect(exportA.providerModels).toEqual([]);
      expect(exportA.providerEfforts).toEqual([]);
    });
  });

  describe('vaultAccess import', () => {
    function vaultTemplate(vaultAccess?: AnyRec): Record<string, unknown> {
      const template = legacyV1Template();
      const [profile] = template.profiles as AnyRec[];
      return {
        ...template,
        profiles: [{ ...profile, familySlug: 'Legacy-Family' }],
        ...(vaultAccess && { vaultAccess }),
      };
    }

    const accessOf = async (projectId: string) =>
      (await h.storage.listVaultFamilyAccess({ projectId })).map((row) => row.familySlug).sort();

    it('create-from-template applies the field; without it the Vault stays off', async () => {
      await seedClaudeProvider(h);
      const create = async (name: string, template: Record<string, unknown>) => {
        const result = (await createFromTemplateWithHelper(
          { name, rootPath: `/tmp/${slugify(name)}`, slug: 'legacy-v1' },
          createDeps(h, template) as never,
        )) as AnyRec;
        return String((result.project as AnyRec).id);
      };

      const withField = await create(
        'Vault On',
        vaultTemplate({ mode: 'families', familySlugs: ['legacy-family', 'ghost'] }),
      );
      const withoutField = await create('Vault Off', vaultTemplate());

      expect(await accessOf(withField)).toEqual(['legacy-family']);
      expect(await accessOf(withoutField)).toEqual([]);
    });

    it('replace-import replaces access exactly; without the field access is untouched', async () => {
      await seedClaudeProvider(h);
      const projectId = await freshProject(h, 'Vault Replace');
      await h.storage.setVaultFamilyAccess(projectId, { mode: 'all' });

      await importProjectWithHelper(
        {
          projectId,
          payload: vaultTemplate({ mode: 'families', familySlugs: ['legacy-family'] }),
        },
        importDeps(h) as never,
      );
      expect(await accessOf(projectId)).toEqual(['legacy-family']);

      await importProjectWithHelper(
        { projectId, payload: vaultTemplate() },
        importDeps(h) as never,
      );
      expect(await accessOf(projectId)).toEqual(['legacy-family']);
    });
  });

  describe('replace import preset application', () => {
    it('applies the freshly stored preset when the team override sets only a limit', async () => {
      await seedClaudeProvider(h);
      const projectId = await freshProject(h, 'Preset Replace');

      const result = await importProjectWithHelper(
        {
          projectId,
          payload: templateWithTeamClearingPreset(),
          presetName: 'Fast',
          teamOverrides: [{ teamName: 'Core Team', maxMembers: 6 }],
        },
        importDeps(h) as never,
      );

      expect(result).toMatchObject({ success: true, mode: 'replace' });
      expect(h.settings.getProjectActivePreset(projectId)).toBe('Fast');
      const agents = await h.storage.listAgents(projectId, { limit: 100, offset: 0 });
      expect(agents.items.find((agent) => agent.name === 'Builder Agent')).toMatchObject({
        modelOverride: 'opus',
        effortOverride: 'high',
      });
      const [team] = (await h.teamsStore.listTeams(projectId)).items;
      expect(await h.teamsStore.getTeam(team.id)).toMatchObject({
        maxMembers: 6,
        profileConfigSelections: [],
      });
    });

    it('keeps team selections and clears the active preset during a Keep import', async () => {
      await seedClaudeProvider(h);
      const projectId = await freshProject(h, 'Keep Preset Replace');
      const payload = templateWithTeamClearingPreset();
      const deps = importDeps(h);

      expect(await importProjectWithHelper({ projectId, payload }, deps as never)).toMatchObject({
        success: true,
      });
      await h.settings.setProjectActivePreset(projectId, 'Fast');

      expect(
        await importProjectWithHelper({ projectId, payload, preserveTeamSetup: {} }, deps as never),
      ).toMatchObject({
        success: true,
        preservationPlan: expect.any(Object),
      });
      const [team] = (await h.teamsStore.listTeams(projectId)).items;
      const [profile] = (await h.storage.listAgentProfiles({ projectId })).items;
      const [config] = await h.storage.listProfileProviderConfigsByProfile(profile.id);
      expect((await h.teamsStore.getTeam(team.id))?.profileConfigSelections).toEqual([
        { profileId: profile.id, configIds: [config.id] },
      ]);
      expect(h.settings.getProjectActivePreset(projectId)).toBeNull();
    });
  });

  // The create and import contracts are observable after a failed preset team write.
  it.each(['create', 'import'] as const)(
    '%s completes when a preset team write fails',
    async (operation) => {
      await seedClaudeProvider(h);
      const payload = templateWithTeamClearingPreset();
      const update = jest
        .spyOn(h.teamsStore, 'updateTeam')
        .mockRejectedValueOnce(new Error('Preset team write failed'));
      let projectId: string;

      if (operation === 'create') {
        const result = await createFromTemplateWithHelper(
          {
            name: 'Preset Create Failure',
            rootPath: '/tmp/preset-create-failure',
            slug: 'roundtrip-all',
            presetName: 'Fast',
          },
          createDeps(h, payload) as never,
        );
        expect(result).toMatchObject({ success: true, project: { id: expect.any(String) } });
        projectId = String(((result as AnyRec).project as AnyRec).id);
      } else {
        projectId = await freshProject(h, 'Preset Import Failure');
        expect(
          await importProjectWithHelper(
            { projectId, payload, presetName: 'Fast' },
            importDeps(h) as never,
          ),
        ).toMatchObject({ success: true });
      }

      expect(update).toHaveBeenCalledTimes(1);
      expect(h.settings.getProjectActivePreset(projectId)).toBeNull();
    },
  );

  it('skips unavailable profile variants of an excluded optional team during a Keep upgrade', async () => {
    const { projectId, target, worker, epic } = await seedPlanningProject(h);
    const optionalId = '99999999-0000-4000-8000-000000000001';
    const payload = {
      ...target,
      profiles: [
        ...target.profiles,
        {
          id: optionalId,
          name: 'Optional OpenCode',
          familySlug: 'optional',
          provider: { name: 'opencode' },
        },
        {
          id: '99999999-0000-4000-8000-000000000002',
          name: 'Optional Gemini',
          familySlug: 'optional',
          provider: { name: 'gemini' },
        },
      ],
      agents: [...target.agents, { name: 'Optional Worker', profileId: optionalId }],
      teams: [...target.teams, { name: 'Optional Team', memberAgentNames: ['Optional Worker'] }],
    };
    const preview = await importProjectWithHelper(
      { projectId, payload, dryRun: true, ...PRESERVATION_CONTROLS },
      importDeps(h) as never,
    );
    expect(preview).toMatchObject({
      readiness: { ready: true, issues: [] },
      counts: { toImport: { profiles: 2, teams: 1 } },
      preservationPlan: {
        additions: {
          teams: expect.arrayContaining([
            expect.objectContaining({ name: 'Optional Team', selected: false }),
          ]),
        },
      },
    });
    expect(specialistSession(h)).toMatchObject({ agent_id: worker.id });

    const { service, getLastUpgradeImportResult } = createRealStorageUpgradeService(h, payload);
    expect(
      await service.upgradeProject({ projectId, targetVersion: '2.0.0', ...PRESERVATION_CONTROLS }),
    ).toMatchObject({
      success: true,
      newVersion: '2.0.0',
      preservationPlan: preview.preservationPlan,
    });
    expect(getLastUpgradeImportResult()).toMatchObject({
      counts: { imported: { profiles: 2, teams: 1 } },
    });
    expect(
      (await h.storage.listAgentProfiles({ projectId })).items.map(({ name }) => name).sort(),
    ).toEqual(['Planner', 'Specialist']);

    const teamList = (await h.teamsStore.listTeams(projectId)).items;
    expect(teamList).toHaveLength(1);
    expect(teamList[0]).toMatchObject({ name: 'Planning', memberCount: 3 });
    const roster = (await h.teamsStore.getTeam(teamList[0].id))!;
    const memberNames = await Promise.all(
      roster.members.map(async ({ agentId }) => (await h.storage.getAgent(agentId)).name),
    );
    expect(memberNames.sort()).toEqual(['Lead', 'Local Specialist', 'Reviewer']);
    const retained = await h.storage.getAgentByName(projectId, worker.name);
    expect(retained.id).not.toBe(worker.id);
    expect(specialistSession(h)).toMatchObject({ agent_id: retained.id, epic_id: epic.id });
    expect(await h.storage.getEpic(epic.id)).toMatchObject({ agentId: retained.id });
  });

  // Real storage verifies that the chosen family variant binds the retained agent on import.
  it('selects an available family provider when Keep has no explicit mapping', async () => {
    const { projectId, target, worker } = await seedPlanningProject(h);
    const controls = {
      selectedProviderNames: ['claude'],
      preserveTeamSetup: PRESERVATION_CONTROLS.preserveTeamSetup,
    };
    const input = { projectId, payload: target, ...controls };
    const preview = await importProjectWithHelper(
      { ...input, dryRun: true },
      importDeps(h) as never,
    );
    expect(preview).toMatchObject({
      readiness: { ready: true, issues: [] },
      preservationPlan: {
        familyAlternatives: expect.arrayContaining([
          expect.objectContaining({
            familySlug: 'specialist-family',
            defaultProvider: 'codex',
            defaultProviderAvailable: false,
            availableProviders: ['claude'],
          }),
        ]),
      },
    });

    expect(await importProjectWithHelper(input, importDeps(h) as never)).toMatchObject({
      success: true,
      preservationPlan: preview.preservationPlan,
    });
    const retained = await h.storage.getAgentByName(projectId, worker.name);
    const option = await h.storage.getProfileProviderConfig(retained.providerConfigId);
    expect(await h.storage.getProvider(option.providerId)).toMatchObject({ name: 'claude' });
  });

  // The seeded roster makes family availability come from the same dependencies as a Keep precheck.
  it.each([
    {
      label: 'a mapping points to a deselected provider',
      specialistProvider: 'claude',
      familyProviderMappings: { 'specialist-family': 'codex' },
      canImport: true,
    },
    {
      label: 'a family has no selected provider',
      specialistProvider: 'codex',
      familyProviderMappings: undefined,
      canImport: false,
    },
  ])(
    'blocks Keep precheck when $label',
    async ({ specialistProvider, familyProviderMappings, canImport }) => {
      const { projectId, target } = await seedPlanningProject(h);
      const specialist = target.profiles.find(({ id }) => id === TARGET_CLAUDE_PROFILE_ID)!;
      specialist.provider = { name: specialistProvider };
      specialist.providerConfigs[0].providerName = specialistProvider;
      const preview = await importProjectWithHelper(
        {
          projectId,
          payload: target,
          dryRun: true,
          preserveTeamSetup: PRESERVATION_CONTROLS.preserveTeamSetup,
          selectedProviderNames: ['claude'],
          familyProviderMappings,
        },
        importDeps(h) as never,
      );
      expect(preview).toMatchObject({
        readiness: {
          ready: false,
          issues: expect.arrayContaining([
            expect.objectContaining({ code: 'provider_mapping_required' }),
          ]),
        },
        providerMappingRequired: { canImport },
      });
    },
  );

  describe.each(['import', 'upgrade'] as const)('keep current setup through %s', (operation) => {
    it.each([
      { label: 'skips both additions', addTeam: false, addMember: false },
      { label: 'adds only the proposed member', addTeam: false, addMember: true },
      { label: 'adds only the proposed team', addTeam: true, addMember: false },
      { label: 'adds both the proposed member and team', addTeam: true, addMember: true },
    ])('$label while retaining Planning', async ({ addTeam, addMember }) => {
      const { projectId, target, worker, epic } = await seedPlanningProject(h);
      const controls = {
        ...PRESERVATION_CONTROLS,
        preserveTeamSetup: {
          ...PRESERVATION_CONTROLS.preserveTeamSetup,
          addTeams: addTeam ? PRESERVATION_ADDITIONS.addTeams : [],
          addMembers: addMember ? PRESERVATION_ADDITIONS.addMembers : [],
        },
      };

      const preview = await importProjectWithHelper(
        { projectId, payload: target, dryRun: true, ...controls },
        importDeps(h) as never,
      );
      const memberAgentNames = ['Lead', 'Reviewer', 'Local Specialist'];
      if (addMember) memberAgentNames.push('Template Planner');
      expect(preview).toMatchObject({
        readiness: { ready: true, issues: [] },
        preservationPlan: {
          teams: [
            expect.objectContaining({
              name: 'Planning',
              memberAgentNames: expect.arrayContaining(memberAgentNames),
            }),
            ...(addTeam ? [expect.objectContaining({ name: 'Dispatch' })] : []),
          ],
          agents: expect.arrayContaining([
            expect.objectContaining({
              name: worker.name,
              status: 'changed',
              currentOption: { configName: 'fable5', providerName: 'claude' },
              option: { configName: 'fable', providerName: 'claude' },
            }),
          ]),
        },
      });

      expect(await applyPreservation(h, operation, projectId, target, controls)).toMatchObject({
        success: true,
        preservationPlan: preview.preservationPlan,
      });
      const { items: agents } = await h.storage.listAgents(projectId);
      expect(agents.map(({ name }) => name).sort()).toEqual(
        [...memberAgentNames, 'Standalone', ...(addTeam ? ['Dispatcher'] : [])].sort(),
      );
      expect(await h.storage.getAgentByName(projectId, 'Lead')).toMatchObject({
        description: 'Current planning lead',
        isProjectOwner: true,
      });
      const retainedWorker = await h.storage.getAgentByName(projectId, worker.name);
      expect(retainedWorker.id).not.toBe(worker.id);
      expect(retainedWorker).toMatchObject({ modelOverride: null, effortOverride: null });
      expect(specialistSession(h)).toMatchObject({ agent_id: retainedWorker.id, epic_id: epic.id });
      expect(await h.storage.getEpic(epic.id)).toMatchObject({ agentId: retainedWorker.id });

      const exported = (await exportProjectWithHelper(
        projectId,
        undefined,
        exportDeps(h),
      )) as AnyRec;
      expect(exported.teams).toEqual([
        expect.objectContaining({
          name: 'Planning',
          teamLeadAgentName: 'Lead',
          memberAgentNames: expect.arrayContaining(memberAgentNames),
          maxMembers: 8,
          maxConcurrentTasks: 5,
          allowTeamLeadCreateAgents: true,
          profileSelections: [{ profileName: 'Planner', configNames: ['standard'] }],
        }),
        ...(addTeam
          ? [
              expect.objectContaining({
                name: 'Dispatch',
                teamLeadAgentName: 'Dispatcher',
                memberAgentNames: ['Dispatcher'],
              }),
            ]
          : []),
      ]);
      const [planning, dispatch] = exported.teams as AnyRec[];
      expect(planning.memberAgentNames).toHaveLength(memberAgentNames.length);
      if (dispatch) {
        expect(dispatch).not.toHaveProperty('maxMembers');
        expect(dispatch).not.toHaveProperty('maxConcurrentTasks');
      }
      expect(exported.profiles).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: retainedWorker.profileId,
            name: 'Specialist',
            providerConfigs: [
              expect.objectContaining({
                name: 'fable',
                providerName: 'claude',
                model: 'target-default',
                effort: 'medium',
              }),
            ],
          }),
        ]),
      );
      expect(
        await h.storage.getProfileProviderConfig(retainedWorker.providerConfigId),
      ).toMatchObject({ name: 'fable' });
    });

    // The stored binding proves both commit entry points apply the precheck plan.
    it.each([
      { label: 'a renamed option', configName: 'fable', providerName: 'claude' },
      {
        label: 'the same option with a different provider',
        configName: 'fable5',
        providerName: 'codex',
      },
    ])('applies the planned replacement for $label', async ({ configName, providerName }) => {
      const { projectId, target, worker } = await seedPlanningProject(h);
      const controls = { ...PRESERVATION_CONTROLS, preserveTeamSetup: {} };
      const profile = target.profiles.find(({ id }) => id === TARGET_CLAUDE_PROFILE_ID)!;
      profile.providerConfigs[0] = {
        ...profile.providerConfigs[0],
        name: configName,
        providerName,
      };
      target.agents.push({
        name: worker.name,
        profileId: profile.id,
        providerConfigName: configName,
      });
      const preview = await importProjectWithHelper(
        { projectId, payload: target, dryRun: true, ...controls },
        importDeps(h) as never,
      );
      expect(preview).toMatchObject({
        readiness: { ready: true, issues: [] },
        preservationPlan: {
          agents: expect.arrayContaining([
            expect.objectContaining({
              name: worker.name,
              status: 'changed',
              reason: 'option_changed',
              currentOption: { configName: 'fable5', providerName: 'claude' },
              option: { configName, providerName },
            }),
          ]),
        },
      });

      expect(await applyPreservation(h, operation, projectId, target, controls)).toMatchObject({
        success: true,
        preservationPlan: preview.preservationPlan,
      });
      const resolved = await h.storage.getAgentByName(projectId, worker.name);
      const option = await h.storage.getProfileProviderConfig(resolved.providerConfigId);
      expect(option.name).toBe(configName);
      expect(await h.storage.getProvider(option.providerId)).toMatchObject({ name: providerName });
      expect(resolved).toMatchObject({ modelOverride: null, effortOverride: null });
    });

    it('reports an unresolved excluded dependency without mutating the original project', async () => {
      const { projectId, target, worker, epic } = await seedPlanningProject(h);
      const payload = {
        ...target,
        scheduledEpics: [
          {
            name: 'Dispatch schedule',
            enabled: true,
            cronExpression: '0 9 * * *',
            timezone: 'UTC',
            titleTemplate: 'Dispatch',
            templateAgentName: 'Dispatcher',
          },
        ],
      };
      const issue = {
        code: 'preserve_agent_reference',
        details: {
          agentName: 'Dispatcher',
          section: 'scheduledEpics',
          name: 'Dispatch schedule',
        },
      };
      const before = (await exportProjectWithHelper(projectId, undefined, exportDeps(h))) as AnyRec;
      const sessionBefore = specialistSession(h);
      const preview = await importProjectWithHelper(
        { projectId, payload, dryRun: true, ...PRESERVATION_CONTROLS },
        importDeps(h) as never,
      );
      const readiness = {
        ready: false,
        issues: expect.arrayContaining([expect.objectContaining(issue)]),
      };
      expect(preview).toMatchObject({ readiness });

      expect(
        await applyPreservation(h, operation, projectId, payload, PRESERVATION_CONTROLS),
      ).toMatchObject({
        success: false,
        mutationStarted: false,
        readiness,
      });
      expect(await exportProjectWithHelper(projectId, undefined, exportDeps(h))).toEqual({
        ...before,
        exportedAt: expect.any(String),
        _manifest: { ...(before._manifest as AnyRec), publishedAt: expect.any(String) },
      });
      expect(await h.storage.getAgentByName(projectId, worker.name)).toEqual(worker);
      expect(await h.storage.getEpic(epic.id)).toEqual(epic);
      expect(specialistSession(h)).toEqual(sessionBefore);
    });

    type FieldPair = readonly [model?: string | null, effort?: string | null];

    it.each<{
      label: string;
      current?: FieldPair;
      currentDefault?: FieldPair;
      incoming?: FieldPair;
      incomingDefault?: FieldPair;
      incomingOption?: string;
      selectedOption?: string;
      differentIncomingProfile?: boolean;
      overrides: FieldPair;
      effective: FieldPair;
    }>([
      {
        label: 'stores the template model and inherits the option effort',
        current: ['old-model', 'high'],
        incoming: ['agent-model'],
        incomingDefault: ['option-model', 'medium'],
        overrides: ['agent-model', null],
        effective: ['agent-model', 'medium'],
      },
      {
        label: 'inherits the option model and stores the template effort',
        current: ['old-model', 'high'],
        incoming: [null, 'low'],
        incomingDefault: ['option-model', 'medium'],
        overrides: [null, 'low'],
        effective: ['option-model', 'low'],
      },
      {
        label: 'stores both template overrides even when they equal the option defaults',
        incoming: ['option-model', 'medium'],
        incomingDefault: ['option-model', 'medium'],
        overrides: ['option-model', 'medium'],
        effective: ['option-model', 'medium'],
      },
      {
        label: 'keeps both current overrides when incoming values are blank',
        current: ['old-model', 'high'],
        currentDefault: ['old-default', 'low'],
        incoming: ['', ' '],
        incomingDefault: [' ', ''],
        overrides: ['old-model', 'high'],
        effective: ['old-model', 'high'],
      },
      {
        label: 'stores the inherited current values when incoming values are missing or null',
        current: [' ', null],
        currentDefault: ['old-default', 'high'],
        incoming: [null],
        incomingDefault: [null],
        overrides: ['old-default', 'high'],
        effective: ['old-default', 'high'],
      },
      {
        label: 'uses the newly selected option default and leaves its empty field unset',
        current: ['old-model', 'high'],
        incoming: ['inapplicable-model', 'low'],
        incomingDefault: ['new-default', null],
        selectedOption: 'replacement',
        overrides: [null, null],
        effective: ['new-default', null],
      },
      {
        label: 'uses a template agent override bound to the newly selected option',
        current: ['old-model', 'high'],
        incoming: ['new-agent-model', null],
        incomingDefault: ['new-default', 'medium'],
        incomingOption: 'replacement',
        selectedOption: 'replacement',
        overrides: ['new-agent-model', null],
        effective: ['new-agent-model', 'medium'],
      },
      {
        label: 'ignores same-name agent overrides from a different profile',
        differentIncomingProfile: true,
        incoming: ['other-model', 'high'],
        incomingDefault: ['option-model', 'medium'],
        overrides: [null, null],
        effective: ['option-model', 'medium'],
      },
      {
        label: 'leaves both fields unset when both sides are empty',
        current: [null, ''],
        currentDefault: ['', null],
        incomingDefault: [' '],
        overrides: [null, null],
        effective: [null, null],
      },
    ])(
      '$label',
      async ({
        current = [],
        currentDefault = [],
        incoming = [],
        incomingDefault = [],
        incomingOption = 'chosen',
        selectedOption = 'chosen',
        differentIncomingProfile,
        overrides,
        effective,
      }) => {
        await seedClaudeProvider(h);
        const projectId = await freshProject(h, `Keep Setup ${operation}`);
        const config = (name: string, [model, effort]: FieldPair) => ({
          name,
          providerName: 'claude',
          model,
          effort,
        });
        const agent = (
          providerConfigName: string,
          [modelOverride, effortOverride]: FieldPair,
          profileId = BUILDER_PROFILE_ID,
        ) => ({ name: 'Worker', profileId, providerConfigName, modelOverride, effortOverride });
        const profile = {
          id: BUILDER_PROFILE_ID,
          name: 'Builder',
          provider: { name: 'claude' },
        };
        const manifest = { slug: 'configured-upgrade', name: 'Configured Upgrade' };
        const chosen = config('chosen', selectedOption === 'chosen' ? incomingDefault : []);
        const target = {
          _manifest: { ...manifest, version: '2.0.0' },
          profiles: [
            {
              ...profile,
              providerConfigs:
                selectedOption === 'chosen'
                  ? [chosen]
                  : [chosen, config(selectedOption, incomingDefault)],
            },
            ...(differentIncomingProfile
              ? [{ ...profile, id: LEGACY_PROFILE_ID, name: 'Other', providerConfigs: [chosen] }]
              : []),
          ],
          agents: [
            agent(
              incomingOption,
              incoming,
              differentIncomingProfile ? LEGACY_PROFILE_ID : undefined,
            ),
          ],
          presets: [
            { name: 'Keep', agentConfigs: [{ agentName: 'Worker', providerConfigName: 'chosen' }] },
          ],
        };
        expect(
          await importProjectWithHelper(
            {
              projectId,
              payload: {
                ...target,
                _manifest: { ...manifest, version: '1.0.0' },
                profiles: [{ ...profile, providerConfigs: [config('chosen', currentDefault)] }],
                teams: [
                  { name: 'Planning', memberAgentNames: ['Worker'], teamLeadAgentName: 'Worker' },
                ],
                agents: [agent('chosen', current)],
              },
            },
            importDeps(h) as never,
          ),
        ).toMatchObject({ success: true });
        await h.settings.setProjectActivePreset(projectId, 'Keep');

        expect(
          await applyPreservation(h, operation, projectId, target, {
            preserveTeamSetup:
              selectedOption === 'chosen'
                ? {}
                : {
                    agentOptions: [
                      { agentName: 'Worker', configName: selectedOption, providerName: 'claude' },
                    ],
                  },
          }),
        ).toMatchObject({ success: true });

        const stored = await h.storage.getAgentByName(projectId, 'Worker');
        expect([stored.modelOverride, stored.effortOverride]).toEqual(overrides);
        const storedOption = await h.storage.getProfileProviderConfig(stored.providerConfigId);
        expect(storedOption.name).toBe(selectedOption);
        expect([
          stored.modelOverride ?? storedOption.model,
          stored.effortOverride ?? storedOption.effort,
        ]).toEqual(effective);
        expect(h.settings.getProjectActivePreset(projectId)).toBeNull();
      },
    );
  });

  describe('create-from-template against real storage (preset + teamOverrides + familyProviderMappings)', () => {
    it('creates a project with all sections (preset + teamOverrides + familyProviderMappings)', async () => {
      await seedClaudeProvider(h);

      const transactionSpy = jest.spyOn(h.storage, 'runInTransaction');

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
        createDeps(h, templateWithTeamClearingPreset()) as never,
      );

      expect(result).toMatchObject({
        success: true,
        message: 'Project created from template successfully.',
      });
      const created = result as AnyRec;
      const project = created.project as AnyRec;
      expect(project).toMatchObject({ name: 'Created Project' });
      expect(h.settings.getProjectPresets(String(project.id))).toEqual(
        templateWithTeamClearingPreset().presets,
      );
      expect(created.imported).toMatchObject({
        prompts: expect.any(Number),
        profiles: expect.any(Number),
        agents: expect.any(Number),
        statuses: expect.any(Number),
      });
      expect(transactionSpy).toHaveBeenCalledTimes(1);

      const agents = await h.storage.listAgents(String(project.id), { limit: 100, offset: 0 });
      expect(agents.items.filter((agent) => agent.isProjectOwner)).toEqual([
        expect.objectContaining({ name: 'Builder Agent' }),
      ]);
      const [team] = (await h.teamsStore.listTeams(String(project.id))).items;
      expect(await h.teamsStore.getTeam(team.id)).toMatchObject({
        maxMembers: 6,
        profileConfigSelections: [
          { profileId: agents.items[0].profileId, configIds: [agents.items[0].providerConfigId] },
        ],
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
      expect(after.items.some((p) => p.name === 'Orphan Check')).toBe(false);
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
      expect(after.items.filter((p) => p.id === explicitId)).toHaveLength(1);
      expect(after.items.some((p) => p.name === 'Conflict Second')).toBe(false);
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

    it('replace-import: binds an agent to a deselected installed provider through a wizard override', async () => {
      await seedClaudeAndCodex(h);
      const projectA = await freshProject(h, 'Replace Installed Provider Override');

      await importProjectWithHelper(
        {
          projectId: projectA,
          payload: deselectedFirstTemplate({ providerConfigName: 'claude-cfg' }),
          selectedProviderNames: ['claude'],
          agentOverrides: [{ agentName: 'Coder', providerConfigName: 'codex-cfg' }],
        },
        importDeps(h) as never,
      );

      const { agent, codexCfg } = await coderConfigs(projectA);
      expect(agent!.providerConfigId).toBe(codexCfg!.id);
    });
  });
});
