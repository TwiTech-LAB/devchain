import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { HooksController } from './hooks.controller';
import { HooksService } from '../services/hooks.service';

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  }),
}));

describe('HooksController', () => {
  let controller: HooksController;
  let mockHooksService: { handleHookEvent: jest.Mock };

  const validPayload = {
    hookEventName: 'SessionStart',
    claudeSessionId: 'claude-session-1',
    source: 'startup',
    tmuxSessionName: 'devchain-test-session',
    projectId: '11111111-1111-1111-1111-111111111111',
    agentId: '22222222-2222-2222-2222-222222222222',
    sessionId: '33333333-3333-3333-3333-333333333333',
  };

  beforeEach(async () => {
    mockHooksService = {
      handleHookEvent: jest.fn().mockResolvedValue({ ok: true, handled: true, data: {} }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HooksController],
      providers: [{ provide: HooksService, useValue: mockHooksService }],
    }).compile();

    controller = module.get(HooksController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('receiveHookEvent', () => {
    it('should accept a valid SessionStart payload and delegate to service', async () => {
      const result = await controller.receiveHookEvent(validPayload);

      expect(result).toEqual({ ok: true, handled: true, data: {} });
      expect(mockHooksService.handleHookEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          hookEventName: 'SessionStart',
          claudeSessionId: 'claude-session-1',
          source: 'startup',
          projectId: '11111111-1111-1111-1111-111111111111',
        }),
      );
    });

    it('should return 400 when required fields are missing', async () => {
      const invalidPayload = { hookEventName: 'SessionStart' };

      await expect(controller.receiveHookEvent(invalidPayload)).rejects.toThrow(
        BadRequestException,
      );
      expect(mockHooksService.handleHookEvent).not.toHaveBeenCalled();
    });

    it('should return 400 when unknown keys are present (strict mode)', async () => {
      const payloadWithExtra = { ...validPayload, unknownField: 'value' };

      await expect(controller.receiveHookEvent(payloadWithExtra)).rejects.toThrow(
        BadRequestException,
      );
      expect(mockHooksService.handleHookEvent).not.toHaveBeenCalled();
    });

    it('should accept unknown hookEventName and delegate to service', async () => {
      mockHooksService.handleHookEvent.mockResolvedValue({ ok: true, handled: false, data: {} });

      const payload = { ...validPayload, hookEventName: 'UnknownEvent' };
      const result = await controller.receiveHookEvent(payload);

      expect(result).toEqual({ ok: true, handled: false, data: {} });
      expect(mockHooksService.handleHookEvent).toHaveBeenCalled();
    });

    it('should accept payload with optional fields omitted', async () => {
      const minimalPayload = {
        hookEventName: 'SessionStart',
        claudeSessionId: 'claude-session-1',
        source: 'startup',
        tmuxSessionName: 'test-session',
        projectId: '11111111-1111-1111-1111-111111111111',
        agentId: null,
        sessionId: null,
      };

      const result = await controller.receiveHookEvent(minimalPayload);

      expect(result).toEqual({ ok: true, handled: true, data: {} });
      expect(mockHooksService.handleHookEvent).toHaveBeenCalled();
    });

    it('should return 400 for projectId that is not a UUID', async () => {
      const badPayload = { ...validPayload, projectId: 'not-a-uuid' };

      await expect(controller.receiveHookEvent(badPayload)).rejects.toThrow(BadRequestException);
    });
  });
});
