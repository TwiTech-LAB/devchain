import { ChildProcessExecutor } from './child-process-executor';
import { FakeProcessExecutor } from './fake-process-executor';
import { validateEnv } from './process-executor.port';
import type { ProcessExecutorOptions } from './process-executor.port';

// ── validateEnv ─────────────────────────────────────────────────────────

describe('validateEnv', () => {
  it('accepts valid env keys and values', () => {
    expect(() => validateEnv({ PATH: '/usr/bin', _FOO: 'bar', A1_B2: 'ok' })).not.toThrow();
  });

  it('rejects env key starting with a digit', () => {
    expect(() => validateEnv({ '1BAD': 'val' })).toThrow(/Invalid env key/);
  });

  it('rejects env key with hyphen', () => {
    expect(() => validateEnv({ 'BAD-KEY': 'val' })).toThrow(/Invalid env key/);
  });

  it('rejects env key with space', () => {
    expect(() => validateEnv({ 'BAD KEY': 'val' })).toThrow(/Invalid env key/);
  });

  it('rejects env value with newline', () => {
    expect(() => validateEnv({ GOOD_KEY: 'bad\nvalue' })).toThrow(/control characters/);
  });

  it('rejects env value with tab', () => {
    expect(() => validateEnv({ KEY: 'bad\tvalue' })).toThrow(/control characters/);
  });

  it('rejects env value with null byte', () => {
    expect(() => validateEnv({ KEY: 'bad\x00value' })).toThrow(/control characters/);
  });
});

// ── ChildProcessExecutor ────────────────────────────────────────────────

describe('ChildProcessExecutor', () => {
  const executor = new ChildProcessExecutor();

  it('runs a simple command successfully (pipe happy path)', async () => {
    const result = await executor.run({
      argv: ['echo', 'hello world'],
      mode: 'pipe',
    });
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello world');
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it('captures stderr from failing command', async () => {
    const result = await executor.run({
      argv: ['node', '-e', 'console.error("err"); process.exit(1)'],
      mode: 'pipe',
    });
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.trim()).toBe('err');
  });

  it('handles timeout', async () => {
    const result = await executor.run({
      argv: ['sleep', '30'],
      mode: 'pipe',
      timeout: 200,
    });
    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(null);
  }, 10_000);

  it('sends input on stdin', async () => {
    const result = await executor.run({
      argv: ['cat'],
      mode: 'pipe',
      input: 'stdin-content',
    });
    expect(result.success).toBe(true);
    expect(result.stdout).toBe('stdin-content');
  });

  it('truncates stdout when output exceeds maxBytes', async () => {
    const result = await executor.run({
      argv: ['node', '-e', 'process.stdout.write("A".repeat(200))'],
      mode: 'pipe',
      outputLimits: { maxBytes: 50 },
    });
    expect(result.stdout.length).toBe(50);
    expect(result.truncated).toBe(true);
  });

  it('rejects env with control chars in values', async () => {
    await expect(
      executor.run({
        argv: ['echo', 'test'],
        mode: 'pipe',
        env: { GOOD_KEY: 'bad\nval' },
      }),
    ).rejects.toThrow(/control characters/);
  });

  it('rejects env with invalid key pattern', async () => {
    await expect(
      executor.run({
        argv: ['echo', 'test'],
        mode: 'pipe',
        env: { '9KEY': 'val' },
      }),
    ).rejects.toThrow(/Invalid env key/);
  });

  it('passes env to the child process', async () => {
    const result = await executor.run({
      argv: ['node', '-e', 'process.stdout.write(process.env.TEST_VAR || "")'],
      mode: 'pipe',
      env: { TEST_VAR: 'hello_env', PATH: process.env.PATH! },
    });
    expect(result.success).toBe(true);
    expect(result.stdout).toBe('hello_env');
  });

  it('returns failure for empty argv', async () => {
    const result = await executor.run({
      argv: [],
      mode: 'pipe',
    });
    expect(result.success).toBe(false);
  });
});

// ── PtyExecutor tests relocated to __tests__/pty-executor.spec.ts ──────

// ── FakeProcessExecutor ─────────────────────────────────────────────────

describe('FakeProcessExecutor', () => {
  let fake: FakeProcessExecutor;

  beforeEach(() => {
    fake = new FakeProcessExecutor();
  });

  it('records calls with argv, mode, cwd, env', async () => {
    const opts: ProcessExecutorOptions = {
      argv: ['git', 'status'],
      mode: 'pipe',
      cwd: '/tmp',
      env: { GIT_DIR: '/repo' },
    };
    await fake.run(opts);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toEqual({
      argv: ['git', 'status'],
      mode: 'pipe',
      cwd: '/tmp',
      env: { GIT_DIR: '/repo' },
    });
  });

  it('returns success by default', async () => {
    const result = await fake.run({ argv: ['cmd'], mode: 'pipe' });
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('returns enqueued failure response', async () => {
    fake.enqueueResponse({ type: 'failure', exitCode: 42, stderr: 'oops' });
    const result = await fake.run({ argv: ['cmd'], mode: 'pipe' });
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(42);
    expect(result.stderr).toBe('oops');
  });

  it('returns enqueued timeout response', async () => {
    fake.enqueueResponse({ type: 'timeout' });
    const result = await fake.run({ argv: ['cmd'], mode: 'pipe' });
    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(null);
  });

  it('returns output-bytes response with truncation', async () => {
    fake.enqueueResponse({
      type: 'output-bytes',
      stdout: 'X'.repeat(200),
    });
    const result = await fake.run({
      argv: ['cmd'],
      mode: 'pipe',
      outputLimits: { maxBytes: 50 },
    });
    expect(result.stdout.length).toBe(50);
    expect(result.truncated).toBe(true);
  });

  it('uses default response after queue is exhausted', async () => {
    fake.enqueueResponse({ type: 'failure', exitCode: 1 });
    fake.setDefaultResponse({ type: 'success', stdout: 'default' });

    await fake.run({ argv: ['a'], mode: 'pipe' });
    const second = await fake.run({ argv: ['b'], mode: 'pipe' });
    expect(second.success).toBe(true);
    expect(second.stdout).toBe('default');
  });

  it('reset clears calls and responses', async () => {
    fake.enqueueResponse({ type: 'failure' });
    await fake.run({ argv: ['cmd'], mode: 'pipe' });
    fake.reset();
    expect(fake.calls).toHaveLength(0);
    const result = await fake.run({ argv: ['cmd'], mode: 'pipe' });
    expect(result.success).toBe(true);
  });
});
