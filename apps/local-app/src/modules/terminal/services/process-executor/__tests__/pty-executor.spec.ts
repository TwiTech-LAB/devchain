import { PtyExecutor } from '../pty-executor';

describe('PtyExecutor', () => {
  const executor = new PtyExecutor();

  it('runs a simple command successfully (pty happy path)', async () => {
    const result = await executor.run({
      argv: ['echo', 'hello pty'],
      mode: 'pty',
    });
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello pty');
    expect(result.stderr).toBe('');
    expect(result.timedOut).toBe(false);
  });

  it('handles timeout with SIGTERM escalation to SIGKILL', async () => {
    const result = await executor.run({
      argv: ['sleep', '30'],
      mode: 'pty',
      timeout: 200,
    });
    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(null);
  }, 10_000);

  it('sends input via pty write', async () => {
    const result = await executor.run({
      argv: [
        'node',
        '-e',
        'process.stdin.once("data", d => { process.stdout.write(d); process.exit(0); })',
      ],
      mode: 'pty',
      input: 'pty-input\n',
      timeout: 5000,
    });
    expect(result.success).toBe(true);
    expect(result.stdout).toContain('pty-input');
  }, 10_000);

  it('truncates output when exceeding maxBytes (backpressure)', async () => {
    const result = await executor.run({
      argv: ['node', '-e', 'process.stdout.write("B".repeat(500))'],
      mode: 'pty',
      outputLimits: { maxBytes: 100 },
    });
    expect(result.stdout.length).toBeLessThanOrEqual(100);
    expect(result.truncated).toBe(true);
  });

  it('cleans up disposables on exit (cleanup)', async () => {
    const result = await executor.run({
      argv: ['echo', 'cleanup-test'],
      mode: 'pty',
      timeout: 5000,
    });
    expect(result.success).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  it('uses configured PTY dimensions (200×30)', async () => {
    const result = await executor.run({
      argv: [
        'node',
        '-e',
        'process.stdout.write(JSON.stringify({cols:process.stdout.columns,rows:process.stdout.rows}))',
      ],
      mode: 'pty',
      timeout: 5000,
    });
    expect(result.success).toBe(true);
    const dims = JSON.parse(result.stdout.trim());
    expect(dims.cols).toBe(200);
    expect(dims.rows).toBe(30);
  });

  it('rejects env with control chars', async () => {
    await expect(
      executor.run({
        argv: ['echo', 'x'],
        mode: 'pty',
        env: { KEY: 'bad\x01val' },
      }),
    ).rejects.toThrow(/control characters/);
  });

  it('rejects env with invalid key', async () => {
    await expect(
      executor.run({
        argv: ['echo', 'x'],
        mode: 'pty',
        env: { 'BAD-KEY': 'val' },
      }),
    ).rejects.toThrow(/Invalid env key/);
  });

  it('returns failure for empty argv', async () => {
    const result = await executor.run({
      argv: [],
      mode: 'pty',
    });
    expect(result.success).toBe(false);
  });
});
