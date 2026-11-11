import { mkdtemp, readFile, rm, stat, mkdir, writeFile } from 'fs/promises';
import { execFileSync } from 'child_process';
import { closeSync, openSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { DevinHooksConfigService } from './devin-hooks-config.service';
import { HooksConfigService } from './hooks-config.service';
import { ChildProcessExecutor } from '../../terminal/services/process-executor/child-process-executor';
import { HookEventSchema } from '../dtos/hook-event.dto';
import { parseJsonc } from '../../../common/jsonc';

jest.mock('../../../common/logging/logger', () => {
  const instance = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
  return { createLogger: () => instance };
});

const logger = jest.requireMock('../../../common/logging/logger').createLogger() as Record<
  'info' | 'error' | 'warn' | 'debug',
  jest.Mock
>;

describe('DevinHooksConfigService', () => {
  let service: DevinHooksConfigService;
  let claude: HooksConfigService;
  let tempDir: string;
  const relayPath = () => join(tempDir, '.devin', 'hooks', 'devchain-relay.sh');
  const configPath = () => join(tempDir, '.devin', 'config.local.json');

  beforeEach(async () => {
    claude = new HooksConfigService();
    service = new DevinHooksConfigService(claude, new ChildProcessExecutor());
    tempDir = await mkdtemp(join(tmpdir(), 'devin-hooks-'));
    jest.clearAllMocks();
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
    // Outside a git repository the exclude step is skipped without a warning.
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
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

  it('keeps comments, user settings and user hooks of a commented config', async () => {
    const original = `{
  // Team permissions — keep.
  "permissions": { "allow": ["Bash(ls)"] },
  "read_config_from": { "claude": false }, /* local only */
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "/u/h.sh" }] }],
  },
}
`;
    await mkdir(join(tempDir, '.devin'), { recursive: true });
    await writeFile(configPath(), original);

    await service.ensureHooksConfig(tempDir);

    const text = await readFile(configPath(), 'utf-8');
    expect(text).toContain('// Team permissions — keep.');
    expect(text).toContain('/* local only */');
    const config = parseJsonc(text) as {
      permissions: unknown;
      read_config_from: unknown;
      hooks: Record<string, Array<{ hooks: Array<{ command?: string }> }>>;
    };
    expect(config.permissions).toEqual({ allow: ['Bash(ls)'] });
    expect(config.read_config_from).toEqual({ claude: false });
    expect(config.hooks.SessionStart[0]).toEqual({
      hooks: [{ type: 'command', command: '/u/h.sh' }],
    });
    for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
      const relayEntries = config.hooks[event].flatMap((group) => group.hooks);
      expect(relayEntries).toContainEqual(expect.objectContaining({ command: `"${relayPath()}"` }));
    }
  });

  it('two concurrent runs in the same millisecond both write a valid config', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      await Promise.all([service.ensureHooksConfig(tempDir), service.ensureHooksConfig(tempDir)]);
    } finally {
      now.mockRestore();
    }
    expect(logger.error).not.toHaveBeenCalled();
    const config = parseJsonc(await readFile(configPath(), 'utf-8')) as {
      hooks: Record<string, unknown[]>;
    };
    expect(config.hooks.SessionStart).toHaveLength(1);
  });

  it('keeps a user hook and extra keys added to the DevChain hook group', async () => {
    await service.ensureHooksConfig(tempDir);
    const config = JSON.parse(await readFile(configPath(), 'utf-8'));
    config.hooks.Stop[0].description = 'user note';
    config.hooks.Stop[0].hooks.push({ type: 'command', command: '/u/stop.sh' });
    config.hooks.Stop[0].hooks[0].timeout = 99;
    await writeFile(configPath(), JSON.stringify(config, null, 2));

    await service.ensureHooksConfig(tempDir);

    const after = JSON.parse(await readFile(configPath(), 'utf-8'));
    expect(after.hooks.Stop).toEqual([
      {
        description: 'user note',
        hooks: [
          { type: 'command', command: `"${relayPath()}"`, timeout: 2 },
          { type: 'command', command: '/u/stop.sh' },
        ],
      },
    ]);
  });

  it.each([
    ['invalid JSON with comments', '{nope // broken\n'],
    ['a non-object root', '[1, 2]\n'],
    ['a non-object "hooks"', '{ "hooks": "off" }\n'],
    ['a null "hooks"', '{ "hooks": null }\n'],
  ])('leaves a config with %s byte-identical and names it in a warning', async (_, content) => {
    await mkdir(join(tempDir, '.devin'), { recursive: true });
    await writeFile(configPath(), content);

    await service.ensureHooksConfig(tempDir);

    expect(await readFile(configPath(), 'utf-8')).toBe(content);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ configPath: configPath() }),
      expect.stringContaining(configPath()),
    );
    // The relay is still in place; the launch continues.
    expect(await readFile(relayPath(), 'utf-8')).toContain('#!/bin/bash');
  });

  it.each([
    ['at the repository root', ''],
    ['in a repository subdirectory', 'sub/project/'],
  ])('excludes the DevChain .devin files from git once, %s', async (_, prefix) => {
    try {
      execFileSync('git', ['init', '-q', tempDir]);
    } catch {
      return; // git unavailable on this platform
    }
    const projectRoot = join(tempDir, prefix);
    await mkdir(join(projectRoot, '.devin'), { recursive: true });
    await writeFile(join(projectRoot, '.devin', 'mcp_config.local.json'), '{}\n');

    await service.ensureHooksConfig(projectRoot);
    await service.ensureHooksConfig(projectRoot);

    const exclude = await readFile(join(tempDir, '.git', 'info', 'exclude'), 'utf-8');
    const lines = exclude.split('\n');
    for (const file of [
      '.devin/config.local.json',
      '.devin/hooks/devchain-relay.sh',
      '.devin/mcp_config.local.json',
    ]) {
      expect(lines.filter((line) => line === `${prefix}${file}`)).toHaveLength(1);
    }
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: tempDir,
      encoding: 'utf-8',
    });
    expect(status).not.toContain('.devin');
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

  describe('relay execution (stubbed curl)', () => {
    let toolsAvailable = false;
    beforeAll(() => {
      try {
        execFileSync('bash', ['-c', 'command -v jq >/dev/null']);
        toolsAvailable = true;
      } catch {
        toolsAvailable = false;
      }
    });

    const devchainEnv = (): NodeJS.ProcessEnv => ({
      ...process.env,
      DEVCHAIN_API_URL: 'http://localhost:9999',
      DEVCHAIN_TMUX_SESSION_NAME: 'devchain-test',
      DEVCHAIN_PROJECT_ID: '11111111-1111-1111-1111-111111111111',
      DEVCHAIN_AGENT_ID: '22222222-2222-2222-2222-222222222222',
      DEVCHAIN_SESSION_ID: '33333333-3333-3333-3333-333333333333',
    });

    /**
     * Runs a materialized relay through bash with a stubbed `curl` that captures
     * the POST body. `fakeNsDate` also stubs `date` to emit 19-digit nanoseconds
     * for `+%s%3N` (non-GNU date behaviour) while `+%s` stays real.
     * Resolves to the captured payload, or undefined when the relay never posts.
     */
    async function runScript(
      scriptPath: string,
      hookJson: unknown,
      {
        extraEnv = {},
        fakeNsDate = false,
      }: { extraEnv?: Record<string, string>; fakeNsDate?: boolean } = {},
    ): Promise<Record<string, unknown> | undefined | null> {
      // null = bash/jq unavailable on this platform; undefined = relay never posted.
      if (!toolsAvailable) return null;
      const binDir = join(tempDir, `fakebin-${Date.now()}`);
      const captureFile = join(tempDir, `captured-${Date.now()}.json`);

      const fakeCurl = `#!/bin/bash
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-d" ]; then shift; out="$1"; fi
  shift
done
printf '%s' "$out" > "${captureFile}.tmp" && mv "${captureFile}.tmp" "${captureFile}"
exit 0
`;
      await mkdir(binDir, { recursive: true });
      await writeFile(join(binDir, 'curl'), fakeCurl, { mode: 0o755 });
      if (fakeNsDate) {
        const fakeDate = `#!/bin/bash
case "$1" in
  +%s%3N) echo "9999999999999999999" ;;
  *) /usr/bin/date "$@" ;;
esac
`;
        await writeFile(join(binDir, 'date'), fakeDate, { mode: 0o755 });
      }

      // stdin comes from a file, not a pipe: a guarded relay exits before it
      // reads stdin, and writing to its closed pipe fails with EPIPE.
      const inputFile = join(tempDir, `hook-input-${Date.now()}.json`);
      await writeFile(inputFile, JSON.stringify(hookJson));
      const stdinFd = openSync(inputFile, 'r');
      try {
        execFileSync('bash', [scriptPath], {
          stdio: [stdinFd, 'pipe', 'pipe'],
          env: {
            ...devchainEnv(),
            ...extraEnv,
            PATH: `${binDir}:${process.env.PATH ?? ''}`,
          },
        });
      } finally {
        closeSync(stdinFd);
      }

      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          const raw = await readFile(captureFile, 'utf8');
          return JSON.parse(raw) as Record<string, unknown>;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      return undefined;
    }

    it.each(['UserPromptSubmit', 'Stop'])(
      'posts a %s turn hook with providerName=devin, providerSessionId and a valid hook time under nanosecond date',
      async (hookEventName) => {
        await service.ensureHooksConfig(tempDir);
        const payload = await runScript(
          relayPath(),
          { hook_event_name: hookEventName, session_id: 'functional-share' },
          { fakeNsDate: true },
        );
        if (payload === null) return; // bash/jq unavailable on this platform
        expect(payload).toBeDefined();
        if (payload === undefined) throw new Error('expected a captured POST payload');

        expect(payload).toMatchObject({
          hookEventName,
          providerName: 'devin',
          providerSessionId: 'functional-share',
          sessionId: '33333333-3333-3333-3333-333333333333',
        });
        // 19-digit nanoseconds must NOT be accepted as ms.
        expect(Math.abs((payload.firedAtMs as number) - Date.now())).toBeLessThan(60_000);
        expect(HookEventSchema.safeParse(payload).success).toBe(true);
      },
    );

    it('posts a SessionStart with providerName=devin and no firedAtMs', async () => {
      await service.ensureHooksConfig(tempDir);
      const payload = await runScript(relayPath(), {
        hook_event_name: 'SessionStart',
        session_id: 'functional-share',
        source: 'resume',
      });
      if (payload === null) return; // bash/jq unavailable on this platform
      expect(payload).toBeDefined();
      if (payload === undefined) throw new Error('expected a captured POST payload');

      expect(payload).toMatchObject({
        hookEventName: 'SessionStart',
        providerName: 'devin',
        providerSessionId: 'functional-share',
        source: 'resume',
      });
      expect(payload).not.toHaveProperty('firedAtMs');
      expect(HookEventSchema.safeParse(payload).success).toBe(true);
    });

    it('the Claude relay stays silent under DEVCHAIN_HOOK_PROVIDER=devin (no duplicate delivery)', async () => {
      // Materialize the guarded Claude relay in the same project.
      await claude.ensureHooksConfig(tempDir);
      const claudeRelay = join(tempDir, '.claude', 'hooks', 'devchain-relay.sh');

      const payload = await runScript(
        claudeRelay,
        { hook_event_name: 'UserPromptSubmit', session_id: 'claude-session-1' },
        { extraEnv: { DEVCHAIN_HOOK_PROVIDER: 'devin' } },
      );
      if (payload === null) return; // bash/jq unavailable on this platform
      // The guard exits before any curl: nothing is ever captured.
      expect(payload).toBeUndefined();
    });
  });
});
