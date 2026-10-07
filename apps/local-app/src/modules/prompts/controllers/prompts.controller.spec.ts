import { Test, TestingModule } from '@nestjs/testing';
import { PromptsController } from './prompts.controller';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { BadRequestException } from '@nestjs/common';
import { ProjectWriteAdmissionService } from '../../remotes/admission/project-write-admission.service';
import { createProjectWriteAdmissionStub } from '../../remotes/admission/testing/project-write-admission.stub';

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
        { provide: ProjectWriteAdmissionService, useValue: createProjectWriteAdmissionStub() },
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

  it.each([
    { name: 'limit', limit: 'abc', offset: undefined },
    { name: 'offset', limit: undefined, offset: 'xyz' },
  ])('ignores invalid $name', async ({ limit, offset }) => {
    storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
    await controller.listPrompts('project-1', undefined, limit, offset);
    expect(storage.listPrompts).toHaveBeenCalledWith({
      projectId: 'project-1',
      q: undefined,
      limit: undefined,
      offset: undefined,
    });
  });
});
