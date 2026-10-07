import Database from 'better-sqlite3';
import { TransactionRunner } from './transaction-runner';

function recordExecStatements(sqlite: Database.Database, statements: string[]): Database.Database {
  return new Proxy(sqlite, {
    get(target, prop) {
      if (prop === 'exec') {
        return (sql: string) => {
          statements.push(sql);
          return target.exec(sql);
        };
      }
      return (target as unknown as Record<string | symbol, unknown>)[prop];
    },
  }) as Database.Database;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

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
        sqlite.prepare('INSERT INTO items (name) VALUES (?)').run('should-vanish');
        throw thrown;
      });
      fail('expected error');
    } catch (error) {
      expect(error).toBe(thrown);
      expect((error as Error).name).toBe('ConflictError');
      expect(sqlite.prepare('SELECT name FROM items').all()).toEqual([]);
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
    const proxyRunner = new TransactionRunner(recordExecStatements(sqlite, execCalls));
    proxyRunner.runImmediate(() => {
      sqlite.prepare('INSERT INTO items (name) VALUES (?)').run('test');
    });

    expect(execCalls[0]).toBe('BEGIN IMMEDIATE');
    expect(execCalls[1]).toBe('COMMIT');
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

    it('shares FIFO admission across runner instances over one client', async () => {
      const secondRunner = new TransactionRunner(sqlite);
      const order: string[] = [];
      const firstGate = deferred();

      const first = runner.runImmediateAsync(async () => {
        order.push('first:start');
        await firstGate.promise;
        order.push('first:end');
      });
      const second = secondRunner.runImmediateAsync(async () => {
        order.push('second');
      });

      await Promise.resolve();
      expect(order).toEqual(['first:start']);

      firstGate.resolve();
      await Promise.all([first, second]);

      expect(order).toEqual(['first:start', 'first:end', 'second']);
    });

    it('reserves queue positions synchronously before callers yield', async () => {
      const secondRunner = new TransactionRunner(sqlite);
      const order: string[] = [];
      const blocker = deferred();

      const held = runner.runImmediateAsync(async () => {
        await blocker.promise;
      });
      const queuedSync = secondRunner.runImmediateQueued(() => {
        order.push('queued-sync');
      });
      const queuedAsync = runner.runImmediateAsync(async () => {
        order.push('queued-async');
      });

      blocker.resolve();
      await Promise.all([held, queuedSync, queuedAsync]);

      expect(order).toEqual(['queued-sync', 'queued-async']);
    });

    it('rolls back a rejected job and admits the next job', async () => {
      const secondRunner = new TransactionRunner(sqlite);
      const rejected = runner.runImmediateAsync(async () => {
        sqlite.prepare('INSERT INTO items (name) VALUES (?)').run('should-rollback');
        throw new Error('job failed');
      });
      const next = secondRunner.runImmediateQueued(() => {
        sqlite.prepare('INSERT INTO items (name) VALUES (?)').run('survived');
      });

      await expect(rejected).rejects.toThrow('job failed');
      await expect(next).resolves.toBeUndefined();

      const rows = sqlite.prepare('SELECT name FROM items ORDER BY id').all() as { name: string }[];
      expect(rows.map((row) => row.name)).toEqual(['survived']);
    });

    it('rejects nested queued admission on the same client across runner instances', async () => {
      const secondRunner = new TransactionRunner(sqlite);

      await runner.runImmediateAsync(async () => {
        await expect(secondRunner.runImmediateQueued(() => undefined)).rejects.toThrow(
          'Nested queued transaction admission on the same SQLite client is not allowed.',
        );
      });
    });
  });

  describe('runImmediateQueued', () => {
    it('executes a synchronous callback between BEGIN IMMEDIATE and COMMIT', async () => {
      const calls: string[] = [];
      const queuedRunner = new TransactionRunner(recordExecStatements(sqlite, calls));

      const result = await queuedRunner.runImmediateQueued(() => {
        calls.push('callback');
        sqlite.prepare('INSERT INTO items (name) VALUES (?)').run('queued');
        return 'value';
      });

      expect(result).toBe('value');
      expect(calls).toEqual(['BEGIN IMMEDIATE', 'callback', 'COMMIT']);
    });

    it('rejects Promise-returning callbacks and rolls back their synchronous work', async () => {
      await expect(
        runner.runImmediateQueued(() => {
          sqlite.prepare('INSERT INTO items (name) VALUES (?)').run('should-rollback');
          return Promise.resolve('not-synchronous');
        }),
      ).rejects.toThrow('runImmediateQueued callback must be synchronous.');

      expect(sqlite.prepare('SELECT name FROM items').all()).toEqual([]);
    });
  });

  describe('runImmediateQueuedOrJoin', () => {
    it('joins the exact owner across runner instances using a savepoint', async () => {
      const statements: string[] = [];
      const proxy = recordExecStatements(sqlite, statements);
      const owner = new TransactionRunner(proxy);
      const participant = new TransactionRunner(proxy);

      await owner.runImmediateAsync(async () => {
        await participant.runImmediateQueuedOrJoin(() => {
          sqlite.prepare('INSERT INTO items (name) VALUES (?)').run('joined');
        });
      });

      expect(statements[0]).toBe('BEGIN IMMEDIATE');
      expect(statements[1]).toMatch(/^SAVEPOINT devchain_vm_\d+$/);
      expect(statements[2]).toMatch(/^RELEASE SAVEPOINT devchain_vm_\d+$/);
      expect(statements[3]).toBe('COMMIT');
      expect(statements.filter((statement) => statement === 'BEGIN IMMEDIATE')).toHaveLength(1);
      expect(statements.filter((statement) => statement === 'COMMIT')).toHaveLength(1);
      expect(statements).not.toContain('ROLLBACK');
    });

    it('includes successful joined work in an outer rollback', async () => {
      const participant = new TransactionRunner(sqlite);

      await expect(
        runner.runImmediateAsync(async () => {
          await participant.runImmediateQueuedOrJoin(() => {
            sqlite.prepare('INSERT INTO items (name) VALUES (?)').run('joined');
          });
          throw new Error('outer failure');
        }),
      ).rejects.toThrow('outer failure');

      expect(sqlite.prepare('SELECT name FROM items').all()).toEqual([]);
    });

    it('rolls back a caught joined failure without rolling back outer work', async () => {
      const participant = new TransactionRunner(sqlite);

      await runner.runImmediateAsync(async () => {
        sqlite.prepare('INSERT INTO items (name) VALUES (?)').run('before');

        await expect(
          participant.runImmediateQueuedOrJoin(() => {
            sqlite.prepare('INSERT INTO items (name) VALUES (?)').run('failed-join');
            throw new Error('joined failure');
          }),
        ).rejects.toThrow('joined failure');

        sqlite.prepare('INSERT INTO items (name) VALUES (?)').run('after');
      });

      const rows = sqlite.prepare('SELECT name FROM items ORDER BY id').all() as { name: string }[];
      expect(rows.map((row) => row.name)).toEqual(['before', 'after']);
    });

    it('runs back-to-back same-owner synchronous bodies before yielding', async () => {
      const participant = new TransactionRunner(sqlite);
      const order: string[] = [];

      await runner.runImmediateAsync(async () => {
        const first = participant.runImmediateQueuedOrJoin(() => {
          order.push('first');
        });
        const second = participant.runImmediateQueuedOrJoin(() => {
          order.push('second');
        });
        order.push('scheduled');

        await Promise.all([first, second]);
      });

      expect(order).toEqual(['first', 'second', 'scheduled']);
    });

    it('uses a unique savepoint for each joined operation', async () => {
      const statements: string[] = [];
      const proxy = recordExecStatements(sqlite, statements);
      const owner = new TransactionRunner(proxy);
      const participant = new TransactionRunner(proxy);

      await owner.runImmediateAsync(async () => {
        await participant.runImmediateQueuedOrJoin(() => undefined);
        await participant.runImmediateQueuedOrJoin(() => undefined);
      });

      const savepoints = statements
        .filter((statement) => statement.startsWith('SAVEPOINT '))
        .map((statement) => statement.slice('SAVEPOINT '.length));
      expect(savepoints).toHaveLength(2);
      expect(new Set(savepoints).size).toBe(2);
    });

    it('rejects thenables and rolls back standalone synchronous work', async () => {
      await expect(
        runner.runImmediateQueuedOrJoin(() => {
          sqlite.prepare('INSERT INTO items (name) VALUES (?)').run('should-rollback');
          return Promise.resolve('not-synchronous');
        }),
      ).rejects.toThrow('runImmediateQueuedOrJoin callback must be synchronous.');

      expect(sqlite.prepare('SELECT name FROM items').all()).toEqual([]);
    });

    it('rejects thenables and rolls back only the joined savepoint', async () => {
      const participant = new TransactionRunner(sqlite);

      await runner.runImmediateAsync(async () => {
        sqlite.prepare('INSERT INTO items (name) VALUES (?)').run('outer');
        await expect(
          participant.runImmediateQueuedOrJoin(() => {
            sqlite.prepare('INSERT INTO items (name) VALUES (?)').run('should-rollback');
            return Promise.resolve('not-synchronous');
          }),
        ).rejects.toThrow('runImmediateQueuedOrJoin callback must be synchronous.');
      });

      const rows = sqlite.prepare('SELECT name FROM items').all() as { name: string }[];
      expect(rows.map((row) => row.name)).toEqual(['outer']);
    });

    it('commits a standalone synchronous body before its scheduled microtask runs', async () => {
      const order: string[] = [];
      const proxy = recordExecStatements(sqlite, order);
      const standalone = new TransactionRunner(proxy);

      await standalone.runImmediateQueuedOrJoin(() => {
        order.push('callback');
        queueMicrotask(() => {
          order.push('microtask');
          sqlite.prepare('INSERT INTO items (name) VALUES (?)').run('after-commit');
        });
      });

      expect(order).toEqual(['BEGIN IMMEDIATE', 'callback', 'COMMIT', 'microtask']);
      expect(sqlite.prepare('SELECT name FROM items').all()).toHaveLength(1);
    });

    it('queues an unrelated context instead of joining an active transaction', async () => {
      const participant = new TransactionRunner(sqlite);
      const order: string[] = [];
      const started = deferred();
      const ownerGate = deferred();

      const owner = runner.runImmediateAsync(async () => {
        order.push('owner:start');
        started.resolve();
        await ownerGate.promise;
        order.push('owner:end');
      });
      await started.promise;

      const unrelated = participant.runImmediateQueuedOrJoin(() => {
        order.push('unrelated');
      });
      await Promise.resolve();
      expect(order).toEqual(['owner:start']);

      ownerGate.resolve();
      await Promise.all([owner, unrelated]);
      expect(order).toEqual(['owner:start', 'owner:end', 'unrelated']);
    });

    it('admits a stale inherited context as a new queued transaction', async () => {
      const participant = new TransactionRunner(sqlite);
      const staleGate = deferred();
      let staleCall!: Promise<void>;

      await runner.runImmediateAsync(async () => {
        staleCall = staleGate.promise.then(() =>
          participant.runImmediateQueuedOrJoin(() => {
            sqlite.prepare('INSERT INTO items (name) VALUES (?)').run('stale-context');
          }),
        );
      });

      staleGate.resolve();
      await staleCall;
      expect(sqlite.prepare('SELECT name FROM items').all()).toHaveLength(1);
    });

    it('does not let a stale token join a newer owner on the same client', async () => {
      const participant = new TransactionRunner(sqlite);
      const order: string[] = [];
      const staleGate = deferred();
      let staleCall!: Promise<void>;

      await runner.runImmediateAsync(async () => {
        staleCall = staleGate.promise.then(() =>
          participant.runImmediateQueuedOrJoin(() => {
            order.push('stale');
          }),
        );
      });

      const started = deferred();
      const newerGate = deferred();
      const newerOwner = runner.runImmediateAsync(async () => {
        order.push('newer:start');
        started.resolve();
        await newerGate.promise;
        order.push('newer:end');
      });
      await started.promise;

      staleGate.resolve();
      await Promise.resolve();
      expect(order).toEqual(['newer:start']);

      newerGate.resolve();
      await Promise.all([newerOwner, staleCall]);
      expect(order).toEqual(['newer:start', 'newer:end', 'stale']);
    });

    it('keeps both existing queued entry points strict for an active owner', async () => {
      const participant = new TransactionRunner(sqlite);

      await runner.runImmediateAsync(async () => {
        await expect(participant.runImmediateQueued(() => undefined)).rejects.toThrow(
          'Nested queued transaction admission on the same SQLite client is not allowed.',
        );
        await expect(participant.runImmediateAsync(async () => undefined)).rejects.toThrow(
          'Nested queued transaction admission on the same SQLite client is not allowed.',
        );
      });
    });

    it('releases admission after standalone failure', async () => {
      const participant = new TransactionRunner(sqlite);
      const failed = runner.runImmediateQueuedOrJoin(() => {
        throw new Error('failed');
      });
      const next = participant.runImmediateQueuedOrJoin(() => {
        sqlite.prepare('INSERT INTO items (name) VALUES (?)').run('next');
      });

      await expect(failed).rejects.toThrow('failed');
      await expect(next).resolves.toBeUndefined();
      expect(sqlite.prepare('SELECT name FROM items').all()).toHaveLength(1);
    });
  });
});
