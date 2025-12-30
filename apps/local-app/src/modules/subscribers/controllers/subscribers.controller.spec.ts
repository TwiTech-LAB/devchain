import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SubscribersController } from './subscribers.controller';
import { SubscribersService } from '../services/subscribers.service';
import type { Subscriber } from '../../storage/models/domain.models';

describe('SubscribersController', () => {
  let controller: SubscribersController;
  let mockService: jest.Mocked<SubscribersService>;

  const createMockSubscriber = (overrides: Partial<Subscriber> = {}): Subscriber => ({
    id: 'subscriber-1',
    projectId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    name: 'Test Subscriber',
    description: null,
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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  });

  beforeEach(async () => {
    mockService = {
      listSubscribers: jest.fn(),
      getSubscriber: jest.fn(),
      createSubscriber: jest.fn(),
      updateSubscriber: jest.fn(),
      deleteSubscriber: jest.fn(),
      toggleSubscriber: jest.fn(),
      findSubscribersByEventName: jest.fn(),
    } as unknown as jest.Mocked<SubscribersService>;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SubscribersController],
      providers: [
        {
          provide: SubscribersService,
          useValue: mockService,
        },
      ],
    }).compile();

    controller = module.get<SubscribersController>(SubscribersController);
  });

  describe('listSubscribers', () => {
    it('should return subscribers for project', async () => {
      const subscribers = [
        createMockSubscriber({ id: 'sub-1' }),
        createMockSubscriber({ id: 'sub-2' }),
      ];
      mockService.listSubscribers.mockResolvedValue(subscribers);

      const result = await controller.listSubscribers('project-1');

      expect(result).toHaveLength(2);
      expect(mockService.listSubscribers).toHaveBeenCalledWith('project-1');
    });

    it('should throw BadRequestException when projectId is missing', async () => {
      await expect(controller.listSubscribers(undefined)).rejects.toThrow(BadRequestException);
      await expect(controller.listSubscribers(undefined)).rejects.toThrow(
        'projectId query parameter is required',
      );
    });
  });

  describe('getSubscriber', () => {
    it('should return subscriber when found', async () => {
      const subscriber = createMockSubscriber();
      mockService.getSubscriber.mockResolvedValue(subscriber);

      const result = await controller.getSubscriber('subscriber-1');

      expect(result.id).toBe('subscriber-1');
      expect(mockService.getSubscriber).toHaveBeenCalledWith('subscriber-1');
    });

    it('should throw NotFoundException when not found', async () => {
      mockService.getSubscriber.mockRejectedValue(
        new NotFoundException('Subscriber not found: non-existent'),
      );

      await expect(controller.getSubscriber('non-existent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('createSubscriber', () => {
    it('should create and return subscriber', async () => {
      const subscriber = createMockSubscriber();
      mockService.createSubscriber.mockResolvedValue(subscriber);

      const body = {
        projectId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        name: 'Test Subscriber',
        eventName: 'test.event',
        actionType: 'send_agent_message',
        actionInputs: { text: { source: 'custom', customValue: 'Hello' } },
      };

      const result = await controller.createSubscriber(body);

      expect(result.name).toBe('Test Subscriber');
      expect(mockService.createSubscriber).toHaveBeenCalled();
    });

    it('should throw BadRequestException for invalid body', async () => {
      const invalidBody = { name: '' }; // missing required fields

      await expect(controller.createSubscriber(invalidBody)).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException for invalid projectId', async () => {
      const invalidBody = {
        projectId: 'not-a-uuid',
        name: 'Test',
        eventName: 'test.event',
        actionType: 'send_agent_message',
        actionInputs: {},
      };

      await expect(controller.createSubscriber(invalidBody)).rejects.toThrow(BadRequestException);
    });
  });

  describe('updateSubscriber', () => {
    it('should update and return subscriber', async () => {
      const subscriber = createMockSubscriber({ name: 'Updated Name' });
      mockService.updateSubscriber.mockResolvedValue(subscriber);

      const result = await controller.updateSubscriber('subscriber-1', { name: 'Updated Name' });

      expect(result.name).toBe('Updated Name');
      expect(mockService.updateSubscriber).toHaveBeenCalledWith('subscriber-1', {
        name: 'Updated Name',
      });
    });

    it('should throw NotFoundException when subscriber not found', async () => {
      mockService.updateSubscriber.mockRejectedValue(
        new NotFoundException('Subscriber not found: non-existent'),
      );

      await expect(
        controller.updateSubscriber('non-existent', { name: 'New Name' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException for invalid body', async () => {
      // name too long
      const invalidBody = { name: 'a'.repeat(101) };

      await expect(controller.updateSubscriber('subscriber-1', invalidBody)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('deleteSubscriber', () => {
    it('should delete subscriber when found', async () => {
      mockService.deleteSubscriber.mockResolvedValue();

      await controller.deleteSubscriber('subscriber-1');

      expect(mockService.deleteSubscriber).toHaveBeenCalledWith('subscriber-1');
    });

    it('should throw NotFoundException when subscriber not found', async () => {
      mockService.deleteSubscriber.mockRejectedValue(
        new NotFoundException('Subscriber not found: non-existent'),
      );

      await expect(controller.deleteSubscriber('non-existent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('toggleSubscriber', () => {
    it('should toggle subscriber enabled status', async () => {
      const subscriber = createMockSubscriber({ enabled: true });
      mockService.toggleSubscriber.mockResolvedValue(subscriber);

      const result = await controller.toggleSubscriber('subscriber-1', { enabled: true });

      expect(result.enabled).toBe(true);
      expect(mockService.toggleSubscriber).toHaveBeenCalledWith('subscriber-1', true);
    });

    it('should throw BadRequestException for invalid body', async () => {
      await expect(
        controller.toggleSubscriber('subscriber-1', { enabled: 'not-boolean' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when enabled is missing', async () => {
      await expect(controller.toggleSubscriber('subscriber-1', {})).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw NotFoundException when subscriber not found', async () => {
      mockService.toggleSubscriber.mockRejectedValue(
        new NotFoundException('Subscriber not found: non-existent'),
      );

      await expect(controller.toggleSubscriber('non-existent', { enabled: true })).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
