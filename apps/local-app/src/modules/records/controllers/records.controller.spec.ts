import { Test, TestingModule } from '@nestjs/testing';
import { RecordsController } from './records.controller';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { BadRequestException } from '@nestjs/common';
import { EpicRecord } from '../../storage/models/domain.models';

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

describe('RecordsController', () => {
  let controller: RecordsController;
  let storage: {
    listRecords: jest.Mock;
    getRecord: jest.Mock;
  };

  const mockRecord: EpicRecord = {
    id: 'record-1',
    epicId: 'epic-1',
    type: 'test-type',
    data: { key: 'value' },
    tags: ['tag1'],
    version: 1,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  beforeEach(async () => {
    storage = {
      listRecords: jest.fn(),
      getRecord: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [RecordsController],
      providers: [
        {
          provide: STORAGE_SERVICE,
          useValue: storage,
        },
      ],
    }).compile();

    controller = module.get(RecordsController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/records', () => {
    it('throws BadRequestException when epicId is missing', async () => {
      await expect(controller.listRecords(undefined as unknown as string)).rejects.toThrow(
        BadRequestException,
      );
      expect(storage.listRecords).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when epicId is empty string', async () => {
      await expect(controller.listRecords('')).rejects.toThrow(BadRequestException);
      expect(storage.listRecords).not.toHaveBeenCalled();
    });

    it('lists records when epicId is provided', async () => {
      storage.listRecords.mockResolvedValue({
        items: [mockRecord],
        total: 1,
        limit: 100,
        offset: 0,
      });

      const result = await controller.listRecords('epic-1');

      expect(storage.listRecords).toHaveBeenCalledWith('epic-1', {});
      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe('record-1');
    });

    it('applies type filter when provided', async () => {
      storage.listRecords.mockResolvedValue({
        items: [mockRecord, { ...mockRecord, id: 'record-2', type: 'other-type' }],
        total: 2,
        limit: 100,
        offset: 0,
      });

      const result = await controller.listRecords('epic-1', 'test-type');

      expect(result.items).toHaveLength(1);
      expect(result.items[0].type).toBe('test-type');
    });

    it('applies tags filter when provided', async () => {
      storage.listRecords.mockResolvedValue({
        items: [mockRecord, { ...mockRecord, id: 'record-2', tags: ['tag2'] }],
        total: 2,
        limit: 100,
        offset: 0,
      });

      const result = await controller.listRecords('epic-1', undefined, 'tag1');

      expect(result.items).toHaveLength(1);
      expect(result.items[0].tags).toContain('tag1');
    });
  });

  describe('GET /api/records/:id', () => {
    it('returns a record by id', async () => {
      storage.getRecord.mockResolvedValue(mockRecord);

      const result = await controller.getRecord('record-1');

      expect(storage.getRecord).toHaveBeenCalledWith('record-1');
      expect(result.id).toBe('record-1');
    });
  });
});
