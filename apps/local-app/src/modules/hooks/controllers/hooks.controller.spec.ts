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
    it('should return 400 when required fields are missing', async () => {
      const invalidPayload = { hookEventName: 'SessionStart' };

      await expect(controller.receiveHookEvent(invalidPayload)).rejects.toThrow(
        BadRequestException,
      );
      expect(mockHooksService.handleHookEvent).not.toHaveBeenCalled();
    });
  });
});
