import { Test, TestingModule } from '@nestjs/testing';
import { HooksService } from './hooks.service';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { EventsService } from '../../events/services/events.service';
import { PendingAskUserQuestionService } from './pending-ask-user-question.service';
import type { HookEventData } from '../dtos/hook-event.dto';

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  }),
}));

describe('HooksService', () => {
  let service: HooksService;
  let mockStorage: { getAgent: jest.Mock };
  let mockEvents: { publish: jest.Mock };
  let mockPending: {
    set: jest.Mock;
    clearByToolUseId: jest.Mock;
    getBySession: jest.Mock;
    clearBySession: jest.Mock;
  };

  const PROJECT_ID = '11111111-1111-1111-1111-111111111111';
  const AGENT_ID = '22222222-2222-2222-2222-222222222222';
  const SESSION_ID = '33333333-3333-3333-3333-333333333333';

  const basePayload: HookEventData = {
    hookEventName: 'SessionStart',
    claudeSessionId: 'claude-session-1',
    source: 'startup',
    tmuxSessionName: 'devchain-test-session',
    projectId: PROJECT_ID,
    agentId: AGENT_ID,
    sessionId: SESSION_ID,
  };

  const askQuestions = [
    {
      question: 'Which color?',
      header: 'Color',
      multiSelect: false,
      options: [{ label: 'Red', description: 'r' }],
    },
  ];

  const prePayload: HookEventData = {
    hookEventName: 'PreToolUse',
    claudeSessionId: 'claude-session-1',
    toolName: 'AskUserQuestion',
    toolUseId: 'toolu_abc',
    toolInput: { questions: askQuestions },
    tmuxSessionName: 'devchain-test-session',
    projectId: PROJECT_ID,
    agentId: AGENT_ID,
    sessionId: SESSION_ID,
  };

  const postPayload: HookEventData = {
    hookEventName: 'PostToolUse',
    claudeSessionId: 'claude-session-1',
    toolName: 'AskUserQuestion',
    toolUseId: 'toolu_abc',
    toolInput: { questions: [] },
    toolResponse: 'Color → Red',
    tmuxSessionName: 'devchain-test-session',
    projectId: PROJECT_ID,
    agentId: AGENT_ID,
    sessionId: SESSION_ID,
  };

  beforeEach(async () => {
    mockStorage = {
      getAgent: jest.fn().mockResolvedValue({ id: basePayload.agentId, name: 'TestAgent' }),
    };

    mockEvents = {
      publish: jest.fn().mockResolvedValue('event-id-123'),
    };

    mockPending = {
      set: jest.fn((args) => ({
        ...args,
        createdAt: 1000,
        expiresAt: 1000 + 1800000,
        status: 'pending',
      })),
      clearByToolUseId: jest.fn().mockReturnValue(true),
      getBySession: jest.fn().mockReturnValue([]),
      clearBySession: jest.fn().mockReturnValue(0),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HooksService,
        { provide: STORAGE_SERVICE, useValue: mockStorage },
        { provide: EventsService, useValue: mockEvents },
        { provide: PendingAskUserQuestionService, useValue: mockPending },
      ],
    }).compile();

    service = module.get<HooksService>(HooksService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('handleHookEvent — SessionStart', () => {
    it('should publish claude.hooks.session.started with resolved agentName', async () => {
      const result = await service.handleHookEvent(basePayload);

      expect(result).toEqual({ ok: true, handled: true, data: {} });
      expect(mockStorage.getAgent).toHaveBeenCalledWith(basePayload.agentId);
      expect(mockEvents.publish).toHaveBeenCalledWith(
        'claude.hooks.session.started',
        expect.objectContaining({
          claudeSessionId: 'claude-session-1',
          source: 'startup',
          tmuxSessionName: 'devchain-test-session',
          projectId: '11111111-1111-1111-1111-111111111111',
          agentId: '22222222-2222-2222-2222-222222222222',
          agentName: 'TestAgent',
          sessionId: '33333333-3333-3333-3333-333333333333',
        }),
      );
    });

    it('should set agentName to null when agentId is null', async () => {
      const payload = { ...basePayload, agentId: null };

      const result = await service.handleHookEvent(payload);

      expect(result).toEqual({ ok: true, handled: true, data: {} });
      expect(mockStorage.getAgent).not.toHaveBeenCalled();
      expect(mockEvents.publish).toHaveBeenCalledWith(
        'claude.hooks.session.started',
        expect.objectContaining({ agentName: null }),
      );
    });

    it('should continue with null agentName when agent lookup fails', async () => {
      mockStorage.getAgent.mockRejectedValue(new Error('Agent not found'));

      const result = await service.handleHookEvent(basePayload);

      expect(result).toEqual({ ok: true, handled: true, data: {} });
      expect(mockEvents.publish).toHaveBeenCalledWith(
        'claude.hooks.session.started',
        expect.objectContaining({ agentName: null }),
      );
    });

    it('should return ok even when event publishing fails', async () => {
      mockEvents.publish.mockRejectedValue(new Error('Publish failed'));

      const result = await service.handleHookEvent(basePayload);

      expect(result).toEqual({ ok: true, handled: true, data: {} });
    });

    it('should include optional fields when provided', async () => {
      const payload: HookEventData = {
        ...basePayload,
        model: 'claude-sonnet-4-5',
        permissionMode: 'default',
        transcriptPath: '/tmp/transcript.jsonl',
      };

      await service.handleHookEvent(payload);

      expect(mockEvents.publish).toHaveBeenCalledWith(
        'claude.hooks.session.started',
        expect.objectContaining({
          model: 'claude-sonnet-4-5',
          permissionMode: 'default',
          transcriptPath: '/tmp/transcript.jsonl',
        }),
      );
    });
  });

  describe('handleHookEvent — SessionStart (provider-aware / Copilot)', () => {
    it('resolves claudeSessionId from providerSessionId when the Claude id is absent', async () => {
      const copilotPayload: HookEventData = {
        hookEventName: 'SessionStart',
        source: 'new',
        providerName: 'copilot',
        providerSessionId: 'copilot-session-9',
        tmuxSessionName: 'devchain-test-session',
        projectId: PROJECT_ID,
        agentId: AGENT_ID,
        sessionId: SESSION_ID,
      };

      const result = await service.handleHookEvent(copilotPayload);

      expect(result).toEqual({ ok: true, handled: true, data: {} });
      expect(mockEvents.publish).toHaveBeenCalledWith(
        'claude.hooks.session.started',
        expect.objectContaining({
          claudeSessionId: 'copilot-session-9',
          providerName: 'copilot',
          providerSessionId: 'copilot-session-9',
          source: 'new',
          sessionId: SESSION_ID,
        }),
      );
    });

    it('skips publish when both claudeSessionId and providerSessionId are missing', async () => {
      const idlessPayload: HookEventData = {
        hookEventName: 'SessionStart',
        source: 'new',
        tmuxSessionName: 'devchain-test-session',
        projectId: PROJECT_ID,
        agentId: null,
        sessionId: null,
      };

      const result = await service.handleHookEvent(idlessPayload);

      expect(result).toEqual({ ok: true, handled: true, data: {} });
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });
  });

  describe('handleHookEvent — Stop (agentStop)', () => {
    it('dispatches Stop without publishing (final-metrics deferred to a later phase)', async () => {
      const stopPayload: HookEventData = {
        hookEventName: 'Stop',
        stopReason: 'end_turn',
        transcriptPath: '/tmp/events.jsonl',
        providerName: 'copilot',
        providerSessionId: 'copilot-session-9',
        tmuxSessionName: 'devchain-test-session',
        projectId: PROJECT_ID,
        agentId: AGENT_ID,
        sessionId: SESSION_ID,
      };

      const result = await service.handleHookEvent(stopPayload);

      expect(result).toEqual({ ok: true, handled: false, data: {} });
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });
  });

  describe('handleHookEvent — unknown event', () => {
    it('should return handled:false for unknown hookEventName (defensive default)', async () => {
      // The schema rejects unknown event names at the controller; the service
      // keeps a defensive default branch in case one slips through.
      const payload = {
        ...basePayload,
        hookEventName: 'SomeUnknownEvent',
      } as unknown as HookEventData;

      const result = await service.handleHookEvent(payload);

      expect(result).toEqual({ ok: true, handled: false, data: {} });
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });
  });

  describe('handleHookEvent — PreToolUse(AskUserQuestion)', () => {
    it('stores normalized questions and publishes the pending event', async () => {
      const result = await service.handleHookEvent(prePayload);

      expect(result).toEqual({ ok: true, handled: true, data: {} });
      expect(mockPending.set).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: PROJECT_ID,
          agentId: AGENT_ID,
          sessionId: SESSION_ID,
          claudeSessionId: 'claude-session-1',
          toolUseId: 'toolu_abc',
          questions: askQuestions,
        }),
      );
      expect(mockEvents.publish).toHaveBeenCalledWith(
        'claude.hooks.ask_user_question.pending',
        expect.objectContaining({
          sessionId: SESSION_ID,
          toolUseId: 'toolu_abc',
          questions: askQuestions,
        }),
      );
    });

    it('ignores PreToolUse for other tools', async () => {
      const result = await service.handleHookEvent({
        ...prePayload,
        toolName: 'Bash',
      } as HookEventData);

      expect(result).toEqual({ ok: true, handled: false, data: {} });
      expect(mockPending.set).not.toHaveBeenCalled();
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });

    it('does not store when sessionId is null', async () => {
      const result = await service.handleHookEvent({
        ...prePayload,
        sessionId: null,
      } as HookEventData);

      expect(result).toEqual({ ok: true, handled: false, data: {} });
      expect(mockPending.set).not.toHaveBeenCalled();
    });

    it('skips storing when questions are malformed', async () => {
      const result = await service.handleHookEvent({
        ...prePayload,
        toolInput: { questions: [{ header: 'no-question' }] },
      } as HookEventData);

      expect(result).toEqual({ ok: true, handled: false, data: {} });
      expect(mockPending.set).not.toHaveBeenCalled();
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });

    it('still responds ok when publishing fails', async () => {
      mockEvents.publish.mockRejectedValue(new Error('boom'));

      const result = await service.handleHookEvent(prePayload);

      expect(result).toEqual({ ok: true, handled: true, data: {} });
      expect(mockPending.set).toHaveBeenCalled();
    });
  });

  describe('handleHookEvent — PostToolUse(AskUserQuestion)', () => {
    it('clears the pending entry and publishes the resolved event', async () => {
      const result = await service.handleHookEvent(postPayload);

      expect(result).toEqual({ ok: true, handled: true, data: { cleared: true } });
      expect(mockPending.clearByToolUseId).toHaveBeenCalledWith(SESSION_ID, 'toolu_abc');
      expect(mockEvents.publish).toHaveBeenCalledWith(
        'claude.hooks.ask_user_question.resolved',
        expect.objectContaining({ sessionId: SESSION_ID, toolUseId: 'toolu_abc' }),
      );
    });

    it('ignores PostToolUse for other tools', async () => {
      const result = await service.handleHookEvent({
        ...postPayload,
        toolName: 'Bash',
      } as HookEventData);

      expect(result).toEqual({ ok: true, handled: false, data: {} });
      expect(mockPending.clearByToolUseId).not.toHaveBeenCalled();
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });
  });
});
