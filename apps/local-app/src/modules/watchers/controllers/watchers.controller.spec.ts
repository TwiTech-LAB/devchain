import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { WatchersController } from './watchers.controller';
import { WatchersService, TestWatcherResult } from '../services/watchers.service';
import type { Watcher } from '../../storage/models/domain.models';

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

  const mockWatcher: Watcher = {
    id: 'watcher-1',
    projectId: 'project-1',
    name: 'Test Watcher',
    description: null,
    enabled: true,
    scope: 'all',
    scopeFilterId: null,
    pollIntervalMs: 5000,
    viewportLines: 50,
    condition: { type: 'contains', pattern: 'error' },
    cooldownMs: 60000,
    cooldownMode: 'time',
    eventName: 'test.event',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
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

    it('lists watchers when projectId is provided', async () => {
      mockWatchersService.listWatchers.mockResolvedValue([mockWatcher]);

      const result = await controller.listWatchers('project-1');

      expect(mockWatchersService.listWatchers).toHaveBeenCalledWith('project-1');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('watcher-1');
    });

    it('returns empty array when no watchers', async () => {
      mockWatchersService.listWatchers.mockResolvedValue([]);

      const result = await controller.listWatchers('project-1');

      expect(result).toEqual([]);
    });
  });

  describe('GET /api/watchers/:id', () => {
    it('returns a watcher by id', async () => {
      mockWatchersService.getWatcher.mockResolvedValue(mockWatcher);

      const result = await controller.getWatcher('watcher-1');

      expect(mockWatchersService.getWatcher).toHaveBeenCalledWith('watcher-1');
      expect(result.id).toBe('watcher-1');
    });

    it('throws NotFoundException when watcher not found', async () => {
      mockWatchersService.getWatcher.mockRejectedValue(
        new NotFoundException('Watcher not found: non-existent'),
      );

      await expect(controller.getWatcher('non-existent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('POST /api/watchers', () => {
    it('creates a watcher with valid data', async () => {
      const createData = {
        projectId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        name: 'New Watcher',
        condition: { type: 'contains', pattern: 'error' },
        eventName: 'new.event',
      };
      mockWatchersService.createWatcher.mockResolvedValue({
        ...mockWatcher,
        id: 'new-watcher',
        projectId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        name: 'New Watcher',
        eventName: 'new.event',
      });

      const result = await controller.createWatcher(createData);

      expect(mockWatchersService.createWatcher).toHaveBeenCalled();
      expect(result.name).toBe('New Watcher');
    });

    it('throws BadRequestException for invalid data', async () => {
      const invalidData = {
        projectId: 'not-a-uuid',
        name: '',
      };

      await expect(controller.createWatcher(invalidData)).rejects.toThrow(BadRequestException);
      expect(mockWatchersService.createWatcher).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when condition is missing', async () => {
      const invalidData = {
        projectId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        name: 'Test',
        eventName: 'test.event',
      };

      await expect(controller.createWatcher(invalidData)).rejects.toThrow(BadRequestException);
    });

    it('allows creating multiple watchers with the same eventName', async () => {
      const createData = {
        projectId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        name: 'Shared Event Watcher',
        condition: { type: 'contains' as const, pattern: 'error' },
        eventName: 'shared.event',
      };
      mockWatchersService.createWatcher
        .mockResolvedValueOnce({
          ...mockWatcher,
          id: 'watcher-1',
          projectId: createData.projectId,
          name: createData.name,
          eventName: createData.eventName,
        })
        .mockResolvedValueOnce({
          ...mockWatcher,
          id: 'watcher-2',
          projectId: createData.projectId,
          name: `${createData.name} 2`,
          eventName: createData.eventName,
        });

      const first = await controller.createWatcher(createData);
      const second = await controller.createWatcher({
        ...createData,
        name: 'Shared Event Watcher 2',
      });

      expect(first.eventName).toBe('shared.event');
      expect(second.eventName).toBe('shared.event');
      expect(mockWatchersService.createWatcher).toHaveBeenCalledTimes(2);
    });
  });

  describe('PUT /api/watchers/:id', () => {
    it('updates a watcher with valid data', async () => {
      const updateData = { name: 'Updated Watcher' };
      mockWatchersService.updateWatcher.mockResolvedValue({
        ...mockWatcher,
        name: 'Updated Watcher',
      });

      const result = await controller.updateWatcher('watcher-1', updateData);

      expect(mockWatchersService.updateWatcher).toHaveBeenCalledWith('watcher-1', updateData);
      expect(result.name).toBe('Updated Watcher');
    });

    it('throws BadRequestException for invalid data', async () => {
      const invalidData = { pollIntervalMs: 100 }; // Below minimum

      await expect(controller.updateWatcher('watcher-1', invalidData)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('DELETE /api/watchers/:id', () => {
    it('deletes a watcher and returns success', async () => {
      mockWatchersService.getWatcher.mockResolvedValue(mockWatcher);
      mockWatchersService.deleteWatcher.mockResolvedValue(undefined);

      const result = await controller.deleteWatcher('watcher-1');

      expect(mockWatchersService.getWatcher).toHaveBeenCalledWith('watcher-1');
      expect(mockWatchersService.deleteWatcher).toHaveBeenCalledWith('watcher-1');
      expect(result).toEqual({ success: true });
    });

    it('throws NotFoundException when watcher not found', async () => {
      mockWatchersService.getWatcher.mockRejectedValue(
        new NotFoundException('Watcher not found: non-existent'),
      );

      await expect(controller.deleteWatcher('non-existent')).rejects.toThrow(NotFoundException);
      expect(mockWatchersService.deleteWatcher).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/watchers/:id/toggle', () => {
    it('toggles watcher enabled status', async () => {
      mockWatchersService.toggleWatcher.mockResolvedValue({ ...mockWatcher, enabled: false });

      const result = await controller.toggleWatcher('watcher-1', { enabled: false });

      expect(mockWatchersService.toggleWatcher).toHaveBeenCalledWith('watcher-1', false);
      expect(result.enabled).toBe(false);
    });

    it('throws BadRequestException for invalid body', async () => {
      await expect(
        controller.toggleWatcher('watcher-1', { enabled: 'not-boolean' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when enabled is missing', async () => {
      await expect(controller.toggleWatcher('watcher-1', {})).rejects.toThrow(BadRequestException);
    });
  });

  describe('POST /api/watchers/:id/test', () => {
    it('returns test results for watcher', async () => {
      const testResult: TestWatcherResult = {
        watcher: mockWatcher,
        sessionsChecked: 2,
        results: [
          {
            sessionId: 'session-1',
            agentId: 'agent-1',
            tmuxSessionId: 'tmux-1',
            viewport: 'error occurred',
            viewportHash: 'hash123',
            conditionMatched: true,
          },
          {
            sessionId: 'session-2',
            agentId: null,
            tmuxSessionId: 'tmux-2',
            viewport: 'all good',
            viewportHash: 'hash456',
            conditionMatched: false,
          },
        ],
      };
      mockWatchersService.testWatcher.mockResolvedValue(testResult);

      const result = await controller.testWatcher('watcher-1');

      expect(mockWatchersService.testWatcher).toHaveBeenCalledWith('watcher-1');
      expect(result.sessionsChecked).toBe(2);
      expect(result.results).toHaveLength(2);
      expect(result.results[0].conditionMatched).toBe(true);
      expect(result.watcher.id).toBe('watcher-1');
    });

    it('throws NotFoundException when watcher not found', async () => {
      mockWatchersService.testWatcher.mockRejectedValue(
        new NotFoundException('Watcher not found: non-existent'),
      );

      await expect(controller.testWatcher('non-existent')).rejects.toThrow(NotFoundException);
    });

    it('returns empty results when no sessions', async () => {
      const testResult: TestWatcherResult = {
        watcher: mockWatcher,
        sessionsChecked: 0,
        results: [],
      };
      mockWatchersService.testWatcher.mockResolvedValue(testResult);

      const result = await controller.testWatcher('watcher-1');

      expect(result.sessionsChecked).toBe(0);
      expect(result.results).toEqual([]);
    });
  });
});
