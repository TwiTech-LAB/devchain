import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { SubscribersService } from './subscribers.service';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import type { Subscriber } from '../../storage/models/domain.models';
import { ProjectWriteAdmissionService } from '../../remotes/admission/project-write-admission.service';
import { createProjectWriteAdmissionStub } from '../../remotes/admission/testing/project-write-admission.stub';

describe('SubscribersService', () => {
  let admission: ReturnType<typeof createProjectWriteAdmissionStub>;
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
    admission = createProjectWriteAdmissionStub();
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
        { provide: ProjectWriteAdmissionService, useValue: admission },
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
    it('should throw NotFoundException if subscriber does not exist', async () => {
      mockStorage.getSubscriber.mockResolvedValue(null);

      await expect(service.updateSubscriber('non-existent', { name: 'New Name' })).rejects.toThrow(
        NotFoundException,
      );
      expect(mockStorage.updateSubscriber).not.toHaveBeenCalled();
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

  // Service tests cover admission before writes without the cost of HTTP or storage integration.
  it.each(['create', 'update', 'delete'] as const)(
    'rejects %s writes to a read-only project before side effects',
    async (operation) => {
      const refusal = new Error('Project is read-only');
      admission.assertWritable.mockImplementation(() => {
        throw refusal;
      });
      const existing = createMockSubscriber();
      mockStorage.getSubscriber.mockResolvedValue(existing);

      const write =
        operation === 'create'
          ? service.createSubscriber(existing)
          : operation === 'update'
            ? service.updateSubscriber(existing.id, { enabled: false })
            : service.deleteSubscriber(existing.id);
      await expect(write).rejects.toBe(refusal);
      expect(admission.assertWritable).toHaveBeenCalledWith(existing.projectId);
      expect(mockStorage.createSubscriber).not.toHaveBeenCalled();
      expect(mockStorage.updateSubscriber).not.toHaveBeenCalled();
      expect(mockStorage.deleteSubscriber).not.toHaveBeenCalled();
    },
  );
});
