import { Test, TestingModule } from '@nestjs/testing';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { LocalStorageService } from './local-storage.service';
import { DB_CONNECTION } from '../db/db.provider';
import { NotFoundError, ValidationError } from '../../../common/errors/error-types';
import { CreateProfileProviderConfig, UpdateProfileProviderConfig } from '../models/domain.models';

describe('LocalStorageService - ProfileProviderConfigs', () => {
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

  describe('createProfileProviderConfig', () => {
    it('should create a provider config successfully', async () => {
      const createData: CreateProfileProviderConfig = {
        profileId: 'profile-1',
        providerId: 'provider-1',
        name: 'claude-config',
        options: '{"model": "claude-3"}',
        env: { API_KEY: 'test-key', DEBUG: 'true' },
      };

      const insertChain = {
        values: jest.fn().mockResolvedValue(undefined),
      };

      mockDb.insert = jest.fn().mockReturnValue(insertChain);

      const result = await service.createProfileProviderConfig(createData);

      expect(result).toMatchObject({
        profileId: createData.profileId,
        providerId: createData.providerId,
        name: createData.name,
        options: createData.options,
        env: createData.env,
      });
      expect(result.id).toBeDefined();
      expect(result.createdAt).toBeDefined();
      expect(result.updatedAt).toBeDefined();
    });

    it('should auto-assign position as max+1 when not provided', async () => {
      const createData: CreateProfileProviderConfig = {
        profileId: 'profile-1',
        providerId: 'provider-1',
        name: 'auto-position-config',
        options: null,
        env: null,
      };

      // Mock the max position query - service does .select({ maxPos: sql... }).from().where()
      // This returns an array like [{ maxPos: 2 }]
      const mockWhere = jest.fn().mockResolvedValue([{ maxPos: 2 }]);
      const mockFrom = jest.fn().mockReturnValue({ where: mockWhere });

      // Reset mockDb.select to return the chain for max query
      let callCount = 0;
      mockDb.select = jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // First call is for max position query
          return { from: mockFrom };
        }
        // Second call would be for getProfileProviderConfig after insert (not called in this test path)
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest
                .fn()
                .mockResolvedValue([{ id: 'new-config', ...createData, position: 3 }]),
            }),
          }),
        };
      });

      const insertChain = {
        values: jest.fn().mockImplementation((data) => {
          expect(data.position).toBe(3); // max(2) + 1 = 3
          return Promise.resolve(undefined);
        }),
      };

      mockDb.insert = jest.fn().mockReturnValue(insertChain);

      const result = await service.createProfileProviderConfig(createData);

      expect(result.position).toBe(3);
    });

    it('should use provided position when given', async () => {
      const createData: CreateProfileProviderConfig = {
        profileId: 'profile-1',
        providerId: 'provider-1',
        name: 'custom-position-config',
        options: null,
        env: null,
        position: 5,
      };

      const insertChain = {
        values: jest.fn().mockImplementation((data) => {
          expect(data.position).toBe(5); // Use provided position
          return Promise.resolve(undefined);
        }),
      };

      mockDb.insert = jest.fn().mockReturnValue(insertChain);

      await service.createProfileProviderConfig(createData);

      expect(insertChain.values).toHaveBeenCalled();
    });

    it('should create a provider config with null env', async () => {
      const createData: CreateProfileProviderConfig = {
        profileId: 'profile-1',
        providerId: 'provider-1',
        name: 'simple-config',
        options: null,
        env: null,
      };

      const insertChain = {
        values: jest.fn().mockResolvedValue(undefined),
      };

      mockDb.insert = jest.fn().mockReturnValue(insertChain);

      const result = await service.createProfileProviderConfig(createData);

      expect(result.env).toBeNull();
      expect(result.options).toBeNull();
      expect(result.name).toBe('simple-config');
    });
  });

  describe('getProfileProviderConfig', () => {
    it('should return provider config when found', async () => {
      const mockRow = {
        id: 'config-1',
        profileId: 'profile-1',
        providerId: 'provider-1',
        name: 'claude-config',
        options: '{"model": "claude-3"}',
        env: '{"API_KEY":"test-key"}',
        position: 0,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      const selectChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([mockRow]),
          }),
        }),
      };

      mockDb.select = jest.fn().mockReturnValue(selectChain);

      const result = await service.getProfileProviderConfig('config-1');

      expect(result).toMatchObject({
        id: 'config-1',
        profileId: 'profile-1',
        providerId: 'provider-1',
        name: 'claude-config',
        options: '{"model": "claude-3"}',
        env: { API_KEY: 'test-key' },
      });
    });

    it('should parse env JSON correctly', async () => {
      const mockRow = {
        id: 'config-1',
        profileId: 'profile-1',
        providerId: 'provider-1',
        name: 'test-config',
        options: null,
        env: '{"KEY1":"value1","KEY2":"value2"}',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      const selectChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([mockRow]),
          }),
        }),
      };

      mockDb.select = jest.fn().mockReturnValue(selectChain);

      const result = await service.getProfileProviderConfig('config-1');

      expect(result.env).toEqual({ KEY1: 'value1', KEY2: 'value2' });
    });

    it('should return null env when stored as null', async () => {
      const mockRow = {
        id: 'config-1',
        profileId: 'profile-1',
        providerId: 'provider-1',
        name: 'null-env-config',
        options: null,
        env: null,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      const selectChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([mockRow]),
          }),
        }),
      };

      mockDb.select = jest.fn().mockReturnValue(selectChain);

      const result = await service.getProfileProviderConfig('config-1');

      expect(result.env).toBeNull();
    });

    it('should throw NotFoundError when provider config not found', async () => {
      const selectChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      };

      mockDb.select = jest.fn().mockReturnValue(selectChain);

      await expect(service.getProfileProviderConfig('nonexistent-id')).rejects.toThrow(
        NotFoundError,
      );
    });

    it('should throw ValidationError when env JSON is corrupt', async () => {
      const mockRow = {
        id: 'config-1',
        profileId: 'profile-1',
        providerId: 'provider-1',
        name: 'corrupt-config',
        options: null,
        env: '{invalid json',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      const selectChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([mockRow]),
          }),
        }),
      };

      mockDb.select = jest.fn().mockReturnValue(selectChain);

      await expect(service.getProfileProviderConfig('config-1')).rejects.toThrow(ValidationError);
      await expect(service.getProfileProviderConfig('config-1')).rejects.toThrow(
        /Invalid JSON in provider config env field/,
      );
    });

    it('should throw ValidationError when env is not an object', async () => {
      const mockRow = {
        id: 'config-1',
        profileId: 'profile-1',
        providerId: 'provider-1',
        name: 'invalid-env-config',
        options: null,
        env: '"just a string"',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      const selectChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([mockRow]),
          }),
        }),
      };

      mockDb.select = jest.fn().mockReturnValue(selectChain);

      await expect(service.getProfileProviderConfig('config-1')).rejects.toThrow(ValidationError);
      await expect(service.getProfileProviderConfig('config-1')).rejects.toThrow(
        /env must be an object/,
      );
    });

    it('should throw ValidationError when env value is not a string', async () => {
      const mockRow = {
        id: 'config-1',
        profileId: 'profile-1',
        providerId: 'provider-1',
        name: 'bad-env-value-config',
        options: null,
        env: '{"KEY": 123}',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      const selectChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([mockRow]),
          }),
        }),
      };

      mockDb.select = jest.fn().mockReturnValue(selectChain);

      await expect(service.getProfileProviderConfig('config-1')).rejects.toThrow(ValidationError);
      await expect(service.getProfileProviderConfig('config-1')).rejects.toThrow(
        /env\["KEY"\] must be a string/,
      );
    });
  });

  describe('listProfileProviderConfigsByProfile', () => {
    it('should return configs for a profile', async () => {
      const mockRows = [
        {
          id: 'config-1',
          profileId: 'profile-1',
          providerId: 'provider-1',
          name: 'claude-config',
          options: '{"model": "claude-3"}',
          env: '{"KEY":"value1"}',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
        {
          id: 'config-2',
          profileId: 'profile-1',
          providerId: 'provider-2',
          name: 'other-config',
          options: null,
          env: '{"KEY":"value2"}',
          createdAt: '2024-01-02T00:00:00Z',
          updatedAt: '2024-01-02T00:00:00Z',
        },
      ];

      const selectChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockResolvedValue(mockRows),
          }),
        }),
      };

      mockDb.select = jest.fn().mockReturnValue(selectChain);

      const result = await service.listProfileProviderConfigsByProfile('profile-1');

      expect(result.length).toBe(2);
      expect(result[0].env).toEqual({ KEY: 'value1' });
      expect(result[1].env).toEqual({ KEY: 'value2' });
    });

    it('should return empty array when no configs exist', async () => {
      const selectChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockResolvedValue([]),
          }),
        }),
      };

      mockDb.select = jest.fn().mockReturnValue(selectChain);

      const result = await service.listProfileProviderConfigsByProfile('profile-without-configs');

      expect(result).toEqual([]);
    });

    it('should throw ValidationError when any config has corrupt env JSON', async () => {
      const mockRows = [
        {
          id: 'config-1',
          profileId: 'profile-1',
          providerId: 'provider-1',
          name: 'valid-config',
          options: null,
          env: '{"KEY":"valid"}',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
        {
          id: 'config-2',
          profileId: 'profile-1',
          providerId: 'provider-2',
          name: 'corrupt-config',
          options: null,
          env: '{corrupt json',
          createdAt: '2024-01-02T00:00:00Z',
          updatedAt: '2024-01-02T00:00:00Z',
        },
      ];

      const selectChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockResolvedValue(mockRows),
          }),
        }),
      };

      mockDb.select = jest.fn().mockReturnValue(selectChain);

      await expect(service.listProfileProviderConfigsByProfile('profile-1')).rejects.toThrow(
        ValidationError,
      );
      await expect(service.listProfileProviderConfigsByProfile('profile-1')).rejects.toThrow(
        /Invalid JSON in provider config env field/,
      );
    });

    it('should return configs ordered by position ASC, id ASC', async () => {
      const mockRows = [
        {
          id: 'config-1',
          profileId: 'profile-1',
          providerId: 'provider-1',
          name: 'first-config',
          options: null,
          env: '{}',
          position: 0,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
        {
          id: 'config-2',
          profileId: 'profile-1',
          providerId: 'provider-1',
          name: 'second-config',
          options: null,
          env: '{}',
          position: 1,
          createdAt: '2024-01-02T00:00:00Z',
          updatedAt: '2024-01-02T00:00:00Z',
        },
      ];

      // Mock orderBy to verify it's called with position
      const mockOrderBy = jest.fn().mockResolvedValue(mockRows);

      const selectChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: mockOrderBy,
          }),
        }),
      };

      mockDb.select = jest.fn().mockReturnValue(selectChain);

      const result = await service.listProfileProviderConfigsByProfile('profile-1');

      // Verify orderBy was called (ordering by position, then id)
      expect(mockOrderBy).toHaveBeenCalled();
      expect(result.length).toBe(2);
      expect(result[0].position).toBe(0);
      expect(result[1].position).toBe(1);
    });
  });

  describe('listProfileProviderConfigsByIds', () => {
    it('should return empty array when no ids provided', async () => {
      const result = await service.listProfileProviderConfigsByIds([]);
      expect(result).toEqual([]);
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it('should return configs for specified ids', async () => {
      const mockRows = [
        {
          id: 'config-1',
          profileId: 'profile-1',
          providerId: 'provider-1',
          name: 'config-one',
          options: null,
          env: '{"KEY1":"value1"}',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
        {
          id: 'config-2',
          profileId: 'profile-2',
          providerId: 'provider-2',
          name: 'config-two',
          options: null,
          env: '{"KEY2":"value2"}',
          createdAt: '2024-01-02T00:00:00Z',
          updatedAt: '2024-01-02T00:00:00Z',
        },
      ];

      const selectChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(mockRows),
        }),
      };

      mockDb.select = jest.fn().mockReturnValue(selectChain);

      const result = await service.listProfileProviderConfigsByIds(['config-1', 'config-2']);

      expect(result.length).toBe(2);
      expect(result[0].env).toEqual({ KEY1: 'value1' });
      expect(result[1].env).toEqual({ KEY2: 'value2' });
    });

    it('should handle partial matches (some ids not found)', async () => {
      const mockRows = [
        {
          id: 'config-1',
          profileId: 'profile-1',
          providerId: 'provider-1',
          name: 'partial-config',
          options: null,
          env: null,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ];

      const selectChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(mockRows),
        }),
      };

      mockDb.select = jest.fn().mockReturnValue(selectChain);

      const result = await service.listProfileProviderConfigsByIds([
        'config-1',
        'config-nonexistent',
      ]);

      expect(result.length).toBe(1);
      expect(result[0].id).toBe('config-1');
    });
  });

  describe('updateProfileProviderConfig', () => {
    it('should update provider config successfully', async () => {
      const updateData: UpdateProfileProviderConfig = {
        options: '{"model": "claude-4"}',
        env: { NEW_KEY: 'new-value' },
      };

      const mockUpdatedRow = {
        id: 'config-1',
        profileId: 'profile-1',
        providerId: 'provider-1',
        name: 'updated-config',
        options: '{"model": "claude-4"}',
        env: '{"NEW_KEY":"new-value"}',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      };

      const updateChain = {
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(undefined),
        }),
      };

      const selectChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([mockUpdatedRow]),
          }),
        }),
      };

      mockDb.update = jest.fn().mockReturnValue(updateChain);
      mockDb.select = jest.fn().mockReturnValue(selectChain);

      const result = await service.updateProfileProviderConfig('config-1', updateData);

      expect(result.options).toBe('{"model": "claude-4"}');
      expect(result.env).toEqual({ NEW_KEY: 'new-value' });
    });

    it('should update env to null', async () => {
      const updateData: UpdateProfileProviderConfig = {
        env: null,
      };

      const mockUpdatedRow = {
        id: 'config-1',
        profileId: 'profile-1',
        providerId: 'provider-1',
        name: 'null-env-update',
        options: null,
        env: null,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      };

      const updateChain = {
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(undefined),
        }),
      };

      const selectChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([mockUpdatedRow]),
          }),
        }),
      };

      mockDb.update = jest.fn().mockReturnValue(updateChain);
      mockDb.select = jest.fn().mockReturnValue(selectChain);

      const result = await service.updateProfileProviderConfig('config-1', updateData);

      expect(result.env).toBeNull();
    });

    it('should throw NotFoundError when updating nonexistent config', async () => {
      const updateData: UpdateProfileProviderConfig = {
        options: '{"model": "claude-4"}',
      };

      const updateChain = {
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(undefined),
        }),
      };

      const selectChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      };

      mockDb.update = jest.fn().mockReturnValue(updateChain);
      mockDb.select = jest.fn().mockReturnValue(selectChain);

      await expect(
        service.updateProfileProviderConfig('nonexistent-id', updateData),
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe('deleteProfileProviderConfig', () => {
    it('should delete provider config when not referenced by agents', async () => {
      // Mock: no agents reference this config
      const agentCheckChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      };

      const deleteChain = {
        where: jest.fn().mockResolvedValue(undefined),
      };

      mockDb.select = jest.fn().mockReturnValue(agentCheckChain);
      mockDb.delete = jest.fn().mockReturnValue(deleteChain);

      await expect(service.deleteProfileProviderConfig('config-1')).resolves.toBeUndefined();
    });

    it('should throw ValidationError when config is referenced by agents', async () => {
      // Mock: agent references this config
      const agentCheckChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([{ id: 'agent-1' }]),
          }),
        }),
      };

      mockDb.select = jest.fn().mockReturnValue(agentCheckChain);

      await expect(service.deleteProfileProviderConfig('config-1')).rejects.toThrow(
        ValidationError,
      );
    });
  });

  describe('env JSON serialization round-trip', () => {
    it('should serialize and deserialize env correctly', async () => {
      const originalEnv = {
        API_KEY: 'sk-test-12345',
        DEBUG: 'true',
        COMPLEX_VALUE: 'value with "quotes" and special chars',
      };

      const createData: CreateProfileProviderConfig = {
        profileId: 'profile-1',
        providerId: 'provider-1',
        name: 'round-trip-config',
        options: null,
        env: originalEnv,
      };

      // Capture what gets inserted
      let insertedEnv: string | null = null;
      const insertChain = {
        values: jest.fn().mockImplementation((data) => {
          insertedEnv = data.env;
          return Promise.resolve(undefined);
        }),
      };

      mockDb.insert = jest.fn().mockReturnValue(insertChain);

      await service.createProfileProviderConfig(createData);

      // Verify JSON was stringified
      expect(insertedEnv).toBe(JSON.stringify(originalEnv));

      // Now test reading back
      const mockRow = {
        id: 'config-1',
        profileId: 'profile-1',
        providerId: 'provider-1',
        name: 'round-trip-config',
        options: null,
        env: insertedEnv,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      const selectChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([mockRow]),
          }),
        }),
      };

      mockDb.select = jest.fn().mockReturnValue(selectChain);

      const result = await service.getProfileProviderConfig('config-1');

      // Verify round-trip preserves data
      expect(result.env).toEqual(originalEnv);
    });
  });
});
