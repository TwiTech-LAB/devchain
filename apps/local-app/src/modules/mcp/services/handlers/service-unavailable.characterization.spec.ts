/**
 * Characterization tests for SERVICE_UNAVAILABLE error shapes.
 *
 * These tests lock the current standalone-MCP error response shape so
 * that the 4A refactor (per-binding-group contexts + null-object adapters)
 * preserves the contract. Every SERVICE_UNAVAILABLE code path in the MCP
 * handler layer is exercised here.
 *
 * Run: pnpm --filter local-app test -- --testPathPatterns service-unavailable.characterization
 */

import { handleSendMessage } from './chat-tools';
import {
  handleListReviews,
  handleGetReview,
  handleGetReviewComments,
  handleReplyComment,
  handleResolveComment,
  handleApplySuggestion,
} from './review-tools';
import {
  handleCreateEpic,
  handleAddEpicComment,
  handleUpdateEpic,
  handleDeleteEpic,
  handleSetEpicRelation,
  handleDeleteEpicRelation,
} from './epic-tools';
import {
  handleTeamsList,
  handleTeamsMembersList,
  handleTeamsConfigsList,
  handleTeamsCreateAgent,
  handleTeamsDeleteAgent,
  handleDevchainTeam,
} from './teams-tools';
import { handleGetAgentByName } from './agent-tools';
import { handleListSessions, handleRegisterGuest } from './session-tools';
import { handleListSkills, handleGetSkill } from './skill-tools';
import type { McpResponse } from '../../dtos/mcp.dto';
import { missingSessionResolver } from '../utils/session-context-helpers';
import { createNullAdapter } from './null-adapter';
import type { TeamsService } from '../../../teams/services/teams.service';
import type { SettingsService } from '../../../settings/services/settings.service';
import type { AgentMessageDeliveryService } from '../../../agent-message-delivery/agent-message-delivery.service';
import type { EpicsService } from '../../../epics/services/epics.service';
import type { EpicRelationsService } from '../../../epics/services/epic-relations.service';
import type { ReviewsService } from '../../../reviews/services/reviews.service';
import type { ReviewSuggestionApplier } from '../../../reviews/services/review-suggestion-applier.service';
import type { SkillsService } from '../../../skills/services/skills.service';
import type { SessionsService } from '../../../sessions/services/sessions.service';
import type { GuestsService } from '../../../guests/services/guests.service';
import type { TerminalIOService } from '../../../terminal/services/terminal-io/terminal-io.service';
import type { InstructionsResolver } from '../instructions-resolver';
import type { ProjectCommunicationService } from '../../../project-communication/project-communication.service';
import type { ChatToolContext } from './chat-context';
import type { ReviewToolContext } from './review-context';
import type { EpicToolContext } from './epic-context';
import type { TeamsToolContext } from './teams-context';
import type { AgentToolContext } from './agent-context';
import type { SessionToolContext } from './session-context';
import type { SkillToolContext } from './skill-context';

jest.mock('../../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

const SESSION_ID = '00000000-0000-0000-0000-000000000001';
const PROJECT_ID = '00000000-0000-0000-0000-000000000002';
const AGENT_ID = '00000000-0000-0000-0000-000000000003';
const REVIEW_ID = '00000000-0000-0000-0000-000000000004';
const COMMENT_ID = '00000000-0000-0000-0000-000000000005';

function makeAgentSessionCtx() {
  return {
    type: 'agent' as const,
    session: {
      id: SESSION_ID,
      agentId: AGENT_ID,
      status: 'active',
      startedAt: '2024-01-01T00:00:00Z',
    },
    agent: { id: AGENT_ID, name: 'Test Agent', projectId: PROJECT_ID },
    project: { id: PROJECT_ID, name: 'Test Project', rootPath: '/tmp/test' },
  };
}

function resolveToAgent() {
  return jest.fn().mockResolvedValue({ success: true, data: makeAgentSessionCtx() });
}

function assertServiceUnavailable(result: McpResponse, expectedMessageSubstring?: string) {
  expect(result.success).toBe(false);
  expect(result.error).toBeDefined();
  expect(result.error!.code).toBe('SERVICE_UNAVAILABLE');
  expect(typeof result.error!.message).toBe('string');
  expect(result.error!.message.length).toBeGreaterThan(0);
  if (expectedMessageSubstring) {
    expect(result.error!.message).toContain(expectedMessageSubstring);
  }
}

function storageWithAgent(): Record<string, jest.Mock> {
  return {
    getAgent: jest
      .fn()
      .mockResolvedValue({ id: AGENT_ID, name: 'Test Agent', projectId: PROJECT_ID }),
    getAgentByName: jest.fn().mockResolvedValue({
      id: AGENT_ID,
      name: 'Test Agent',
      profileId: null,
      description: null,
      projectId: PROJECT_ID,
    }),
    getReview: jest.fn().mockResolvedValue({ id: REVIEW_ID, projectId: PROJECT_ID }),
    getReviewComment: jest.fn().mockResolvedValue({ id: COMMENT_ID, reviewId: REVIEW_ID }),
    listAgents: jest
      .fn()
      .mockResolvedValue({ items: [{ id: AGENT_ID, name: 'Test Agent' }], total: 1 }),
    listGuests: jest.fn().mockResolvedValue([]),
    findStatusByName: jest.fn().mockResolvedValue({ id: 'status-1', label: 'Open' }),
    listStatuses: jest.fn().mockResolvedValue({ items: [] }),
    getGuestByName: jest.fn().mockResolvedValue(null),
    getGuestsByIdPrefix: jest.fn().mockResolvedValue([]),
    getEpic: jest.fn().mockResolvedValue({
      id: '00000000-0000-0000-0000-000000000010',
      projectId: PROJECT_ID,
      title: 'Test',
      statusId: 'status-1',
      parentId: null,
      agentId: null,
      version: 1,
      tags: [],
    }),
    getWorkspaceEpicsByIdPrefix: jest.fn().mockResolvedValue([
      {
        id: '00000000-0000-0000-0000-000000000011',
        projectId: PROJECT_ID,
        projectName: 'Test Project',
        title: 'Related',
        statusId: 'status-1',
        statusLabel: 'Open',
        statusColor: '#ccc',
        statusMcpHidden: false,
        parentId: null,
      },
    ]),
  };
}

function createNullChatContext(overrides: Partial<ChatToolContext> = {}): ChatToolContext {
  return {
    storage: createNullAdapter('StorageService'),
    teamsService: createNullAdapter<TeamsService>('TeamsService'),
    agentMessageDelivery: createNullAdapter<AgentMessageDeliveryService>(
      'AgentMessageDeliveryService',
    ),
    settingsService: createNullAdapter<SettingsService>('SettingsService'),
    projectCommunicationService: createNullAdapter<ProjectCommunicationService>(
      'ProjectCommunicationService',
    ),
    resolveSessionContext: () => Promise.resolve(missingSessionResolver()),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// §1  session-context-helpers.ts — missingSessionResolver
// ---------------------------------------------------------------------------
describe('session-context-helpers: missingSessionResolver', () => {
  it('returns SERVICE_UNAVAILABLE with standalone MCP message', () => {
    const result = missingSessionResolver();
    assertServiceUnavailable(result, 'standalone MCP mode');
  });

  it('has the canonical response shape { success, error: { code, message } }', () => {
    const result = missingSessionResolver();
    expect(result).toEqual({
      success: false,
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: expect.any(String),
      },
    });
  });
});

// ---------------------------------------------------------------------------
// §2  chat-tools.ts — retained terminal-routing SERVICE_UNAVAILABLE sites
// ---------------------------------------------------------------------------
describe('chat-tools SERVICE_UNAVAILABLE', () => {
  it('handleSendMessage: teamsService missing (team routing path)', async () => {
    const ctx: ChatToolContext = createNullChatContext({
      storage: storageWithAgent() as never,
      resolveSessionContext: resolveToAgent(),
    });
    const result = await handleSendMessage(ctx, {
      sessionId: SESSION_ID,
      message: 'hi',
      teamName: 'MyTeam',
    });
    assertServiceUnavailable(result, 'standalone MCP mode');
  });

  it('handleSendMessage: agentMessageDelivery missing (agent recipient path)', async () => {
    const storage = storageWithAgent();
    storage.getAgentByName.mockResolvedValue({ id: 'r1', name: 'Agent-B', projectId: PROJECT_ID });
    const ctx: ChatToolContext = createNullChatContext({
      storage: storage as never,
      resolveSessionContext: resolveToAgent(),
    });
    const result = await handleSendMessage(ctx, {
      sessionId: SESSION_ID,
      message: 'hi',
      recipientAgentNames: ['Agent-B'],
    });
    assertServiceUnavailable(result, 'standalone MCP mode');
  });
});

// ---------------------------------------------------------------------------
// §3  review-tools.ts — 6 SERVICE_UNAVAILABLE sites
// ---------------------------------------------------------------------------
describe('review-tools SERVICE_UNAVAILABLE', () => {
  it('handleListReviews: reviewsService is null adapter', async () => {
    const ctx: ReviewToolContext = {
      storage: storageWithAgent() as never,
      reviewsService: createNullAdapter<ReviewsService>('ReviewsService'),
      reviewSuggestionApplier:
        createNullAdapter<ReviewSuggestionApplier>('ReviewSuggestionApplier'),
      resolveSessionContext: resolveToAgent(),
    };
    const result = await handleListReviews(ctx, { sessionId: SESSION_ID });
    assertServiceUnavailable(result);
  });

  it('handleGetReview: reviewsService is null adapter', async () => {
    const ctx: ReviewToolContext = {
      storage: storageWithAgent() as never,
      reviewsService: createNullAdapter<ReviewsService>('ReviewsService'),
      reviewSuggestionApplier:
        createNullAdapter<ReviewSuggestionApplier>('ReviewSuggestionApplier'),
      resolveSessionContext: resolveToAgent(),
    };
    const result = await handleGetReview(ctx, { sessionId: SESSION_ID, reviewId: REVIEW_ID });
    assertServiceUnavailable(result);
  });

  it('handleGetReviewComments: reviewsService is null adapter', async () => {
    const ctx: ReviewToolContext = {
      storage: storageWithAgent() as never,
      reviewsService: createNullAdapter<ReviewsService>('ReviewsService'),
      reviewSuggestionApplier:
        createNullAdapter<ReviewSuggestionApplier>('ReviewSuggestionApplier'),
      resolveSessionContext: resolveToAgent(),
    };
    const result = await handleGetReviewComments(ctx, {
      sessionId: SESSION_ID,
      reviewId: REVIEW_ID,
    });
    assertServiceUnavailable(result);
  });

  it('handleReplyComment: reviewsService is null adapter', async () => {
    const ctx: ReviewToolContext = {
      storage: storageWithAgent() as never,
      reviewsService: createNullAdapter<ReviewsService>('ReviewsService'),
      reviewSuggestionApplier:
        createNullAdapter<ReviewSuggestionApplier>('ReviewSuggestionApplier'),
      resolveSessionContext: resolveToAgent(),
    };
    const result = await handleReplyComment(ctx, {
      sessionId: SESSION_ID,
      reviewId: REVIEW_ID,
      parentCommentId: COMMENT_ID,
      content: 'reply',
    });
    assertServiceUnavailable(result);
  });

  it('handleResolveComment: reviewsService is null adapter', async () => {
    const ctx: ReviewToolContext = {
      storage: storageWithAgent() as never,
      reviewsService: createNullAdapter<ReviewsService>('ReviewsService'),
      reviewSuggestionApplier:
        createNullAdapter<ReviewSuggestionApplier>('ReviewSuggestionApplier'),
      resolveSessionContext: resolveToAgent(),
    };
    const result = await handleResolveComment(ctx, {
      sessionId: SESSION_ID,
      commentId: COMMENT_ID,
      resolution: 'accepted',
      version: 1,
    });
    assertServiceUnavailable(result);
  });

  it('handleApplySuggestion: reviewSuggestionApplier is null adapter', async () => {
    const ctx: ReviewToolContext = {
      storage: storageWithAgent() as never,
      reviewsService: createNullAdapter<ReviewsService>('ReviewsService'),
      reviewSuggestionApplier:
        createNullAdapter<ReviewSuggestionApplier>('ReviewSuggestionApplier'),
      resolveSessionContext: resolveToAgent(),
    };
    const result = await handleApplySuggestion(ctx, {
      sessionId: SESSION_ID,
      commentId: COMMENT_ID,
      version: 1,
    });
    assertServiceUnavailable(result);
  });
});

// ---------------------------------------------------------------------------
// §4  epic-tools.ts — 6 SERVICE_UNAVAILABLE sites
// ---------------------------------------------------------------------------
describe('epic-tools SERVICE_UNAVAILABLE', () => {
  it('handleCreateEpic: epicsService is null adapter', async () => {
    const ctx: EpicToolContext = {
      storage: storageWithAgent() as never,
      epicsService: createNullAdapter<EpicsService>('EpicsService'),
      resolveSessionContext: resolveToAgent(),
    };
    const result = await handleCreateEpic(ctx, { sessionId: SESSION_ID, title: 'Test' });
    assertServiceUnavailable(result, 'standalone MCP mode');
  });

  it('handleAddEpicComment: epicsService is null adapter', async () => {
    const ctx: EpicToolContext = {
      storage: storageWithAgent() as never,
      epicsService: createNullAdapter<EpicsService>('EpicsService'),
      resolveSessionContext: resolveToAgent(),
    };
    const result = await handleAddEpicComment(ctx, {
      sessionId: SESSION_ID,
      epicId: '00000000-0000-0000-0000-000000000010',
      content: 'comment',
    });
    assertServiceUnavailable(result, 'standalone MCP mode');
  });

  it('handleUpdateEpic: epicsService is null adapter', async () => {
    const ctx: EpicToolContext = {
      storage: storageWithAgent() as never,
      epicsService: createNullAdapter<EpicsService>('EpicsService'),
      resolveSessionContext: resolveToAgent(),
    };
    const result = await handleUpdateEpic(ctx, {
      sessionId: SESSION_ID,
      id: '00000000-0000-0000-0000-000000000010',
      version: 1,
      title: 'Updated',
    });
    assertServiceUnavailable(result, 'standalone MCP mode');
  });

  it('handleDeleteEpic: epicsService is null adapter', async () => {
    const ctx: EpicToolContext = {
      storage: storageWithAgent() as never,
      epicsService: createNullAdapter<EpicsService>('EpicsService'),
      resolveSessionContext: resolveToAgent(),
    };
    const result = await handleDeleteEpic(ctx, {
      sessionId: SESSION_ID,
      id: '00000000-0000-0000-0000-000000000010',
    });
    assertServiceUnavailable(result, 'standalone MCP mode');
  });

  it.each([
    ['set', handleSetEpicRelation, { relation: 'related' }],
    ['delete', handleDeleteEpicRelation, {}],
  ] as const)(
    'handle relation %s: relation service is null adapter',
    async (_name, handler, extra) => {
      const ctx: EpicToolContext = {
        storage: storageWithAgent() as never,
        epicsService: createNullAdapter<EpicsService>('EpicsService'),
        epicRelationsService: createNullAdapter<EpicRelationsService>('EpicRelationsService'),
        resolveSessionContext: resolveToAgent(),
      };
      const result = await handler(ctx, {
        sessionId: SESSION_ID,
        epicId: '00000000-0000-0000-0000-000000000010',
        relatedEpicId: '00000000-0000-0000-0000-000000000011',
        ...extra,
      });
      assertServiceUnavailable(result, 'standalone MCP mode');
    },
  );
});

// ---------------------------------------------------------------------------
// §5  teams-tools.ts — 6 SERVICE_UNAVAILABLE sites (via teamsServiceUnavailable())
// ---------------------------------------------------------------------------
describe('teams-tools SERVICE_UNAVAILABLE', () => {
  const baseCtx: TeamsToolContext = {
    storage: storageWithAgent() as never,
    teamsService: createNullAdapter<TeamsService>('TeamsService'),
    resolveSessionContext: resolveToAgent(),
  };

  it('handleTeamsList: teamsService is null adapter', async () => {
    const result = await handleTeamsList(baseCtx, { sessionId: SESSION_ID });
    assertServiceUnavailable(result, 'standalone MCP mode');
  });

  it('handleTeamsMembersList: teamsService is null adapter', async () => {
    const result = await handleTeamsMembersList(baseCtx, { sessionId: SESSION_ID });
    assertServiceUnavailable(result, 'standalone MCP mode');
  });

  it('handleTeamsConfigsList: teamsService is null adapter', async () => {
    const result = await handleTeamsConfigsList(baseCtx, { sessionId: SESSION_ID });
    assertServiceUnavailable(result, 'standalone MCP mode');
  });

  it('handleTeamsCreateAgent: teamsService is null adapter', async () => {
    const result = await handleTeamsCreateAgent(baseCtx, {
      sessionId: SESSION_ID,
      name: 'test-agent',
      configName: 'default',
      profileName: 'default',
      teamName: 'test-team',
    });
    assertServiceUnavailable(result, 'standalone MCP mode');
  });

  it('handleTeamsDeleteAgent: teamsService is null adapter', async () => {
    const result = await handleTeamsDeleteAgent(baseCtx, {
      sessionId: SESSION_ID,
      name: 'test-agent',
      teamName: 'test-team',
    });
    assertServiceUnavailable(result, 'standalone MCP mode');
  });

  it('handleDevchainTeam: teamsService is null adapter', async () => {
    const result = await handleDevchainTeam(baseCtx, { sessionId: SESSION_ID });
    assertServiceUnavailable(result, 'standalone MCP mode');
  });
});

// ---------------------------------------------------------------------------
// §6  agent-tools.ts — 1 SERVICE_UNAVAILABLE site (instructionsResolver null adapter)
// ---------------------------------------------------------------------------
describe('agent-tools SERVICE_UNAVAILABLE', () => {
  it('handleGetAgentByName: instructionsResolver is null adapter', async () => {
    const storage = {
      ...storageWithAgent(),
      getAgentByName: jest.fn().mockResolvedValue({
        id: AGENT_ID,
        name: 'Test Agent',
        profileId: 'profile-1',
        description: null,
        projectId: PROJECT_ID,
        profile: { id: 'profile-1', name: 'Default', instructions: 'system prompt' },
      }),
    };
    const ctx: AgentToolContext = {
      storage: storage as never,
      sessionsService: createNullAdapter<SessionsService>('SessionsService'),
      terminalIO: createNullAdapter<TerminalIOService>('TerminalIOService'),
      instructionsResolver: createNullAdapter<InstructionsResolver>(
        'InstructionsResolver',
      ) as never,
      teamsService: createNullAdapter<TeamsService>('TeamsService'),
      defaultInlineMaxBytes: 64 * 1024,
      resolveSessionContext: resolveToAgent(),
    };
    const result = await handleGetAgentByName(ctx, { sessionId: SESSION_ID, name: 'Test Agent' });
    assertServiceUnavailable(result, 'standalone MCP mode');
  });
});

// ---------------------------------------------------------------------------
// §7  session-tools.ts — 2 SERVICE_UNAVAILABLE sites
// ---------------------------------------------------------------------------
describe('session-tools SERVICE_UNAVAILABLE', () => {
  it('handleListSessions: sessionsService is null adapter', async () => {
    const ctx: SessionToolContext = {
      storage: storageWithAgent() as never,
      sessionsService: createNullAdapter<SessionsService>('SessionsService'),
      guestsService: createNullAdapter<GuestsService>('GuestsService'),
    };
    const result = await handleListSessions(ctx, {});
    assertServiceUnavailable(result, 'standalone MCP mode');
  });

  it('handleRegisterGuest: guestsService is null adapter', async () => {
    const ctx: SessionToolContext = {
      storage: storageWithAgent() as never,
      sessionsService: createNullAdapter<SessionsService>('SessionsService'),
      guestsService: createNullAdapter<GuestsService>('GuestsService'),
    };
    const result = await handleRegisterGuest(ctx, {
      name: 'guest-1',
      tmuxSessionId: 'tmux-001',
    });
    assertServiceUnavailable(result, 'full app context');
  });
});

// ---------------------------------------------------------------------------
// §8  skill-tools.ts — 2 SERVICE_UNAVAILABLE sites
// ---------------------------------------------------------------------------
describe('skill-tools SERVICE_UNAVAILABLE', () => {
  it('handleListSkills: skillsService is null adapter', async () => {
    const ctx: SkillToolContext = {
      storage: storageWithAgent() as never,
      skillsService: createNullAdapter<SkillsService>('SkillsService'),
      resolveSessionContext: resolveToAgent(),
    };
    const result = await handleListSkills(ctx, { sessionId: SESSION_ID });
    assertServiceUnavailable(result);
  });

  it('handleGetSkill: skillsService is null adapter', async () => {
    const ctx: SkillToolContext = {
      storage: storageWithAgent() as never,
      skillsService: createNullAdapter<SkillsService>('SkillsService'),
      resolveSessionContext: resolveToAgent(),
    };
    const result = await handleGetSkill(ctx, { sessionId: SESSION_ID, slug: 'test/skill' });
    assertServiceUnavailable(result);
  });
});

// ---------------------------------------------------------------------------
// §10  Structural contract: all SERVICE_UNAVAILABLE responses share shape
// ---------------------------------------------------------------------------
describe('SERVICE_UNAVAILABLE structural contract', () => {
  it('every SERVICE_UNAVAILABLE response has { success: false, error: { code, message } } with no extra keys on error', () => {
    const result = missingSessionResolver();
    const errorKeys = Object.keys(result.error!).sort();
    expect(errorKeys).toEqual(['code', 'message']);
  });

  it('error.code is the literal string "SERVICE_UNAVAILABLE"', () => {
    const result = missingSessionResolver();
    expect(result.error!.code).toBe('SERVICE_UNAVAILABLE');
    expect(typeof result.error!.code).toBe('string');
  });

  it('error.message is a non-empty string', () => {
    const result = missingSessionResolver();
    expect(typeof result.error!.message).toBe('string');
    expect(result.error!.message.length).toBeGreaterThan(0);
  });

  it('error object has no data field (SERVICE_UNAVAILABLE never carries data)', () => {
    const result = missingSessionResolver();
    expect(result.error).not.toHaveProperty('data');
  });
});
