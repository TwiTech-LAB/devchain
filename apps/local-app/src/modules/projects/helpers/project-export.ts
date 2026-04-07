import type { ManifestData } from '@devchain/shared';
import { createLogger } from '../../../common/logging/logger';
import type { SettingsService } from '../../settings/services/settings.service';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import { resolveExportPresets } from './profile-mapping.helpers';

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
    }>;
  }>;
}

interface ExportProjectDeps {
  storage: StorageService;
  settings: SettingsService;
  slugify: (name: string) => string;
}

type ExportState = Awaited<ReturnType<typeof loadExportState>>;
type ProfileExportContext = Awaited<ReturnType<typeof loadProfileExportContext>>;
type ProjectSettingsExport = {
  initialPromptTitle?: string;
  autoCleanStatusLabels?: string[];
  epicAssignedTemplate?: string;
  messagePoolSettings?: {
    enabled?: boolean;
    delayMs?: number;
    maxWaitMs?: number;
    maxMessages?: number;
    separator?: string;
  };
};

export async function exportProjectWithHelper(
  projectId: string,
  opts: ExportProjectOptions | undefined,
  deps: ExportProjectDeps,
) {
  logger.info({ projectId }, 'exportProject');

  const { manifestOverrides, presets: presetsOverride } = opts ?? {};
  const state = await loadExportState(projectId, deps);

  // Reserved for future use to sanitize sensitive data in exports
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _sanitize = createSecretSanitizer();

  const prompts = await loadExportPrompts(state.promptsRes, deps.storage);
  const profileContext = await loadProfileExportContext(state.profilesRes, deps.storage);

  const profiles = buildExportProfiles(state.profilesRes, profileContext);
  const agents = buildExportAgents(state.agentsRes, profileContext.configIdToInfo);
  const statuses = buildExportStatuses(state.statusesRes);
  const projectSettings = buildProjectSettings(state, projectId);
  const watchers = await buildExportWatchers(state, deps.storage);
  const subscribers = buildExportSubscribers(state.subscribersRes);
  const providerSettings = buildProviderSettings(profileContext.providersMap);
  const providerModels = await buildProviderModels(profileContext.providersMap, deps.storage);

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
    watchers,
    subscribers,
    ...(exportPresets !== undefined ? { presets: exportPresets } : {}),
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

function createSecretSanitizer() {
  const secretKeys = new Set([
    'apikey',
    'api_key',
    'api-key',
    'api_key_id',
    'api-secret',
    'api_secret',
    'token',
    'access_token',
    'access-token',
    'refresh_token',
    'refresh-token',
    'secret',
    'client_secret',
    'clientsecret',
    'password',
    'openaiapikey',
    'anthropicapikey',
    'azureapikey',
    'googleapikey',
    'geminiapikey',
  ]);

  const sanitize = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map((entry) => sanitize(entry));
    }
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        out[key] = secretKeys.has(key.toLowerCase()) ? '***' : sanitize(entry);
      }
      return out;
    }
    return value;
  };

  return sanitize;
}

async function loadExportPrompts(
  promptsRes: ExportState['promptsRes'],
  storage: StorageService,
): Promise<Array<{ id: string; title: string; content: string; version: number; tags: string[] }>> {
  const fullPrompts = await Promise.all(
    promptsRes.items.map((prompt) => storage.getPrompt(prompt.id)),
  );

  return fullPrompts.map((prompt) => ({
    id: prompt.id,
    title: prompt.title,
    content: prompt.content,
    version: prompt.version,
    tags: prompt.tags,
  }));
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

function buildExportProfiles(
  profilesRes: ExportState['profilesRes'],
  context: ProfileExportContext,
) {
  return profilesRes.items.map((profile) => {
    const configs = context.allConfigsByProfile.get(profile.id) || [];

    let primaryProvider: { id: string; name: string } | null = null;
    const providerConfigs = configs.map((config) => {
      const provider = context.providersMap.get(config.providerId);
      if (!primaryProvider && provider) {
        primaryProvider = { id: provider.id, name: provider.name };
      }

      context.configIdToInfo.set(config.id, { name: config.name, profileId: profile.id });

      return {
        name: config.name,
        providerName: provider?.name || 'unknown',
        options: config.options,
        env: config.env,
        position: config.position,
      };
    });

    return {
      id: profile.id,
      name: profile.name,
      provider: primaryProvider,
      familySlug: profile.familySlug,
      instructions: profile.instructions,
      temperature: profile.temperature,
      maxTokens: profile.maxTokens,
      ...(providerConfigs.length > 0 && { providerConfigs }),
    };
  });
}

function buildExportAgents(
  agentsRes: ExportState['agentsRes'],
  configIdToInfo: Map<string, { name: string; profileId: string }>,
) {
  return agentsRes.items.map((agent) => {
    let providerConfigName: string | null = null;
    if (agent.providerConfigId) {
      providerConfigName = configIdToInfo.get(agent.providerConfigId)?.name ?? null;
    }

    return {
      id: agent.id,
      name: agent.name,
      profileId: agent.profileId,
      description: agent.description,
      modelOverride: agent.modelOverride ?? null,
      ...(providerConfigName && { providerConfigName }),
    };
  });
}

function buildExportStatuses(statusesRes: ExportState['statusesRes']) {
  return statusesRes.items.map((status) => ({
    id: status.id,
    label: status.label,
    color: status.color,
    position: status.position,
    mcpHidden: status.mcpHidden,
  }));
}

function buildProjectSettings(state: ExportState, projectId: string): ProjectSettingsExport {
  const projectSettings: ProjectSettingsExport = {};

  if (state.initialPrompt?.title) {
    projectSettings.initialPromptTitle = state.initialPrompt.title;
  }

  const autoCleanStatusIds = state.settings.autoClean?.statusIds?.[projectId] ?? [];
  if (autoCleanStatusIds.length > 0) {
    const statusMap = new Map(state.statusesRes.items.map((status) => [status.id, status.label]));
    const autoCleanLabels = autoCleanStatusIds
      .map((statusId) => statusMap.get(statusId))
      .filter((label): label is string => Boolean(label));

    if (autoCleanLabels.length > 0) {
      projectSettings.autoCleanStatusLabels = autoCleanLabels;
    }
  }

  const epicAssignedTemplate = state.settings.events?.epicAssigned?.template;
  if (epicAssignedTemplate) {
    projectSettings.epicAssignedTemplate = epicAssignedTemplate;
  }

  const poolSettings = state.settings.messagePool?.projects?.[projectId];
  if (poolSettings && Object.keys(poolSettings).length > 0) {
    projectSettings.messagePoolSettings = poolSettings;
  }

  return projectSettings;
}

async function buildExportWatchers(state: ExportState, storage: StorageService) {
  return Promise.all(
    state.watchersRes.map(async (watcher) => {
      let scopeFilterName: string | null = null;

      if (watcher.scopeFilterId) {
        switch (watcher.scope) {
          case 'agent':
            scopeFilterName =
              state.agentsRes.items.find((agent) => agent.id === watcher.scopeFilterId)?.name ??
              null;
            break;
          case 'profile':
            scopeFilterName =
              state.profilesRes.items.find((profile) => profile.id === watcher.scopeFilterId)
                ?.name ?? null;
            break;
          case 'provider':
            try {
              scopeFilterName = (await storage.getProvider(watcher.scopeFilterId))?.name ?? null;
            } catch {
              scopeFilterName = null;
            }
            break;
        }
      }

      return {
        id: watcher.id,
        name: watcher.name,
        description: watcher.description,
        enabled: watcher.enabled,
        scope: watcher.scope,
        scopeFilterName,
        pollIntervalMs: watcher.pollIntervalMs,
        viewportLines: watcher.viewportLines,
        idleAfterSeconds: watcher.idleAfterSeconds,
        condition: watcher.condition,
        cooldownMs: watcher.cooldownMs,
        cooldownMode: watcher.cooldownMode,
        eventName: watcher.eventName,
      };
    }),
  );
}

function buildExportSubscribers(subscribersRes: ExportState['subscribersRes']) {
  return subscribersRes.map((subscriber) => ({
    id: subscriber.id,
    name: subscriber.name,
    description: subscriber.description,
    enabled: subscriber.enabled,
    eventName: subscriber.eventName,
    eventFilter: subscriber.eventFilter,
    actionType: subscriber.actionType,
    actionInputs: subscriber.actionInputs,
    delayMs: subscriber.delayMs,
    cooldownMs: subscriber.cooldownMs,
    retryOnError: subscriber.retryOnError,
    groupName: subscriber.groupName,
    position: subscriber.position,
    priority: subscriber.priority,
  }));
}

function buildProviderSettings(
  providersMap: Map<string, Awaited<ReturnType<StorageService['listProvidersByIds']>>[number]>,
) {
  const providerSettings: Array<{
    name: string;
    autoCompactThreshold: number | null;
    autoCompactThreshold1m?: number | null;
    oneMillionContextEnabled?: boolean;
  }> = [];

  for (const provider of providersMap.values()) {
    if (
      provider.autoCompactThreshold != null ||
      provider.autoCompactThreshold1m != null ||
      provider.oneMillionContextEnabled
    ) {
      providerSettings.push({
        name: provider.name,
        autoCompactThreshold: provider.autoCompactThreshold ?? null,
        ...(provider.autoCompactThreshold1m != null && {
          autoCompactThreshold1m: provider.autoCompactThreshold1m,
        }),
        ...(provider.oneMillionContextEnabled && { oneMillionContextEnabled: true }),
      });
    }
  }

  return providerSettings;
}

async function buildProviderModels(
  providersMap: Map<string, Awaited<ReturnType<StorageService['listProvidersByIds']>>[number]>,
  storage: StorageService,
) {
  const providerIds = [...providersMap.keys()];
  if (providerIds.length === 0) {
    return [] as Array<{ providerName: string; models: string[] }>;
  }

  const allModels = await storage.listProviderModelsByProviderIds(providerIds);
  const modelsByProviderId = new Map<string, string[]>();

  for (const model of allModels) {
    const models = modelsByProviderId.get(model.providerId) ?? [];
    models.push(model.name);
    modelsByProviderId.set(model.providerId, models);
  }

  const result: Array<{ providerName: string; models: string[] }> = [];
  for (const [providerId, provider] of providersMap.entries()) {
    const models = modelsByProviderId.get(providerId);
    if (models && models.length > 0) {
      result.push({ providerName: provider.name, models });
    }
  }

  return result;
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
