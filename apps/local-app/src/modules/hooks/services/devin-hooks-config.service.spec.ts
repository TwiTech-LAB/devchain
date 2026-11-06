import { mkdtemp, readFile, rm, stat, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { DevinHooksConfigService } from './devin-hooks-config.service';
import { HooksConfigService } from './hooks-config.service';

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

describe('DevinHooksConfigService', () => {
  let service: DevinHooksConfigService;
  let claude: HooksConfigService;
  let tempDir: string;
  const relayPath = () => join(tempDir, '.devin', 'hooks', 'devchain-relay.sh');
  const configPath = () => join(tempDir, '.devin', 'config.local.json');

  beforeEach(async () => {
    claude = new HooksConfigService();
    service = new DevinHooksConfigService(claude);
    tempDir = await mkdtemp(join(tmpdir(), 'devin-hooks-'));
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('materializes an executable project-level relay and merges hook groups', async () => {
    await service.ensureHooksConfig(tempDir);
    const script = await readFile(relayPath(), 'utf-8');
    expect(script).toContain('#!/bin/bash');
    expect(script).toContain('.hook_event_name');
    expect(script).toContain('--arg providerName "devin"');
    expect(script).toContain('providerSessionId');
    expect(script).toContain('--max-time 2');
    expect(script).toContain('--max-time 10');
    // chmod is honored on POSIX; Windows reports generic file modes.
    expect(((await stat(relayPath())).mode & 0o111) !== 0 || process.platform === 'win32').toBe(
      true,
    );

    const config = JSON.parse(await readFile(configPath(), 'utf-8'));
    const quoted = `"${relayPath()}"`;
    expect(config.hooks.SessionStart).toEqual([
      { hooks: [{ type: 'command', command: quoted, timeout: 10 }] },
    ]);
    expect(config.hooks.UserPromptSubmit[0].hooks[0].timeout).toBe(2);
    expect(config.hooks.Stop[0].hooks[0].timeout).toBe(2);
    expect(config.hooks.PreToolUse).toBeUndefined();
  });

  it('preserves user keys + user hooks and stays idempotent across runs', async () => {
    await mkdir(join(tempDir, '.devin'), { recursive: true });
    await writeFile(
      configPath(),
      JSON.stringify({
        keep: 'me',
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '/u/h.sh' }] }] },
      }),
    );
    await service.ensureHooksConfig(tempDir);
    await service.ensureHooksConfig(tempDir);
    const config = JSON.parse(await readFile(configPath(), 'utf-8'));
    expect(config.keep).toBe('me');
    expect(config.hooks.SessionStart).toHaveLength(2);
    expect(config.hooks.SessionStart[0].hooks[0].command).toBe('/u/h.sh');
    expect(config.hooks.Stop).toHaveLength(1);
  });

  it('handles invalid JSON config.local.json gracefully', async () => {
    await mkdir(join(tempDir, '.devin'), { recursive: true });
    await writeFile(configPath(), '{nope');
    await service.ensureHooksConfig(tempDir);
    const config = JSON.parse(await readFile(configPath(), 'utf-8'));
    expect(config.hooks.SessionStart).toHaveLength(1);
  });

  it('refreshes an existing Claude relay (provider guard) but never creates one', async () => {
    const claudeRelay = join(tempDir, '.claude', 'hooks', 'devchain-relay.sh');
    await service.ensureHooksConfig(tempDir);
    // No .claude relay existed → still absent.
    await expect(readFile(claudeRelay, 'utf-8')).rejects.toThrow();
    // An old (guard-less) relay gets refreshed with the provider guard.
    await mkdir(join(tempDir, '.claude', 'hooks'), { recursive: true });
    await writeFile(claudeRelay, '#!/bin/bash\necho old\n');
    await service.ensureHooksConfig(tempDir);
    const refreshed = await readFile(claudeRelay, 'utf-8');
    expect(refreshed).toContain('DEVCHAIN_HOOK_PROVIDER');
  });
});
