import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';

async function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHealth(url: string, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch (_) {}
    await wait(250);
  }
  return false;
}

describe('CLI smoke (spawn dist/cli.js)', () => {
  it('starts and responds to /health (skips if CLI or build missing)', async () => {
    if (process.env.RUN_CLI_SMOKE !== '1') {
      // This test can interfere with (or be blocked by) an already-running devchain instance.
      // Keep it opt-in so the E2E suite is reliable in dev environments.
      // eslint-disable-next-line no-console
      console.warn('RUN_CLI_SMOKE!=1; skipping CLI smoke test');
      return;
    }

    const repoRoot = join(process.cwd(), '..', '..');
    const cliPath = join(repoRoot, 'dist', 'cli.js');
    const serverMain = join(process.cwd(), 'dist', 'main.js');

    if (!existsSync(cliPath) || !existsSync(serverMain)) {
      // CLI or server build missing in workspace; skip in dev
      // eslint-disable-next-line no-console
      console.warn('CLI or server build missing; skipping CLI smoke test');
      return;
    }

    const port = '4020';
    const dbDir = mkdtempSync(join(tmpdir(), 'devchain-cli-e2e-'));

    const child = spawn(
      process.execPath,
      [
        cliPath,
        'start',
        '--foreground',
        '--no-open',
        '--port',
        port,
        '--db',
        dbDir,
        '--log-level',
        'error',
      ],
      {
        stdio: 'pipe',
        env: {
          ...process.env,
          DEVCHAIN_SKIP_TMUX_CHECK: '1',
          DEVCHAIN_SKIP_PROVIDER_CHECK: '1',
        },
      },
    );

    let output = '';
    child.stdout?.on('data', (buf) => {
      output += String(buf);
    });
    child.stderr?.on('data', (buf) => {
      output += String(buf);
    });

    try {
      const ok = await waitForHealth(`http://127.0.0.1:${port}/health`, 15_000);
      if (!ok) {
        // eslint-disable-next-line no-console
        console.error('CLI output:\n', output.slice(-5000));
      }
      expect(ok).toBe(true);
    } finally {
      child.kill('SIGINT');
      // Ensure the process can't keep the suite alive if SIGINT is ignored.
      await Promise.race([
        new Promise<void>((resolve) => child.once('exit', () => resolve())),
        wait(2000),
      ]);
      if (!child.killed) {
        child.kill('SIGKILL');
      }
    }
  });
});
