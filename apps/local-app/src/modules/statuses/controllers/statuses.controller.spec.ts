import { Test, TestingModule } from '@nestjs/testing';
import { StatusesController } from './statuses.controller';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { BadRequestException } from '@nestjs/common';
import { Status } from '../../storage/models/domain.models';

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

describe('StatusesController', () => {
  let controller: StatusesController;
  let storage: {
    listStatuses: jest.Mock;
    getStatus: jest.Mock;
    createStatus: jest.Mock;
    updateStatus: jest.Mock;
    deleteStatus: jest.Mock;
  };

  const mockStatus: Status = {
    id: 'status-1',
    projectId: 'project-1',
    label: 'In Progress',
    color: '#007bff',
    position: 0,
    mcpHidden: false,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  beforeEach(async () => {
    storage = {
      listStatuses: jest.fn(),
      getStatus: jest.fn(),
      createStatus: jest.fn(),
      updateStatus: jest.fn(),
      deleteStatus: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [StatusesController],
      providers: [
        {
          provide: STORAGE_SERVICE,
          useValue: storage,
        },
      ],
    }).compile();

    controller = module.get(StatusesController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/statuses', () => {
    it('throws BadRequestException when projectId is missing', async () => {
      await expect(controller.listStatuses(undefined as unknown as string)).rejects.toThrow(
        BadRequestException,
      );
      expect(storage.listStatuses).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when projectId is empty string', async () => {
      await expect(controller.listStatuses('')).rejects.toThrow(BadRequestException);
      expect(storage.listStatuses).not.toHaveBeenCalled();
    });

    it('lists statuses when projectId is provided', async () => {
      storage.listStatuses.mockResolvedValue({
        items: [mockStatus],
        total: 1,
        limit: 100,
        offset: 0,
      });

      const result = await controller.listStatuses('project-1');

      expect(storage.listStatuses).toHaveBeenCalledWith('project-1');
      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe('status-1');
    });
  });

  describe('GET /api/statuses/:id', () => {
    it('returns a status by id', async () => {
      storage.getStatus.mockResolvedValue(mockStatus);

      const result = await controller.getStatus('status-1');

      expect(storage.getStatus).toHaveBeenCalledWith('status-1');
      expect(result.id).toBe('status-1');
    });
  });

  describe('POST /api/statuses', () => {
    it('creates a new status with valid data', async () => {
      const createData = {
        projectId: '550e8400-e29b-41d4-a716-446655440000',
        label: 'New Status',
        color: '#28a745',
        position: 1,
      };
      storage.createStatus.mockResolvedValue({ ...mockStatus, ...createData });

      const result = await controller.createStatus(createData);

      // Zod schema adds mcpHidden: false as default
      expect(storage.createStatus).toHaveBeenCalledWith({ ...createData, mcpHidden: false });
      expect(result.label).toBe('New Status');
    });
  });

  describe('PUT /api/statuses/:id', () => {
    it('updates a status with valid data', async () => {
      const updateData = { label: 'Updated Status' };
      storage.updateStatus.mockResolvedValue({ ...mockStatus, label: 'Updated Status' });

      const result = await controller.updateStatus('status-1', updateData);

      expect(storage.updateStatus).toHaveBeenCalledWith('status-1', updateData);
      expect(result.label).toBe('Updated Status');
    });
  });

  describe('DELETE /api/statuses/:id', () => {
    it('deletes a status', async () => {
      storage.deleteStatus.mockResolvedValue(undefined);

      await controller.deleteStatus('status-1');

      expect(storage.deleteStatus).toHaveBeenCalledWith('status-1');
    });
  });

  describe('POST /api/statuses/reorder', () => {
    it('reorders statuses', async () => {
      storage.updateStatus.mockResolvedValue(mockStatus);

      const result = await controller.reorderStatuses({
        projectId: 'project-1',
        statusIds: ['status-1', 'status-2'],
      });

      expect(result.success).toBe(true);
      expect(storage.updateStatus).toHaveBeenCalled();
    });
  });
});
