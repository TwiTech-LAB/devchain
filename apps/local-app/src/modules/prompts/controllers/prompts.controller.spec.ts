import { Test, TestingModule } from '@nestjs/testing';
import { PromptsController } from './prompts.controller';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { BadRequestException } from '@nestjs/common';

describe('PromptsController', () => {
  let controller: PromptsController;
  let storage: {
    listPrompts: jest.Mock;
    getPrompt: jest.Mock;
    createPrompt: jest.Mock;
    updatePrompt: jest.Mock;
    deletePrompt: jest.Mock;
  };

  beforeEach(async () => {
    storage = {
      listPrompts: jest.fn(),
      getPrompt: jest.fn(),
      createPrompt: jest.fn(),
      updatePrompt: jest.fn(),
      deletePrompt: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PromptsController],
      providers: [
        {
          provide: STORAGE_SERVICE,
          useValue: storage,
        },
      ],
    }).compile();

    controller = module.get(PromptsController);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('GET /api/prompts requires projectId', async () => {
    await expect(
      controller.listPrompts(undefined as unknown as string, undefined, undefined, undefined),
    ).rejects.toThrow(BadRequestException);
  });

  it('GET /api/prompts lists by projectId', async () => {
    storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
    await controller.listPrompts('project-1', undefined, undefined, undefined);
    expect(storage.listPrompts).toHaveBeenCalledWith({
      projectId: 'project-1',
      q: undefined,
      limit: undefined,
      offset: undefined,
    });
  });

  it('GET /api/prompts passes search query to storage', async () => {
    storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
    await controller.listPrompts('project-1', 'search term', '10', '20');
    expect(storage.listPrompts).toHaveBeenCalledWith({
      projectId: 'project-1',
      q: 'search term',
      limit: 10,
      offset: 20,
    });
  });

  it('GET /api/prompts ignores invalid limit value', async () => {
    storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
    await controller.listPrompts('project-1', undefined, 'abc', undefined);
    expect(storage.listPrompts).toHaveBeenCalledWith({
      projectId: 'project-1',
      q: undefined,
      limit: undefined,
      offset: undefined,
    });
  });

  it('GET /api/prompts ignores invalid offset value', async () => {
    storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
    await controller.listPrompts('project-1', undefined, undefined, 'xyz');
    expect(storage.listPrompts).toHaveBeenCalledWith({
      projectId: 'project-1',
      q: undefined,
      limit: undefined,
      offset: undefined,
    });
  });

  it('GET /api/prompts ignores both invalid limit and offset values', async () => {
    storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
    await controller.listPrompts('project-1', 'test', 'not-a-number', 'also-not-a-number');
    expect(storage.listPrompts).toHaveBeenCalledWith({
      projectId: 'project-1',
      q: 'test',
      limit: undefined,
      offset: undefined,
    });
  });

  it('POST /api/prompts requires projectId', async () => {
    await expect(controller.createPrompt({ title: 'T', content: 'C', tags: [] })).rejects.toThrow(
      'Required',
    );
  });

  it('POST /api/prompts creates prompt with projectId', async () => {
    storage.createPrompt.mockResolvedValue({
      id: 'prompt-1',
      projectId: 'project-1',
      title: 'T',
      content: 'C',
      version: 1,
      tags: [],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    });
    const result = await controller.createPrompt({
      projectId: 'project-1',
      title: 'T',
      content: 'C',
    });
    expect(result.projectId).toBe('project-1');
    expect(storage.createPrompt).toHaveBeenCalledWith({
      projectId: 'project-1',
      title: 'T',
      content: 'C',
    });
  });
});
