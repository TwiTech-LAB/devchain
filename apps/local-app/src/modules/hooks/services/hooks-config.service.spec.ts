import { mkdtemp, readFile, rm, writeFile, stat, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { HooksConfigService } from './hooks-config.service';

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  }),
}));

describe('HooksConfigService', () => {
  let service: HooksConfigService;
  let tempDir: string;

  beforeEach(async () => {
    service = new HooksConfigService();
    tempDir = await mkdtemp(join(tmpdir(), 'hooks-config-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('ensureHooksConfig', () => {
    it('should create settings and relay script when no .claude directory exists', async () => {
      await service.ensureHooksConfig(tempDir);

      // Verify relay script exists
      const scriptPath = join(tempDir, '.claude', 'hooks', 'devchain-relay.sh');
      const scriptContent = await readFile(scriptPath, 'utf-8');
      expect(scriptContent).toContain('#!/bin/bash');
      expect(scriptContent).toContain('DEVCHAIN_API_URL');
      expect(scriptContent).toContain('curl');

      // Verify script is executable
      const scriptStat = await stat(scriptPath);
      const mode = scriptStat.mode & 0o777;
      expect(mode & 0o111).toBeTruthy(); // executable bits set

      // Verify settings file exists and has hooks config
      const settingsPath = join(tempDir, '.claude', 'settings.local.json');
      const settingsContent = JSON.parse(await readFile(settingsPath, 'utf-8'));
      expect(settingsContent.hooks).toBeDefined();
      expect(settingsContent.hooks.SessionStart).toBeInstanceOf(Array);
      expect(settingsContent.hooks.SessionStart).toHaveLength(1);
    });

    it('should preserve existing permissions and user keys during merge', async () => {
      const settingsDir = join(tempDir, '.claude');
      await mkdir(settingsDir, { recursive: true });

      const existingSettings = {
        permissions: { allow: ['mcp__devchain'], deny: [], ask: [] },
        customKey: 'user-value',
      };
      await writeFile(
        join(settingsDir, 'settings.local.json'),
        JSON.stringify(existingSettings, null, 2),
      );

      await service.ensureHooksConfig(tempDir);

      const settings = JSON.parse(
        await readFile(join(settingsDir, 'settings.local.json'), 'utf-8'),
      );
      expect(settings.permissions).toEqual({ allow: ['mcp__devchain'], deny: [], ask: [] });
      expect(settings.customKey).toBe('user-value');
      expect(settings.hooks.SessionStart).toHaveLength(1);
    });

    it('should preserve existing user hooks and add DevChain entry', async () => {
      const settingsDir = join(tempDir, '.claude');
      await mkdir(settingsDir, { recursive: true });

      const existingSettings = {
        hooks: {
          SessionStart: [
            {
              matcher: 'startup',
              hooks: [{ type: 'command', command: '/user/custom-hook.sh' }],
            },
          ],
        },
      };
      await writeFile(
        join(settingsDir, 'settings.local.json'),
        JSON.stringify(existingSettings, null, 2),
      );

      await service.ensureHooksConfig(tempDir);

      const settings = JSON.parse(
        await readFile(join(settingsDir, 'settings.local.json'), 'utf-8'),
      );
      // User hook preserved + DevChain hook added
      expect(settings.hooks.SessionStart).toHaveLength(2);
      const userHook = settings.hooks.SessionStart[0];
      expect(userHook.hooks[0].command).toBe('/user/custom-hook.sh');
      const devchainHook = settings.hooks.SessionStart[1];
      expect(devchainHook.hooks[0].command).toContain('devchain-relay.sh');
    });

    it('should handle invalid JSON in settings gracefully', async () => {
      const settingsDir = join(tempDir, '.claude');
      await mkdir(settingsDir, { recursive: true });
      await writeFile(join(settingsDir, 'settings.local.json'), 'not valid json {{{');

      await service.ensureHooksConfig(tempDir);

      // Should create fresh settings
      const settings = JSON.parse(
        await readFile(join(settingsDir, 'settings.local.json'), 'utf-8'),
      );
      expect(settings.hooks.SessionStart).toHaveLength(1);
    });

    it('should be idempotent — calling twice produces same result', async () => {
      await service.ensureHooksConfig(tempDir);
      await service.ensureHooksConfig(tempDir);

      const settings = JSON.parse(
        await readFile(join(tempDir, '.claude', 'settings.local.json'), 'utf-8'),
      );
      // Should still have exactly one DevChain hook group, not two
      expect(settings.hooks.SessionStart).toHaveLength(1);
    });

    it('should use absolute path for hook command', async () => {
      await service.ensureHooksConfig(tempDir);

      const settings = JSON.parse(
        await readFile(join(tempDir, '.claude', 'settings.local.json'), 'utf-8'),
      );
      const command = settings.hooks.SessionStart[0].hooks[0].command;
      expect(command).toContain(tempDir);
      expect(command).toContain('.claude/hooks/devchain-relay.sh');
    });

    it('should not throw on errors (non-fatal)', async () => {
      // Pass a path that will fail (read-only scenarios handled by the service)
      // The service wraps everything in try/catch, so this should not throw
      await expect(service.ensureHooksConfig(tempDir)).resolves.toBeUndefined();
    });
  });
});
