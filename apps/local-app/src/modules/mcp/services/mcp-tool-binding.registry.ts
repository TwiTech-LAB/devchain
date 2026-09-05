import { Inject, Injectable, Optional, forwardRef } from '@nestjs/common';
import type { ZodSchema } from 'zod';
import { AgentMessageDeliveryService } from '../../agent-message-delivery/agent-message-delivery.service';
import { EpicsService } from '../../epics/services/epics.service';
import { EpicRelationsService } from '../../epics/services/epic-relations.service';
import { GuestsService } from '../../guests/services/guests.service';
import { ProjectCommunicationService } from '../../project-communication/project-communication.service';
import { ReviewsService } from '../../reviews/services/reviews.service';
import { ReviewSuggestionApplier } from '../../reviews/services/review-suggestion-applier.service';
import { SessionsService } from '../../sessions/services/sessions.service';
import { SettingsService } from '../../settings/services/settings.service';
import { SkillsService } from '../../skills/services/skills.service';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import { TeamsService } from '../../teams/services/teams.service';
import { TerminalIOService } from '../../terminal/services/terminal-io/terminal-io.service';
import { allMetadata } from '../tool-descriptors';
import type { BoundMcpToolHandler, McpBindingRuntime } from '../tool-descriptors/binding-types';
import { allBindingDefinitions } from '../tool-descriptors/runtime-bindings';
import { InstructionsResolver } from './instructions-resolver';
import { buildInlineResolution } from './utils/document-link-resolver';
import { SessionContextResolver } from './utils/session-context-resolver';

export interface ResolvedMcpToolBinding {
  readonly paramsSchema: ZodSchema | null;
  readonly invoke: BoundMcpToolHandler;
}

@Injectable()
export class McpToolBindingRegistry {
  private readonly bindings: ReadonlyMap<string, ResolvedMcpToolBinding>;

  constructor(
    @Inject(STORAGE_SERVICE) storage: StorageService,
    @Optional()
    @Inject(forwardRef(() => SessionsService))
    sessionsService?: SessionsService,
    @Optional()
    @Inject(forwardRef(() => EpicsService))
    epicsService?: EpicsService,
    @Optional()
    @Inject(EpicRelationsService)
    epicRelationsService?: EpicRelationsService,
    @Optional()
    @Inject(forwardRef(() => SettingsService))
    settingsService?: SettingsService,
    @Optional()
    @Inject(forwardRef(() => GuestsService))
    guestsService?: GuestsService,
    @Optional()
    @Inject(forwardRef(() => SkillsService))
    skillsService?: SkillsService,
    @Optional()
    @Inject(forwardRef(() => ReviewsService))
    reviewsService?: ReviewsService,
    @Optional()
    @Inject(forwardRef(() => ReviewSuggestionApplier))
    reviewSuggestionApplier?: ReviewSuggestionApplier,
    @Optional()
    @Inject(forwardRef(() => TeamsService))
    teamsService?: TeamsService,
    @Optional() terminalIO?: TerminalIOService,
    @Optional()
    @Inject(forwardRef(() => AgentMessageDeliveryService))
    agentMessageDelivery?: AgentMessageDeliveryService,
    @Optional() projectCommunicationService?: ProjectCommunicationService,
  ) {
    const instructionsResolver = new InstructionsResolver(
      storage,
      (document, cache, maxDepth, maxBytes) =>
        buildInlineResolution(storage, document, cache, maxDepth, maxBytes),
    );
    const sessionContextResolver = new SessionContextResolver(
      storage,
      sessionsService,
      guestsService,
      terminalIO,
    );
    const runtime: McpBindingRuntime = Object.freeze({
      storage,
      sessionsService,
      epicsService,
      epicRelationsService,
      settingsService,
      guestsService,
      skillsService,
      reviewsService,
      reviewSuggestionApplier,
      teamsService,
      terminalIO,
      agentMessageDelivery,
      projectCommunicationService,
      instructionsResolver,
      defaultInlineMaxBytes: 64 * 1024,
      resolveSessionContext: (sessionId: string) => sessionContextResolver.resolve(sessionId),
    });

    const metadataByName = new Map<string, (typeof allMetadata)[number]>();
    for (const metadata of allMetadata) {
      if (metadataByName.has(metadata.name)) {
        throw new Error(`Duplicate MCP metadata name: ${metadata.name}`);
      }
      metadataByName.set(metadata.name, metadata);
    }

    const invokeByName = new Map<string, BoundMcpToolHandler>();
    for (const definition of allBindingDefinitions) {
      if (invokeByName.has(definition.name)) {
        throw new Error(`Duplicate MCP binding name: ${definition.name}`);
      }
      invokeByName.set(definition.name, definition.bind(runtime));
    }

    const metadataWithoutBindings = [...metadataByName.keys()].filter(
      (name) => !invokeByName.has(name),
    );
    const bindingsWithoutMetadata = [...invokeByName.keys()].filter(
      (name) => !metadataByName.has(name),
    );
    if (metadataWithoutBindings.length > 0 || bindingsWithoutMetadata.length > 0) {
      throw new Error(
        `MCP metadata/binding catalog mismatch: metadataWithoutBindings=${metadataWithoutBindings.join(',')}; bindingsWithoutMetadata=${bindingsWithoutMetadata.join(',')}`,
      );
    }

    this.bindings = new Map(
      [...invokeByName].map(([name, invoke]) => [
        name,
        { paramsSchema: metadataByName.get(name)?.paramsSchema ?? null, invoke },
      ]),
    );
  }

  resolve(normalizedName: string): ResolvedMcpToolBinding | undefined {
    return this.bindings.get(normalizedName);
  }
}
