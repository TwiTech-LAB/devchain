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
import { join, resolve, sep } from 'path';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { getEnvConfig } from '../../../common/config/env.config';
import { ExportSchema, type ManifestData } from '@devchain/shared';
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
  /** Template slug (unique identifier) */
  slug: string;
  /** Optional version - if null, uses bundled or latest downloaded */
  version?: string | null;
}

export interface ImportProjectInput {
  projectId: string;
  payload: unknown;
  dryRun?: boolean;
  statusMappings?: Record<string, string>; // oldStatusId -> templateStatusLabel
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

    // 1. Load template via UnifiedTemplateService
    const templateResult = await this.unifiedTemplateService.getTemplate(
      input.slug,
      input.version ?? undefined,
    );

    // 2. Parse and validate template content
    let payload;
    try {
      payload = ExportSchema.parse(templateResult.content);
    } catch (error) {
      logger.error({ error, slug: input.slug, version: input.version }, 'Invalid template format');
      throw new ValidationError('Invalid template format', {
        hint: 'Template file does not match expected export schema',
      });
    }

    // 3. Provider precheck and mapping
    const providerNames = new Set(
      (payload.profiles ?? []).map((p) => p.provider.name.trim().toLowerCase()),
    );
    const { available, missing: missingProviders } = await this.resolveProviders(providerNames);

    if (missingProviders.length > 0) {
      throw new ValidationError('Import aborted: missing providers', {
        missingProviders,
        hint: 'Install/configure providers by name before creating project from template.',
      });
    }

    // 4. Prepare template payload with resolved provider IDs
    const templatePayload: import('../../storage/interfaces/storage.interface').TemplateImportPayload =
      {
        prompts: payload.prompts.map((p) => ({
          id: p.id,
          title: p.title,
          content: p.content,
          version: p.version,
          tags: p.tags,
        })),
        profiles: payload.profiles.map((prof) => {
          const providerId = available.get(prof.provider.name.trim().toLowerCase());
          if (!providerId) {
            throw new NotFoundError('Provider', prof.provider.name);
          }
          return {
            id: prof.id,
            name: prof.name,
            providerId,
            options: this.normalizeProfileOptions(prof.options),
            instructions: prof.instructions ?? null,
            temperature: prof.temperature ?? null,
            maxTokens: prof.maxTokens ?? null,
          };
        }),
        agents: payload.agents.map((a) => ({
          id: a.id,
          name: a.name,
          profileId: a.profileId,
          description: a.description,
        })),
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
    const { created: watchersCreated } = await this.createWatchersFromPayload(
      result.project.id,
      payload.watchers,
      {
        agentNameToId: agentNameToNewId,
        profileNameToId: profileNameToNewId,
        providerNameToId: available,
      },
    );

    // 8. Create subscribers from template using helper
    const { created: subscribersCreated } = await this.createSubscribersFromPayload(
      result.project.id,
      payload.subscribers,
    );

    // 9. Set template metadata for upgrade tracking
    const registryConfig = this.settings.getRegistryConfig();
    await this.settings.setProjectTemplateMetadata(result.project.id, {
      templateSlug: input.slug,
      source: templateResult.source,
      installedVersion: templateResult.version,
      registryUrl: templateResult.source === 'registry' ? registryConfig.url : null,
      installedAt: new Date().toISOString(),
    });

    logger.info(
      {
        projectId: result.project.id,
        slug: input.slug,
        source: templateResult.source,
        version: templateResult.version,
      },
      'Template metadata set for project',
    );

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

  async exportProject(projectId: string, opts?: { manifestOverrides?: Partial<ManifestData> }) {
    logger.info({ projectId }, 'exportProject');

    const { manifestOverrides } = opts ?? {};

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

    const sanitizeOptionsString = (options: string | null): string | null => {
      if (!options) return null;
      // Options are stored as plain CLI flag strings, not JSON
      return options;
    };

    // Fetch full prompts to get content (listPrompts returns summaries without content)
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

    const profiles = await Promise.all(
      profilesRes.items.map(async (prof) => {
        const provider = await this.storage.getProvider(prof.providerId);
        return {
          id: prof.id,
          name: prof.name,
          provider: { id: provider.id, name: provider.name },
          options: sanitizeOptionsString(prof.options),
          instructions: prof.instructions,
          temperature: prof.temperature,
          maxTokens: prof.maxTokens,
        };
      }),
    );

    const agents = agentsRes.items.map((a) => ({
      id: a.id,
      name: a.name,
      profileId: a.profileId,
      description: a.description,
    }));

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
    };

    return exportPayload;
  }

  async importProject(input: ImportProjectInput) {
    logger.info({ projectId: input.projectId, dryRun: input.dryRun }, 'importProject');

    const isDryRun = input.dryRun ?? false;
    const payload = ExportSchema.parse(input.payload ?? {});

    // Provider precheck
    const providerNames = new Set(
      (payload.profiles ?? []).map((p) => p.provider.name.trim().toLowerCase()),
    );
    const { available, missing: missingProviders } = await this.resolveProviders(providerNames);

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
      return {
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
            profiles: payload.profiles.length,
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
    }

    if (missingProviders.length > 0) {
      throw new ValidationError('Import aborted: missing providers', {
        missingProviders,
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
      for (const prof of payload.profiles) {
        const providerId = available.get(prof.provider.name.trim().toLowerCase());
        if (!providerId) {
          // Should not happen due to precheck
          throw new NotFoundError('Provider', prof.provider.name);
        }
        const created = await this.storage.createAgentProfile({
          projectId: input.projectId,
          name: prof.name,
          providerId,
          options: this.normalizeProfileOptions(prof.options),
          systemPrompt: null,
          instructions: prof.instructions ?? null,
          temperature: prof.temperature ?? null,
          maxTokens: prof.maxTokens ?? null,
        });
        // Use synthetic key for items without ID (enables helper to build name maps)
        const profKey = prof.id || `name:${prof.name.trim().toLowerCase()}`;
        profileIdMap[profKey] = created.id;
      }

      // Agents - build ID map (with synthetic keys for items without IDs)
      for (const a of payload.agents) {
        const oldProfileId = a.profileId ?? '';
        const newProfileId =
          oldProfileId && profileIdMap[oldProfileId] ? profileIdMap[oldProfileId] : undefined;
        if (!newProfileId) {
          throw new ValidationError(`Profile mapping missing for agent ${a.name}`, {
            profileId: oldProfileId || null,
          });
        }
        const created = await this.storage.createAgent({
          projectId: input.projectId,
          name: a.name,
          profileId: newProfileId,
          description: a.description ?? null,
        });
        // Use synthetic key for items without ID (enables helper to build name maps)
        const agentKey = a.id || `name:${a.name.trim().toLowerCase()}`;
        agentIdMap[agentKey] = created.id;
      }

      // Build name-to-ID maps for scope resolution using helper
      // Create augmented payload with synthetic IDs for items without original IDs
      const augmentedPayload = {
        agents: payload.agents.map((a) => ({
          ...a,
          id: a.id || `name:${a.name.trim().toLowerCase()}`,
        })),
        profiles: payload.profiles.map((p) => ({
          ...p,
          id: p.id || `name:${p.name.trim().toLowerCase()}`,
        })),
      };
      const { agentNameToId: agentNameToNewId, profileNameToId: profileNameToNewId } =
        this.buildNameToIdMaps(augmentedPayload, { agentIdMap, profileIdMap });

      // Create watchers using helper (handles scope resolution and auto-start)
      const { watcherIdMap } = await this.createWatchersFromPayload(
        input.projectId,
        payload.watchers,
        {
          agentNameToId: agentNameToNewId,
          profileNameToId: profileNameToNewId,
          providerNameToId: available,
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
      condition: { type: 'contains' | 'regex' | 'not_contains'; pattern: string; flags?: string };
      cooldownMs: number;
      cooldownMode: 'time' | 'until_clear';
      eventName: string;
    }>,
    maps: {
      agentNameToId: Map<string, string>;
      profileNameToId: Map<string, string>;
      providerNameToId: Map<string, string>;
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
            scopeFilterId = maps.profileNameToId.get(scopeFilterNameLower) ?? null;
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

      try {
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
          condition: w.condition,
          cooldownMs: w.cooldownMs,
          cooldownMode: w.cooldownMode,
          eventName: w.eventName,
        });

        if (w.id) watcherIdMap[w.id] = createdWatcher.id;
        created++;
      } catch (error) {
        // Handle duplicate eventName constraint violation
        if (
          error instanceof Error &&
          error.message.includes('UNIQUE constraint failed') &&
          error.message.includes('event_name')
        ) {
          throw new ConflictError(`Duplicate watcher eventName: "${w.eventName}"`, {
            hint: 'Each watcher must have a unique eventName within the project.',
          });
        }
        throw error;
      }
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
}
