import type { StorageService } from '../../../storage/interfaces/storage.interface';
import type { McpBindingRuntime } from '../../tool-descriptors/binding-types';
import { McpToolBindingRegistry } from '../mcp-tool-binding.registry';

export type McpToolBindingRegistryFixtureDependencies = Partial<
  Pick<
    McpBindingRuntime,
    | 'sessionsService'
    | 'epicsService'
    | 'epicRelationsService'
    | 'settingsService'
    | 'guestsService'
    | 'skillsService'
    | 'reviewsService'
    | 'reviewSuggestionApplier'
    | 'teamsService'
    | 'terminalIO'
    | 'agentMessageDelivery'
    | 'projectCommunicationService'
  >
>;

export function createMcpToolBindingRegistryFixture(
  storage: StorageService,
  dependencies: McpToolBindingRegistryFixtureDependencies = {},
): McpToolBindingRegistry {
  return new McpToolBindingRegistry(
    storage,
    dependencies.sessionsService,
    dependencies.epicsService,
    dependencies.epicRelationsService,
    dependencies.settingsService,
    dependencies.guestsService,
    dependencies.skillsService,
    dependencies.reviewsService,
    dependencies.reviewSuggestionApplier,
    dependencies.teamsService,
    dependencies.terminalIO,
    dependencies.agentMessageDelivery,
    dependencies.projectCommunicationService,
  );
}
