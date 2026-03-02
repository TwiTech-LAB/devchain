import { createLogger } from '../../../common/logging/logger';
import type { SettingsService } from '../../settings/services/settings.service';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { WatchersService } from '../../watchers/services/watchers.service';
import type { ProjectSettingsTemplateInput } from './profile-mapping.helpers';

const logger = createLogger('ProjectsService');

export interface WatcherTemplateInput {
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
}

export interface SubscriberTemplateInput {
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
}

export interface ScopeLookupMaps {
  agentNameToId: Map<string, string>;
  profileNameToId: Map<string, string>;
  providerNameToId: Map<string, string>;
  profileNameRemapMap?: Map<string, string>;
}

export async function createWatchersFromPayloadWithHelper(
  projectId: string,
  watchers: WatcherTemplateInput[],
  maps: ScopeLookupMaps,
  watchersService: Pick<WatchersService, 'createWatcher'>,
): Promise<{ created: number; watcherIdMap: Record<string, string> }> {
  const watcherIdMap: Record<string, string> = {};
  let created = 0;

  for (const watcher of watchers) {
    let scopeFilterId: string | null = null;

    if (watcher.scopeFilterName && watcher.scope !== 'all') {
      const scopeFilterNameLower = watcher.scopeFilterName.trim().toLowerCase();

      switch (watcher.scope) {
        case 'agent':
          scopeFilterId = maps.agentNameToId.get(scopeFilterNameLower) ?? null;
          break;
        case 'profile': {
          scopeFilterId = maps.profileNameToId.get(scopeFilterNameLower) ?? null;
          if (!scopeFilterId && maps.profileNameRemapMap) {
            const remappedName = maps.profileNameRemapMap.get(scopeFilterNameLower);
            if (remappedName) {
              scopeFilterId = maps.profileNameToId.get(remappedName) ?? null;
              if (scopeFilterId) {
                logger.info(
                  {
                    projectId,
                    watcherName: watcher.name,
                    originalProfile: watcher.scopeFilterName,
                    remappedProfile: remappedName,
                  },
                  'Watcher profile scope remapped due to provider family selection',
                );
              }
            }
          }
          break;
        }
        case 'provider':
          scopeFilterId = maps.providerNameToId.get(scopeFilterNameLower) ?? null;
          break;
      }

      if (!scopeFilterId) {
        logger.warn(
          {
            projectId,
            watcherName: watcher.name,
            scope: watcher.scope,
            scopeFilterName: watcher.scopeFilterName,
          },
          'Could not resolve scope filter, setting scope to "all"',
        );
      }
    }

    const createdWatcher = await watchersService.createWatcher({
      projectId,
      name: watcher.name,
      description: watcher.description ?? null,
      enabled: watcher.enabled,
      scope: scopeFilterId ? watcher.scope : 'all',
      scopeFilterId,
      pollIntervalMs: watcher.pollIntervalMs,
      viewportLines: watcher.viewportLines,
      idleAfterSeconds: watcher.idleAfterSeconds ?? 0,
      condition: watcher.condition,
      cooldownMs: watcher.cooldownMs,
      cooldownMode: watcher.cooldownMode,
      eventName: watcher.eventName,
    });

    if (watcher.id) {
      watcherIdMap[watcher.id] = createdWatcher.id;
    }
    created++;
  }

  return { created, watcherIdMap };
}

export async function createSubscribersFromPayloadWithHelper(
  projectId: string,
  subscribers: SubscriberTemplateInput[],
  storage: Pick<StorageService, 'createSubscriber'>,
): Promise<{ created: number; subscriberIdMap: Record<string, string> }> {
  const subscriberIdMap: Record<string, string> = {};
  let created = 0;

  for (const subscriber of subscribers) {
    const createdSubscriber = await storage.createSubscriber({
      projectId,
      name: subscriber.name,
      description: subscriber.description ?? null,
      enabled: subscriber.enabled,
      eventName: subscriber.eventName,
      eventFilter: subscriber.eventFilter ?? null,
      actionType: subscriber.actionType,
      actionInputs: subscriber.actionInputs,
      delayMs: subscriber.delayMs,
      cooldownMs: subscriber.cooldownMs,
      retryOnError: subscriber.retryOnError,
      groupName: subscriber.groupName ?? null,
      position: subscriber.position ?? 0,
      priority: subscriber.priority ?? 0,
    });

    if (subscriber.id) {
      subscriberIdMap[subscriber.id] = createdSubscriber.id;
    }
    created++;
  }

  return { created, subscriberIdMap };
}

export async function applyProjectSettingsWithHelper(
  projectId: string,
  projectSettings: ProjectSettingsTemplateInput | undefined,
  maps: {
    promptTitleToId: Map<string, string>;
    statusLabelToId: Map<string, string>;
  },
  archiveStatusId: string | null,
  settings: SettingsService,
): Promise<{ initialPromptSet: boolean }> {
  let initialPromptSet = false;

  if (projectSettings) {
    if (projectSettings.initialPromptTitle) {
      const promptId = maps.promptTitleToId.get(projectSettings.initialPromptTitle.toLowerCase());
      if (promptId) {
        await settings.updateSettings({
          projectId,
          initialSessionPromptId: promptId,
        });
        initialPromptSet = true;
        logger.info(
          { projectId, promptTitle: projectSettings.initialPromptTitle },
          'Applied initial prompt from projectSettings',
        );
      }
    }

    if (projectSettings.autoCleanStatusLabels && projectSettings.autoCleanStatusLabels.length > 0) {
      const autoCleanStatusIds = projectSettings.autoCleanStatusLabels
        .map((label) => maps.statusLabelToId.get(label.toLowerCase()))
        .filter((id): id is string => Boolean(id));

      if (autoCleanStatusIds.length > 0) {
        const currentSettings = settings.getSettings();
        const existingAutoClean = currentSettings.autoClean?.statusIds ?? {};
        await settings.updateSettings({
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
      const currentSettings = settings.getSettings();
      const existingAutoClean = currentSettings.autoClean?.statusIds ?? {};
      await settings.updateSettings({
        autoClean: {
          statusIds: { ...existingAutoClean, [projectId]: [archiveStatusId] },
        },
      });
      logger.info(
        { projectId, archiveStatusId },
        'Auto-configured Archive status for auto-clean (fallback)',
      );
    }

    if (projectSettings.epicAssignedTemplate) {
      await settings.updateSettings({
        events: {
          epicAssigned: { template: projectSettings.epicAssignedTemplate },
        },
      });
      logger.info({ projectId }, 'Applied epicAssigned template from projectSettings');
    }

    if (projectSettings.messagePoolSettings) {
      await settings.setProjectPoolSettings(projectId, projectSettings.messagePoolSettings);
      logger.info(
        { projectId, poolSettings: projectSettings.messagePoolSettings },
        'Applied message pool settings from projectSettings',
      );
    }
  } else if (archiveStatusId) {
    const currentSettings = settings.getSettings();
    const existingAutoClean = currentSettings.autoClean?.statusIds ?? {};
    await settings.updateSettings({
      autoClean: {
        statusIds: { ...existingAutoClean, [projectId]: [archiveStatusId] },
      },
    });
    logger.info({ projectId, archiveStatusId }, 'Auto-configured Archive status for auto-clean');
  }

  return { initialPromptSet };
}

export function normalizeProfileOptions(options: unknown): string | null {
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

export function getImportErrorMessage(error: unknown): string {
  const errorCode = (error as { code?: string })?.code;
  if (errorCode === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    return 'Import failed: Cannot delete items that are still referenced. Check for cross-project agents using these profiles.';
  }

  if (errorCode === 'SQLITE_CONSTRAINT_UNIQUE') {
    return 'Import failed: Duplicate entry detected.';
  }

  if (error instanceof Error) {
    if (error.message.includes('FOREIGN KEY constraint failed')) {
      return 'Import failed: Cannot delete items that are still referenced. Check for cross-project agents using these profiles.';
    }
    if (error.message.includes('UNIQUE constraint failed')) {
      return 'Import failed: Duplicate entry detected.';
    }
    if (error.message.startsWith('Import failed')) {
      return error.message;
    }
    return `Import failed: ${error.message}`;
  }

  return 'Import failed: An unexpected error occurred.';
}
