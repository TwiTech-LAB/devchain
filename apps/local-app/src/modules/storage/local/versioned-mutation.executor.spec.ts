import Database from 'better-sqlite3';
import {
  NotFoundError,
  OptimisticLockError,
  StorageError,
} from '../../../common/errors/error-types';
import { TransactionRunner } from '../db/transaction-runner';
import {
  VersionedMutationExecutor,
  type VersionedMutationSpec,
} from './versioned-mutation.executor';

interface TestRow {
  id: string;
  version: number;
  value: string;
}

describe('VersionedMutationExecutor', () => {
  let sqlite: Database.Database;
  let executor: VersionedMutationExecutor;
  let current: TestRow;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(
      'CREATE TABLE records (id TEXT PRIMARY KEY, version INTEGER NOT NULL, value TEXT NOT NULL)',
    );
    current = { id: 'record-1', version: 3, value: 'before' };
    executor = new VersionedMutationExecutor(new TransactionRunner(sqlite));
  });

  afterEach(() => {
    sqlite.close();
  });

  function createSpec(
    overrides: Partial<VersionedMutationSpec<TestRow, string, TestRow>> = {},
  ): VersionedMutationSpec<TestRow, string, TestRow> {
    return {
      resource: 'Record',
      id: current.id,
      expectedVersion: current.version,
      loadCurrent: () => current,
      versionOf: (row) => row.version,
      prepare: () => ({ kind: 'write', state: 'after' }),
      write: () => 1,
      loadResult: () => ({ ...current, version: current.version + 1, value: 'after' }),
      ...overrides,
    };
  }

  it('stops at a supplied-version mismatch before preparation or write', async () => {
    const prepare = jest.fn(() => ({ kind: 'write' as const, state: 'after' }));
    const write = jest.fn(() => 1);

    await expect(
      executor.execute(createSpec({ expectedVersion: 2, prepare, write })),
    ).rejects.toMatchObject({
      constructor: OptimisticLockError,
      details: { expectedVersion: 2, actualVersion: 3 },
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('returns a typed no-change result without writing or running side effects', async () => {
    const unchanged = { ...current };
    const write = jest.fn(() => 1);
    const afterWrite = jest.fn();
    const loadResult = jest.fn(() => ({ ...current, version: 4 }));

    await expect(
      executor.execute(
        createSpec({
          prepare: () => ({ kind: 'no_change', result: unchanged }),
          write,
          afterWrite,
          loadResult,
        }),
      ),
    ).resolves.toBe(unchanged);
    expect(write).not.toHaveBeenCalled();
    expect(afterWrite).not.toHaveBeenCalled();
    expect(loadResult).not.toHaveBeenCalled();
  });

  it('reloads and classifies a zero-row compare-and-swap as a conflict', async () => {
    const loadCurrent = jest
      .fn<TestRow, []>()
      .mockReturnValueOnce(current)
      .mockReturnValueOnce({ ...current, version: 4 });

    await expect(
      executor.execute(createSpec({ loadCurrent, write: () => 0 })),
    ).rejects.toMatchObject({
      constructor: OptimisticLockError,
      details: { expectedVersion: 3, actualVersion: 4 },
    });
    expect(loadCurrent).toHaveBeenCalledTimes(2);
  });

  it('propagates not-found classification when the zero-row reload cannot find the row', async () => {
    const loadCurrent = jest
      .fn<TestRow, []>()
      .mockReturnValueOnce(current)
      .mockImplementationOnce(() => {
        throw new NotFoundError('Record', current.id);
      });

    await expect(
      executor.execute(createSpec({ loadCurrent, write: () => 0 })),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('runs dependent writes only after one row changes and reloads the result last', async () => {
    const order: string[] = [];
    const result = { ...current, version: 4, value: 'after' };

    await expect(
      executor.execute(
        createSpec({
          loadCurrent: () => {
            order.push('load-current');
            return current;
          },
          prepare: (context) => {
            order.push(`prepare:${context.actualVersion}->${context.nextVersion}`);
            return { kind: 'write', state: 'after' };
          },
          write: (context, state) => {
            order.push(`write:${context.actualVersion}:${state}`);
            return 1;
          },
          afterWrite: (_context, state) => {
            order.push(`after-write:${state}`);
          },
          loadResult: () => {
            order.push('load-result');
            return result;
          },
        }),
      ),
    ).resolves.toBe(result);
    expect(order).toEqual([
      'load-current',
      'prepare:3->4',
      'write:3:after',
      'after-write:after',
      'load-result',
    ]);
  });

  it.each([
    ['dependent write', true],
    ['result reload', false],
  ])('rolls back when the %s fails', async (_label, failAfterWrite) => {
    const failure = new Error('mutation failed');
    const spec = createSpec({
      write: (context, state) => {
        sqlite
          .prepare('INSERT INTO records (id, version, value) VALUES (?, ?, ?)')
          .run(context.current.id, context.nextVersion, state);
        return 1;
      },
      afterWrite: failAfterWrite
        ? () => {
            throw failure;
          }
        : undefined,
      loadResult: () => {
        if (!failAfterWrite) throw failure;
        return { ...current, version: 4 };
      },
    });

    await expect(executor.execute(spec)).rejects.toBe(failure);
    expect(sqlite.prepare('SELECT * FROM records').all()).toEqual([]);
  });

  it('rejects an invariant-breaking multi-row result before dependent writes', async () => {
    const afterWrite = jest.fn();

    await expect(
      executor.execute(createSpec({ write: () => 2, afterWrite })),
    ).rejects.toMatchObject({
      constructor: StorageError,
      details: { resource: 'Record', id: 'record-1', changes: 2 },
    });
    expect(afterWrite).not.toHaveBeenCalled();
  });

  it('lets the runner reject an inferred thenable result and roll back the write', async () => {
    await expect(
      executor.execute(
        createSpec({
          write: (context, state) => {
            sqlite
              .prepare('INSERT INTO records (id, version, value) VALUES (?, ?, ?)')
              .run(context.current.id, context.nextVersion, state);
            return 1;
          },
          loadResult: () => Promise.resolve(current) as unknown as TestRow,
        }),
      ),
    ).rejects.toThrow('runImmediateQueuedOrJoin callback must be synchronous.');
    expect(sqlite.prepare('SELECT * FROM records').all()).toEqual([]);
  });
});
