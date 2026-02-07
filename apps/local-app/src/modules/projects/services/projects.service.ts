import { Injectable, Inject } from '@nestjs/common';
import { StorageService, STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { SessionsService } from '../../sessions/services/sessions.service';
import { SettingsService } from '../../settings/services/settings.service';
import { WatchersService } from '../../watchers/services/watchers.service';
import { WatcherRunnerService } from '../../watchers/services/watcher-runner.service';
import { createLogger } from '../../../common/logging/logger';
import {
  ValidationError,
  NotFoundError,
  StorageError,
  ConflictError,
} from '../../../common/errors/error-types';
import { join, resolve, sep, basename } from 'path';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { getEnvConfig } from '../../../common/config/env.config';
import { ExportSchema, type ManifestData, isLessThan, isValidSemVer } from '@devchain/shared';
import { UnifiedTemplateService } from '../../registry/services/unified-template.service';

const logger = createLogger('ProjectsService');

export interface TemplateInfo {
  id: string;
  fileName: string;
}

export interface CreateFromTemplateInput {
  name: string;
  description?: string | null;
  rootPath: string;
  /** Template slug (unique identifier) - required for slug-based templates */
  slug?: string;
  /** Optional version - if null, uses bundled or latest downloaded */
  version?: string | null;
  /** Absolute path to template file - alternative to slug-based templates */
  templatePath?: string;
  /** Optional family-to-provider mappings for remapping profiles when default providers are unavailable */
  familyProviderMappings?: Record<string, string>;
  /** Optional preset name to apply after project creation */
  presetName?: string;
}

/**
 * Result returned when provider mapping is required but not provided.
 * Signals to the client that a mapping modal should be shown.
 */
export interface ProviderMappingRequired {
  /** Provider names required by template but not available locally */
  missingProviders: string[];
  /** Per-family alternative provider information */
  familyAlternatives: FamilyAlternative[];
  /** Whether import can proceed (all families have at least one available provider) */
  canImport: boolean;
}

export interface ImportProjectInput {
  projectId: string;
  payload: unknown;
  dryRun?: boolean;
  statusMappings?: Record<string, string>; // oldStatusId -> templateStatusLabel
  familyProviderMappings?: Record<string, string>; // familySlug -> providerName
}

/**
 * Represents a family of profiles and their provider alternatives.
 * Used for provider mapping during template import when default providers are unavailable.
 */
export interface FamilyAlternative {
  /** The family slug (e.g., 'coder', 'reviewer') */
  familySlug: string;
  /** The default provider name from the template */
  defaultProvider: string;
  /** Whether the default provider is available locally */
  defaultProviderAvailable: boolean;
  /** Provider names that have profiles for this family and are available locally */
  availableProviders: string[];
  /** Whether there are alternative providers available */
  hasAlternatives: boolean;
}

/**
 * Result of computing family alternatives for a template import.
 */
export interface FamilyAlternativesResult {
  /** Per-family alternative provider information */
  alternatives: FamilyAlternative[];
  /** Provider names required by template but not available locally */
  missingProviders: string[];
  /** Whether import can proceed (all families have at least one available provider) */
  canImport: boolean;
}

@Injectable()
export class ProjectsService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly sessions: SessionsService,
    private readonly settings: SettingsService,
    private readonly watchersService: WatchersService,
    private readonly watcherRunner: WatcherRunnerService,
    private readonly unifiedTemplateService: UnifiedTemplateService,
  ) {}

  private findTemplatesDirectory(): string | null {
    const env = getEnvConfig();

    // 1. Check for explicit TEMPLATES_DIR environment variable override
    if (env.TEMPLATES_DIR) {
      if (existsSync(env.TEMPLATES_DIR)) {
        logger.debug({ path: env.TEMPLATES_DIR }, 'Using TEMPLATES_DIR from environment');
        return env.TEMPLATES_DIR;
      }
      logger.warn({ path: env.TEMPLATES_DIR }, 'TEMPLATES_DIR set but path does not exist');
    }

    // 2. Try template paths for different deployment scenarios
    const possibleTemplatePaths = [
      // Relative to this file: works in both dev and prod builds
      // Dev: apps/local-app/src/modules/projects/services -> apps/local-app/templates
      // Prod: dist/server/modules/projects/services -> dist/server/templates
      join(__dirname, '..', '..', '..', '..', 'templates'),
      // Dev mode fallback: running from monorepo root with ts-node
      join(process.cwd(), 'apps', 'local-app', 'templates'),
    ];

    for (const path of possibleTemplatePaths) {
      if (existsSync(path)) {
        logger.debug({ path }, 'Found templates directory');
        return path;
      }
    }

    return null;
  }

  async listTemplates(): Promise<TemplateInfo[]> {
    logger.info('listTemplates');

    const templatesDir = this.findTemplatesDirectory();

    if (!templatesDir) {
      logger.error('Templates directory not found');
      throw new StorageError('Templates directory not found', {
        hint: 'Templates directory is not available in this deployment',
      });
    }

    try {
      const files = readdirSync(templatesDir);
      const jsonFiles = files.filter((file) => file.endsWith('.json'));

      const templates = jsonFiles.map((fileName) => {
        const id = fileName.replace(/\.json$/, '');
        return { id, fileName };
      });

      logger.info({ templatesDir, count: templates.length }, 'Listed project templates');
      return templates;
    } catch (error) {
      logger.error({ error, templatesDir }, 'Failed to read templates directory');
      throw new StorageError('Failed to read templates directory', {
        hint: 'Error accessing templates',
      });
    }
  }

  async getTemplateContent(templateId: string): Promise<unknown> {
    logger.info({ templateId }, 'getTemplateContent');

    const templatesDir = this.findTemplatesDirectory();
    if (!templatesDir) {
      throw new StorageError('Templates directory not found', {
        hint: 'Templates directory is not available in this deployment',
      });
    }

    // Security: Validate templateId to prevent path traversal attacks
    const TEMPLATE_ID_REGEX = /^[a-zA-Z0-9_-]+$/;
    if (!TEMPLATE_ID_REGEX.test(templateId)) {
      throw new ValidationError(
        'Invalid template ID: must contain only alphanumeric characters, hyphens, and underscores',
        { templateId },
      );
    }

    // Security: Resolve absolute paths and verify the template stays within templates directory
    const resolvedTemplatesDir = resolve(templatesDir);
    const templatePath = resolve(templatesDir, `${templateId}.json`);

    if (!templatePath.startsWith(resolvedTemplatesDir + sep)) {
      logger.warn(
        { templateId, templatePath, templatesDir: resolvedTemplatesDir },
        'Path traversal attempt detected',
      );
      throw new ValidationError('Invalid template ID: path traversal not allowed', { templateId });
    }

    if (!existsSync(templatePath)) {
      throw new NotFoundError('Template', templateId);
    }

    try {
      const content = readFileSync(templatePath, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      logger.error({ error, templatePath }, 'Failed to read template file');
      throw new StorageError('Failed to read template file', {
        hint: 'Template file exists but cannot be read or parsed',
      });
    }
  }

  async createFromTemplate(input: CreateFromTemplateInput) {
    logger.info({ input }, 'createFromTemplate');

    // 1. Load template via UnifiedTemplateService (branch based on input type)
    let templateResult;
    let templateSlug: string;

    if (input.templatePath) {
      // File-based template: load from absolute path
      templateResult = this.unifiedTemplateService.getTemplateFromFilePath(input.templatePath);
      // Derive templateSlug from _manifest.slug (already injected by getTemplateFromFilePath)
      const manifest = templateResult.content._manifest as { slug?: string } | undefined;
      templateSlug = manifest?.slug ?? this.deriveSlugFromPath(input.templatePath);
    } else if (input.slug) {
      // Slug-based template: load from bundled or registry
      templateResult = await this.unifiedTemplateService.getTemplate(
        input.slug,
        input.version ?? undefined,
      );
      templateSlug = input.slug;
    } else {
      throw new ValidationError('Either slug or templatePath is required', {});
    }

    // 2. Parse and validate template content
    // Note: For file-based templates, content is already validated by getTemplateFromFilePath
    let payload;
    try {
      payload = ExportSchema.parse(templateResult.content);
    } catch (error) {
      logger.error(
        { error, slug: templateSlug, version: input.version },
        'Invalid template format',
      );
      throw new ValidationError('Invalid template format', {
        hint: 'Template file does not match expected export schema',
      });
    }

    // 3. Compute family alternatives to determine if mapping is needed
    const familyResult = await this.computeFamilyAlternatives(payload.profiles, payload.agents);

    // 4. Check if provider mapping is required
    const needsMapping = familyResult.alternatives.some((alt) => !alt.defaultProviderAvailable);

    if (needsMapping && !input.familyProviderMappings) {
      // Return provider mapping info so UI can show mapping modal
      return {
        success: false,
        providerMappingRequired: {
          missingProviders: familyResult.missingProviders,
          familyAlternatives: familyResult.alternatives,
          canImport: familyResult.canImport,
        },
      };
    }

    // 4b. Enforce canImport server-side - block if no alternatives available
    if (!familyResult.canImport) {
      throw new ValidationError(
        'Cannot import: some profile families have no available providers',
        {
          hint: 'Install the required providers or use a different template',
          missingProviders: familyResult.missingProviders,
          familyAlternatives: familyResult.alternatives,
        },
      );
    }

    // 5. Provider precheck and mapping
    const providerNames = new Set(
      (payload.profiles ?? []).map((p) => p.provider.name.trim().toLowerCase()),
    );
    const { available } = await this.resolveProviders(providerNames);

    // 6. Build profile selection map based on family mappings
    // When mappings are provided, select the profile for each family that matches the mapped provider
    const selectedProfilesByFamily = this.selectProfilesForFamilies(
      payload.profiles,
      payload.agents,
      input.familyProviderMappings,
      available,
    );

    // 7. Prepare template payload with resolved provider IDs
    // Filter profiles to only include those selected based on family mappings
    const templatePayload: import('../../storage/interfaces/storage.interface').TemplateImportPayload =
      {
        prompts: payload.prompts.map((p) => ({
          id: p.id,
          title: p.title,
          content: p.content,
          version: p.version,
          tags: p.tags,
        })),
        profiles: selectedProfilesByFamily.profilesToCreate.map((prof) => {
          const providerId = available.get(prof.provider.name.trim().toLowerCase());
          if (!providerId) {
            throw new NotFoundError('Provider', prof.provider.name);
          }
          return {
            id: prof.id,
            name: prof.name,
            providerId,
            familySlug: prof.familySlug ?? null,
            options: this.normalizeProfileOptions(prof.options),
            instructions: prof.instructions ?? null,
            temperature: prof.temperature ?? null,
            maxTokens: prof.maxTokens ?? null,
          };
        }),
        agents: payload.agents.map((a) => {
          // Remap agent's profileId if family was remapped
          const remappedProfileId =
            selectedProfilesByFamily.agentProfileMap.get(a.id ?? '') ?? a.profileId;
          return {
            id: a.id,
            name: a.name,
            profileId: remappedProfileId,
            description: a.description,
          };
        }),
        statuses: payload.statuses.map((s) => ({
          id: s.id,
          label: s.label,
          color: s.color,
          position: s.position,
          mcpHidden: s.mcpHidden,
        })),
        initialPrompt: payload.initialPrompt,
      };

    // 5. Create project with template in transaction
    const result = await this.storage.createProjectWithTemplate(
      {
        name: input.name,
        description: input.description ?? null,
        rootPath: input.rootPath,
        isTemplate: false,
      },
      templatePayload,
    );

    // 5b. Build name-to-ID maps for watcher scope resolution
    const { agentNameToId: agentNameToNewId, profileNameToId: profileNameToNewId } =
      this.buildNameToIdMaps(templatePayload, result.mappings);

    // 5c. Create provider configs and update agents with providerConfigId
    // Map: { newProfileId, configName } -> newConfigId
    const configLookupMap = new Map<string, string>(); // key: `${newProfileId}:${configName}`

    for (const prof of selectedProfilesByFamily.profilesToCreate) {
      if (!prof.id) continue;
      const newProfileId = result.mappings.profileIdMap[prof.id];
      if (!newProfileId) continue;

      // Check if profile has providerConfigs (new format)
      const providerConfigs = (
        prof as {
          providerConfigs?: Array<{
            name: string;
            providerName: string;
            options?: string | null;
            env?: Record<string, string> | null;
          }>;
        }
      ).providerConfigs;

      if (providerConfigs && providerConfigs.length > 0) {
        // New format: create configs from providerConfigs array
        for (const config of providerConfigs) {
          const configProviderId = available.get(config.providerName.trim().toLowerCase());
          if (!configProviderId) {
            logger.warn(
              { profileName: prof.name, providerName: config.providerName },
              'Provider not found for config in createFromTemplate, skipping',
            );
            continue;
          }

          const createdConfig = await this.storage.createProfileProviderConfig({
            profileId: newProfileId,
            providerId: configProviderId,
            name: config.name,
            options: config.options ?? null,
            env: config.env ?? null,
          });

          const lookupKey = `${newProfileId}:${config.name.trim().toLowerCase()}`;
          configLookupMap.set(lookupKey, createdConfig.id);
        }
      }
    }

    // Track profiles with providerConfigs for cleanup after agent updates
    const profilesWithProviderConfigs = new Map<
      string,
      { profileName: string; configNames: Set<string> }
    >();
    for (const prof of selectedProfilesByFamily.profilesToCreate) {
      if (!prof.id) continue;
      const newProfileId = result.mappings.profileIdMap[prof.id];
      if (!newProfileId) continue;

      const providerConfigs = (
        prof as {
          providerConfigs?: Array<{ name: string }>;
        }
      ).providerConfigs;

      if (providerConfigs && providerConfigs.length > 0) {
        profilesWithProviderConfigs.set(newProfileId, {
          profileName: prof.name,
          configNames: new Set(providerConfigs.map((pc) => pc.name.trim().toLowerCase())),
        });
      }
    }

    // Update agents with providerConfigId if they have providerConfigName
    for (const a of payload.agents) {
      const agentWithConfig = a as { providerConfigName?: string | null };
      if (!agentWithConfig.providerConfigName || !a.id) continue;

      const newAgentId = result.mappings.agentIdMap[a.id];
      if (!newAgentId) continue;

      // Get the agent's profile (potentially remapped)
      const remappedProfileId = selectedProfilesByFamily.agentProfileMap.get(a.id) ?? a.profileId;
      const newProfileId = remappedProfileId
        ? result.mappings.profileIdMap[remappedProfileId]
        : null;
      if (!newProfileId) continue;

      // Look up config by name
      const lookupKey = `${newProfileId}:${agentWithConfig.providerConfigName.trim().toLowerCase()}`;
      const providerConfigId = configLookupMap.get(lookupKey);

      if (providerConfigId) {
        await this.storage.updateAgent(newAgentId, { providerConfigId });
        logger.debug(
          { agentName: a.name, providerConfigId },
          'Updated agent with providerConfigId',
        );
      } else {
        logger.warn(
          { agentName: a.name, providerConfigName: agentWithConfig.providerConfigName },
          'Provider config not found for agent in createFromTemplate',
        );
      }
    }

    // 5d. Delete duplicate configs created by storage layer
    // Storage layer creates a default config for each profile (with name = profile name).
    // If we created configs from providerConfigs, we need to delete the duplicates.
    // This must happen AFTER agent updates to avoid foreign key violations.
    for (const [newProfileId, { profileName, configNames }] of profilesWithProviderConfigs) {
      const existingConfigs = await this.storage.listProfileProviderConfigsByProfile(newProfileId);
      for (const existingConfig of existingConfigs) {
        // Delete configs with name matching profile name (created by storage layer)
        // Skip configs that were created from providerConfigs
        const isFromProviderConfigs = configNames.has(existingConfig.name.trim().toLowerCase());
        if (!isFromProviderConfigs && existingConfig.name === profileName) {
          await this.storage.deleteProfileProviderConfig(existingConfig.id);
          logger.debug(
            { profileName, configId: existingConfig.id },
            'Deleted duplicate config created by storage layer',
          );
        }
      }
    }

    // 6. Apply projectSettings from template using helper
    // Merge initial prompt: payload.initialPrompt takes precedence over projectSettings.initialPromptTitle
    // This consolidates the dual-mechanism into a single path through applyProjectSettings.
    let mergedInitialPromptTitle: string | undefined;
    if (payload.initialPrompt?.title) {
      // payload.initialPrompt.title takes highest precedence
      mergedInitialPromptTitle = payload.initialPrompt.title;
    } else if (payload.initialPrompt?.promptId) {
      // If only promptId is specified, look up the title from payload.prompts
      const matchingPrompt = payload.prompts.find((p) => p.id === payload.initialPrompt!.promptId);
      if (matchingPrompt) {
        mergedInitialPromptTitle = matchingPrompt.title;
      }
    } else if (payload.projectSettings?.initialPromptTitle) {
      // Fall back to projectSettings.initialPromptTitle
      mergedInitialPromptTitle = payload.projectSettings.initialPromptTitle;
    }

    const mergedSettings = payload.projectSettings
      ? { ...payload.projectSettings, initialPromptTitle: mergedInitialPromptTitle }
      : mergedInitialPromptTitle
        ? { initialPromptTitle: mergedInitialPromptTitle }
        : undefined;

    // Build maps for prompt and status lookup
    const promptTitleToId = new Map<string, string>();
    for (const p of payload.prompts) {
      if (p.id && result.mappings.promptIdMap[p.id]) {
        promptTitleToId.set(p.title.toLowerCase(), result.mappings.promptIdMap[p.id]);
      }
    }
    const statusLabelToId = new Map<string, string>();
    for (const s of templatePayload.statuses) {
      if (s.id && result.mappings.statusIdMap[s.id]) {
        statusLabelToId.set(s.label.toLowerCase(), result.mappings.statusIdMap[s.id]);
      }
    }
    // Find Archive status ID for fallback
    const archiveTemplateStatus = templatePayload.statuses.find(
      (s) => s.label.toLowerCase() === 'archive',
    );
    const archiveStatusId = archiveTemplateStatus?.id
      ? (result.mappings.statusIdMap[archiveTemplateStatus.id] ?? null)
      : null;

    const settingsResult = await this.applyProjectSettings(
      result.project.id,
      mergedSettings,
      { promptTitleToId, statusLabelToId },
      archiveStatusId,
    );
    const initialPromptSet = settingsResult.initialPromptSet;

    // 7. Create watchers from template using helper
    // Pass profileNameRemapMap to handle watcher scope fallback when profiles are remapped
    const { created: watchersCreated } = await this.createWatchersFromPayload(
      result.project.id,
      payload.watchers,
      {
        agentNameToId: agentNameToNewId,
        profileNameToId: profileNameToNewId,
        providerNameToId: available,
        profileNameRemapMap: selectedProfilesByFamily.profileNameRemapMap,
      },
    );

    // 8. Create subscribers from template using helper
    const { created: subscribersCreated } = await this.createSubscribersFromPayload(
      result.project.id,
      payload.subscribers,
    );

    // 9. Set template metadata for upgrade tracking
    // For bundled templates, read version from _manifest since getTemplate returns version: null
    const manifestVersion =
      (payload._manifest as { version?: string } | undefined)?.version ?? null;
    const installedVersion = templateResult.version ?? manifestVersion;

    const registryConfig = this.settings.getRegistryConfig();
    await this.settings.setProjectTemplateMetadata(result.project.id, {
      templateSlug,
      source: templateResult.source,
      installedVersion,
      registryUrl: templateResult.source === 'registry' ? registryConfig.url : null,
      installedAt: new Date().toISOString(),
    });

    logger.info(
      {
        projectId: result.project.id,
        slug: templateSlug,
        source: templateResult.source,
        version: installedVersion,
      },
      'Template metadata set for project',
    );

    // 10. Store presets from template in settings (if present)
    const rawPresets = (payload as { presets?: unknown }).presets;
    const templatePresets = Array.isArray(rawPresets) ? rawPresets : [];
    if (templatePresets.length > 0) {
      await this.settings.setProjectPresets(result.project.id, templatePresets);
      logger.info(
        { projectId: result.project.id, presetCount: templatePresets.length },
        'Presets stored for project',
      );
    }

    // 11. Apply selected preset if provided
    if (input.presetName) {
      const selectedPreset = templatePresets.find(
        (p: unknown) =>
          typeof p === 'object' && p !== null && 'name' in p && p.name === input.presetName,
      );
      if (!selectedPreset) {
        logger.warn(
          { projectId: result.project.id, presetName: input.presetName },
          'Selected preset not found in template',
        );
      } else {
        await this.applyPreset(result.project.id, input.presetName, {
          agentNameToId: agentNameToNewId,
          configLookupMap,
        });
        logger.info(
          { projectId: result.project.id, presetName: input.presetName },
          'Applied preset to project',
        );
      }
    }

    return {
      success: true,
      project: result.project,
      imported: {
        ...result.imported,
        watchers: watchersCreated,
        subscribers: subscribersCreated,
      },
      mappings: result.mappings,
      initialPromptSet,
      message: 'Project created from template successfully.',
    };
  }

  async exportProject(
    projectId: string,
    opts?: {
      manifestOverrides?: Partial<ManifestData>;
      presets?: Array<{
        name: string;
        description?: string | null;
        agentConfigs: Array<{ agentName: string; providerConfigName: string }>;
      }>;
    },
  ) {
    logger.info({ projectId }, 'exportProject');

    const { manifestOverrides, presets: presetsOverride } = opts ?? {};

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
      this.storage.getProject(projectId),
      this.storage.listPrompts({ projectId, limit: 1000, offset: 0 }),
      this.storage.listAgentProfiles({ projectId, limit: 1000, offset: 0 }),
      this.storage.listAgents(projectId, { limit: 1000, offset: 0 }),
      this.storage.listStatuses(projectId, { limit: 1000, offset: 0 }),
      this.storage.getInitialSessionPrompt(projectId),
      Promise.resolve(this.settings.getSettings()),
      this.storage.listWatchers(projectId),
      this.storage.listSubscribers(projectId),
    ]);

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

    // Reserved for future use to sanitize sensitive data in exports
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _sanitize = (value: unknown): unknown => {
      if (Array.isArray(value)) {
        return value.map((v) => _sanitize(v));
      }
      if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          const keyLc = k.toLowerCase();
          if (secretKeys.has(keyLc)) {
            out[k] = '***';
          } else {
            out[k] = _sanitize(v);
          }
        }
        return out;
      }
      return value;
    };

    // sanitizeOptionsString removed - options are stored as plain CLI flag strings, not JSON
    // No sanitization needed

    // Fetch full prompts to get content (listPrompts returns summaries without content)
    // Note: This is O(N) storage calls for N prompts. Acceptable for export (non-hot path).
    // If export becomes a hot path, consider adding listPromptsByIds() bulk method.
    const fullPrompts = await Promise.all(
      promptsRes.items.map((p) => this.storage.getPrompt(p.id)),
    );
    const prompts = fullPrompts.map((p) => ({
      id: p.id,
      title: p.title,
      content: p.content,
      version: p.version,
      tags: p.tags,
    }));

    // Build configId -> config info map for agent providerConfigName resolution
    const configIdToInfo = new Map<string, { name: string; profileId: string }>();

    // Fetch all configs for this project's profiles in bulk to avoid N+1
    // Note: listProfileProviderConfigsByProfile is called per profile (O(N) for N profiles).
    // This is acceptable for export (non-hot path). If performance becomes critical,
    // consider adding listProfileProviderConfigsByProfileIds() bulk method.
    const profileIds = profilesRes.items.map((p) => p.id);
    const allConfigsByProfile = new Map<
      string,
      Awaited<ReturnType<typeof this.storage.listProfileProviderConfigsByProfile>>
    >();
    await Promise.all(
      profileIds.map(async (profileId) => {
        const configs = await this.storage.listProfileProviderConfigsByProfile(profileId);
        allConfigsByProfile.set(profileId, configs);
      }),
    );

    // Collect all unique provider IDs and fetch in bulk (fixes N+1 for provider lookups)
    const allProviderIds = new Set<string>();
    for (const configs of allConfigsByProfile.values()) {
      for (const config of configs) {
        allProviderIds.add(config.providerId);
      }
    }
    const providersArray = await this.storage.listProvidersByIds([...allProviderIds]);
    const providersMap = new Map(providersArray.map((p) => [p.id, p]));

    // Build profiles with pre-fetched data (no additional storage calls)
    const profiles = profilesRes.items.map((prof) => {
      const configs = allConfigsByProfile.get(prof.id) || [];

      // Build providerConfigs array and populate configId map
      // Provider is now derived from configs (profiles no longer have providerId)
      let primaryProvider: { id: string; name: string } | null = null;
      const providerConfigs = configs.map((config) => {
        const configProvider = providersMap.get(config.providerId);

        // First config's provider becomes the primary (for backward compat in export)
        if (!primaryProvider && configProvider) {
          primaryProvider = { id: configProvider.id, name: configProvider.name };
        }

        // Use stored config name directly (added in Phase 5)
        const configName = config.name;

        // Store in map for agent resolution
        configIdToInfo.set(config.id, { name: configName, profileId: prof.id });

        return {
          name: configName,
          providerName: configProvider?.name || 'unknown',
          options: config.options,
          env: config.env,
          position: config.position,
        };
      });

      return {
        id: prof.id,
        name: prof.name,
        provider: primaryProvider,
        familySlug: prof.familySlug,
        // Note: options removed from profile in Phase 4, now only on configs
        instructions: prof.instructions,
        temperature: prof.temperature,
        maxTokens: prof.maxTokens,
        // Include providerConfigs if any exist
        ...(providerConfigs.length > 0 && { providerConfigs }),
      };
    });

    const agents = agentsRes.items.map((a) => {
      // Resolve providerConfigId to config name for stable reference
      let providerConfigName: string | null = null;
      if (a.providerConfigId) {
        const configInfo = configIdToInfo.get(a.providerConfigId);
        if (configInfo) {
          providerConfigName = configInfo.name;
        }
      }

      return {
        id: a.id,
        name: a.name,
        profileId: a.profileId,
        description: a.description,
        // Include providerConfigName if agent has a config reference
        ...(providerConfigName && { providerConfigName }),
      };
    });

    const statuses = statusesRes.items.map((s) => ({
      id: s.id,
      label: s.label,
      color: s.color,
      position: s.position,
      mcpHidden: s.mcpHidden,
    }));

    // Build projectSettings for export (uses labels/titles for portability)
    const projectSettings: {
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
    } = {};

    // Include initial prompt title if set
    if (initialPrompt?.title) {
      projectSettings.initialPromptTitle = initialPrompt.title;
    }

    // Resolve autoClean status IDs to labels
    const autoCleanStatusIds = settings.autoClean?.statusIds?.[projectId] ?? [];
    if (autoCleanStatusIds.length > 0) {
      const statusMap = new Map(statusesRes.items.map((s) => [s.id, s.label]));
      const autoCleanLabels = autoCleanStatusIds
        .map((id) => statusMap.get(id))
        .filter((label): label is string => !!label);
      if (autoCleanLabels.length > 0) {
        projectSettings.autoCleanStatusLabels = autoCleanLabels;
      }
    }

    // Include epic assigned template if set
    const epicAssignedTemplate = settings.events?.epicAssigned?.template;
    if (epicAssignedTemplate) {
      projectSettings.epicAssignedTemplate = epicAssignedTemplate;
    }

    // Include per-project message pool settings if set
    const poolSettings = settings.messagePool?.projects?.[projectId];
    if (poolSettings && Object.keys(poolSettings).length > 0) {
      projectSettings.messagePoolSettings = poolSettings;
    }

    // Export watchers with name-based scope references for portability
    const watchers = await Promise.all(
      watchersRes.map(async (w) => {
        let scopeFilterName: string | null = null;
        if (w.scopeFilterId) {
          switch (w.scope) {
            case 'agent': {
              const agent = agentsRes.items.find((a) => a.id === w.scopeFilterId);
              scopeFilterName = agent?.name ?? null;
              break;
            }
            case 'profile': {
              const profile = profilesRes.items.find((p) => p.id === w.scopeFilterId);
              scopeFilterName = profile?.name ?? null;
              break;
            }
            case 'provider': {
              try {
                const provider = await this.storage.getProvider(w.scopeFilterId);
                scopeFilterName = provider?.name ?? null;
              } catch {
                scopeFilterName = null;
              }
              break;
            }
          }
        }
        return {
          id: w.id,
          name: w.name,
          description: w.description,
          enabled: w.enabled,
          scope: w.scope,
          scopeFilterName,
          pollIntervalMs: w.pollIntervalMs,
          viewportLines: w.viewportLines,
          idleAfterSeconds: w.idleAfterSeconds,
          condition: w.condition,
          cooldownMs: w.cooldownMs,
          cooldownMode: w.cooldownMode,
          eventName: w.eventName,
        };
      }),
    );

    // Export subscribers (no cross-references, export directly)
    const subscribers = subscribersRes.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      enabled: s.enabled,
      eventName: s.eventName,
      eventFilter: s.eventFilter,
      actionType: s.actionType,
      actionInputs: s.actionInputs,
      delayMs: s.delayMs,
      cooldownMs: s.cooldownMs,
      retryOnError: s.retryOnError,
      groupName: s.groupName,
      position: s.position,
      priority: s.priority,
    }));

    // Build _manifest from project metadata and overrides
    const existingMetadata = this.settings.getProjectTemplateMetadata(projectId);
    const manifest: ManifestData = {
      slug: existingMetadata?.templateSlug || this.slugify(project.name),
      name: project.name,
      description: project.description || null,
      version: existingMetadata?.installedVersion || '1.0.0',
      ...manifestOverrides,
      publishedAt: new Date().toISOString(),
    };

    const exportPayload = {
      _manifest: manifest,
      version: 1,
      exportedAt: new Date().toISOString(),
      prompts,
      profiles,
      agents,
      statuses,
      initialPrompt: initialPrompt
        ? { promptId: initialPrompt.id, title: initialPrompt.title }
        : null,
      // Only include projectSettings if any settings are present
      ...(Object.keys(projectSettings).length > 0 && { projectSettings }),
      // Include watchers and subscribers (empty arrays if none)
      watchers,
      subscribers,
      // Include presets from override if provided; otherwise from settings.
      // Contract:
      //   - `presets: undefined` (not provided) → use stored presets if any
      //   - `presets: []` (empty array) → explicitly export without presets
      //   - `presets: [...]` → export with provided presets
      ...(presetsOverride !== undefined
        ? { presets: presetsOverride }
        : this.settings.getProjectPresets(projectId).length > 0
          ? { presets: this.settings.getProjectPresets(projectId) }
          : {}),
    };

    return exportPayload;
  }

  /**
   * Check if a project's current agent configurations match a preset
   * Match logic: compares agent name + providerConfigName for each agent in the preset
   * @param projectId The project ID
   * @param preset The preset to compare against
   * @returns true if all agents in the preset have matching provider configs, false otherwise
   */
  async doesProjectMatchPreset(
    projectId: string,
    preset: {
      name: string;
      agentConfigs: Array<{ agentName: string; providerConfigName: string }>;
    },
  ): Promise<boolean> {
    // Get all agents in the project
    const agentsRes = await this.storage.listAgents(projectId, { limit: 1000, offset: 0 });
    const agentsByName = new Map(agentsRes.items.map((a) => [a.name.toLowerCase(), a]));

    // Collect all unique provider config IDs used by agents (bulk query to avoid N+1)
    const uniqueProviderConfigIds = new Set<string>();
    for (const agent of agentsRes.items) {
      if (agent.providerConfigId) {
        uniqueProviderConfigIds.add(agent.providerConfigId);
      }
    }

    // Single bulk query to get all provider configs
    const allProviderConfigs =
      uniqueProviderConfigIds.size > 0
        ? await this.storage.listProfileProviderConfigsByIds(Array.from(uniqueProviderConfigIds))
        : [];

    // Map provider config ID to name for quick lookup
    const providerConfigNames = new Map(allProviderConfigs.map((c) => [c.id, c.name]));

    // Check each agent config in the preset
    for (const agentConfig of preset.agentConfigs) {
      const agentNameLower = agentConfig.agentName.trim().toLowerCase();
      const providerConfigNameLower = agentConfig.providerConfigName.trim().toLowerCase();

      const agent = agentsByName.get(agentNameLower);
      if (!agent) {
        return false; // Agent not found
      }

      const currentProviderConfigName = providerConfigNames.get(agent.providerConfigId ?? '');
      if (currentProviderConfigName?.toLowerCase() !== providerConfigNameLower) {
        return false; // Provider config doesn't match
      }
    }

    // All agents in preset match current configuration
    return true;
  }

  /**
   * Apply a preset to a project by batch updating agent provider config assignments
   * @param projectId The project ID
   * @param presetName The name of the preset to apply
   * @param nameMaps Optional name-to-ID maps for resolution (can be passed from createFromTemplate)
   * @returns Object with applied count and any warnings
   */
  async applyPreset(
    projectId: string,
    presetName: string,
    nameMaps?: {
      agentNameToId: Map<string, string>;
      configLookupMap: Map<string, string>;
    },
  ): Promise<{ applied: number; warnings: string[] }> {
    logger.info({ projectId, presetName }, 'applyPreset');

    const warnings: string[] = [];

    // 1. Get presets for this project
    const presets = this.settings.getProjectPresets(projectId);
    const selectedPreset = presets.find((p) => p.name === presetName);

    if (!selectedPreset) {
      throw new NotFoundError('Preset', presetName);
    }

    // Defensive check: ensure agentConfigs exists and is an array
    if (!selectedPreset.agentConfigs || !Array.isArray(selectedPreset.agentConfigs)) {
      throw new ValidationError(`Preset "${presetName}" has invalid or missing agentConfigs`, {
        presetName,
      });
    }

    // 2. Get all agents in the project
    const agentsRes = await this.storage.listAgents(projectId, { limit: 1000, offset: 0 });

    // 3. Build name-to-ID map for agents (or use provided)
    let agentNameToId: Map<string, string>;

    if (nameMaps?.agentNameToId) {
      agentNameToId = nameMaps.agentNameToId;
    } else {
      // Build map from current project state
      agentNameToId = new Map();
      for (const agent of agentsRes.items) {
        agentNameToId.set(agent.name.toLowerCase(), agent.id);
      }
    }

    // 4. Build config lookup map ONCE before the loop
    // Maps: profileId:configName -> configId
    let configLookupMap: Map<string, string>;

    if (nameMaps?.configLookupMap) {
      configLookupMap = nameMaps.configLookupMap;
    } else {
      // Build config lookup map for all profiles in the project
      configLookupMap = new Map();
      const profilesRes = await this.storage.listAgentProfiles({
        projectId,
        limit: 1000,
        offset: 0,
      });
      for (const profile of profilesRes.items) {
        const configs = await this.storage.listProfileProviderConfigsByProfile(profile.id);
        for (const config of configs) {
          const lookupKey = `${profile.id}:${config.name.trim().toLowerCase()}`;
          configLookupMap.set(lookupKey, config.id);
        }
      }
    }

    // 5. Apply preset: batch update agents with provider config assignments
    let applied = 0;
    const agentsById = new Map(agentsRes.items.map((a) => [a.id, a]));

    for (const agentConfig of selectedPreset.agentConfigs) {
      const agentId = agentNameToId.get(agentConfig.agentName.trim().toLowerCase());

      if (!agentId) {
        warnings.push(`Agent "${agentConfig.agentName}" not found in project`);
        continue;
      }

      // Get the agent to find its profile
      const agent = agentsById.get(agentId);
      if (!agent) continue;

      // Look up provider config by name within the agent's profile
      const profileId = agent.profileId;
      const lookupKey = `${profileId}:${agentConfig.providerConfigName.trim().toLowerCase()}`;
      const providerConfigId = configLookupMap.get(lookupKey);

      if (!providerConfigId) {
        warnings.push(
          `Provider config "${agentConfig.providerConfigName}" not found for agent "${agentConfig.agentName}"`,
        );
        continue;
      }

      // Update agent with provider config
      await this.storage.updateAgent(agentId, { providerConfigId });
      applied++;
      logger.debug(
        { projectId, agentId, agentName: agentConfig.agentName, providerConfigId },
        'Applied preset: updated agent provider config',
      );
    }

    // Set activePreset only if full match (no warnings, all agents applied)
    // This ensures activePreset is only set when the configuration truly matches the preset
    const fullMatch = warnings.length === 0 && applied === selectedPreset.agentConfigs.length;
    if (fullMatch) {
      await this.settings.setProjectActivePreset(projectId, presetName);
      logger.info({ projectId, presetName }, 'Active preset set (full match)');
    }

    logger.info({ projectId, presetName, applied, warnings: warnings.length }, 'Preset applied');

    return { applied, warnings };
  }

  async importProject(input: ImportProjectInput) {
    logger.info({ projectId: input.projectId, dryRun: input.dryRun }, 'importProject');

    const isDryRun = input.dryRun ?? false;
    const payload = ExportSchema.parse(input.payload ?? {});

    // Compute family alternatives to determine if mapping is needed
    const familyResult = await this.computeFamilyAlternatives(payload.profiles, payload.agents);
    const needsMapping = familyResult.alternatives.some((alt) => !alt.defaultProviderAvailable);

    // Provider precheck - get all available providers
    const providerNames = new Set(
      (payload.profiles ?? []).map((p) => p.provider.name.trim().toLowerCase()),
    );
    const { available, missing: missingProviders } = await this.resolveProviders(providerNames);

    // Build profile selection based on family mappings (used for both dry-run info and actual import)
    const selectedProfilesByFamily = this.selectProfilesForFamilies(
      payload.profiles,
      payload.agents,
      input.familyProviderMappings,
      available,
    );

    const [
      existingPrompts,
      existingProfiles,
      existingAgents,
      existingStatuses,
      existingWatchers,
      existingSubscribers,
    ] = await Promise.all([
      this.storage.listPrompts({ projectId: input.projectId, limit: 10000, offset: 0 }),
      this.storage.listAgentProfiles({ projectId: input.projectId, limit: 10000, offset: 0 }),
      this.storage.listAgents(input.projectId, { limit: 10000, offset: 0 }),
      this.storage.listStatuses(input.projectId, { limit: 10000, offset: 0 }),
      this.storage.listWatchers(input.projectId),
      this.storage.listSubscribers(input.projectId),
    ]);

    // Find unmatched statuses (existing statuses not in template that have epics)
    const templateStatusLabels = new Set(payload.statuses.map((s) => s.label.trim().toLowerCase()));
    const unmatchedStatuses: Array<{
      id: string;
      label: string;
      color: string;
      epicCount: number;
    }> = [];

    for (const s of existingStatuses.items) {
      const labelKey = s.label.trim().toLowerCase();
      if (!templateStatusLabels.has(labelKey)) {
        const epicCount = await this.storage.countEpicsByStatus(s.id);
        if (epicCount > 0) {
          unmatchedStatuses.push({
            id: s.id,
            label: s.label,
            color: s.color,
            epicCount,
          });
        }
      }
    }

    if (isDryRun) {
      // Build base dry-run response
      const dryRunResponse: {
        dryRun: true;
        missingProviders: string[];
        unmatchedStatuses: typeof unmatchedStatuses;
        templateStatuses: { label: string; color: string }[];
        providerMappingRequired?: {
          missingProviders: string[];
          familyAlternatives: FamilyAlternative[];
          canImport: boolean;
        };
        counts: {
          toImport: {
            prompts: number;
            profiles: number;
            agents: number;
            statuses: number;
            watchers: number;
            subscribers: number;
          };
          toDelete: {
            prompts: number;
            profiles: number;
            agents: number;
            statuses: number;
            watchers: number;
            subscribers: number;
          };
        };
      } = {
        dryRun: true,
        missingProviders,
        unmatchedStatuses,
        templateStatuses: payload.statuses.map((s) => ({
          label: s.label,
          color: s.color,
        })),
        counts: {
          toImport: {
            prompts: payload.prompts.length,
            // Profile count reflects selected profiles after mapping
            profiles: selectedProfilesByFamily.profilesToCreate.length,
            agents: payload.agents.length,
            statuses: payload.statuses.length,
            watchers: payload.watchers.length,
            subscribers: payload.subscribers.length,
          },
          toDelete: {
            prompts: existingPrompts.total,
            profiles: existingProfiles.total,
            agents: existingAgents.total,
            statuses: existingStatuses.total,
            watchers: existingWatchers.length,
            subscribers: existingSubscribers.length,
          },
        },
      };

      // Only include providerMappingRequired if mapping is needed and not provided
      if (needsMapping && !input.familyProviderMappings) {
        dryRunResponse.providerMappingRequired = {
          missingProviders: familyResult.missingProviders,
          familyAlternatives: familyResult.alternatives,
          canImport: familyResult.canImport,
        };
      }

      return dryRunResponse;
    }

    // Require provider mapping if defaults are missing (mirrors createFromTemplate behavior)
    if (needsMapping && !input.familyProviderMappings) {
      return {
        success: false,
        providerMappingRequired: {
          missingProviders: familyResult.missingProviders,
          familyAlternatives: familyResult.alternatives,
          canImport: familyResult.canImport,
        },
      };
    }

    // Enforce canImport server-side - block if no alternatives available
    if (!familyResult.canImport) {
      throw new ValidationError(
        'Cannot import: some profile families have no available providers',
        {
          hint: 'Install the required providers or use a different template',
          missingProviders: familyResult.missingProviders,
          familyAlternatives: familyResult.alternatives,
        },
      );
    }

    // Check if import can proceed based on selected profiles
    // When familyProviderMappings is provided, we use only the selected profiles, not all
    // So we check if the selected profiles' providers are all available
    const selectedProviderNames = new Set(
      selectedProfilesByFamily.profilesToCreate.map((p) => p.provider.name.trim().toLowerCase()),
    );
    const unavailableSelectedProviders = Array.from(selectedProviderNames).filter(
      (name) => !available.has(name),
    );

    if (unavailableSelectedProviders.length > 0) {
      throw new ValidationError('Import aborted: missing providers', {
        missingProviders: unavailableSelectedProviders,
        hint: 'Install/configure providers by name before importing profiles.',
      });
    }

    // Guard: abort if any agents have active sessions in this project
    // Use fast DB-only check (no tmux validation) to avoid hanging on many sessions
    const activeSessions = this.sessions.getActiveSessionsForProject(input.projectId);
    if (activeSessions.length > 0) {
      throw new ConflictError('Import aborted: active agent sessions detected', {
        activeSessions: activeSessions.map((s) => ({ id: s.id, agentId: s.agentId })),
        hint: 'Terminate all running sessions for this project before importing.',
      });
    }

    // REPLACE semantics: delete existing project-scoped data (preserve epics and statuses)
    // Order matters: agents → profiles → prompts → initial prompt mapping
    // Note: We preserve statuses and epics, remapping references by label/name

    try {
      // Build map of old agent ID -> name for later epic remapping
      const oldAgentIdToName = new Map<string, string>();
      for (const a of existingAgents.items) {
        oldAgentIdToName.set(a.id, a.name.trim().toLowerCase());
      }

      for (const a of existingAgents.items) {
        await this.storage.deleteAgent(a.id);
      }
      for (const p of existingProfiles.items) {
        await this.storage.deleteAgentProfile(p.id);
      }
      for (const pr of existingPrompts.items) {
        await this.storage.deletePrompt(pr.id);
      }

      // Delete existing watchers (stops polling via WatchersService)
      for (const w of existingWatchers) {
        await this.watchersService.deleteWatcher(w.id);
      }

      // Delete existing subscribers
      for (const s of existingSubscribers) {
        await this.storage.deleteSubscriber(s.id);
      }

      // Clear per-project initial prompt mapping
      await this.settings.updateSettings({
        projectId: input.projectId,
        initialSessionPromptId: null,
      });

      // Create new entities and build mappings
      const statusIdMap: Record<string, string> = {};
      const promptIdMap: Record<string, string> = {};
      const profileIdMap: Record<string, string> = {};
      const agentIdMap: Record<string, string> = {};

      // Statuses: match by label, update existing or create new
      const existingStatusByLabel = new Map<string, (typeof existingStatuses.items)[0]>();
      for (const s of existingStatuses.items) {
        existingStatusByLabel.set(s.label.trim().toLowerCase(), s);
      }

      // Shift all existing status positions to temporary high values to avoid unique constraint conflicts
      // during import (projectId + position is unique)
      const TEMP_POSITION_OFFSET = 100000;
      for (const s of existingStatuses.items) {
        await this.storage.updateStatus(s.id, { position: s.position + TEMP_POSITION_OFFSET });
      }

      for (const s of payload.statuses.sort((a, b) => a.position - b.position)) {
        const labelKey = s.label.trim().toLowerCase();
        const existing = existingStatusByLabel.get(labelKey);

        if (existing) {
          // Update existing status with new properties
          const updated = await this.storage.updateStatus(existing.id, {
            color: s.color,
            position: s.position,
            mcpHidden: s.mcpHidden,
          });
          if (s.id) statusIdMap[s.id] = updated.id;
          existingStatusByLabel.delete(labelKey); // Mark as processed
        } else {
          // Create new status
          const created = await this.storage.createStatus({
            projectId: input.projectId,
            label: s.label,
            color: s.color,
            position: s.position,
            mcpHidden: s.mcpHidden,
          });
          if (s.id) statusIdMap[s.id] = created.id;
        }
      }

      // Build map of template status label -> actual status ID
      const templateLabelToStatusId = new Map<string, string>();
      const allStatuses = await this.storage.listStatuses(input.projectId, {
        limit: 10000,
        offset: 0,
      });
      for (const s of allStatuses.items) {
        templateLabelToStatusId.set(s.label.trim().toLowerCase(), s.id);
      }

      // Apply status mappings: remap epics and delete old unmatched statuses
      if (input.statusMappings && Object.keys(input.statusMappings).length > 0) {
        let epicsMapped = 0;
        let statusesDeleted = 0;

        for (const [oldStatusId, targetLabel] of Object.entries(input.statusMappings)) {
          const targetStatusId = templateLabelToStatusId.get(targetLabel.trim().toLowerCase());
          if (targetStatusId) {
            // Update all epics using oldStatusId to use targetStatusId
            const remapped = await this.storage.updateEpicsStatus(oldStatusId, targetStatusId);
            epicsMapped += remapped;
            // Delete the old unmatched status
            await this.storage.deleteStatus(oldStatusId);
            statusesDeleted++;
          }
        }

        logger.info(
          { epicsMapped, statusesDeleted },
          'Applied status mappings: epics remapped and old statuses deleted',
        );
      }

      // Prompts
      const createdPrompts: Array<{ id: string; title: string }> = [];
      for (const p of payload.prompts) {
        const created = await this.storage.createPrompt({
          projectId: input.projectId,
          title: p.title,
          content: p.content,
          tags: p.tags ?? [],
        });
        if (p.id) promptIdMap[p.id] = created.id;
        createdPrompts.push({ id: created.id, title: created.title });
      }

      // Profiles - build ID map (with synthetic keys for items without IDs)
      // Use selectedProfilesByFamily to only create profiles needed after family mapping
      for (const prof of selectedProfilesByFamily.profilesToCreate) {
        // Create profile (providerId and options now live on profile_provider_configs)
        const created = await this.storage.createAgentProfile({
          projectId: input.projectId,
          name: prof.name,
          familySlug: prof.familySlug ?? null,
          systemPrompt: null,
          instructions: prof.instructions ?? null,
          temperature: prof.temperature ?? null,
          maxTokens: prof.maxTokens ?? null,
        });
        // Use synthetic key for items without ID (enables helper to build name maps)
        const profKey = prof.id || `name:${prof.name.trim().toLowerCase()}`;
        profileIdMap[profKey] = created.id;
      }

      // Provider Configs - create configs for each profile and build lookup map
      // Map: { newProfileId, configName } -> newConfigId
      const configLookupMap = new Map<string, string>(); // key: `${newProfileId}:${configName}`
      const configIdMap: Record<string, string> = {};

      for (const prof of selectedProfilesByFamily.profilesToCreate) {
        const profKey = prof.id || `name:${prof.name.trim().toLowerCase()}`;
        const newProfileId = profileIdMap[profKey];
        if (!newProfileId) continue;

        // Check if profile has providerConfigs (new format)
        const providerConfigs = (
          prof as {
            providerConfigs?: Array<{
              name: string;
              providerName: string;
              options?: string | null;
              env?: Record<string, string> | null;
            }>;
          }
        ).providerConfigs;

        if (providerConfigs && providerConfigs.length > 0) {
          // New format: create configs from providerConfigs array
          for (const config of providerConfigs) {
            const configProviderId = available.get(config.providerName.trim().toLowerCase());
            if (!configProviderId) {
              logger.warn(
                { profileName: prof.name, providerName: config.providerName },
                'Provider not found for config, skipping',
              );
              continue;
            }

            const createdConfig = await this.storage.createProfileProviderConfig({
              profileId: newProfileId,
              providerId: configProviderId,
              name: config.name,
              options: config.options ?? null,
              env: config.env ?? null,
            });

            const lookupKey = `${newProfileId}:${config.name.trim().toLowerCase()}`;
            configLookupMap.set(lookupKey, createdConfig.id);
            configIdMap[`${profKey}:${config.name}`] = createdConfig.id;
          }
        } else {
          // Legacy format: create default config from profile's provider
          const providerName = prof.provider.name.trim().toLowerCase();
          const configProviderId = available.get(providerName);
          if (configProviderId) {
            // Normalize options to string format
            const options =
              prof.options != null
                ? typeof prof.options === 'string'
                  ? prof.options
                  : JSON.stringify(prof.options)
                : null;

            const createdConfig = await this.storage.createProfileProviderConfig({
              profileId: newProfileId,
              providerId: configProviderId,
              name: 'default', // Legacy profiles get 'default' as config name
              options,
              env: null,
            });

            // Use 'default' as config name for legacy profiles
            const lookupKey = `${newProfileId}:default`;
            configLookupMap.set(lookupKey, createdConfig.id);
            configIdMap[`${profKey}:default`] = createdConfig.id;
          }
        }
      }

      // Agents - build ID map (with synthetic keys for items without IDs)
      // Use agentProfileMap to remap profile assignments based on family mappings
      for (const a of payload.agents) {
        // Check if agent's profile was remapped due to family provider mapping
        const remappedProfileId = selectedProfilesByFamily.agentProfileMap.get(a.id ?? '');
        const oldProfileId = remappedProfileId ?? a.profileId ?? '';
        const newProfileId =
          oldProfileId && profileIdMap[oldProfileId] ? profileIdMap[oldProfileId] : undefined;
        if (!newProfileId) {
          throw new ValidationError(`Profile mapping missing for agent ${a.name}`, {
            profileId: oldProfileId || null,
          });
        }

        // Resolve providerConfigName to providerConfigId
        let providerConfigId: string | undefined;
        const agentWithConfig = a as { providerConfigName?: string | null };
        if (agentWithConfig.providerConfigName && newProfileId) {
          const lookupKey = `${newProfileId}:${agentWithConfig.providerConfigName.trim().toLowerCase()}`;
          providerConfigId = configLookupMap.get(lookupKey);
        }
        // If no providerConfigName provided, try to use first config for the profile from the lookup map
        if (!providerConfigId && newProfileId) {
          // Find any config for this profile in the lookup map (prefix match on profileId:)
          const profilePrefix = `${newProfileId}:`;
          for (const [key, configId] of configLookupMap.entries()) {
            if (key.startsWith(profilePrefix)) {
              providerConfigId = configId;
              break;
            }
          }
        }
        if (!providerConfigId) {
          throw new ValidationError(`No provider config available for agent ${a.name}`, {
            profileId: newProfileId,
            providerConfigName: agentWithConfig.providerConfigName || null,
          });
        }

        const created = await this.storage.createAgent({
          projectId: input.projectId,
          name: a.name,
          profileId: newProfileId,
          description: a.description ?? null,
          providerConfigId,
        });
        // Use synthetic key for items without ID (enables helper to build name maps)
        const agentKey = a.id || `name:${a.name.trim().toLowerCase()}`;
        agentIdMap[agentKey] = created.id;
      }

      // Build name-to-ID maps for scope resolution using helper
      // Create augmented payload with synthetic IDs for items without original IDs
      // Use selectedProfilesByFamily.profilesToCreate for profiles to match what was actually created
      const augmentedPayload = {
        agents: payload.agents.map((a) => ({
          ...a,
          id: a.id || `name:${a.name.trim().toLowerCase()}`,
        })),
        profiles: selectedProfilesByFamily.profilesToCreate.map((p) => ({
          ...p,
          id: p.id || `name:${p.name.trim().toLowerCase()}`,
        })),
      };
      const { agentNameToId: agentNameToNewId, profileNameToId: profileNameToNewId } =
        this.buildNameToIdMaps(augmentedPayload, { agentIdMap, profileIdMap });

      // Create watchers using helper (handles scope resolution and auto-start)
      // Pass profileNameRemapMap to handle watcher scope fallback when profiles are remapped
      const { watcherIdMap } = await this.createWatchersFromPayload(
        input.projectId,
        payload.watchers,
        {
          agentNameToId: agentNameToNewId,
          profileNameToId: profileNameToNewId,
          providerNameToId: available,
          profileNameRemapMap: selectedProfilesByFamily.profileNameRemapMap,
        },
      );

      // Create subscribers using helper
      const { subscriberIdMap } = await this.createSubscribersFromPayload(
        input.projectId,
        payload.subscribers,
      );

      logger.info(
        {
          watchersCreated: payload.watchers.length,
          subscribersCreated: payload.subscribers.length,
        },
        'Watchers and subscribers imported',
      );

      // Remap epic agentId references: match by agent name or clear
      // (reuse agentNameToNewId map built during agent creation for robust resolution)

      // Fetch all epics for this project and update agentId references
      const existingEpics = await this.storage.listEpics(input.projectId, {
        limit: 100000,
        offset: 0,
      });

      let epicsRemapped = 0;
      let epicsCleared = 0;
      for (const epic of existingEpics.items) {
        if (epic.agentId) {
          // Find the old agent's name
          const oldAgentName = oldAgentIdToName.get(epic.agentId);
          if (oldAgentName) {
            // Try to find a matching new agent by name using the name-to-newId map
            const newAgentId = agentNameToNewId.get(oldAgentName);
            if (newAgentId) {
              // Remap to new agent
              await this.storage.updateEpic(epic.id, { agentId: newAgentId }, epic.version);
              epicsRemapped++;
            } else {
              // No matching agent, clear the reference
              await this.storage.updateEpic(epic.id, { agentId: null }, epic.version);
              epicsCleared++;
            }
          } else {
            // Old agent not found (orphaned reference), clear it
            await this.storage.updateEpic(epic.id, { agentId: null }, epic.version);
            epicsCleared++;
          }
        }
      }

      logger.info({ epicsRemapped, epicsCleared }, 'Epic agent references updated after import');

      // Apply projectSettings from payload using helper
      // Merge initial prompt: payload.initialPrompt takes precedence over projectSettings.initialPromptTitle
      // This consolidates the dual-mechanism into a single path through applyProjectSettings.
      let mergedInitialPromptTitle: string | undefined;
      if (payload.initialPrompt?.title) {
        // payload.initialPrompt.title takes highest precedence
        mergedInitialPromptTitle = payload.initialPrompt.title;
      } else if (payload.initialPrompt?.promptId) {
        // If only promptId is specified, look up the title from payload.prompts
        const matchingPrompt = payload.prompts.find(
          (p) => p.id === payload.initialPrompt!.promptId,
        );
        if (matchingPrompt) {
          mergedInitialPromptTitle = matchingPrompt.title;
        }
      } else if (payload.projectSettings?.initialPromptTitle) {
        // Fall back to projectSettings.initialPromptTitle
        mergedInitialPromptTitle = payload.projectSettings.initialPromptTitle;
      }

      const mergedSettings = payload.projectSettings
        ? { ...payload.projectSettings, initialPromptTitle: mergedInitialPromptTitle }
        : mergedInitialPromptTitle
          ? { initialPromptTitle: mergedInitialPromptTitle }
          : undefined;

      // Build promptTitleToId map from created prompts
      const promptTitleToId = new Map<string, string>();
      for (const cp of createdPrompts) {
        promptTitleToId.set(cp.title.toLowerCase(), cp.id);
      }
      // Find Archive status ID for fallback
      const archiveStatusId = templateLabelToStatusId.get('archive') ?? null;

      const settingsResult = await this.applyProjectSettings(
        input.projectId,
        mergedSettings,
        { promptTitleToId, statusLabelToId: templateLabelToStatusId },
        archiveStatusId,
      );
      const initialPromptSet = settingsResult.initialPromptSet;

      // Update template metadata if manifest is present
      if (payload._manifest?.slug) {
        // Determine if template is bundled or registry-sourced
        let templateSource: 'bundled' | 'registry' = 'registry';
        try {
          this.unifiedTemplateService.getBundledTemplate(payload._manifest.slug);
          templateSource = 'bundled';
        } catch {
          // Not a bundled template, use registry source
          templateSource = 'registry';
        }

        await this.settings.setProjectTemplateMetadata(input.projectId, {
          templateSlug: payload._manifest.slug,
          source: templateSource,
          installedVersion: payload._manifest.version ?? null,
          registryUrl: null, // Unknown source URL during import
          installedAt: new Date().toISOString(),
        });
        logger.info(
          { projectId: input.projectId, slug: payload._manifest.slug, source: templateSource },
          'Updated template metadata after import',
        );
      }

      // Replace presets from template (if present)
      const rawPresets = (payload as { presets?: unknown }).presets;
      const templatePresets = Array.isArray(rawPresets) ? rawPresets : [];
      if (templatePresets.length > 0) {
        await this.settings.setProjectPresets(input.projectId, templatePresets);
        logger.info(
          { projectId: input.projectId, presetCount: templatePresets.length },
          'Presets replaced from template during import',
        );
      } else {
        // Clear existing presets if template has none
        await this.settings.clearProjectPresets(input.projectId);
        logger.info(
          { projectId: input.projectId },
          'Presets cleared during import (template has none)',
        );
      }

      return {
        success: true,
        mode: 'replace',
        replaced: true,
        missingProviders: [],
        counts: {
          imported: {
            prompts: payload.prompts.length,
            profiles: payload.profiles.length,
            agents: payload.agents.length,
            statuses: payload.statuses.length,
            watchers: payload.watchers.length,
            subscribers: payload.subscribers.length,
          },
          deleted: {
            prompts: existingPrompts.total,
            profiles: existingProfiles.total,
            agents: existingAgents.total,
            statuses: 0, // Statuses are preserved/updated, not deleted
            watchers: existingWatchers.length,
            subscribers: existingSubscribers.length,
          },
          epics: {
            preserved: existingEpics.total,
            agentRemapped: epicsRemapped,
            agentCleared: epicsCleared,
          },
        },
        mappings: {
          promptIdMap,
          profileIdMap,
          agentIdMap,
          statusIdMap,
          watcherIdMap,
          subscriberIdMap,
        },
        initialPromptSet,
        message: 'Project configuration replaced. Epics preserved.',
      };
    } catch (error) {
      logger.error({ error, projectId: input.projectId }, 'Import failed');
      const message = this.getImportErrorMessage(error);
      throw new StorageError(message);
    }
  }

  /**
   * Resolve provider names to IDs and identify missing providers.
   * Used by both createFromTemplate and importProject for provider precheck.
   *
   * @param providerNames - Set of provider names (already lowercased and trimmed)
   * @returns available map (name → id) and missing array of unresolved names
   */
  private async resolveProviders(providerNames: Set<string>): Promise<{
    available: Map<string, string>;
    missing: string[];
  }> {
    const providers = await this.storage.listProviders();
    const available = new Map<string, string>();
    for (const prov of providers.items) {
      available.set(prov.name.trim().toLowerCase(), prov.id);
    }
    const missing = Array.from(providerNames).filter((n) => !available.has(n));
    return { available, missing };
  }

  /**
   * Compute per-family provider alternatives based on template profiles and locally available providers.
   * Used to determine which providers can substitute for missing defaults during template import.
   *
   * Only considers families that are actually used by agents in the template.
   *
   * @param templateProfiles - Profile definitions from the template
   * @param templateAgents - Agent definitions from the template (to filter to used families)
   * @returns Family alternatives, missing providers, and whether import can proceed
   */
  async computeFamilyAlternatives(
    templateProfiles: Array<{
      id?: string;
      name: string;
      provider: { name: string };
      familySlug?: string | null;
    }>,
    templateAgents: Array<{
      id?: string;
      name: string;
      profileId?: string;
    }>,
  ): Promise<FamilyAlternativesResult> {
    // 1. Get locally available providers
    const localProviders = await this.storage.listProviders();
    const availableProviderNames = new Set(
      localProviders.items.map((p) => p.name.trim().toLowerCase()),
    );

    // 2. Build profileId -> profile map for agent lookups
    const profileById = new Map<string, (typeof templateProfiles)[0]>();
    for (const prof of templateProfiles) {
      if (prof.id) {
        profileById.set(prof.id, prof);
      }
    }

    // 3. Identify families actually used by agents
    const usedFamilySlugs = new Set<string>();
    for (const agent of templateAgents) {
      if (agent.profileId) {
        const profile = profileById.get(agent.profileId);
        if (profile?.familySlug) {
          usedFamilySlugs.add(profile.familySlug);
        }
      }
    }

    // 4. Group profiles by familySlug and track providers per family
    // Map: familySlug -> Map<providerName, profileName[]>
    const familyProviders = new Map<string, Map<string, string[]>>();

    for (const prof of templateProfiles) {
      const familySlug = prof.familySlug;
      if (!familySlug) continue;

      if (!familyProviders.has(familySlug)) {
        familyProviders.set(familySlug, new Map());
      }

      const providerName = prof.provider.name.trim().toLowerCase();
      const familyMap = familyProviders.get(familySlug)!;

      if (!familyMap.has(providerName)) {
        familyMap.set(providerName, []);
      }
      familyMap.get(providerName)!.push(prof.name);
    }

    // 5. For each used family, compute alternatives
    const alternatives: FamilyAlternative[] = [];
    const allMissingProviders = new Set<string>();
    let canImport = true;

    for (const familySlug of usedFamilySlugs) {
      const providersForFamily = familyProviders.get(familySlug);

      if (!providersForFamily || providersForFamily.size === 0) {
        // Family has no profiles - shouldn't happen but handle gracefully
        logger.warn({ familySlug }, 'Family used by agent has no profiles');
        continue;
      }

      // Get all provider names for this family
      const providerNamesForFamily = Array.from(providersForFamily.keys());

      // Find the default provider (first profile's provider in the family)
      // We use the first one as the "default" since template order matters
      const defaultProvider = providerNamesForFamily[0];
      const defaultProviderAvailable = availableProviderNames.has(defaultProvider);

      // Find available providers for this family
      const availableForFamily = providerNamesForFamily.filter((name) =>
        availableProviderNames.has(name),
      );

      // Track missing providers
      for (const provName of providerNamesForFamily) {
        if (!availableProviderNames.has(provName)) {
          allMissingProviders.add(provName);
        }
      }

      // Determine if import can proceed for this family
      const hasAlternatives = availableForFamily.length > 0;
      if (!hasAlternatives) {
        canImport = false;
      }

      alternatives.push({
        familySlug,
        defaultProvider,
        defaultProviderAvailable,
        availableProviders: availableForFamily.sort(),
        hasAlternatives,
      });
    }

    return {
      alternatives,
      missingProviders: Array.from(allMissingProviders).sort(),
      canImport,
    };
  }

  /**
   * Select profiles for each family based on family-provider mappings.
   * Returns the profiles to create and a map of agent IDs to their (possibly remapped) profile IDs.
   *
   * @param templateProfiles - All profiles from the template
   * @param templateAgents - All agents from the template
   * @param familyProviderMappings - Optional mappings of familySlug -> providerName
   * @param availableProviders - Map of provider name -> provider ID
   * @returns Profiles to create and agent->profile remapping
   */
  private selectProfilesForFamilies(
    templateProfiles: Array<{
      id?: string;
      name: string;
      provider: { name: string };
      familySlug?: string | null;
      options?: unknown;
      instructions?: string | null;
      temperature?: number | null;
      maxTokens?: number | null;
    }>,
    templateAgents: Array<{
      id?: string;
      name: string;
      profileId?: string;
    }>,
    familyProviderMappings: Record<string, string> | undefined,
    availableProviders: Map<string, string>,
  ): {
    profilesToCreate: typeof templateProfiles;
    agentProfileMap: Map<string, string | undefined>;
    /** Maps original profile names to selected profile names for profiles in the same family (for watcher scope remap) */
    profileNameRemapMap: Map<string, string>;
  } {
    // Build profile lookup maps
    const profileById = new Map<string, (typeof templateProfiles)[0]>();
    for (const prof of templateProfiles) {
      if (prof.id) {
        profileById.set(prof.id, prof);
      }
    }

    // Group profiles by familySlug and provider
    // Map: familySlug -> Map<providerName, profile>
    const profilesByFamilyAndProvider = new Map<
      string,
      Map<string, (typeof templateProfiles)[0]>
    >();
    for (const prof of templateProfiles) {
      if (!prof.familySlug) continue;
      const family = prof.familySlug;
      const providerName = prof.provider.name.trim().toLowerCase();

      if (!profilesByFamilyAndProvider.has(family)) {
        profilesByFamilyAndProvider.set(family, new Map());
      }
      // Keep only the first profile per family/provider combo
      const familyMap = profilesByFamilyAndProvider.get(family)!;
      if (!familyMap.has(providerName)) {
        familyMap.set(providerName, prof);
      }
    }

    // Build a map of family -> original provider based on agent profileId assignments
    // This determines which provider agents in each family were originally using
    const familyOriginalProviders = new Map<string, string>();
    for (const agent of templateAgents) {
      if (!agent.profileId) continue;
      const profile = profileById.get(agent.profileId);
      if (!profile?.familySlug) continue;

      const providerName = profile.provider.name.trim().toLowerCase();
      // Track which provider agents in this family are using
      // If multiple agents use different providers, we keep the last one (arbitrary but consistent)
      familyOriginalProviders.set(profile.familySlug, providerName);
    }

    // Determine which profile to use for each family (for agent mapping)
    // This only affects which profile agents are assigned to, NOT which profiles are imported
    const selectedProfileIdsByFamily = new Map<string, string>();

    for (const [familySlug, providerMap] of profilesByFamilyAndProvider) {
      let selectedProvider: string | undefined;

      if (familyProviderMappings?.[familySlug]) {
        // Use mapped provider
        selectedProvider = familyProviderMappings[familySlug].trim().toLowerCase();
      } else {
        // Use agent's original provider if available, otherwise fall back to first available
        const originalProvider = familyOriginalProviders.get(familySlug);
        if (
          originalProvider &&
          availableProviders.has(originalProvider) &&
          providerMap.has(originalProvider)
        ) {
          selectedProvider = originalProvider;
        } else {
          // Fall back to first available provider for this family
          for (const provName of providerMap.keys()) {
            if (availableProviders.has(provName)) {
              selectedProvider = provName;
              break;
            }
          }
        }
      }

      if (selectedProvider && providerMap.has(selectedProvider)) {
        const profile = providerMap.get(selectedProvider)!;
        if (profile.id) {
          selectedProfileIdsByFamily.set(familySlug, profile.id);
        }
      }
    }

    // Import ALL profiles whose provider is available (not just one per family)
    const profilesToCreate: typeof templateProfiles = [];
    const usedProfileIds = new Set<string>();

    for (const prof of templateProfiles) {
      if (!prof.id || usedProfileIds.has(prof.id)) continue;

      const providerName = prof.provider.name.trim().toLowerCase();
      if (availableProviders.has(providerName)) {
        usedProfileIds.add(prof.id);
        profilesToCreate.push(prof);
      }
    }

    // Build agent -> profile mapping
    const agentProfileMap = new Map<string, string | undefined>();
    for (const agent of templateAgents) {
      if (!agent.id || !agent.profileId) continue;

      const originalProfile = profileById.get(agent.profileId);
      if (!originalProfile) {
        agentProfileMap.set(agent.id, agent.profileId);
        continue;
      }

      if (originalProfile.familySlug) {
        // This agent uses a family - remap to selected profile for that family
        const selectedProfileId = selectedProfileIdsByFamily.get(originalProfile.familySlug);
        agentProfileMap.set(agent.id, selectedProfileId ?? agent.profileId);
      } else {
        // No family - keep original profile reference
        agentProfileMap.set(agent.id, agent.profileId);
      }
    }

    // Build profile name remap map for watcher scope resolution
    // Maps original profile names to selected profile names for profiles in the same family
    const profileNameRemapMap = new Map<string, string>();
    for (const [familySlug, providerMap] of profilesByFamilyAndProvider) {
      // Find the selected profile for this family
      const selectedProfileId = selectedProfileIdsByFamily.get(familySlug);
      const selectedProfile = selectedProfileId
        ? templateProfiles.find((p) => p.id === selectedProfileId)
        : undefined;

      if (selectedProfile) {
        const selectedNameLower = selectedProfile.name.trim().toLowerCase();
        // Map all profile names in this family to the selected profile name
        // providerMap.values() contains profile objects (one per provider)
        for (const profile of providerMap.values()) {
          const profileNameLower = profile.name.trim().toLowerCase();
          if (profileNameLower !== selectedNameLower) {
            profileNameRemapMap.set(profileNameLower, selectedNameLower);
          }
        }
      }
    }

    return { profilesToCreate, agentProfileMap, profileNameRemapMap };
  }

  /**
   * Build name-to-ID maps for agents and profiles.
   * Used for watcher/subscriber scope resolution by name.
   *
   * @param payload - Payload containing agents and profiles with names
   * @param mappings - ID mappings (old ID → new ID)
   * @returns Maps of name (lowercase) → new ID for both agents and profiles
   */
  private buildNameToIdMaps(
    payload: {
      agents: Array<{ id?: string; name: string }>;
      profiles: Array<{ id?: string; name: string }>;
    },
    mappings: {
      agentIdMap: Record<string, string>;
      profileIdMap: Record<string, string>;
    },
  ): {
    agentNameToId: Map<string, string>;
    profileNameToId: Map<string, string>;
  } {
    const agentNameToId = new Map<string, string>();
    for (const a of payload.agents) {
      if (a.id && mappings.agentIdMap[a.id]) {
        const nameLower = a.name.trim().toLowerCase();
        if (agentNameToId.has(nameLower)) {
          logger.warn(
            {
              name: a.name,
              existingId: agentNameToId.get(nameLower),
              newId: mappings.agentIdMap[a.id],
            },
            'Duplicate agent name detected, using last occurrence',
          );
        }
        agentNameToId.set(nameLower, mappings.agentIdMap[a.id]);
      }
    }

    const profileNameToId = new Map<string, string>();
    for (const prof of payload.profiles) {
      if (prof.id && mappings.profileIdMap[prof.id]) {
        const nameLower = prof.name.trim().toLowerCase();
        if (profileNameToId.has(nameLower)) {
          logger.warn(
            {
              name: prof.name,
              existingId: profileNameToId.get(nameLower),
              newId: mappings.profileIdMap[prof.id],
            },
            'Duplicate profile name detected, using last occurrence',
          );
        }
        profileNameToId.set(nameLower, mappings.profileIdMap[prof.id]);
      }
    }

    return { agentNameToId, profileNameToId };
  }

  /**
   * Create watchers from a payload with scope resolution.
   * Uses WatchersService.createWatcher() which handles start automatically.
   *
   * @param projectId - Project ID
   * @param watchers - Watchers payload array
   * @param maps - Name-to-ID maps for scope resolution
   * @returns Created count and ID map
   */
  private async createWatchersFromPayload(
    projectId: string,
    watchers: Array<{
      id?: string;
      name: string;
      description?: string | null;
      enabled: boolean;
      scope: 'all' | 'agent' | 'profile' | 'provider';
      scopeFilterName?: string | null;
      pollIntervalMs: number;
      viewportLines: number;
      idleAfterSeconds?: number;
      condition: {
        type: 'contains' | 'regex' | 'not_contains';
        pattern: string;
        flags?: string;
      };
      cooldownMs: number;
      cooldownMode: 'time' | 'until_clear';
      eventName: string;
    }>,
    maps: {
      agentNameToId: Map<string, string>;
      profileNameToId: Map<string, string>;
      providerNameToId: Map<string, string>;
      /** Optional map for remapping profile names when provider families are remapped */
      profileNameRemapMap?: Map<string, string>;
    },
  ): Promise<{
    created: number;
    watcherIdMap: Record<string, string>;
  }> {
    const watcherIdMap: Record<string, string> = {};
    let created = 0;

    for (const w of watchers) {
      let scopeFilterId: string | null = null;

      if (w.scopeFilterName && w.scope !== 'all') {
        const scopeFilterNameLower = w.scopeFilterName.trim().toLowerCase();
        switch (w.scope) {
          case 'agent': {
            scopeFilterId = maps.agentNameToId.get(scopeFilterNameLower) ?? null;
            break;
          }
          case 'profile': {
            // First try direct lookup
            scopeFilterId = maps.profileNameToId.get(scopeFilterNameLower) ?? null;
            // If not found and we have a remap map, try to find remapped profile name
            if (!scopeFilterId && maps.profileNameRemapMap) {
              const remappedName = maps.profileNameRemapMap.get(scopeFilterNameLower);
              if (remappedName) {
                scopeFilterId = maps.profileNameToId.get(remappedName) ?? null;
                if (scopeFilterId) {
                  logger.info(
                    {
                      projectId,
                      watcherName: w.name,
                      originalProfile: w.scopeFilterName,
                      remappedProfile: remappedName,
                    },
                    'Watcher profile scope remapped due to provider family selection',
                  );
                }
              }
            }
            break;
          }
          case 'provider': {
            scopeFilterId = maps.providerNameToId.get(scopeFilterNameLower) ?? null;
            break;
          }
        }

        // If scope filter not resolved, warn and fallback to 'all'
        if (!scopeFilterId) {
          logger.warn(
            { projectId, watcherName: w.name, scope: w.scope, scopeFilterName: w.scopeFilterName },
            'Could not resolve scope filter, setting scope to "all"',
          );
        }
      }

      // Use WatchersService.createWatcher() which handles start automatically
      const createdWatcher = await this.watchersService.createWatcher({
        projectId,
        name: w.name,
        description: w.description ?? null,
        enabled: w.enabled,
        scope: scopeFilterId ? w.scope : 'all', // Fallback to 'all' if not resolved
        scopeFilterId,
        pollIntervalMs: w.pollIntervalMs,
        viewportLines: w.viewportLines,
        idleAfterSeconds: w.idleAfterSeconds ?? 0,
        condition: w.condition,
        cooldownMs: w.cooldownMs,
        cooldownMode: w.cooldownMode,
        eventName: w.eventName,
      });

      if (w.id) watcherIdMap[w.id] = createdWatcher.id;
      created++;
    }

    return { created, watcherIdMap };
  }

  /**
   * Create subscribers from a payload.
   *
   * @param projectId - Project ID
   * @param subscribers - Subscribers payload array
   * @returns Created count and ID map
   */
  private async createSubscribersFromPayload(
    projectId: string,
    subscribers: Array<{
      id?: string;
      name: string;
      description?: string | null;
      enabled: boolean;
      eventName: string;
      eventFilter?: {
        field: string;
        operator: 'equals' | 'contains' | 'regex';
        value: string;
      } | null;
      actionType: string;
      actionInputs: Record<
        string,
        { source: 'event_field' | 'custom'; eventField?: string; customValue?: string }
      >;
      delayMs: number;
      cooldownMs: number;
      retryOnError: boolean;
      groupName?: string | null;
      position?: number;
      priority?: number;
    }>,
  ): Promise<{
    created: number;
    subscriberIdMap: Record<string, string>;
  }> {
    const subscriberIdMap: Record<string, string> = {};
    let created = 0;

    for (const s of subscribers) {
      const createdSubscriber = await this.storage.createSubscriber({
        projectId,
        name: s.name,
        description: s.description ?? null,
        enabled: s.enabled,
        eventName: s.eventName,
        eventFilter: s.eventFilter ?? null,
        actionType: s.actionType,
        actionInputs: s.actionInputs,
        delayMs: s.delayMs,
        cooldownMs: s.cooldownMs,
        retryOnError: s.retryOnError,
        groupName: s.groupName ?? null,
        position: s.position ?? 0,
        priority: s.priority ?? 0,
      });

      if (s.id) subscriberIdMap[s.id] = createdSubscriber.id;
      created++;
    }

    return { created, subscriberIdMap };
  }

  /**
   * Apply project settings from template/import payload.
   * Unified behavior: Archive fallback applies to BOTH createFromTemplate and importProject.
   *
   * **Initial Prompt Precedence:**
   * Callers merge `payload.initialPrompt` with `projectSettings.initialPromptTitle` before calling:
   * 1. `payload.initialPrompt.title` (highest precedence)
   * 2. `payload.initialPrompt.promptId` (resolved to title via payload.prompts)
   * 3. `projectSettings.initialPromptTitle` (fallback)
   *
   * @param projectId - Project ID
   * @param projectSettings - Merged project settings (with initialPromptTitle already resolved)
   * @param maps - Pre-built name-to-ID maps for lookup (promptTitleToId, statusLabelToId)
   * @param archiveStatusId - The ID of the Archive status for fallback auto-clean, or null if none
   * @returns Object with initialPromptSet boolean indicating if initial prompt was configured
   */
  private async applyProjectSettings(
    projectId: string,
    projectSettings:
      | {
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
        }
      | undefined,
    maps: {
      promptTitleToId: Map<string, string>;
      statusLabelToId: Map<string, string>;
    },
    archiveStatusId: string | null,
  ): Promise<{ initialPromptSet: boolean }> {
    let initialPromptSet = false;

    if (projectSettings) {
      const ps = projectSettings;

      // 1. Set initial prompt by title
      if (ps.initialPromptTitle) {
        const promptId = maps.promptTitleToId.get(ps.initialPromptTitle.toLowerCase());
        if (promptId) {
          await this.settings.updateSettings({
            projectId,
            initialSessionPromptId: promptId,
          });
          initialPromptSet = true;
          logger.info(
            { projectId, promptTitle: ps.initialPromptTitle },
            'Applied initial prompt from projectSettings',
          );
        }
      }

      // 2. Set autoClean statuses by label (case-insensitive)
      if (ps.autoCleanStatusLabels && ps.autoCleanStatusLabels.length > 0) {
        const autoCleanStatusIds = ps.autoCleanStatusLabels
          .map((label) => maps.statusLabelToId.get(label.toLowerCase()))
          .filter((id): id is string => !!id);

        if (autoCleanStatusIds.length > 0) {
          const currentSettings = this.settings.getSettings();
          const existingAutoClean = currentSettings.autoClean?.statusIds ?? {};
          await this.settings.updateSettings({
            autoClean: {
              statusIds: { ...existingAutoClean, [projectId]: autoCleanStatusIds },
            },
          });
          logger.info(
            { projectId, autoCleanStatusIds },
            'Applied autoClean statuses from projectSettings',
          );
        }
      } else if (archiveStatusId) {
        // Fallback: Auto-configure Archive status for auto-clean
        const currentSettings = this.settings.getSettings();
        const existingAutoClean = currentSettings.autoClean?.statusIds ?? {};
        await this.settings.updateSettings({
          autoClean: {
            statusIds: { ...existingAutoClean, [projectId]: [archiveStatusId] },
          },
        });
        logger.info(
          { projectId, archiveStatusId },
          'Auto-configured Archive status for auto-clean (fallback)',
        );
      }

      // 3. Set epicAssigned template (GLOBAL, not per-project)
      if (ps.epicAssignedTemplate) {
        await this.settings.updateSettings({
          events: {
            epicAssigned: { template: ps.epicAssignedTemplate },
          },
        });
        logger.info({ projectId }, 'Applied epicAssigned template from projectSettings');
      }

      // 4. Set message pool settings
      if (ps.messagePoolSettings) {
        await this.settings.setProjectPoolSettings(projectId, ps.messagePoolSettings);
        logger.info(
          { projectId, poolSettings: ps.messagePoolSettings },
          'Applied message pool settings from projectSettings',
        );
      }
    } else if (archiveStatusId) {
      // No projectSettings - apply Archive auto-clean fallback (BOTH paths)
      const currentSettings = this.settings.getSettings();
      const existingAutoClean = currentSettings.autoClean?.statusIds ?? {};
      await this.settings.updateSettings({
        autoClean: {
          statusIds: { ...existingAutoClean, [projectId]: [archiveStatusId] },
        },
      });
      logger.info({ projectId, archiveStatusId }, 'Auto-configured Archive status for auto-clean');
    }

    return { initialPromptSet };
  }

  /**
   * Normalize profile options to a JSON string.
   * Handles string, object, null/undefined inputs.
   *
   * @param options - Profile options (string, object, or null/undefined)
   * @returns JSON string or null
   */
  private normalizeProfileOptions(options: unknown): string | null {
    if (typeof options === 'string') {
      return options;
    }
    if (options && typeof options === 'object') {
      try {
        return JSON.stringify(options);
      } catch {
        return null;
      }
    }
    return null;
  }

  private getImportErrorMessage(error: unknown): string {
    // Check for SQLite error codes (better-sqlite3/drizzle format)
    const errorCode = (error as { code?: string })?.code;
    if (errorCode === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
      return 'Import failed: Cannot delete items that are still referenced. Check for cross-project agents using these profiles.';
    }
    if (errorCode === 'SQLITE_CONSTRAINT_UNIQUE') {
      return 'Import failed: Duplicate entry detected.';
    }

    if (error instanceof Error) {
      // SQLite FK constraint violation (message format)
      if (error.message.includes('FOREIGN KEY constraint failed')) {
        return 'Import failed: Cannot delete items that are still referenced. Check for cross-project agents using these profiles.';
      }
      // SQLite unique constraint (message format)
      if (error.message.includes('UNIQUE constraint failed')) {
        return 'Import failed: Duplicate entry detected.';
      }
      // Pass through known app errors
      if (error.message.startsWith('Import failed')) {
        return error.message;
      }
      return `Import failed: ${error.message}`;
    }
    return 'Import failed: An unexpected error occurred.';
  }

  /**
   * Convert a string to a valid slug (lowercase, alphanumeric + hyphens).
   * Used for generating template slugs from project names.
   *
   * @param name - The string to slugify
   * @returns A valid slug string
   */
  private slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
  }

  /**
   * Derive a template slug from a file path.
   * Extracts the filename without extension and converts to a valid slug.
   *
   * @param filePath - The absolute path to the template file
   * @returns A slug derived from the filename
   */
  private deriveSlugFromPath(filePath: string): string {
    const filename = basename(filePath);
    // Remove .json extension (case-insensitive)
    const nameWithoutExt = filename.replace(/\.json$/i, '');
    return this.slugify(nameWithoutExt);
  }

  /**
   * Get the original template manifest for a project.
   * Uses stored metadata to fetch the correct template version from the appropriate source.
   *
   * @param projectId - The project ID
   * @returns The template manifest or null if unavailable
   */
  async getTemplateManifestForProject(projectId: string): Promise<ManifestData | null> {
    // 1. Get template metadata from settings
    const metadata = this.settings.getProjectTemplateMetadata(projectId);
    if (!metadata?.templateSlug) {
      logger.debug({ projectId }, 'No template metadata for project');
      return null;
    }

    try {
      // 2. Fetch template based on source
      // File-based templates are non-upgradable (file may have moved/changed)
      if (metadata.source === 'file') {
        logger.debug(
          { projectId, templateSlug: metadata.templateSlug },
          'File-based template - no manifest available',
        );
        return null;
      }

      if (metadata.source === 'bundled') {
        // Use getBundledTemplate directly to avoid registry preference
        const template = this.unifiedTemplateService.getBundledTemplate(metadata.templateSlug);
        return (template.content as { _manifest?: ManifestData })._manifest ?? null;
      } else {
        // Registry: use installedVersion, not latest
        const template = await this.unifiedTemplateService.getTemplate(
          metadata.templateSlug,
          metadata.installedVersion ?? undefined,
        );
        // Honor stored source: reject if UnifiedTemplateService fell back to bundled
        if (template.source !== 'registry') {
          logger.debug(
            {
              projectId,
              templateSlug: metadata.templateSlug,
              expectedSource: 'registry',
              actualSource: template.source,
            },
            'Template source mismatch - registry template not available, rejecting bundled fallback',
          );
          return null;
        }
        return (template.content as { _manifest?: ManifestData })._manifest ?? null;
      }
    } catch (error) {
      // Graceful fallback: return null if template unavailable
      logger.debug(
        { projectId, templateSlug: metadata.templateSlug, error },
        'Failed to fetch template manifest for project',
      );
      return null;
    }
  }

  /**
   * Check if a bundled template has an upgrade available.
   * Compares the project's installed version with the current bundled template version.
   *
   * @param templateSlug The template slug
   * @param installedVersion The version installed in the project
   * @returns The new version if upgrade is available, null otherwise
   */
  getBundledUpgradeVersion(templateSlug: string, installedVersion: string | null): string | null {
    // Can't compare if installed version is unknown
    if (!installedVersion) {
      return null;
    }

    try {
      const bundled = this.unifiedTemplateService.getBundledTemplate(templateSlug);
      const manifest = (bundled.content as { _manifest?: { version?: string } })._manifest;
      const bundledVersion = manifest?.version;

      // Can't compare if bundled template has no version
      if (!bundledVersion) {
        return null;
      }

      // Guard against invalid semver strings - treat as no upgrade available
      if (!isValidSemVer(installedVersion) || !isValidSemVer(bundledVersion)) {
        logger.warn(
          { templateSlug, installedVersion, bundledVersion },
          'Invalid semver version detected, skipping upgrade check',
        );
        return null;
      }

      // Check if bundled version is newer than installed version
      if (isLessThan(installedVersion, bundledVersion)) {
        return bundledVersion;
      }

      return null;
    } catch {
      // Template not found or other error - no upgrade available
      return null;
    }
  }

  /**
   * Batch check bundled upgrades for multiple projects.
   * Returns a map of projectId -> upgrade version (or null if no upgrade).
   *
   * @param projects Array of { projectId, templateSlug, installedVersion, source }
   * @returns Map of projectId to upgrade version
   */
  getBundledUpgradesForProjects(
    projects: Array<{
      projectId: string;
      templateSlug: string | null;
      installedVersion: string | null;
      source: 'bundled' | 'registry' | 'file' | null;
    }>,
  ): Map<string, string | null> {
    const result = new Map<string, string | null>();

    // Cache bundled template versions to avoid repeated reads
    const bundledVersionCache = new Map<string, string | null>();

    for (const project of projects) {
      // Only check bundled templates
      if (project.source !== 'bundled' || !project.templateSlug) {
        result.set(project.projectId, null);
        continue;
      }

      // Check cache first
      if (!bundledVersionCache.has(project.templateSlug)) {
        try {
          const bundled = this.unifiedTemplateService.getBundledTemplate(project.templateSlug);
          const manifest = (bundled.content as { _manifest?: { version?: string } })._manifest;
          bundledVersionCache.set(project.templateSlug, manifest?.version ?? null);
        } catch {
          bundledVersionCache.set(project.templateSlug, null);
        }
      }

      const bundledVersion = bundledVersionCache.get(project.templateSlug);
      if (!bundledVersion || !project.installedVersion) {
        result.set(project.projectId, null);
        continue;
      }

      // Guard against invalid semver strings - treat as no upgrade available
      if (!isValidSemVer(project.installedVersion) || !isValidSemVer(bundledVersion)) {
        logger.warn(
          {
            projectId: project.projectId,
            templateSlug: project.templateSlug,
            installedVersion: project.installedVersion,
            bundledVersion,
          },
          'Invalid semver version detected, skipping upgrade check',
        );
        result.set(project.projectId, null);
        continue;
      }

      // Check if bundled version is newer
      if (isLessThan(project.installedVersion, bundledVersion)) {
        result.set(project.projectId, bundledVersion);
      } else {
        result.set(project.projectId, null);
      }
    }

    return result;
  }
}
