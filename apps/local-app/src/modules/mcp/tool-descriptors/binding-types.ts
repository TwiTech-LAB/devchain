import type { McpResponse } from '../dtos/mcp.dto';
import type { AgentMessageDeliveryService } from '../../agent-message-delivery/agent-message-delivery.service';
import type { EpicsService } from '../../epics/services/epics.service';
import type { EpicRelationsService } from '../../epics/services/epic-relations.service';
import type { GuestsService } from '../../guests/services/guests.service';
import type { ProjectCommunicationService } from '../../project-communication/project-communication.service';
import type { ReviewsService } from '../../reviews/services/reviews.service';
import type { ReviewSuggestionApplier } from '../../reviews/services/review-suggestion-applier.service';
import type { SessionsService } from '../../sessions/services/sessions.service';
import type { SettingsService } from '../../settings/services/settings.service';
import type { SkillsService } from '../../skills/services/skills.service';
import type { SkillSourceLifecycleService } from '../../skills/services/skill-source-lifecycle.service';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { TeamsService } from '../../teams/services/teams.service';
import type { TerminalIOService } from '../../terminal/services/terminal-io/terminal-io.service';
import type { InstructionsResolver } from '../services/instructions-resolver';

export type ContextualMcpToolHandler<TContext> = (
  context: TContext,
  params: unknown,
) => Promise<McpResponse>;

export type BoundMcpToolHandler = (params: unknown) => Promise<McpResponse>;

export interface McpBindingRuntime {
  readonly storage: StorageService;
  readonly sessionsService?: SessionsService;
  readonly epicsService?: EpicsService;
  readonly epicRelationsService?: EpicRelationsService;
  readonly settingsService?: SettingsService;
  readonly guestsService?: GuestsService;
  readonly skillsService?: SkillsService;
  readonly skillSourceLifecycleService?: SkillSourceLifecycleService;
  readonly reviewsService?: ReviewsService;
  readonly reviewSuggestionApplier?: ReviewSuggestionApplier;
  readonly teamsService?: TeamsService;
  readonly terminalIO?: TerminalIOService;
  readonly agentMessageDelivery?: AgentMessageDeliveryService;
  readonly projectCommunicationService?: ProjectCommunicationService;
  readonly instructionsResolver: InstructionsResolver;
  readonly defaultInlineMaxBytes: number;
  readonly resolveSessionContext: (sessionId: string) => Promise<McpResponse>;
}

export interface McpToolBindingDefinition {
  readonly name: string;
  readonly bind: (runtime: McpBindingRuntime) => BoundMcpToolHandler;
}

export function defineToolGroup<TContext>(
  createContext: (runtime: McpBindingRuntime) => TContext,
  entries: readonly (readonly [string, ContextualMcpToolHandler<TContext>])[],
): readonly McpToolBindingDefinition[] {
  return Object.freeze(
    entries.map(([name, handler]) =>
      Object.freeze({
        name,
        bind:
          (runtime: McpBindingRuntime): BoundMcpToolHandler =>
          async (params: unknown): Promise<McpResponse> =>
            handler(createContext(runtime), params),
      }),
    ),
  );
}
