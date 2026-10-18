// Promise barriers prove mutex admission without timers, filesystem or Git.
import { ProjectGitMutex } from './project-git-mutex';

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('ProjectGitMutex', () => {
  it('serializes a project and releases waiting work even after failure', async () => {
    const mutex = new ProjectGitMutex();
    const started = barrier();
    const finish = barrier();
    const order: string[] = [];
    const first = mutex.runExclusive('project', async () => {
      order.push('first');
      started.release();
      await finish.promise;
      throw new Error('fixture failure');
    });
    const firstResult = expect(first).rejects.toThrow('fixture failure');
    await started.promise;
    const second = mutex.runExclusive('project', async () => {
      order.push('second');
      return 2;
    });
    expect(order).toEqual(['first']);
    finish.release();
    await firstResult;
    expect(await second).toBe(2);
    expect(order).toEqual(['first', 'second']);
    expect(await mutex.runExclusive('project', async () => 3)).toBe(3);
  });

  it('admits another project while the first project is held', async () => {
    const mutex = new ProjectGitMutex();
    const started = barrier();
    const finish = barrier();
    const first = mutex.runExclusive('first', async () => {
      started.release();
      await finish.promise;
      return 1;
    });
    await started.promise;
    try {
      expect(await mutex.runExclusive('second', async () => 2)).toBe(2);
    } finally {
      finish.release();
    }
    expect(await first).toBe(1);
  });
});
