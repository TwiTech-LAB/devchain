import Database from 'better-sqlite3';
import { TransactionRunner } from './transaction-runner';

describe('TransactionRunner', () => {
  let sqlite: Database.Database;
  let runner: TransactionRunner;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    runner = new TransactionRunner(sqlite);
  });

  afterEach(() => {
    sqlite.close();
  });

  it('commits on success', () => {
    runner.runImmediate(() => {
      sqlite.prepare('INSERT INTO items (name) VALUES (?)').run('alpha');
      sqlite.prepare('INSERT INTO items (name) VALUES (?)').run('beta');
    });

    const rows = sqlite.prepare('SELECT name FROM items ORDER BY id').all() as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual(['alpha', 'beta']);
  });

  it('returns the callback result', () => {
    const result = runner.runImmediate(() => {
      sqlite.prepare('INSERT INTO items (name) VALUES (?)').run('gamma');
      return { inserted: true, count: 1 };
    });

    expect(result).toEqual({ inserted: true, count: 1 });
  });

  it('rolls back on thrown error', () => {
    sqlite.prepare('INSERT INTO items (name) VALUES (?)').run('existing');

    expect(() =>
      runner.runImmediate(() => {
        sqlite.prepare('INSERT INTO items (name) VALUES (?)').run('should-vanish');
        throw new Error('domain error');
      }),
    ).toThrow('domain error');

    const rows = sqlite.prepare('SELECT name FROM items').all() as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual(['existing']);
  });

  it('re-throws domain errors after rollback', () => {
    class ConflictError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'ConflictError';
      }
    }

    const thrown = new ConflictError('version mismatch');

    try {
      runner.runImmediate(() => {
        throw thrown;
      });
      fail('expected error');
    } catch (error) {
      expect(error).toBe(thrown);
      expect((error as Error).name).toBe('ConflictError');
    }
  });

  it('logs rollback failure without masking original error', () => {
    let rollbackCalled = false;
    const fakeClient = {
      exec: (sql: string) => {
        if (sql === 'BEGIN IMMEDIATE') return;
        if (sql === 'ROLLBACK') {
          rollbackCalled = true;
          throw new Error('disk I/O error');
        }
      },
    } as unknown as Database.Database;

    const faultyRunner = new TransactionRunner(fakeClient);

    expect(() =>
      faultyRunner.runImmediate(() => {
        throw new Error('original error');
      }),
    ).toThrow('original error');

    expect(rollbackCalled).toBe(true);
  });

  it('uses BEGIN IMMEDIATE (not deferred)', () => {
    const execCalls: string[] = [];
    const proxy = new Proxy(sqlite, {
      get(target, prop) {
        if (prop === 'exec') {
          return (sql: string) => {
            execCalls.push(sql);
            return target.exec(sql);
          };
        }
        return (target as Record<string | symbol, unknown>)[prop];
      },
    });

    const proxyRunner = new TransactionRunner(proxy as Database.Database);
    proxyRunner.runImmediate(() => {
      sqlite.prepare('INSERT INTO items (name) VALUES (?)').run('test');
    });

    expect(execCalls[0]).toBe('BEGIN IMMEDIATE');
    expect(execCalls[1]).toBe('COMMIT');
  });

  it('handles nested function calls correctly', () => {
    function insertItem(db: Database.Database, name: string): number {
      const result = db.prepare('INSERT INTO items (name) VALUES (?)').run(name);
      return Number(result.lastInsertRowid);
    }

    const ids = runner.runImmediate(() => {
      const id1 = insertItem(sqlite, 'first');
      const id2 = insertItem(sqlite, 'second');
      return [id1, id2];
    });

    expect(ids).toHaveLength(2);
    const rows = sqlite.prepare('SELECT name FROM items ORDER BY id').all() as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual(['first', 'second']);
  });

  describe('runImmediateAsync', () => {
    it('commits on success with async callback', async () => {
      await runner.runImmediateAsync(async () => {
        sqlite.prepare('INSERT INTO items (name) VALUES (?)').run('async-alpha');
        sqlite.prepare('INSERT INTO items (name) VALUES (?)').run('async-beta');
      });

      const rows = sqlite.prepare('SELECT name FROM items ORDER BY id').all() as { name: string }[];
      expect(rows.map((r) => r.name)).toEqual(['async-alpha', 'async-beta']);
    });

    it('rolls back on thrown error in async callback', async () => {
      sqlite.prepare('INSERT INTO items (name) VALUES (?)').run('pre-existing');

      await expect(
        runner.runImmediateAsync(async () => {
          sqlite.prepare('INSERT INTO items (name) VALUES (?)').run('should-vanish');
          throw new Error('async domain error');
        }),
      ).rejects.toThrow('async domain error');

      const rows = sqlite.prepare('SELECT name FROM items').all() as { name: string }[];
      expect(rows.map((r) => r.name)).toEqual(['pre-existing']);
    });

    it('returns the async callback result', async () => {
      const result = await runner.runImmediateAsync(async () => {
        sqlite.prepare('INSERT INTO items (name) VALUES (?)').run('value-item');
        return { count: 1 };
      });

      expect(result).toEqual({ count: 1 });
    });
  });
});
