import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetEnvConfig } from '../../../common/config/env.config';
import { ChildProcessExecutor } from '../../terminal/services/process-executor/child-process-executor';
import {
  ProcessExecutor,
  type DaemonSpawnOptions,
  type DaemonSpawnResult,
  type ExecutorResult,
  type ProcessExecutorOptions,
} from '../../terminal/services/process-executor/process-executor.port';
import { ProviderAuthWatcherService } from '../../provider-auth/provider-auth-watcher.service';
import { HostHelperService } from './host-helper.service';
import {
  HostProviderAuthService,
  parseHostEnvFile,
  renderHostEnvFile,
} from './host-provider-auth.service';

const TOKEN = 'sk-ant-oat01-host-secret-token-value';

/** Prints what `claude auth status` prints, with the auth method it is told to report. */
const FAKE_CLAUDE = `#!/bin/sh
[ "$DISABLE_AUTOUPDATER" = "1" ] || exit 91
echo "stdin=$(readlink /proc/$$/fd/0)" >> "$HOME/stdin.log"
if [ -z "$CLAUDE_CODE_OAUTH_TOKEN" ]; then echo '{"loggedIn":false}'; exit 1; fi
printf '{"loggedIn":true,"authMethod":"%s","apiProvider":"firstParty","token":"%s"}\\n' "$FAKE_AUTH_METHOD" "$CLAUDE_CODE_OAUTH_TOKEN"
`;

/** Records every run's argv so tmux interactions are asserted without a tmux server. */
class RecordingExecutor extends ProcessExecutor {
  readonly argvs: string[][] = [];

  async run(options: ProcessExecutorOptions): Promise<ExecutorResult> {
    this.argvs.push([...options.argv]);
    return {
      success: true,
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      truncated: false,
    };
  }

  async spawnDaemon(_options: DaemonSpawnOptions): Promise<DaemonSpawnResult> {
    throw new Error('spawnDaemon is not part of this spec');
  }
}

// Layer: backend integration. Real files in a temp home and a real child
// process (a fake `claude` on PATH) through the process executor.
describe('HostProviderAuthService', () => {
  let root: string;
  let home: string;
  let etcDir: string;
  let service: HostProviderAuthService;
  let watcher: ProviderAuthWatcherService;
  let saved: NodeJS.ProcessEnv;
  let executor: ProcessExecutor;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'devchain-host-auth-'));
    home = join(root, 'home');
    etcDir = join(root, 'etc');
    mkdirSync(join(home, '.devchain'), { recursive: true });
    mkdirSync(etcDir);
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'bin', 'claude'), FAKE_CLAUDE);
    chmodSync(join(root, 'bin', 'claude'), 0o755);
    writeFileSync(join(etcDir, 'claim.json'), '{}');
    writeFileSync(
      join(home, '.devchain', 'host.env'),
      renderHostEnvFile({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN, OTHER: 'a"b$c' }),
      { mode: 0o600 },
    );
    saved = { ...process.env };
    process.env.HOME = home;
    process.env.DISABLE_AUTOUPDATER = '0';
    process.env.PATH = `${join(root, 'bin')}:/usr/bin:/bin`;
    process.env.DEVCHAIN_HOST_ETC_DIR = etcDir;
    resetEnvConfig();
    executor = new ChildProcessExecutor();
    watcher = new ProviderAuthWatcherService();
    watcher.onModuleInit();
    service = new HostProviderAuthService(new HostHelperService(executor), executor, watcher, {
      listProviders: async () => ({ items: [] }),
    } as never);
  });

  afterEach(() => {
    watcher?.onModuleDestroy();
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    resetEnvConfig();
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ['claude', { DISABLE_AUTOUPDATER: '1' }],
    ['copilot', { COPILOT_AUTO_UPDATE: 'false' }],
    ['opencode', { OPENCODE_DISABLE_AUTOUPDATE: 'true' }],
    ['agy', { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' }],
    ['codex', {}],
  ] as const)(
    'enforces the %s policy over inherited and host env',
    async (provider, expectedEnv) => {
      const conflicts = Object.fromEntries(
        Object.keys(expectedEnv).map((key) => [key, 'conflict']),
      );
      Object.assign(process.env, conflicts);
      writeFileSync(join(home, '.devchain', 'host.env'), renderHostEnvFile(conflicts));
      const run = jest.spyOn(executor, 'run').mockResolvedValue({
        success: true,
        exitCode: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
        truncated: false,
      });
      await service.verify(provider, []);
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({ env: expect.objectContaining(expectedEnv) }),
      );
      if (provider === 'codex')
        expect(run.mock.calls[0][0].argv.slice(1, 3)).toEqual([
          '-c',
          'check_for_update_on_startup=false',
        ]);
    },
  );

  it('reads host.env back exactly as the bootstrap writes it', () => {
    const env = { A: 'plain', B: 'quote " dollar $ tick ` slash \\' };
    expect(parseHostEnvFile(renderHostEnvFile(env))).toEqual(env);
  });

  it('fails Claude with the .credentials.json hint when it does not use the token', async () => {
    process.env.FAKE_AUTH_METHOD = 'claude.ai';

    const result = await service.verify('claude', []);

    expect(result.ok).toBe(false);
    expect(result.hint).toContain('remove ~/.claude/.credentials.json');
    expect(result.summary).toContain('"authMethod":"claude.ai"');
    expect(result.summary).not.toContain(TOKEN);
    expect(result.summary).toContain('[redacted]');
  });

  it('passes Claude with oauth_token, running with stdin from /dev/null and host.env', async () => {
    process.env.FAKE_AUTH_METHOD = 'oauth_token';
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

    const result = await service.verify('claude', []);

    expect(result).toMatchObject({ ok: true, hint: null });
    expect(result.summary).not.toContain(TOKEN);
    expect(readFileSync(join(home, 'stdin.log'), 'utf8').trim()).toBe('stdin=/dev/null');
  });

  it('refuses on an instance that is not a claimed host', async () => {
    rmSync(join(etcDir, 'claim.json'));
    await expect(service.verify('claude', [])).rejects.toMatchObject({
      details: { code: 'NOT_A_HOST' },
    });
  });

  it('applies files 0600 in 0700 dirs and merges env into host.env', async () => {
    const result = await service.apply({
      env: { COPILOT_GITHUB_TOKEN: 'gho_new' },
      files: [
        {
          path: join(home, '.codex', 'auth.json'),
          mode: '0600',
          contentBase64: Buffer.from('{"a":1}').toString('base64'),
        },
      ],
    });

    expect(result).toEqual({
      envKeys: ['COPILOT_GITHUB_TOKEN'],
      files: [join(home, '.codex', 'auth.json')],
      removed: { envKeys: [], files: [] },
    });
    expect(readFileSync(join(home, '.codex', 'auth.json'), 'utf8')).toBe('{"a":1}');
    expect(statSync(join(home, '.codex', 'auth.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, '.codex')).mode & 0o777).toBe(0o700);
    expect(parseHostEnvFile(readFileSync(join(home, '.devchain', 'host.env'), 'utf8'))).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
      OTHER: 'a"b$c',
      COPILOT_GITHUB_TOKEN: 'gho_new',
    });
    expect(statSync(join(home, '.devchain', 'host.env')).mode & 0o777).toBe(0o600);
    expect(process.env.COPILOT_GITHUB_TOKEN).toBe('gho_new');
  });

  it('refuses files outside home, the Claude credentials file, reserved env keys, and symlinks', async () => {
    const file = (path: string) => ({ path, mode: '0600' as const, contentBase64: 'e30=' });
    await expect(
      service.apply({ env: {}, files: [file(join(root, 'outside.json'))] }),
    ).rejects.toMatchObject({ details: { reason: 'provider_auth_file_outside_home' } });
    await expect(
      service.apply({ env: {}, files: [file(join(home, '.claude', '.credentials.json'))] }),
    ).rejects.toMatchObject({ details: { reason: 'provider_auth_file_refused' } });
    await expect(service.apply({ env: { PATH: '/x' }, files: [] })).rejects.toMatchObject({
      details: { reason: 'provider_auth_env_key_refused' },
    });
    symlinkSync(root, join(home, 'link'));
    await expect(
      service.apply({ env: {}, files: [file(join(home, 'link', 'x.json'))] }),
    ).rejects.toMatchObject({ details: { reason: 'provider_auth_symlink' } });
    expect(existsSync(join(root, 'x.json'))).toBe(false);
  });

  describe('removing logins on apply', () => {
    const CODEX_PATH = () => join(home, '.codex', 'auth.json');
    const OPENCODE_PATH = () => join(home, '.local', 'share', 'opencode', 'auth.json');
    let recorder: RecordingExecutor;
    let removing: HostProviderAuthService;

    beforeEach(() => {
      recorder = new RecordingExecutor();
      removing = new HostProviderAuthService(new HostHelperService(recorder), recorder, watcher, {
        listProviders: async () => ({ items: [] }),
      } as never);
    });

    it('removes env keys and family files before applying the writes', async () => {
      mkdirSync(join(home, '.codex'), { recursive: true });
      writeFileSync(CODEX_PATH(), '{"old":"login"}', { mode: 0o600 });
      process.env.OTHER = 'legacy';

      const result = await removing.apply({
        remove: {
          envKeys: ['OTHER', 'NEVER_PRESENT_KEY'],
          files: [CODEX_PATH(), OPENCODE_PATH()],
        },
        env: { COPILOT_GITHUB_TOKEN: 'gho_new' },
        files: [
          {
            path: CODEX_PATH(),
            mode: '0600',
            contentBase64: Buffer.from('{"new":"login"}').toString('base64'),
          },
        ],
      });

      expect(result).toEqual({
        envKeys: ['COPILOT_GITHUB_TOKEN'],
        files: [CODEX_PATH()],
        removed: { envKeys: ['OTHER'], files: [CODEX_PATH()] },
      });
      // Removal ran before the write: the re-sent file carries the new login.
      expect(readFileSync(CODEX_PATH(), 'utf8')).toBe('{"new":"login"}');
      // The missing OpenCode file was a no-op and stays absent.
      expect(existsSync(OPENCODE_PATH())).toBe(false);
      // host.env was rewritten without the removed key and with the merge.
      expect(parseHostEnvFile(readFileSync(join(home, '.devchain', 'host.env'), 'utf8'))).toEqual({
        CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
        COPILOT_GITHUB_TOKEN: 'gho_new',
      });
      expect(process.env.OTHER).toBeUndefined();
      expect(process.env.COPILOT_GITHUB_TOKEN).toBe('gho_new');
      // The fake executor saw the unset before the set, in that order.
      const unsetAt = recorder.argvs.findIndex(
        (argv) => argv.join(' ') === 'tmux set-environment -gu OTHER',
      );
      const setAt = recorder.argvs.findIndex(
        (argv) => argv.join(' ') === 'tmux set-environment -g COPILOT_GITHUB_TOKEN gho_new',
      );
      expect(unsetAt).toBeGreaterThanOrEqual(0);
      expect(setAt).toBeGreaterThan(unsetAt);
    });

    it('reports nothing removed when every target is already gone', async () => {
      const result = await removing.apply({
        remove: { envKeys: ['NEVER_PRESENT_KEY'], files: [OPENCODE_PATH()] },
        env: {},
        files: [],
      });

      expect(result.removed).toEqual({ envKeys: [], files: [] });
      expect(parseHostEnvFile(readFileSync(join(home, '.devchain', 'host.env'), 'utf8'))).toEqual({
        CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
        OTHER: 'a"b$c',
      });
    });

    it('refuses reserved and malformed env keys, and non-family, refused, outside and unknown paths', async () => {
      const remove = (spec: { envKeys: string[]; files: string[] }) =>
        removing.apply({ remove: spec, env: {}, files: [] });
      await expect(remove({ envKeys: ['PATH'], files: [] })).rejects.toMatchObject({
        details: { reason: 'provider_auth_env_key_refused' },
      });
      await expect(remove({ envKeys: ['BAD-KEY'], files: [] })).rejects.toMatchObject({
        details: { reason: 'provider_auth_env_key_refused' },
      });
      await expect(
        remove({ envKeys: [], files: [join(root, 'outside.json')] }),
      ).rejects.toMatchObject({ details: { reason: 'provider_auth_file_outside_home' } });
      await expect(
        remove({ envKeys: [], files: [join(home, '.devchain', 'host.env')] }),
      ).rejects.toMatchObject({ details: { reason: 'provider_auth_file_refused' } });
      await expect(
        remove({ envKeys: [], files: [join(home, '.codex', 'other.json')] }),
      ).rejects.toMatchObject({ details: { reason: 'provider_auth_file_not_family' } });
    });

    it('refuses a symlinked family file and a symlinked parent, leaving the targets alone', async () => {
      writeFileSync(join(root, 'real.json'), '{"real":1}', { mode: 0o600 });
      mkdirSync(join(root, 'target'), { recursive: true });
      writeFileSync(join(root, 'target', 'auth.json'), '{"real":2}', { mode: 0o600 });
      mkdirSync(join(home, '.codex'));
      symlinkSync(join(root, 'real.json'), CODEX_PATH());
      symlinkSync(join(root, 'target'), join(home, '.local'));

      await expect(
        removing.apply({ remove: { envKeys: [], files: [CODEX_PATH()] }, env: {}, files: [] }),
      ).rejects.toMatchObject({ details: { reason: 'provider_auth_symlink' } });
      await expect(
        removing.apply({ remove: { envKeys: [], files: [OPENCODE_PATH()] }, env: {}, files: [] }),
      ).rejects.toMatchObject({ details: { reason: 'provider_auth_symlink' } });

      expect(readFileSync(join(root, 'real.json'), 'utf8')).toBe('{"real":1}');
      expect(readFileSync(join(root, 'target', 'auth.json'), 'utf8')).toBe('{"real":2}');
    });

    it('removes a family file that exists and rewrites host.env without the removed keys', async () => {
      mkdirSync(join(home, '.codex'), { recursive: true });
      writeFileSync(CODEX_PATH(), '{"old":"login"}', { mode: 0o600 });
      process.env.OTHER = 'legacy';

      const result = await removing.apply({
        remove: { envKeys: ['OTHER'], files: [CODEX_PATH()] },
        env: {},
        files: [],
      });

      expect(result.removed).toEqual({ envKeys: ['OTHER'], files: [CODEX_PATH()] });
      expect(existsSync(CODEX_PATH())).toBe(false);
      expect(parseHostEnvFile(readFileSync(join(home, '.devchain', 'host.env'), 'utf8'))).toEqual({
        CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
      });
      expect(process.env.OTHER).toBeUndefined();
      expect(recorder.argvs).toContainEqual(['tmux', 'set-environment', '-gu', 'OTHER']);
    });
  });

  describe('families report', () => {
    const CODEX_REFRESHED = '{"tokens":{"refresh_token":"rotated"}}';

    function writeCodexAuth(content: string): number {
      mkdirSync(join(home, '.codex'), { recursive: true });
      writeFileSync(join(home, '.codex', 'auth.json'), content, { mode: 0o600 });
      return statSync(join(home, '.codex', 'auth.json')).mtimeMs;
    }

    it('serves a changed family file with content and filters by since', async () => {
      const mtime = writeCodexAuth(CODEX_REFRESHED);

      const changed = await service.families(0);
      expect(changed).toEqual([
        {
          provider: 'codex',
          files: [
            {
              path: '.codex/auth.json',
              contentBase64: Buffer.from(CODEX_REFRESHED, 'utf8').toString('base64'),
              mtime,
            },
          ],
        },
      ]);

      // Nothing newer than the reported mtime: the cheap empty answer.
      await expect(service.families(mtime)).resolves.toEqual([]);
    });

    it('picks up a refresh that happens after a first report', async () => {
      writeCodexAuth(CODEX_REFRESHED);
      const [first] = await service.families(0);

      const refreshed = '{"tokens":{"refresh_token":"rotated-again"}}';
      writeCodexAuth(refreshed);
      // ext filesystems stamp back-to-back writes with the same coarse mtime;
      // force the refresh to be strictly newer than the reported one.
      const codexAuth = join(home, '.codex', 'auth.json');
      utimesSync(codexAuth, new Date(first.files[0].mtime + 5), new Date(first.files[0].mtime + 5));
      const [second] = await service.families(first.files[0].mtime);

      expect(Buffer.from(second.files[0].contentBase64, 'base64').toString('utf8')).toBe(refreshed);
    });

    it('refuses the report on an instance that is not a claimed host', async () => {
      writeCodexAuth(CODEX_REFRESHED);
      rmSync(join(etcDir, 'claim.json'));

      await expect(service.families(0)).rejects.toMatchObject({
        details: { code: 'NOT_A_HOST' },
      });
    });

    it('reports nothing when no family file exists', async () => {
      await expect(service.families(0)).resolves.toEqual([]);
    });
  });
});
