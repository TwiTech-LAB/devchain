import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { SubscribersController } from './subscribers.controller';
import { SubscribersService } from '../services/subscribers.service';

describe('SubscribersController', () => {
  let controller: SubscribersController;
  let mockService: jest.Mocked<SubscribersService>;

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
    it('should throw BadRequestException when projectId is missing', async () => {
      await expect(controller.listSubscribers(undefined)).rejects.toThrow(BadRequestException);
      await expect(controller.listSubscribers(undefined)).rejects.toThrow(
        'projectId query parameter is required',
      );
    });
  });

  describe('createSubscriber', () => {
    it.each([
      {
        name: 'controller.createSubscriber',
        invoke: () => controller.createSubscriber({ name: '' }),
      },
      {
        name: 'controller.updateSubscriber',
        invoke: () => controller.updateSubscriber('subscriber-1', { name: 'a'.repeat(101) }),
      },
      {
        name: 'controller.toggleSubscriber',
        invoke: () => controller.toggleSubscriber('subscriber-1', { enabled: 'not-boolean' }),
      },
    ])('maps invalid input in $name to bad request', async ({ invoke }) => {
      await expect(invoke()).rejects.toThrow(BadRequestException);
    });
  });
});
