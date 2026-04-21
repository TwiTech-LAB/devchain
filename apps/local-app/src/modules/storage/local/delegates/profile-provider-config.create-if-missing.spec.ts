import { ProfileProviderConfigStorageDelegate } from './profile-provider-config.delegate';
import type { StorageDelegateContext } from './base-storage.delegate';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type Database from 'better-sqlite3';
import { StorageError } from '../../../../common/errors/error-types';

function createMockChain() {
  return {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
    values: jest.fn().mockResolvedValue(undefined),
  };
}

function createDelegate(overrides?: {
  selectImpl?: jest.Mock;
  insertImpl?: jest.Mock;
  rawClient?: Partial<Database.Database> | null;
}) {
  const mockChain = createMockChain();
  const mockDb = {
    select: overrides?.selectImpl ?? jest.fn().mockReturnValue(mockChain),
    insert: overrides?.insertImpl ?? jest.fn().mockReturnValue(mockChain),
    update: jest.fn().mockReturnValue(mockChain),
    delete: jest.fn().mockReturnValue(mockChain),
  } as unknown as BetterSQLite3Database;

  const mockRawClient = (
    overrides?.rawClient !== undefined ? overrides.rawClient : { exec: jest.fn() }
  ) as Database.Database;

  const context: StorageDelegateContext = {
    db: mockDb,
    rawClient: mockRawClient,
  };

  const delegate = new ProfileProviderConfigStorageDelegate(context, {
    getProfileProviderConfig: jest.fn(),
  });

  return { delegate, mockDb, mockRawClient };
}

const baseInput = {
  profileId: 'profile-1',
  providerId: 'provider-1',
  name: 'claude',
};

describe('ProfileProviderConfigStorageDelegate.createIfMissing', () => {
  describe('successful insert', () => {
    it('returns { inserted: true } when no existing row', async () => {
      let selectCallCount = 0;
      const selectImpl = jest.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return {
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([]),
              }),
            }),
          };
        }
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([{ maxPos: 2 }]),
          }),
        };
      });

      const insertImpl = jest.fn().mockReturnValue({
        values: jest.fn().mockResolvedValue(undefined),
      });

      const { delegate, mockRawClient } = createDelegate({ selectImpl, insertImpl });

      const result = await delegate.createIfMissing(baseInput);

      expect(result).toEqual({ inserted: true });
      expect((mockRawClient.exec as jest.Mock).mock.calls[0][0]).toBe(
        'BEGIN IMMEDIATE TRANSACTION',
      );
      expect((mockRawClient.exec as jest.Mock).mock.calls[1][0]).toBe('COMMIT');
    });

    it('persists CLI string options verbatim and serializes env as JSON', async () => {
      let selectCallCount = 0;
      const selectImpl = jest.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return {
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([]),
              }),
            }),
          };
        }
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([{ maxPos: -1 }]),
          }),
        };
      });

      let insertedValues: Record<string, unknown> | null = null;
      const insertImpl = jest.fn().mockReturnValue({
        values: jest.fn().mockImplementation((data: Record<string, unknown>) => {
          insertedValues = data;
          return Promise.resolve(undefined);
        }),
      });

      const { delegate } = createDelegate({ selectImpl, insertImpl });

      await delegate.createIfMissing({
        ...baseInput,
        options: '--model opus --effort high',
        env: { API_KEY: 'sk-test' },
      });

      expect(insertedValues).not.toBeNull();
      expect(insertedValues!.options).toBe('--model opus --effort high');
      expect(insertedValues!.env).toBe('{"API_KEY":"sk-test"}');
      expect(insertedValues!.position).toBe(0);
    });

    it('persists null options as null', async () => {
      let selectCallCount = 0;
      const selectImpl = jest.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return {
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([]),
              }),
            }),
          };
        }
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([{ maxPos: -1 }]),
          }),
        };
      });

      let insertedValues: Record<string, unknown> | null = null;
      const insertImpl = jest.fn().mockReturnValue({
        values: jest.fn().mockImplementation((data: Record<string, unknown>) => {
          insertedValues = data;
          return Promise.resolve(undefined);
        }),
      });

      const { delegate } = createDelegate({ selectImpl, insertImpl });

      await delegate.createIfMissing({ ...baseInput, options: null });

      expect(insertedValues).not.toBeNull();
      expect(insertedValues!.options).toBeNull();
    });

    it('persists null options when options field is omitted', async () => {
      let selectCallCount = 0;
      const selectImpl = jest.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return {
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([]),
              }),
            }),
          };
        }
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([{ maxPos: -1 }]),
          }),
        };
      });

      let insertedValues: Record<string, unknown> | null = null;
      const insertImpl = jest.fn().mockReturnValue({
        values: jest.fn().mockImplementation((data: Record<string, unknown>) => {
          insertedValues = data;
          return Promise.resolve(undefined);
        }),
      });

      const { delegate } = createDelegate({ selectImpl, insertImpl });

      await delegate.createIfMissing(baseInput);

      expect(insertedValues).not.toBeNull();
      expect(insertedValues!.options).toBeNull();
    });
  });

  describe('pre-check: name exists same provider', () => {
    it('returns skip with reason and existingRow', async () => {
      const existingDbRow = {
        id: 'existing-id',
        profileId: 'profile-1',
        providerId: 'provider-1',
        name: 'claude',
        options: null,
        env: null,
        position: 0,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      const selectImpl = jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([existingDbRow]),
          }),
        }),
      });

      const { delegate } = createDelegate({ selectImpl });

      const result = await delegate.createIfMissing(baseInput);

      expect(result.inserted).toBe(false);
      expect(result.reason).toBe('name_exists_same_provider');
      expect(result.existingRow).toMatchObject({
        id: 'existing-id',
        providerId: 'provider-1',
        name: 'claude',
      });
    });
  });

  describe('pre-check: name exists other provider', () => {
    it('returns skip with reason when name belongs to different provider', async () => {
      const existingDbRow = {
        id: 'existing-id',
        profileId: 'profile-1',
        providerId: 'provider-OTHER',
        name: 'claude',
        options: null,
        env: null,
        position: 0,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      const selectImpl = jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([existingDbRow]),
          }),
        }),
      });

      const { delegate } = createDelegate({ selectImpl });

      const result = await delegate.createIfMissing(baseInput);

      expect(result.inserted).toBe(false);
      expect(result.reason).toBe('name_exists_other_provider');
      expect(result.existingRow?.providerId).toBe('provider-OTHER');
    });
  });

  describe('constraint conflict: name conflict on insert', () => {
    it('classifies concurrent name winner (same provider)', async () => {
      const concurrentRow = {
        id: 'concurrent-id',
        profileId: 'profile-1',
        providerId: 'provider-1',
        name: 'claude',
        options: null,
        env: null,
        position: 0,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      let selectCallCount = 0;
      const selectImpl = jest.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return {
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([]),
              }),
            }),
          };
        }
        if (selectCallCount === 2) {
          return {
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockResolvedValue([{ maxPos: 0 }]),
            }),
          };
        }
        // Post-conflict re-read: name conflict found
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([concurrentRow]),
            }),
          }),
        };
      });

      const constraintError = new Error('UNIQUE constraint failed');
      (constraintError as unknown as Record<string, unknown>).code = 'SQLITE_CONSTRAINT_UNIQUE';

      const insertImpl = jest.fn().mockReturnValue({
        values: jest.fn().mockRejectedValue(constraintError),
      });

      const { delegate } = createDelegate({ selectImpl, insertImpl });

      const result = await delegate.createIfMissing(baseInput);

      expect(result.inserted).toBe(false);
      expect(result.reason).toBe('name_exists_same_provider');
      expect(result.existingRow?.id).toBe('concurrent-id');
    });

    it('classifies concurrent name winner (other provider)', async () => {
      const concurrentRow = {
        id: 'concurrent-id',
        profileId: 'profile-1',
        providerId: 'provider-OTHER',
        name: 'claude',
        options: null,
        env: null,
        position: 0,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      let selectCallCount = 0;
      const selectImpl = jest.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return {
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([]),
              }),
            }),
          };
        }
        if (selectCallCount === 2) {
          return {
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockResolvedValue([{ maxPos: 0 }]),
            }),
          };
        }
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([concurrentRow]),
            }),
          }),
        };
      });

      const constraintError = new Error('UNIQUE constraint failed');
      (constraintError as unknown as Record<string, unknown>).code = 'SQLITE_CONSTRAINT_UNIQUE';

      const insertImpl = jest.fn().mockReturnValue({
        values: jest.fn().mockRejectedValue(constraintError),
      });

      const { delegate } = createDelegate({ selectImpl, insertImpl });

      const result = await delegate.createIfMissing(baseInput);

      expect(result.inserted).toBe(false);
      expect(result.reason).toBe('name_exists_other_provider');
    });
  });

  describe('constraint conflict: position conflict on insert', () => {
    it('returns position_conflict when name re-read is empty but position clashes', async () => {
      const posRow = {
        id: 'pos-conflict-id',
        profileId: 'profile-1',
        providerId: 'provider-X',
        name: 'other-name',
        options: null,
        env: null,
        position: 1,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      let selectCallCount = 0;
      const selectImpl = jest.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return {
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([]),
              }),
            }),
          };
        }
        if (selectCallCount === 2) {
          return {
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockResolvedValue([{ maxPos: 0 }]),
            }),
          };
        }
        if (selectCallCount === 3) {
          // Name re-read: no conflict
          return {
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([]),
              }),
            }),
          };
        }
        // Position re-read: conflict found
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([posRow]),
            }),
          }),
        };
      });

      const constraintError = new Error('UNIQUE constraint failed');
      (constraintError as unknown as Record<string, unknown>).code = 'SQLITE_CONSTRAINT_UNIQUE';

      const insertImpl = jest.fn().mockReturnValue({
        values: jest.fn().mockRejectedValue(constraintError),
      });

      const { delegate } = createDelegate({ selectImpl, insertImpl });

      const result = await delegate.createIfMissing(baseInput);

      expect(result.inserted).toBe(false);
      expect(result.reason).toBe('position_conflict');
    });
  });

  describe('constraint conflict: unknown', () => {
    it('returns unknown_constraint when neither name nor position re-read matches', async () => {
      let selectCallCount = 0;
      const selectImpl = jest.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount <= 2) {
          if (selectCallCount === 1) {
            return {
              from: jest.fn().mockReturnValue({
                where: jest.fn().mockReturnValue({
                  limit: jest.fn().mockResolvedValue([]),
                }),
              }),
            };
          }
          return {
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockResolvedValue([{ maxPos: 0 }]),
            }),
          };
        }
        // Both re-reads return empty
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
        };
      });

      const constraintError = new Error('UNIQUE constraint failed');
      (constraintError as unknown as Record<string, unknown>).code = 'SQLITE_CONSTRAINT_UNIQUE';

      const insertImpl = jest.fn().mockReturnValue({
        values: jest.fn().mockRejectedValue(constraintError),
      });

      const { delegate } = createDelegate({ selectImpl, insertImpl });

      const result = await delegate.createIfMissing(baseInput);

      expect(result.inserted).toBe(false);
      expect(result.reason).toBe('unknown_constraint');
    });
  });

  describe('non-constraint errors', () => {
    it('throws and rolls back on non-constraint insert error', async () => {
      let selectCallCount = 0;
      const selectImpl = jest.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return {
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([]),
              }),
            }),
          };
        }
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([{ maxPos: 0 }]),
          }),
        };
      });

      const diskError = new Error('disk I/O error');
      const insertImpl = jest.fn().mockReturnValue({
        values: jest.fn().mockRejectedValue(diskError),
      });

      const { delegate, mockRawClient } = createDelegate({ selectImpl, insertImpl });

      await expect(delegate.createIfMissing(baseInput)).rejects.toThrow('disk I/O error');
      expect((mockRawClient.exec as jest.Mock).mock.calls).toEqual([
        ['BEGIN IMMEDIATE TRANSACTION'],
        ['ROLLBACK'],
      ]);
    });
  });

  describe('rawClient validation', () => {
    it('throws StorageError when rawClient is null', async () => {
      const { delegate } = createDelegate({ rawClient: null });

      await expect(delegate.createIfMissing(baseInput)).rejects.toThrow(StorageError);
    });

    it('throws StorageError when rawClient has no exec method', async () => {
      const { delegate } = createDelegate({
        rawClient: {} as unknown as Database.Database,
      });

      await expect(delegate.createIfMissing(baseInput)).rejects.toThrow(StorageError);
    });
  });

  describe('transaction lifecycle', () => {
    it('commits on pre-check hit (no insert attempted)', async () => {
      const existingDbRow = {
        id: 'existing-id',
        profileId: 'profile-1',
        providerId: 'provider-1',
        name: 'claude',
        options: null,
        env: null,
        position: 0,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      const selectImpl = jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([existingDbRow]),
          }),
        }),
      });

      const { delegate, mockRawClient } = createDelegate({ selectImpl });

      await delegate.createIfMissing(baseInput);

      expect((mockRawClient.exec as jest.Mock).mock.calls).toEqual([
        ['BEGIN IMMEDIATE TRANSACTION'],
        ['COMMIT'],
      ]);
    });

    it('commits on constraint conflict (not rollback)', async () => {
      const concurrentRow = {
        id: 'concurrent-id',
        profileId: 'profile-1',
        providerId: 'provider-1',
        name: 'claude',
        options: null,
        env: null,
        position: 0,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      let selectCallCount = 0;
      const selectImpl = jest.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return {
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([]),
              }),
            }),
          };
        }
        if (selectCallCount === 2) {
          return {
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockResolvedValue([{ maxPos: 0 }]),
            }),
          };
        }
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([concurrentRow]),
            }),
          }),
        };
      });

      const constraintError = new Error('UNIQUE constraint failed');
      (constraintError as unknown as Record<string, unknown>).code = 'SQLITE_CONSTRAINT_UNIQUE';

      const insertImpl = jest.fn().mockReturnValue({
        values: jest.fn().mockRejectedValue(constraintError),
      });

      const { delegate, mockRawClient } = createDelegate({ selectImpl, insertImpl });

      await delegate.createIfMissing(baseInput);

      expect((mockRawClient.exec as jest.Mock).mock.calls).toEqual([
        ['BEGIN IMMEDIATE TRANSACTION'],
        ['COMMIT'],
      ]);
    });
  });

  describe('idempotent sequential calls', () => {
    it('first call inserts, second call returns name_exists_same_provider', async () => {
      const insertedRow = {
        id: 'inserted-id',
        profileId: 'profile-1',
        providerId: 'provider-1',
        name: 'claude',
        options: null,
        env: null,
        position: 0,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      let callSequence = 0;
      const selectImpl = jest.fn().mockImplementation(() => {
        callSequence++;
        if (callSequence === 1) {
          return {
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([]),
              }),
            }),
          };
        }
        if (callSequence === 2) {
          return {
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockResolvedValue([{ maxPos: -1 }]),
            }),
          };
        }
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([insertedRow]),
            }),
          }),
        };
      });

      const insertImpl = jest.fn().mockReturnValue({
        values: jest.fn().mockResolvedValue(undefined),
      });

      const { delegate } = createDelegate({ selectImpl, insertImpl });

      const first = await delegate.createIfMissing(baseInput);
      expect(first.inserted).toBe(true);

      const second = await delegate.createIfMissing(baseInput);
      expect(second.inserted).toBe(false);
      expect(second.reason).toBe('name_exists_same_provider');
      expect(second.existingRow?.id).toBe('inserted-id');
    });
  });
});
