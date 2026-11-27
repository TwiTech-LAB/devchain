import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { spawn } from 'child_process';
import { ChildProcessExecutor } from '../child-process-executor';
import type { ExecutorResult } from '../process-executor.port';

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: jest.fn(),
}));

const TIMEOUT_MS = 50;
const GRACE_MS = 100;

class ShortGraceExecutor extends ChildProcessExecutor {
  protected readonly killGraceMs = GRACE_MS;
}

/**
 * A child whose `kill` fails like Node's on EPERM: it emits `error` synchronously and returns
 * false. Like Node, it emits `close` after `exit` once both output streams are closed.
 */
class StubChild extends EventEmitter {
  readonly stdin = null;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = jest.fn((_signal?: NodeJS.Signals) => {
    this.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM' }));
    return false;
  });

  exit(code: number): void {
    this.exitCode = code;
    this.emit('exit', code, null);
    let open = 2;
    for (const stream of [this.stdout, this.stderr]) {
      const closed = () => {
        open -= 1;
        if (open === 0) this.emit('close', code, null);
      };
      if (stream.destroyed) closed();
      else stream.once('close', closed);
    }
  }
}

describe('ChildProcessExecutor when signal delivery fails', () => {
  const executor = new ShortGraceExecutor();
  let child: StubChild;

  beforeEach(() => {
    // Stream `close` events run on nextTick, so only the timers are fake.
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    child = new StubChild();
    jest.mocked(spawn).mockReturnValue(child as never);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /** Starts a run and records when it settles. */
  function start(timeout = TIMEOUT_MS) {
    const outcome: { result?: ExecutorResult } = {};
    void executor
      .run({ argv: ['agy', '--version'], mode: 'pipe', timeout })
      .then((result) => (outcome.result = result));
    return outcome;
  }

  /** Lets pending stream events and promise callbacks run. */
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  const timedOutResult = expect.objectContaining({
    success: false,
    exitCode: null,
    timedOut: true,
  });
  const streamsDestroyed = () => child.stdout.destroyed && child.stderr.destroyed;

  it('keeps the timeout result and settles at the grace end when SIGTERM and SIGKILL fail', async () => {
    const run = start();
    child.stdout.write('partial');

    await jest.advanceTimersByTimeAsync(TIMEOUT_MS);
    await flush();
    expect(child.kill.mock.calls).toEqual([['SIGTERM']]);
    expect(run.result).toBeUndefined();

    await jest.advanceTimersByTimeAsync(GRACE_MS - 1);
    await flush();
    expect(run.result).toBeUndefined();
    expect(streamsDestroyed()).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    await flush();
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    expect(run.result).toEqual(timedOutResult);
    expect(run.result?.stdout).toBe('partial');
    expect(streamsDestroyed()).toBe(true);
  });

  it('keeps the timeout result when SIGTERM fails and the child exits before the grace end', async () => {
    const run = start();

    await jest.advanceTimersByTimeAsync(TIMEOUT_MS);
    child.exit(0);
    await flush();

    expect(run.result).toEqual(timedOutResult);
    expect(streamsDestroyed()).toBe(true);
    await jest.advanceTimersByTimeAsync(GRACE_MS);
    expect(child.kill.mock.calls).toEqual([['SIGTERM']]);
  });

  it('settles a spawn error before the timeout as a failure that did not time out', async () => {
    const run = start();

    child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    await flush();

    expect(run.result).toEqual(
      expect.objectContaining({ success: false, exitCode: null, timedOut: false }),
    );
    await jest.advanceTimersByTimeAsync(TIMEOUT_MS + GRACE_MS);
    expect(child.kill).not.toHaveBeenCalled();
  });
});
