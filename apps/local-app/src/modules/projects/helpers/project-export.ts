import type { ManifestData } from '@devchain/shared';
import { createLogger } from '../../../common/logging/logger';
import type { SettingsService } from '../../settings/services/settings.service';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import { resolveExportPresets } from './profile-mapping.helpers';
// Export builders colocated with their section codecs (moved out of this file).
import { loadExportPrompts } from '../template-codec/codecs/prompts.codec';
import { buildExportStatuses } from '../template-codec/codecs/statuses.codec';
import { buildExportProfiles } from '../template-codec/codecs/profiles.codec';
import { buildExportAgents } from '../template-codec/codecs/agents.codec';
import { buildProviderModels } from '../template-codec/codecs/provider-models.codec';
import { buildProviderEfforts } from '../template-codec/codecs/provider-efforts.codec';
import { buildProviderSettings } from '../template-codec/codecs/provider-settings.codec';
import { buildExportTeams } from '../template-codec/codecs/teams.codec';
import { buildExportScheduledEpics } from '../template-codec/codecs/scheduled-epics.codec';
import { buildExportWatchers } from '../template-codec/codecs/watchers.codec';
import { buildExportSubscribers } from '../template-codec/codecs/subscribers.codec';
import { buildProjectSettings } from '../template-codec/codecs/project-settings.codec';

const logger = createLogger('ProjectExport');

export interface ExportProjectOptions {
  manifestOverrides?: Partial<ManifestData>;
  presets?: Array<{
    name: string;
    description?: string | null;
    agentConfigs: Array<{
      agentName: string;
      providerConfigName: string;
      modelOverride?: string | null;
      effortOverride?: string | null;
    }>;
  }>;
}

interface ExportProjectDeps {
  storage: StorageService;
  settings: SettingsService;
  slugify: (name: string) => string;
  teamsService?: {
    listTeams: (
      projectId: string,
      options?: { limit?: number },
    ) => Promise<{
      items: Array<{
        id: string;
        name: string;
        description: string | null;
        teamLeadAgentId: string | null;
        memberCount: number;
      }>;
    }>;
    getTeam: (id: string) => Promise<{
      id: string;
      name: string;
      description: string | null;
      teamLeadAgentId: string | null;
      maxMembers: number;
      maxConcurrentTasks: number;
      allowTeamLeadCreateAgents: boolean;
      members: Array<{ agentId: string }>;
      profileIds: string[];
      profileConfigSelections: Array<{ profileId: string; configIds: string[] }>;
    } | null>;
  };
}

type ExportState = Awaited<ReturnType<typeof loadExportState>>;

export async function exportProjectWithHelper(
  projectId: string,
  opts: ExportProjectOptions | undefined,
  deps: ExportProjectDeps,
) {
  logger.info({ projectId }, 'exportProject');

  const { manifestOverrides, presets: presetsOverride } = opts ?? {};
  const state = await loadExportState(projectId, deps);

  const prompts = await loadExportPrompts(state.promptsRes, deps.storage);
  const profileContext = await loadProfileExportContext(state.profilesRes, deps.storage);

  const profiles = buildExportProfiles(state.profilesRes, profileContext, sanitizeEnvMap);
  const agents = buildExportAgents(state.agentsRes, profileContext.configIdToInfo);
  const statuses = buildExportStatuses(state.statusesRes);
  const projectSettings = buildProjectSettings({
    initialPromptTitle: state.initialPrompt?.title,
    autoCleanStatusIds: state.settings.autoClean?.statusIds?.[projectId] ?? [],
    statuses: state.statusesRes.items,
    epicAssignedTemplate: state.settings.events?.epicAssigned?.template,
    poolSettings: state.settings.messagePool?.projects?.[projectId],
  });
  const watchers = await buildExportWatchers(
    state.watchersRes,
    state.agentsRes.items,
    state.profilesRes.items,
    deps.storage,
  );
  const subscribers = buildExportSubscribers(state.subscribersRes);
  const scopeMap = deps.storage.listEnvScopesByProviderIds([...profileContext.providersMap.keys()]);
  const providerSettings = buildProviderSettings(profileContext.providersMap, projectId, scopeMap, {
    filterEnvByScope,
    sanitizeEnvMap,
  });
  const providerModels = await buildProviderModels(profileContext.providersMap, deps.storage);
  const providerEfforts = await buildProviderEfforts(profileContext.providersMap, deps.storage);
  const teams = deps.teamsService
    ? await buildExportTeams(state.project, deps.teamsService, deps.storage)
    : [];
  const scheduledEpics = await buildExportScheduledEpics(projectId, state, deps.storage);

  const manifest = buildManifest(
    state.project,
    deps.settings.getProjectTemplateMetadata(projectId),
    deps.slugify,
    manifestOverrides,
  );
  const exportPresets = resolveExportPresets(
    presetsOverride,
    deps.settings.getProjectPresets(projectId),
  );

  return {
    _manifest: manifest,
    version: 1,
    exportedAt: new Date().toISOString(),
    prompts,
    profiles,
    agents,
    statuses,
    initialPrompt: state.initialPrompt
      ? { promptId: state.initialPrompt.id, title: state.initialPrompt.title }
      : null,
    ...(Object.keys(projectSettings).length > 0 && { projectSettings }),
    ...(providerSettings.length > 0 && { providerSettings }),
    providerModels,
    providerEfforts,
    watchers,
    subscribers,
    ...(teams.length > 0 && { teams }),
    ...(exportPresets !== undefined ? { presets: exportPresets } : {}),
    scheduledEpics,
  };
}

async function loadExportState(projectId: string, deps: ExportProjectDeps) {
  const [
    project,
    promptsRes,
    profilesRes,
    agentsRes,
    statusesRes,
    initialPrompt,
    settings,
    watchersRes,
    subscribersRes,
  ] = await Promise.all([
    deps.storage.getProject(projectId),
    deps.storage.listPrompts({ projectId, limit: 1000, offset: 0 }),
    deps.storage.listAgentProfiles({ projectId, limit: 1000, offset: 0 }),
    deps.storage.listAgents(projectId, { limit: 1000, offset: 0 }),
    deps.storage.listStatuses(projectId, { limit: 1000, offset: 0 }),
    deps.storage.getInitialSessionPrompt(projectId),
    Promise.resolve(deps.settings.getSettings()),
    deps.storage.listWatchers(projectId),
    deps.storage.listSubscribers(projectId),
  ]);

  return {
    project,
    promptsRes,
    profilesRes,
    agentsRes,
    statusesRes,
    initialPrompt,
    settings,
    watchersRes,
    subscribersRes,
  };
}

// Canonical secret-key tokens for env-map sanitization (source of truth).
// Most tokens use case-insensitive substring matching.
// "pat" uses boundary-aware matching (must be a whole segment between _ or
// start/end) to avoid false-positives on PATH, PATTERN, DISPATCH, etc.
// Bare "auth" is intentionally excluded — it false-positives on
// AUTHOR_NAME, AUTHENTICATOR, etc.
const SECRET_ENV_TOKENS = [
  'api_key',
  'apikey',
  'token',
  'secret',
  'password',
  'passwd',
  'private_key',
  'client_secret',
  'access_key',
  'bearer',
  'credential',
  'credentials',
  'service_account',
  'ssh_key',
  'connection_string',
  'database_url',
  'dsn',
  'webhook_secret',
  'signing_key',
  'encryption_key',
];

// Boundary-aware: matches "pat" only as a whole underscore-delimited segment
const PAT_BOUNDARY_RE = /(^|_)pat(_|$)/i;

export function sanitizeEnvMap(
  env: Record<string, string> | null | undefined,
): Record<string, string> | null {
  if (!env) return null;

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const lower = key.toLowerCase();
    const isSecret = SECRET_ENV_TOKENS.some((t) => lower.includes(t)) || PAT_BOUNDARY_RE.test(key);
    result[key] = isSecret ? '***' : value;
  }
  return result;
}

async function loadProfileExportContext(
  profilesRes: ExportState['profilesRes'],
  storage: StorageService,
) {
  const configIdToInfo = new Map<string, { name: string; profileId: string }>();
  const allConfigsByProfile = new Map<
    string,
    Awaited<ReturnType<StorageService['listProfileProviderConfigsByProfile']>>
  >();

  await Promise.all(
    profilesRes.items.map(async (profile) => {
      const configs = await storage.listProfileProviderConfigsByProfile(profile.id);
      allConfigsByProfile.set(profile.id, configs);
    }),
  );

  const providerIds = new Set<string>();
  for (const configs of allConfigsByProfile.values()) {
    for (const config of configs) {
      providerIds.add(config.providerId);
    }
  }

  const providers = await storage.listProvidersByIds([...providerIds]);
  const providersMap = new Map(providers.map((provider) => [provider.id, provider]));

  return { configIdToInfo, allConfigsByProfile, providersMap };
}

function filterEnvByScope(
  env: Record<string, string>,
  scopes: Record<string, string[]> | undefined,
  sourceProjectId: string,
): Record<string, string> | null {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const keyScopes = scopes?.[key];
    if (!keyScopes || keyScopes.length === 0 || keyScopes.includes(sourceProjectId)) {
      filtered[key] = value;
    }
  }
  return Object.keys(filtered).length > 0 ? filtered : null;
}

function buildManifest(
  project: ExportState['project'],
  existingMetadata: ReturnType<SettingsService['getProjectTemplateMetadata']>,
  slugify: (name: string) => string,
  manifestOverrides: Partial<ManifestData> | undefined,
): ManifestData {
  return {
    slug: existingMetadata?.templateSlug || slugify(project.name),
    name: project.name,
    description: project.description || null,
    version: existingMetadata?.installedVersion || '1.0.0',
    ...manifestOverrides,
    publishedAt: new Date().toISOString(),
  };
}
