import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { WatchersService } from './watchers.service';
import { WatcherRunnerService } from './watcher-runner.service';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import type { Watcher, CreateWatcher, UpdateWatcher } from '../../storage/models/domain.models';
import { ProjectWriteGate } from '../../storage/write-gate/project-write-gate';
import { createProjectWriteGateStub } from '../../storage/write-gate/testing/project-write-gate.stub';

describe('WatchersService', () => {
  let admission: ReturnType<typeof createProjectWriteGateStub>;
  let service: WatchersService;
  let mockStorage: {
    listWatchers: jest.Mock;
    getWatcher: jest.Mock;
    createWatcher: jest.Mock;
    updateWatcher: jest.Mock;
    deleteWatcher: jest.Mock;
    listEnabledWatchers: jest.Mock;
  };
  let mockWatcherRunner: {
    startWatcher: jest.Mock;
    stopWatcher: jest.Mock;
    isWatcherRunning: jest.Mock;
    testWatcher: jest.Mock;
  };

  const createMockWatcher = (overrides: Partial<Watcher> = {}): Watcher => ({
    id: 'watcher-1',
    projectId: 'project-1',
    name: 'Test Watcher',
    description: null,
    enabled: true,
    scope: 'all',
    scopeFilterId: null,
    pollIntervalMs: 1000,
    viewportLines: 50,
    idleAfterSeconds: 0,
    condition: { type: 'contains', pattern: 'error' },
    cooldownMs: 5000,
    cooldownMode: 'time',
    eventName: 'test.event',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  });

  beforeEach(async () => {
    admission = createProjectWriteGateStub();
    mockStorage = {
      listWatchers: jest.fn().mockResolvedValue([]),
      getWatcher: jest.fn().mockResolvedValue(null),
      createWatcher: jest.fn(),
      updateWatcher: jest.fn(),
      deleteWatcher: jest.fn().mockResolvedValue(undefined),
      listEnabledWatchers: jest.fn().mockResolvedValue([]),
    };

    mockWatcherRunner = {
      startWatcher: jest.fn().mockResolvedValue(undefined),
      stopWatcher: jest.fn().mockResolvedValue(undefined),
      isWatcherRunning: jest.fn().mockReturnValue(false),
      testWatcher: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: ProjectWriteGate, useValue: admission },
        WatchersService,
        {
          provide: STORAGE_SERVICE,
          useValue: mockStorage,
        },
        {
          provide: WatcherRunnerService,
          useValue: mockWatcherRunner,
        },
      ],
    }).compile();

    service = module.get<WatchersService>(WatchersService);
  });

  describe('getWatcher', () => {
    it('should throw NotFoundException when not found', async () => {
      mockStorage.getWatcher.mockResolvedValue(null);

      await expect(service.getWatcher('non-existent')).rejects.toThrow(NotFoundException);
      await expect(service.getWatcher('non-existent')).rejects.toThrow(
        'Watcher not found: non-existent',
      );
    });
  });

  describe('createWatcher', () => {
    it('should create watcher and start if enabled', async () => {
      const createData: CreateWatcher = {
        projectId: 'project-1',
        name: 'New Watcher',
        description: null,
        enabled: true,
        scope: 'all',
        scopeFilterId: null,
        pollIntervalMs: 1000,
        viewportLines: 50,
        idleAfterSeconds: 0,
        condition: { type: 'contains', pattern: 'error' },
        cooldownMs: 5000,
        cooldownMode: 'time',
        eventName: 'new.event',
      };
      const createdWatcher = createMockWatcher({ ...createData, id: 'new-watcher' });
      mockStorage.createWatcher.mockResolvedValue(createdWatcher);

      const result = await service.createWatcher(createData);

      expect(result).toEqual(createdWatcher);
      expect(mockStorage.createWatcher).toHaveBeenCalledWith(createData);
      expect(mockWatcherRunner.startWatcher).toHaveBeenCalledWith(createdWatcher);
    });

    it('should create watcher without starting if disabled', async () => {
      const createData: CreateWatcher = {
        projectId: 'project-1',
        name: 'Disabled Watcher',
        description: null,
        enabled: false,
        scope: 'all',
        scopeFilterId: null,
        pollIntervalMs: 1000,
        viewportLines: 50,
        idleAfterSeconds: 0,
        condition: { type: 'contains', pattern: 'error' },
        cooldownMs: 5000,
        cooldownMode: 'time',
        eventName: 'disabled.event',
      };
      const createdWatcher = createMockWatcher({ ...createData, id: 'disabled-watcher' });
      mockStorage.createWatcher.mockResolvedValue(createdWatcher);

      const result = await service.createWatcher(createData);

      expect(result).toEqual(createdWatcher);
      expect(mockWatcherRunner.startWatcher).not.toHaveBeenCalled();
    });
  });

  describe('updateWatcher', () => {
    it('should update watcher and restart if running and enabled', async () => {
      const existingWatcher = createMockWatcher({ id: 'watcher-1', enabled: true });
      const updateData: UpdateWatcher = { name: 'Updated Name' };
      const updatedWatcher = createMockWatcher({ ...existingWatcher, name: 'Updated Name' });

      mockStorage.getWatcher.mockResolvedValue(existingWatcher);
      mockStorage.updateWatcher.mockResolvedValue(updatedWatcher);
      mockWatcherRunner.isWatcherRunning.mockReturnValue(true);

      const result = await service.updateWatcher('watcher-1', updateData);

      expect(result).toEqual(updatedWatcher);
      expect(mockWatcherRunner.stopWatcher).toHaveBeenCalledWith('watcher-1');
      expect(mockWatcherRunner.startWatcher).toHaveBeenCalledWith(updatedWatcher);
    });

    it('should stop watcher when disabled', async () => {
      const existingWatcher = createMockWatcher({ id: 'watcher-1', enabled: true });
      const updateData: UpdateWatcher = { enabled: false };
      const updatedWatcher = createMockWatcher({ ...existingWatcher, enabled: false });

      mockStorage.getWatcher.mockResolvedValue(existingWatcher);
      mockStorage.updateWatcher.mockResolvedValue(updatedWatcher);
      mockWatcherRunner.isWatcherRunning.mockReturnValue(true);

      const result = await service.updateWatcher('watcher-1', updateData);

      expect(result).toEqual(updatedWatcher);
      expect(mockWatcherRunner.stopWatcher).toHaveBeenCalledWith('watcher-1');
      expect(mockWatcherRunner.startWatcher).not.toHaveBeenCalled();
    });

    it('should start watcher when enabled from disabled', async () => {
      const existingWatcher = createMockWatcher({ id: 'watcher-1', enabled: false });
      const updateData: UpdateWatcher = { enabled: true };
      const updatedWatcher = createMockWatcher({ ...existingWatcher, enabled: true });

      mockStorage.getWatcher.mockResolvedValue(existingWatcher);
      mockStorage.updateWatcher.mockResolvedValue(updatedWatcher);
      mockWatcherRunner.isWatcherRunning.mockReturnValue(false);

      const result = await service.updateWatcher('watcher-1', updateData);

      expect(result).toEqual(updatedWatcher);
      expect(mockWatcherRunner.stopWatcher).not.toHaveBeenCalled();
      expect(mockWatcherRunner.startWatcher).toHaveBeenCalledWith(updatedWatcher);
    });

    it('should throw NotFoundException if watcher does not exist', async () => {
      mockStorage.getWatcher.mockResolvedValue(null);

      await expect(service.updateWatcher('non-existent', { name: 'New' })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('deleteWatcher', () => {
    it('should stop running watcher before deletion', async () => {
      mockWatcherRunner.isWatcherRunning.mockReturnValue(true);

      await service.deleteWatcher('watcher-1');

      expect(mockWatcherRunner.stopWatcher).toHaveBeenCalledWith('watcher-1');
      expect(mockStorage.deleteWatcher).toHaveBeenCalledWith('watcher-1');
    });

    it('should delete watcher without stopping if not running', async () => {
      mockWatcherRunner.isWatcherRunning.mockReturnValue(false);

      await service.deleteWatcher('watcher-1');

      expect(mockWatcherRunner.stopWatcher).not.toHaveBeenCalled();
      expect(mockStorage.deleteWatcher).toHaveBeenCalledWith('watcher-1');
    });
  });

  describe('toggleWatcher', () => {
    it('should enable watcher via updateWatcher', async () => {
      const existingWatcher = createMockWatcher({ enabled: false });
      const updatedWatcher = createMockWatcher({ enabled: true });

      mockStorage.getWatcher.mockResolvedValue(existingWatcher);
      mockStorage.updateWatcher.mockResolvedValue(updatedWatcher);
      mockWatcherRunner.isWatcherRunning.mockReturnValue(false);

      const result = await service.toggleWatcher('watcher-1', true);

      expect(result).toEqual(updatedWatcher);
      expect(mockStorage.updateWatcher).toHaveBeenCalledWith('watcher-1', { enabled: true });
    });
  });

  describe('testWatcher', () => {
    it('should get watcher and delegate to runner', async () => {
      const watcher = createMockWatcher();
      const testResults = [
        {
          sessionId: 'session-1',
          agentId: 'agent-1',
          tmuxSessionId: 'tmux-1',
          viewport: 'error in terminal',
          viewportHash: 'hash123',
          conditionMatched: true,
        },
      ];

      mockStorage.getWatcher.mockResolvedValue(watcher);
      mockWatcherRunner.testWatcher.mockResolvedValue(testResults);

      const result = await service.testWatcher('watcher-1');

      expect(result.watcher).toEqual(watcher);
      expect(result.sessionsChecked).toBe(1);
      expect(result.results).toEqual(testResults);
      expect(mockWatcherRunner.testWatcher).toHaveBeenCalledWith(watcher);
    });
  });

  it.each(['create', 'update', 'delete'] as const)(
    'propagates %s admission refusals without runner side effects',
    async (operation) => {
      const refusal = new Error('Project is read-only');
      if (operation === 'delete') {
        admission.assertWritable.mockImplementation(() => {
          throw refusal;
        });
      } else if (operation === 'create') {
        mockStorage.createWatcher.mockRejectedValue(refusal);
      } else {
        mockStorage.updateWatcher.mockRejectedValue(refusal);
      }
      const existing = createMockWatcher();
      mockStorage.getWatcher.mockResolvedValue(existing);
      mockWatcherRunner.isWatcherRunning.mockReturnValue(true);
      const write =
        operation === 'create'
          ? service.createWatcher(existing)
          : operation === 'update'
            ? service.updateWatcher(existing.id, { enabled: false })
            : service.deleteWatcher(existing.id);
      await expect(write).rejects.toBe(refusal);
      if (operation === 'delete') {
        expect(admission.assertWritable).toHaveBeenCalledWith(existing.projectId);
      } else {
        expect(admission.assertWritable).not.toHaveBeenCalled();
      }
      expect(mockStorage.createWatcher).toHaveBeenCalledTimes(operation === 'create' ? 1 : 0);
      expect(mockStorage.updateWatcher).toHaveBeenCalledTimes(operation === 'update' ? 1 : 0);
      expect(mockStorage.deleteWatcher).not.toHaveBeenCalled();
      expect(mockWatcherRunner.startWatcher).not.toHaveBeenCalled();
      expect(mockWatcherRunner.stopWatcher).not.toHaveBeenCalled();
    },
  );
});
