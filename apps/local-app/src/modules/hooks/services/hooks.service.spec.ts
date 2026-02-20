import { Test, TestingModule } from '@nestjs/testing';
import { HooksService } from './hooks.service';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { EventsService } from '../../events/services/events.service';
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

  const basePayload: HookEventData = {
    hookEventName: 'SessionStart',
    claudeSessionId: 'claude-session-1',
    source: 'startup',
    tmuxSessionName: 'devchain-test-session',
    projectId: '11111111-1111-1111-1111-111111111111',
    agentId: '22222222-2222-2222-2222-222222222222',
    sessionId: '33333333-3333-3333-3333-333333333333',
  };

  beforeEach(async () => {
    mockStorage = {
      getAgent: jest.fn().mockResolvedValue({ id: basePayload.agentId, name: 'TestAgent' }),
    };

    mockEvents = {
      publish: jest.fn().mockResolvedValue('event-id-123'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HooksService,
        { provide: STORAGE_SERVICE, useValue: mockStorage },
        { provide: EventsService, useValue: mockEvents },
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

  describe('handleHookEvent — unknown event', () => {
    it('should return handled:false for unknown hookEventName', async () => {
      const payload = { ...basePayload, hookEventName: 'SomeUnknownEvent' };

      const result = await service.handleHookEvent(payload);

      expect(result).toEqual({ ok: true, handled: false, data: {} });
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });
  });
});
