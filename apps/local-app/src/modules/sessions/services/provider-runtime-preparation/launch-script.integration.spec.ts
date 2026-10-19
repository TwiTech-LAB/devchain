import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LAUNCH_SCRIPT_SHELL, launchScriptPath, writeLaunchScript } from './launch-script';

// Only a real shell parses the script, so this is the cheapest layer that catches a quoting
// bug: a unit test can only compare the text against the same quoting rule that wrote it.
describe('launch script under a real /bin/sh', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'devchain-launch-script-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('passes argv and env through exactly and deletes itself', async () => {
    const big = 'z'.repeat(10_240);
    const shared = ["it's", 'say "hi"', '$HOME ${PATH}', '`id` $(id)', 'ünïcødé ✓ 日本', big];
    const env = Object.fromEntries(shared.map((value, index) => [`LAUNCH_VALUE_${index}`, value]));
    // Env values reject newlines (env-builder.ts), so only argv covers them.
    const argv = [...shared, 'line one\nline two', '', '-n'];
    const probe =
      'process.stdout.write(JSON.stringify({ argv: process.argv.slice(1), env: Object.fromEntries(' +
      'Object.entries(process.env).filter(([key]) => key.startsWith("LAUNCH_")' +
      ' || key === "DEVCHAIN_UNSET_ME")) }))';
    const commandArgs = [
      'env',
      '-u',
      'DEVCHAIN_UNSET_ME',
      ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
      process.execPath,
      '-e',
      probe,
      ...argv,
    ];
    const script = launchScriptPath(root);

    await writeLaunchScript(script, commandArgs);
    const result = spawnSync(LAUNCH_SCRIPT_SHELL, [script], {
      encoding: 'utf8',
      env: { ...process.env, DEVCHAIN_UNSET_ME: 'inherited' },
    });

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ argv, env });
    expect(existsSync(script)).toBe(false);
  });
});
