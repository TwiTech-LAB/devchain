import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { WatchersController } from './watchers.controller';
import { WatchersService } from '../services/watchers.service';

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

describe('WatchersController', () => {
  let controller: WatchersController;
  let mockWatchersService: {
    listWatchers: jest.Mock;
    getWatcher: jest.Mock;
    createWatcher: jest.Mock;
    updateWatcher: jest.Mock;
    deleteWatcher: jest.Mock;
    toggleWatcher: jest.Mock;
    testWatcher: jest.Mock;
  };

  beforeEach(async () => {
    mockWatchersService = {
      listWatchers: jest.fn(),
      getWatcher: jest.fn(),
      createWatcher: jest.fn(),
      updateWatcher: jest.fn(),
      deleteWatcher: jest.fn(),
      toggleWatcher: jest.fn(),
      testWatcher: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [WatchersController],
      providers: [
        {
          provide: WatchersService,
          useValue: mockWatchersService,
        },
      ],
    }).compile();

    controller = module.get(WatchersController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/watchers', () => {
    it('throws BadRequestException when projectId is missing', async () => {
      await expect(controller.listWatchers(undefined)).rejects.toThrow(BadRequestException);
      expect(mockWatchersService.listWatchers).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/watchers', () => {
    it.each([
      {
        name: 'controller.createWatcher',
        invoke: () =>
          controller.createWatcher({
            projectId: 'not-a-uuid',
            name: '',
          }),
      },
      {
        name: 'controller.updateWatcher',
        invoke: () => controller.updateWatcher('watcher-1', { pollIntervalMs: 100 }),
      },
      {
        name: 'controller.toggleWatcher',
        invoke: () => controller.toggleWatcher('watcher-1', { enabled: 'not-boolean' }),
      },
    ])('maps invalid input in $name to bad request', async ({ invoke }) => {
      await expect(invoke()).rejects.toThrow(BadRequestException);
      expect(mockWatchersService.createWatcher).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /api/watchers/:id', () => {
    it('throws NotFoundException when watcher not found', async () => {
      mockWatchersService.getWatcher.mockRejectedValue(
        new NotFoundException('Watcher not found: non-existent'),
      );

      await expect(controller.deleteWatcher('non-existent')).rejects.toThrow(NotFoundException);
      expect(mockWatchersService.deleteWatcher).not.toHaveBeenCalled();
    });
  });
});
