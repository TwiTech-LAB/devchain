import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { SubscribersService } from './subscribers.service';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import type { Subscriber } from '../../storage/models/domain.models';
import { ProjectWriteGate } from '../../storage/write-gate/project-write-gate';
import { createProjectWriteGateStub } from '../../storage/write-gate/testing/project-write-gate.stub';
import { NotFoundError } from '../../../common/errors/error-types';

describe('SubscribersService', () => {
  let admission: ReturnType<typeof createProjectWriteGateStub>;
  let service: SubscribersService;
  let mockStorage: jest.Mocked<
    Pick<
      StorageService,
      | 'listSubscribers'
      | 'getSubscriber'
      | 'createSubscriber'
      | 'updateSubscriber'
      | 'deleteSubscriber'
      | 'findSubscribersByEventName'
    >
  >;

  const createMockSubscriber = (overrides: Partial<Subscriber> = {}): Subscriber => ({
    id: 'subscriber-1',
    projectId: 'project-1',
    name: 'Test Subscriber',
    description: null,
    enabled: true,
    eventName: 'test.event',
    eventFilter: null,
    actionType: 'send_agent_message',
    actionInputs: { text: { source: 'custom', customValue: 'Hello' } },
    delayMs: 0,
    cooldownMs: 0,
    retryOnError: false,
    groupName: null,
    position: 0,
    priority: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  });

  beforeEach(async () => {
    admission = createProjectWriteGateStub();
    mockStorage = {
      listSubscribers: jest.fn(),
      getSubscriber: jest.fn(),
      createSubscriber: jest.fn(),
      updateSubscriber: jest.fn(),
      deleteSubscriber: jest.fn(),
      findSubscribersByEventName: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: ProjectWriteGate, useValue: admission },
        SubscribersService,
        {
          provide: STORAGE_SERVICE,
          useValue: mockStorage,
        },
      ],
    }).compile();

    service = module.get<SubscribersService>(SubscribersService);
  });

  describe('getSubscriber', () => {
    it('should throw NotFoundException when not found', async () => {
      mockStorage.getSubscriber.mockResolvedValue(null);

      await expect(service.getSubscriber('non-existent')).rejects.toThrow(NotFoundException);
      await expect(service.getSubscriber('non-existent')).rejects.toThrow(
        'Subscriber not found: non-existent',
      );
    });
  });

  describe('updateSubscriber', () => {
    it('propagates storage NotFoundError if subscriber does not exist', async () => {
      mockStorage.updateSubscriber.mockRejectedValue(
        new NotFoundError('Subscriber', 'non-existent'),
      );

      await expect(service.updateSubscriber('non-existent', { name: 'New Name' })).rejects.toThrow(
        NotFoundError,
      );
      expect(mockStorage.updateSubscriber).toHaveBeenCalledWith('non-existent', {
        name: 'New Name',
      });
    });
  });

  describe('deleteSubscriber', () => {
    it('should throw NotFoundException if subscriber does not exist', async () => {
      mockStorage.getSubscriber.mockResolvedValue(null);

      await expect(service.deleteSubscriber('non-existent')).rejects.toThrow(NotFoundException);
      expect(mockStorage.deleteSubscriber).not.toHaveBeenCalled();
    });
  });

  describe('toggleSubscriber', () => {
    it('should enable a disabled subscriber', async () => {
      const subscriber = createMockSubscriber({ enabled: false });
      const enabledSubscriber = createMockSubscriber({ enabled: true });

      mockStorage.getSubscriber.mockResolvedValue(subscriber);
      mockStorage.updateSubscriber.mockResolvedValue(enabledSubscriber);

      const result = await service.toggleSubscriber('subscriber-1', true);

      expect(result.enabled).toBe(true);
      expect(mockStorage.updateSubscriber).toHaveBeenCalledWith('subscriber-1', { enabled: true });
    });
  });

  it.each(['create', 'update', 'delete'] as const)(
    'propagates %s admission refusals from storage',
    async (operation) => {
      const refusal = new Error('Project is read-only');
      if (operation === 'create') mockStorage.createSubscriber.mockRejectedValue(refusal);
      else if (operation === 'update') mockStorage.updateSubscriber.mockRejectedValue(refusal);
      else mockStorage.deleteSubscriber.mockRejectedValue(refusal);
      const existing = createMockSubscriber();
      mockStorage.getSubscriber.mockResolvedValue(existing);

      const write =
        operation === 'create'
          ? service.createSubscriber(existing)
          : operation === 'update'
            ? service.updateSubscriber(existing.id, { enabled: false })
            : service.deleteSubscriber(existing.id);
      await expect(write).rejects.toBe(refusal);
      expect(admission.assertWritable).not.toHaveBeenCalled();
      expect(mockStorage.createSubscriber).toHaveBeenCalledTimes(operation === 'create' ? 1 : 0);
      expect(mockStorage.updateSubscriber).toHaveBeenCalledTimes(operation === 'update' ? 1 : 0);
      expect(mockStorage.deleteSubscriber).toHaveBeenCalledTimes(operation === 'delete' ? 1 : 0);
    },
  );
});
