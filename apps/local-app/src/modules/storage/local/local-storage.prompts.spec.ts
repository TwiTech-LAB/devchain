import { Test, TestingModule } from '@nestjs/testing';
import { LocalStorageService } from './local-storage.service';
import { DB_CONNECTION } from '../db/db.provider';
import { ValidationError } from '../../../common/errors/error-types';
import type { PromptSummary } from '../interfaces/storage.interface';

describe('LocalStorageService — profile prompt assignments', () => {
  let service: LocalStorageService;
  let db: {
    select: jest.Mock;
    insert: jest.Mock;
    delete: jest.Mock;
    update: jest.Mock;
    transaction: jest.Mock;
  };

  beforeEach(async () => {
    const chain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      offset: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
    };

    db = {
      select: jest.fn().mockReturnValue(chain),
      insert: jest.fn().mockReturnValue(chain),
      delete: jest.fn().mockReturnValue(chain),
      update: jest.fn().mockReturnValue(chain),
      transaction: jest.fn(async (fn: (tx: unknown) => Promise<void>) => {
        await fn(db);
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [LocalStorageService, { provide: DB_CONNECTION, useValue: db }],
    }).compile();

    service = module.get(LocalStorageService);
  });

  it('replaces assignments transactionally and preserves order', async () => {
    // Profile exists
    jest
      .spyOn(service, 'getAgentProfile')
      .mockResolvedValue({ id: 'prof-1', projectId: 'project-1' } as unknown as Awaited<
        ReturnType<typeof service.getAgentProfile>
      >);
    // Prompts existence within same project
    db.select = jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([
          { id: 'p1', projectId: 'project-1' },
          { id: 'p2', projectId: 'project-1' },
        ]),
      }),
    });

    await service.setAgentProfilePrompts('prof-1', ['p1', 'p2']);

    // Delete old rows then insert new in order
    expect(db.delete).toHaveBeenCalled();
    expect(db.insert).toHaveBeenCalled();
    const lastValuesArg = (db.insert().values as jest.Mock).mock.calls.pop()?.[0];
    expect(lastValuesArg.map((r: { promptId: string }) => r.promptId)).toEqual(['p1', 'p2']);
  });

  it('rejects cross-project prompt assignments', async () => {
    jest
      .spyOn(service, 'getAgentProfile')
      .mockResolvedValue({ id: 'prof-1', projectId: 'project-1' } as unknown as Awaited<
        ReturnType<typeof service.getAgentProfile>
      >);
    db.select = jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([{ id: 'p1', projectId: 'project-2' }]),
      }),
    });

    await expect(service.setAgentProfilePrompts('prof-1', ['p1'])).rejects.toThrow(ValidationError);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('rejects unknown prompt ids', async () => {
    jest
      .spyOn(service, 'getAgentProfile')
      .mockResolvedValue({ id: 'prof-1', projectId: 'project-1' } as unknown as Awaited<
        ReturnType<typeof service.getAgentProfile>
      >);
    db.select = jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([{ id: 'p1', projectId: 'project-1' }]),
      }),
    });

    await expect(service.setAgentProfilePrompts('prof-1', ['p1', 'p9'])).rejects.toThrow(
      ValidationError,
    );
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('idempotency: last call order wins', async () => {
    jest
      .spyOn(service, 'getAgentProfile')
      .mockResolvedValue({ id: 'prof-2', projectId: 'project-1' } as unknown as Awaited<
        ReturnType<typeof service.getAgentProfile>
      >);
    db.select = jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([
          { id: 'p1', projectId: 'project-1' },
          { id: 'p2', projectId: 'project-1' },
        ]),
      }),
    });

    await service.setAgentProfilePrompts('prof-2', ['p1', 'p2']);
    await service.setAgentProfilePrompts('prof-2', ['p2', 'p1']);

    const calls = (db.insert().values as jest.Mock).mock.calls;
    const last = calls[calls.length - 1]?.[0];
    expect(last.map((r: { promptId: string }) => r.promptId)).toEqual(['p2', 'p1']);
  });
});

describe('LocalStorageService — listPrompts with search', () => {
  let service: LocalStorageService;
  let db: {
    select: jest.Mock;
    insert: jest.Mock;
    delete: jest.Mock;
    update: jest.Mock;
    transaction: jest.Mock;
  };

  const mockPromptRows = [
    {
      id: 'prompt-1',
      projectId: 'project-1',
      title: 'Hello World Prompt',
      version: 1,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    },
    {
      id: 'prompt-2',
      projectId: 'project-1',
      title: 'Goodbye World Prompt',
      version: 1,
      createdAt: '2024-01-02T00:00:00Z',
      updatedAt: '2024-01-02T00:00:00Z',
    },
    {
      id: 'prompt-3',
      projectId: 'project-2',
      title: 'Hello Universe Prompt',
      version: 1,
      createdAt: '2024-01-03T00:00:00Z',
      updatedAt: '2024-01-03T00:00:00Z',
    },
  ];

  beforeEach(async () => {
    const selectChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      offset: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
    };

    db = {
      select: jest.fn().mockReturnValue(selectChain),
      insert: jest.fn().mockReturnValue(selectChain),
      delete: jest.fn().mockReturnValue(selectChain),
      update: jest.fn().mockReturnValue(selectChain),
      transaction: jest.fn(async (fn: (tx: unknown) => Promise<void>) => {
        await fn(db);
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [LocalStorageService, { provide: DB_CONNECTION, useValue: db }],
    }).compile();

    service = module.get(LocalStorageService);
  });

  it('returns empty result when no prompts match', async () => {
    const selectChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockResolvedValue([]),
    };
    db.select = jest.fn().mockReturnValue(selectChain);

    const result = await service.listPrompts({ projectId: 'project-1' });

    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('returns prompts filtered by projectId', async () => {
    // First call returns prompts, subsequent calls return tags
    let callCount = 0;
    const selectChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockImplementation(() => ({
        orderBy: jest.fn().mockResolvedValue([mockPromptRows[0], mockPromptRows[1]]),
      })),
      orderBy: jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve([mockPromptRows[0], mockPromptRows[1]]);
        }
        return Promise.resolve([]);
      }),
      innerJoin: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([]),
      }),
    };
    db.select = jest.fn().mockReturnValue(selectChain);

    const result = await service.listPrompts({ projectId: 'project-1' });

    expect(result.items.length).toBe(2);
    expect(result.items.every((p: PromptSummary) => p.projectId === 'project-1')).toBe(true);
  });

  it('filters prompts by search query on title', async () => {
    const selectChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockImplementation(() => ({
        orderBy: jest.fn().mockResolvedValue([mockPromptRows[0]]),
      })),
      innerJoin: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([]),
      }),
    };
    db.select = jest.fn().mockReturnValue(selectChain);

    const result = await service.listPrompts({ projectId: 'project-1', q: 'Hello' });

    expect(result.items.length).toBe(1);
    expect(result.items[0].title).toBe('Hello World Prompt');
  });

  it('respects pagination parameters', async () => {
    const selectChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockImplementation(() => ({
        orderBy: jest.fn().mockResolvedValue(mockPromptRows),
      })),
      orderBy: jest.fn().mockResolvedValue(mockPromptRows),
      innerJoin: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([]),
      }),
    };
    db.select = jest.fn().mockReturnValue(selectChain);

    const result = await service.listPrompts({
      projectId: null,
      limit: 1,
      offset: 1,
    });

    expect(result.items.length).toBe(1);
    expect(result.items[0].id).toBe('prompt-2');
    expect(result.total).toBe(3);
    expect(result.limit).toBe(1);
    expect(result.offset).toBe(1);
  });

  it('returns PromptSummary without content field', async () => {
    const selectChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockImplementation(() => ({
        orderBy: jest.fn().mockResolvedValue([mockPromptRows[0]]),
      })),
      innerJoin: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([{ tagName: 'test-tag' }]),
      }),
    };
    db.select = jest.fn().mockReturnValue(selectChain);

    const result = await service.listPrompts({ projectId: 'project-1' });

    expect(result.items.length).toBe(1);
    const item = result.items[0] as PromptSummary & { content?: string };
    expect(item.id).toBe('prompt-1');
    expect(item.title).toBe('Hello World Prompt');
    expect(item.tags).toEqual(['test-tag']);
    expect('content' in item).toBe(false);
  });
});
