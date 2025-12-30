import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { SubscribersService } from './subscribers.service';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import type {
  Subscriber,
  CreateSubscriber,
  UpdateSubscriber,
} from '../../storage/models/domain.models';

describe('SubscribersService', () => {
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
        SubscribersService,
        {
          provide: STORAGE_SERVICE,
          useValue: mockStorage,
        },
      ],
    }).compile();

    service = module.get<SubscribersService>(SubscribersService);
  });

  describe('listSubscribers', () => {
    it('should return all subscribers for a project', async () => {
      const subscribers = [
        createMockSubscriber({ id: 'sub-1', name: 'Subscriber 1' }),
        createMockSubscriber({ id: 'sub-2', name: 'Subscriber 2' }),
      ];
      mockStorage.listSubscribers.mockResolvedValue(subscribers);

      const result = await service.listSubscribers('project-1');

      expect(result).toEqual(subscribers);
      expect(mockStorage.listSubscribers).toHaveBeenCalledWith('project-1');
    });

    it('should return empty array when no subscribers exist', async () => {
      mockStorage.listSubscribers.mockResolvedValue([]);

      const result = await service.listSubscribers('project-1');

      expect(result).toEqual([]);
    });
  });

  describe('getSubscriber', () => {
    it('should return subscriber when found', async () => {
      const subscriber = createMockSubscriber();
      mockStorage.getSubscriber.mockResolvedValue(subscriber);

      const result = await service.getSubscriber('subscriber-1');

      expect(result).toEqual(subscriber);
      expect(mockStorage.getSubscriber).toHaveBeenCalledWith('subscriber-1');
    });

    it('should throw NotFoundException when not found', async () => {
      mockStorage.getSubscriber.mockResolvedValue(null);

      await expect(service.getSubscriber('non-existent')).rejects.toThrow(NotFoundException);
      await expect(service.getSubscriber('non-existent')).rejects.toThrow(
        'Subscriber not found: non-existent',
      );
    });
  });

  describe('createSubscriber', () => {
    it('should create and return a new subscriber', async () => {
      const createData: CreateSubscriber = {
        projectId: 'project-1',
        name: 'New Subscriber',
        description: 'A new subscriber',
        enabled: true,
        eventName: 'test.event',
        eventFilter: null,
        actionType: 'send_agent_message',
        actionInputs: { text: { source: 'custom', customValue: 'Hello' } },
        delayMs: 0,
        cooldownMs: 5000,
        retryOnError: false,
        groupName: null,
        position: 0,
        priority: 0,
      };
      const createdSubscriber = createMockSubscriber({ ...createData, id: 'new-subscriber' });
      mockStorage.createSubscriber.mockResolvedValue(createdSubscriber);

      const result = await service.createSubscriber(createData);

      expect(result).toEqual(createdSubscriber);
      expect(mockStorage.createSubscriber).toHaveBeenCalledWith(createData);
    });
  });

  describe('updateSubscriber', () => {
    it('should update and return subscriber', async () => {
      const existingSubscriber = createMockSubscriber();
      const updateData: UpdateSubscriber = { name: 'Updated Name' };
      const updatedSubscriber = createMockSubscriber({ name: 'Updated Name' });

      mockStorage.getSubscriber.mockResolvedValue(existingSubscriber);
      mockStorage.updateSubscriber.mockResolvedValue(updatedSubscriber);

      const result = await service.updateSubscriber('subscriber-1', updateData);

      expect(result).toEqual(updatedSubscriber);
      expect(mockStorage.getSubscriber).toHaveBeenCalledWith('subscriber-1');
      expect(mockStorage.updateSubscriber).toHaveBeenCalledWith('subscriber-1', updateData);
    });

    it('should throw NotFoundException if subscriber does not exist', async () => {
      mockStorage.getSubscriber.mockResolvedValue(null);

      await expect(service.updateSubscriber('non-existent', { name: 'New Name' })).rejects.toThrow(
        NotFoundException,
      );
      expect(mockStorage.updateSubscriber).not.toHaveBeenCalled();
    });
  });

  describe('deleteSubscriber', () => {
    it('should delete subscriber when found', async () => {
      const subscriber = createMockSubscriber();
      mockStorage.getSubscriber.mockResolvedValue(subscriber);
      mockStorage.deleteSubscriber.mockResolvedValue();

      await service.deleteSubscriber('subscriber-1');

      expect(mockStorage.getSubscriber).toHaveBeenCalledWith('subscriber-1');
      expect(mockStorage.deleteSubscriber).toHaveBeenCalledWith('subscriber-1');
    });

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

    it('should disable an enabled subscriber', async () => {
      const subscriber = createMockSubscriber({ enabled: true });
      const disabledSubscriber = createMockSubscriber({ enabled: false });

      mockStorage.getSubscriber.mockResolvedValue(subscriber);
      mockStorage.updateSubscriber.mockResolvedValue(disabledSubscriber);

      const result = await service.toggleSubscriber('subscriber-1', false);

      expect(result.enabled).toBe(false);
      expect(mockStorage.updateSubscriber).toHaveBeenCalledWith('subscriber-1', { enabled: false });
    });

    it('should throw NotFoundException if subscriber does not exist', async () => {
      mockStorage.getSubscriber.mockResolvedValue(null);

      await expect(service.toggleSubscriber('non-existent', true)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('findSubscribersByEventName', () => {
    it('should return subscribers matching the event name', async () => {
      const subscribers = [
        createMockSubscriber({ id: 'sub-1', eventName: 'test.event' }),
        createMockSubscriber({ id: 'sub-2', eventName: 'test.event' }),
      ];
      mockStorage.findSubscribersByEventName.mockResolvedValue(subscribers);

      const result = await service.findSubscribersByEventName('project-1', 'test.event');

      expect(result).toEqual(subscribers);
      expect(mockStorage.findSubscribersByEventName).toHaveBeenCalledWith(
        'project-1',
        'test.event',
      );
    });

    it('should return empty array when no subscribers match', async () => {
      mockStorage.findSubscribersByEventName.mockResolvedValue([]);

      const result = await service.findSubscribersByEventName('project-1', 'other.event');

      expect(result).toEqual([]);
    });
  });
});
