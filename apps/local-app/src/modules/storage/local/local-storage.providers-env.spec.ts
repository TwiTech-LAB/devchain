import { Test, TestingModule } from '@nestjs/testing';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { LocalStorageService } from './local-storage.service';
import { DB_CONNECTION } from '../db/db.provider';
import { ValidationError } from '../../../common/errors/error-types';

describe('LocalStorageService - Provider env', () => {
  let service: LocalStorageService;
  let mockDb: jest.Mocked<BetterSQLite3Database>;

  beforeEach(async () => {
    const mockChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      offset: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
    };

    mockDb = {
      select: jest.fn().mockReturnValue(mockChain),
      insert: jest.fn().mockReturnValue(mockChain),
      update: jest.fn().mockReturnValue(mockChain),
      delete: jest.fn().mockReturnValue(mockChain),
    } as unknown as jest.Mocked<BetterSQLite3Database>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LocalStorageService,
        {
          provide: DB_CONNECTION,
          useValue: mockDb,
        },
      ],
    }).compile();

    service = module.get<LocalStorageService>(LocalStorageService);
  });

  describe('createProvider with env', () => {
    it('creates provider with env and returns parsed env', async () => {
      const insertChain = { values: jest.fn().mockResolvedValue(undefined) };
      mockDb.insert = jest.fn().mockReturnValue(insertChain);

      const result = await service.createProvider({
        name: 'claude',
        binPath: '/usr/local/bin/claude',
        mcpConfigured: false,
        mcpEndpoint: null,
        mcpRegisteredAt: null,
        env: { API_BASE: 'https://api.example.com', DEBUG: 'true' },
      });

      expect(result.env).toEqual({
        API_BASE: 'https://api.example.com',
        DEBUG: 'true',
        CLAUDE_CODE_NO_FLICKER: '1',
      });
      expect(result.id).toBeDefined();
    });

    it('creates provider with null env — Claude gets CLAUDE_CODE_NO_FLICKER default', async () => {
      const insertChain = { values: jest.fn().mockResolvedValue(undefined) };
      mockDb.insert = jest.fn().mockReturnValue(insertChain);

      const result = await service.createProvider({
        name: 'claude',
        binPath: '/usr/local/bin/claude',
        mcpConfigured: false,
        mcpEndpoint: null,
        mcpRegisteredAt: null,
        env: null,
      });

      expect(result.env).toEqual({ CLAUDE_CODE_NO_FLICKER: '1' });
    });

    it('normalizes empty env {} — Claude gets CLAUDE_CODE_NO_FLICKER default', async () => {
      const insertChain = { values: jest.fn().mockResolvedValue(undefined) };
      mockDb.insert = jest.fn().mockReturnValue(insertChain);

      const result = await service.createProvider({
        name: 'claude',
        binPath: '/usr/local/bin/claude',
        mcpConfigured: false,
        mcpEndpoint: null,
        mcpRegisteredAt: null,
        env: {},
      });

      expect(result.env).toEqual({ CLAUDE_CODE_NO_FLICKER: '1' });
    });
  });

  describe('getProvider with env', () => {
    const makeGetSelectChain = (row: Record<string, unknown>) => ({
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnValue([row]),
    });

    it('parses JSON env from row', async () => {
      const mockRow = {
        id: 'p1',
        name: 'claude',
        binPath: '/usr/local/bin/claude',
        mcpConfigured: 1,
        mcpEndpoint: null,
        mcpRegisteredAt: null,
        autoCompactThreshold: null,
        autoCompactThreshold1m: null,
        oneMillionContextEnabled: 0,
        env: '{"API_BASE":"https://api.example.com","LOG_LEVEL":"debug"}',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };

      mockDb.select = jest.fn().mockReturnValue(makeGetSelectChain(mockRow));

      const result = await service.getProvider('p1');
      expect(result.env).toEqual({ API_BASE: 'https://api.example.com', LOG_LEVEL: 'debug' });
    });

    it('returns null env when column is NULL', async () => {
      const mockRow = {
        id: 'p1',
        name: 'claude',
        binPath: '/usr/local/bin/claude',
        mcpConfigured: 1,
        mcpEndpoint: null,
        mcpRegisteredAt: null,
        autoCompactThreshold: null,
        autoCompactThreshold1m: null,
        oneMillionContextEnabled: 0,
        env: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };

      mockDb.select = jest.fn().mockReturnValue(makeGetSelectChain(mockRow));

      const result = await service.getProvider('p1');
      expect(result.env).toBeNull();
    });

    it('throws ValidationError for corrupt env JSON', async () => {
      const mockRow = {
        id: 'p1',
        name: 'claude',
        binPath: '/usr/local/bin/claude',
        mcpConfigured: 1,
        mcpEndpoint: null,
        mcpRegisteredAt: null,
        autoCompactThreshold: null,
        autoCompactThreshold1m: null,
        oneMillionContextEnabled: 0,
        env: 'not-valid-json',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };

      mockDb.select = jest.fn().mockReturnValue(makeGetSelectChain(mockRow));

      await expect(service.getProvider('p1')).rejects.toThrow(ValidationError);
    });
  });

  describe('listProviders with env', () => {
    it('parses env on each row', async () => {
      const mockRows = [
        {
          id: 'p1',
          name: 'claude',
          binPath: '/usr/local/bin/claude',
          mcpConfigured: 1,
          mcpEndpoint: null,
          mcpRegisteredAt: null,
          autoCompactThreshold: null,
          autoCompactThreshold1m: null,
          oneMillionContextEnabled: 0,
          env: '{"KEY1":"val1"}',
          createdAt: '2024-01-01',
          updatedAt: '2024-01-01',
        },
        {
          id: 'p2',
          name: 'opencode',
          binPath: '/usr/local/bin/opencode',
          mcpConfigured: 0,
          mcpEndpoint: null,
          mcpRegisteredAt: null,
          autoCompactThreshold: null,
          autoCompactThreshold1m: null,
          oneMillionContextEnabled: 0,
          env: null,
          createdAt: '2024-01-01',
          updatedAt: '2024-01-01',
        },
      ];

      const selectChain = {
        from: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        offset: jest.fn().mockReturnValue(mockRows),
      };
      mockDb.select = jest.fn().mockReturnValue(selectChain);

      const result = await service.listProviders();
      expect(result.items[0].env).toEqual({ KEY1: 'val1' });
      expect(result.items[1].env).toBeNull();
    });
  });

  describe('updateProvider with env', () => {
    const makeUpdateMocks = (returnRow: Record<string, unknown>) => {
      const updateChain = {
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnValue(undefined),
      };
      const selectChain = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnValue([returnRow]),
      };
      mockDb.update = jest.fn().mockReturnValue(updateChain);
      mockDb.select = jest.fn().mockReturnValue(selectChain);
      return { updateChain };
    };

    const providerRow = (envJson: string | null) => ({
      id: 'p1',
      name: 'claude',
      binPath: '/usr/local/bin/claude',
      mcpConfigured: 1,
      mcpEndpoint: null,
      mcpRegisteredAt: null,
      autoCompactThreshold: null,
      autoCompactThreshold1m: null,
      oneMillionContextEnabled: 0,
      env: envJson,
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
    });

    it('updates env to a new map', async () => {
      makeUpdateMocks(providerRow('{"NEW_KEY":"new-value"}'));

      const result = await service.updateProvider('p1', {
        env: { NEW_KEY: 'new-value' },
      });

      expect(result.env).toEqual({ NEW_KEY: 'new-value' });
    });

    it('updates env to null (clear)', async () => {
      makeUpdateMocks(providerRow(null));

      const result = await service.updateProvider('p1', {
        env: null,
      });

      expect(result.env).toBeNull();
    });

    it('leaves env unchanged when omitted from update', async () => {
      makeUpdateMocks(providerRow('{"EXISTING":"keep"}'));

      const result = await service.updateProvider('p1', {
        name: 'updated-name',
      });

      expect(result.env).toEqual({ EXISTING: 'keep' });
    });
  });
});
