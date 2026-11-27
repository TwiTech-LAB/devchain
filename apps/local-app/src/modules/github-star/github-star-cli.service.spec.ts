import {
  FakeProcessExecutor,
  type CannedResponse,
} from '../terminal/services/process-executor/fake-process-executor';
import type {
  ExecutorResult,
  ProcessExecutorOptions,
} from '../terminal/services/process-executor/process-executor.port';
import type { GithubStarCheckResult } from './github-star-gh.port';
import { GithubStarCliService } from './github-star-cli.service';

/** Adds the spawn-failure answer (`exitCode: null`, no timeout) the base fake cannot give. */
class GhExecutor extends FakeProcessExecutor {
  spawnFails = false;

  async run(options: ProcessExecutorOptions): Promise<ExecutorResult> {
    if (!this.spawnFails) return super.run(options);
    this.calls.push(options);
    return {
      success: false,
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      truncated: false,
    };
  }
}

describe('GithubStarCliService', () => {
  let executor: GhExecutor;
  let service: GithubStarCliService;
  const savedEnv = process.env;

  beforeEach(() => {
    process.env = {
      HOME: '/home/dev',
      PATH: '/usr/bin',
      'BAD-KEY': 'x',
      MULTILINE: 'a\nb',
      GH_HOST: 'ghe.example.com',
    };
    executor = new GhExecutor();
    service = new GithubStarCliService(executor);
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  describe('isAlreadyStarred', () => {
    it.each<[string, CannedResponse | 'spawn-fails', GithubStarCheckResult]>([
      ['204', { type: 'success', stdout: 'HTTP/2.0 204 No Content\r\nDate: x\r\n\r\n' }, 'starred'],
      [
        '404 with exit 1',
        { type: 'failure', exitCode: 1, stdout: 'HTTP/2.0 404 Not Found\n\n{}' },
        'not-starred',
      ],
      ['HTTP/1.1 404', { type: 'failure', stdout: 'HTTP/1.1 404 Not Found\n' }, 'not-starred'],
      ['200', { type: 'success', stdout: 'HTTP/2.0 200 OK\n' }, 'unknown'],
      ['a timeout', { type: 'timeout' }, 'unknown'],
      ['gh not installed', 'spawn-fails', 'unknown'],
      [
        'gh not logged in',
        {
          type: 'failure',
          exitCode: 4,
          stderr: 'To get started with GitHub CLI, please run:  gh auth login',
        },
        'unknown',
      ],
      [
        'no status line',
        { type: 'failure', stdout: 'error connecting to api.github.com\n' },
        'unknown',
      ],
      [
        'a status line after the first line',
        { type: 'success', stdout: '\nHTTP/2.0 204\n' },
        'unknown',
      ],
    ])('classifies %s', async (_name, response, expected) => {
      if (response === 'spawn-fails') executor.spawnFails = true;
      else executor.enqueueResponse(response);

      await expect(service.isAlreadyStarred()).resolves.toBe(expected);
    });

    it('runs one process for concurrent checks and a new one afterwards', async () => {
      executor.setDefaultResponse({ type: 'success', stdout: 'HTTP/2.0 204 No Content\n' });

      const results = await Promise.all([service.isAlreadyStarred(), service.isAlreadyStarred()]);
      expect(results).toEqual(['starred', 'starred']);
      expect(executor.calls).toHaveLength(1);

      await service.isAlreadyStarred();
      expect(executor.calls).toHaveLength(2);
    });
  });

  describe('star', () => {
    it.each<[string, CannedResponse, boolean]>([
      ['exit 0', { type: 'success' }, true],
      ['exit 1', { type: 'failure', exitCode: 1 }, false],
      ['a timeout', { type: 'timeout' }, false],
    ])('returns %s → %s', async (_name, response, expected) => {
      executor.enqueueResponse(response);
      await expect(service.star()).resolves.toBe(expected);
    });
  });

  it('runs both commands against github.com with a filtered, non-interactive env', async () => {
    executor.setDefaultResponse({ type: 'success', stdout: 'HTTP/2.0 204\n' });
    await service.isAlreadyStarred();
    await service.star();

    expect(executor.calls.map((call) => call.argv)).toEqual([
      ['gh', 'api', '--hostname', 'github.com', '--include', 'user/starred/TwiTech-LAB/devchain'],
      [
        'gh',
        'api',
        '--hostname',
        'github.com',
        '--silent',
        '-X',
        'PUT',
        'user/starred/TwiTech-LAB/devchain',
      ],
    ]);
    for (const call of executor.calls) {
      expect(call.mode).toBe('pipe');
      expect(call.outputLimits?.maxBytes).toBeGreaterThan(0);
      expect(call.env).toEqual({
        HOME: '/home/dev',
        PATH: '/usr/bin',
        GH_HOST: 'ghe.example.com',
        GH_PROMPT_DISABLED: '1',
        GH_TELEMETRY: 'false',
      });
    }
  });
});
