import { createTestDatabase } from '../../common/test/test-database.helper';
import Database from 'better-sqlite3';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import { dirname, join } from 'node:path';
import { ConflictError, ValidationError } from '../../common/errors/error-types';
import type { ProviderAdapterFactory } from '../providers/adapters/provider-adapter.factory';
import { LocalStorageService } from '../storage/local/local-storage.service';
import { IntegrationCredentialCipher } from '../storage/local/integration-credential-cipher';
import type {
  StandaloneTerminal,
  StandaloneTerminalService,
} from '../terminal/services/standalone-terminal.service';
import { PROVIDER_AUTH_ADAPTERS } from './provider-auth-adapters';
import { ChildProcessExecutor } from '../terminal/services/process-executor/child-process-executor';
import {
  ProviderAuthGeneratorService,
  loginArgv,
  redactSecrets,
  resolveExecutable,
  type ProviderAuthGeneration,
} from './provider-auth-generator.service';
import { ProviderAuthVaultService } from './provider-auth-vault.service';

const CODEX_REFRESH = 'codex-refresh-token-0123456789';
const AGY_REFRESH = 'agy-refresh-token-0123456789';
const GH_TOKEN = 'gho_' + 'A'.repeat(36);

/** Fake CLIs: each behaves like the proven command for its role and logs what it saw. */
const FAKE_CLIS: Record<string, string> = {
  codex: `
[ "$1" = "-c" ] && [ "$2" = "check_for_update_on_startup=false" ] || exit 91
shift 2
if [ "$1 $2" = "login status" ]; then
  echo "stdin=$(readlink /proc/$$/fd/0)" >> "$FAKE_LOG"
  if [ -n "$FAKE_CODEX_STATUS_FAIL" ]; then
    echo "refresh failed for $(cat "$CODEX_HOME/auth.json") and ${GH_TOKEN}"; exit 1
  fi
  [ -f "$CODEX_HOME/auth.json" ] && { echo "Logged in using ChatGPT"; exit 0; }
  echo "Not logged in"; exit 1
fi
if [ "$1" = "login" ]; then
  [ -n "$FAKE_CODEX_NEVER" ] && { sleep 30; exit 0; }
  [ -n "$FAKE_CODEX_GIVE_UP" ] && exit 1
  sleep 0.05
  mkdir -p "$CODEX_HOME/tmp/arg0"
  printf '{"auth_mode":"chatgpt","tokens":{"access_token":"codex-access-token-0123","refresh_token":"${CODEX_REFRESH}"}}' > "$CODEX_HOME/auth.json"
  exit 0
fi
exit 2`,
  agy: `
[ "$AGY_CLI_DISABLE_AUTO_UPDATE" = "true" ] || exit 91
if [ "$1" = "-p" ]; then
  echo "stdin=$(readlink /proc/$$/fd/0)" >> "$FAKE_LOG"
  [ -f "$HOME/.gemini/antigravity-cli/antigravity-oauth-token" ] && { echo OK; exit 0; }
  exit 1
fi
env | sort > "$FAKE_ENV_DUMP"
ls -A "$XDG_RUNTIME_DIR" | wc -l > "$FAKE_ENV_DUMP.runtime"
mkdir -p "$HOME/.gemini/antigravity-cli/cache"
echo '{}' > "$HOME/.gemini/antigravity-cli/settings.json"
printf '{"token":{"access_token":"agy-access-token-0123","refresh_token":"${AGY_REFRESH}"},"auth_method":"oauth"}' > "$HOME/.gemini/antigravity-cli/antigravity-oauth-token"
sleep 30`,
  gh: `
[ "$COPILOT_AUTO_UPDATE" = "false" ] || exit 91
if [ "$1 $2" = "auth token" ]; then
  if [ -n "$GH_TOKEN" ]; then echo "$GH_TOKEN"; exit 0; fi
  [ -f "$GH_CONFIG_DIR/hosts.yml" ] && { echo "${GH_TOKEN}"; exit 0; }
  exit 1
fi
if [ "$1 $2" = "auth login" ]; then
  echo "login-args=$*" >> "$FAKE_LOG"
  echo "github.com: {}" > "$GH_CONFIG_DIR/hosts.yml"
  echo "version: 1" > "$GH_CONFIG_DIR/config.yml"
  exit 0
fi
exit 2`,
  copilot: `
[ "$COPILOT_AUTO_UPDATE" = "false" ] || exit 91
echo "stdin=$(readlink /proc/$$/fd/0)" >> "$FAKE_LOG"
[ "$COPILOT_GITHUB_TOKEN" = "${GH_TOKEN}" ] && { echo "OK"; echo "Tokens: 12"; exit 0; }
echo "not authenticated"; exit 1`,
  opencode: `
[ "$OPENCODE_DISABLE_AUTOUPDATE" = "true" ] || exit 91
if [ "$1 $2" = "auth list" ]; then
  echo "stdin=$(readlink /proc/$$/fd/0)" >> "$FAKE_LOG"
  echo "Credentials $XDG_DATA_HOME/opencode/auth.json"
  echo "OpenAI oauth"; echo "GitHub Copilot oauth"; echo "Anthropic api"; exit 0
fi
if [ "$1 $2" = "auth login" ]; then
  mkdir -p "$XDG_DATA_HOME/opencode"
  printf '%s' '{"openai":{"type":"oauth","access":"oc-access-0123456","refresh":"oc-refresh-0123456","expires":1},"github-copilot":{"type":"oauth","access":"ghc-access-0123456","refresh":"ghc-refresh-0123456","expires":1},"anthropic":{"type":"api","key":"sk-ant-api-key-0123456789"}}' > "$XDG_DATA_HOME/opencode/auth.json"
  exit 0
fi
exit 2`,
};

/** The PC's own provider files; every test checks they stay byte- and mtime-identical. */
const PC_FILES = [
  '.codex/auth.json',
  '.gemini/antigravity-cli/antigravity-oauth-token',
  '.local/share/opencode/auth.json',
  '.config/gh/hosts.yml',
];

/** Runs the pane command directly, as tmux would, with this process's environment. */
class FakeTerminals {
  readonly children = new Map<string, ChildProcess>();
  readonly ended = new Map<string, string>();
  private exited = new Set<string>();
  private next = 0;

  async start(argv: string[], options: { cwd: string }): Promise<StandaloneTerminal> {
    const sessionId = `terminal-${++this.next}`;
    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: process.env,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.on('exit', () => this.exited.add(sessionId));
    this.children.set(sessionId, child);
    return { sessionId, tmuxSessionName: `fake_${sessionId}` };
  }

  async isRunning(sessionId: string): Promise<boolean> {
    return this.children.has(sessionId) && !this.exited.has(sessionId);
  }

  async end(sessionId: string, message: string): Promise<void> {
    this.ended.set(sessionId, message);
    this.children.get(sessionId)?.kill('SIGKILL');
  }

  killAll(): void {
    for (const child of this.children.values()) child.kill('SIGKILL');
  }
}

// Layer: backend integration. Real vault storage (migrated SQLite, real cipher),
// real child processes running fake CLIs through the generated login script; only
// tmux is replaced by FakeTerminals.
describe('ProviderAuthGeneratorService', () => {
  let root: string;
  let pcHome: string;
  let baseDir: string;
  let log: string;
  let sqlite: Database.Database;
  let storage: LocalStorageService;
  let terminals: FakeTerminals;
  let generator: ProviderAuthGeneratorService;
  let savedEnv: NodeJS.ProcessEnv;
  let pcSnapshot: Array<{ file: string; content: string; mtimeMs: number }>;
  let providerBins: Array<{ name: string; binPath: string | null }>;

  const adapters = {
    isSupported: (provider: string) => provider.toLowerCase() in PROVIDER_AUTH_ADAPTERS,
    getSupportedProviders: () => Object.keys(PROVIDER_AUTH_ADAPTERS),
  } as unknown as ProviderAdapterFactory;

  function makeGenerator(options: { timeoutMs?: number } = {}): ProviderAuthGeneratorService {
    return new ProviderAuthGeneratorService(
      new ProviderAuthVaultService(storage, adapters),
      terminals as unknown as StandaloneTerminalService,
      adapters,
      new ChildProcessExecutor(),
      { listProviders: async () => ({ items: providerBins }) } as never,
      { baseDir, pollIntervalMs: 10, timeoutMs: options.timeoutMs ?? 20_000 },
    );
  }

  async function settle(id: string): Promise<ProviderAuthGeneration> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const view = generator.get(id);
      if (view.finishedAt) return view;
      if (Date.now() > deadline) throw new Error(`generation still ${view.state}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  const stdinLines = () =>
    (existsSync(log) ? readFileSync(log, 'utf8') : '')
      .split('\n')
      .filter((line) => line.startsWith('stdin='));

  beforeEach(() => {
    root = mkdtempSync(join(os.tmpdir(), 'devchain-auth-gen-'));
    pcHome = join(root, 'pc-home');
    baseDir = join(root, 'devchain-auth-gen');
    log = join(root, 'fake.log');
    const bin = join(root, 'bin');
    mkdirSync(bin);
    for (const [name, body] of Object.entries(FAKE_CLIS)) {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    }

    // The PC's own logins, and a desktop session whose bus agy must not find.
    const pcRuntime = join(root, 'pc-run');
    mkdirSync(pcRuntime);
    writeFileSync(join(pcRuntime, 'bus'), '');
    pcSnapshot = PC_FILES.map((relative) => {
      const file = join(pcHome, relative);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `pc-own-${relative}`);
      const stat = statSync(file);
      return { file, content: readFileSync(file, 'utf8'), mtimeMs: stat.mtimeMs };
    });

    savedEnv = { ...process.env };
    // Only the fakes and base utilities: the real provider CLIs must never run here.
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    process.env.HOME = pcHome;
    process.env.COPILOT_AUTO_UPDATE = 'true';
    process.env.OPENCODE_DISABLE_AUTOUPDATE = 'false';
    process.env.AGY_CLI_DISABLE_AUTO_UPDATE = 'false';
    process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${pcRuntime}/bus`;
    process.env.XDG_RUNTIME_DIR = pcRuntime;
    process.env.GH_TOKEN = 'gho_pc_own_token_should_never_be_used_00';
    process.env.FAKE_LOG = log;
    process.env.FAKE_ENV_DUMP = join(root, 'agy-env');

    const database = createTestDatabase();
    sqlite = database.sqlite;
    const db = database.db;
    storage = new LocalStorageService(
      db,
      new IntegrationCredentialCipher({
        secretDirectory: join(root, 'secret'),
        machineIdentity: 'provider-auth-generator-test:test-user',
      }),
    );
    providerBins = [];
    terminals = new FakeTerminals();
    generator = makeGenerator();
  });

  afterEach(async () => {
    await generator.onModuleDestroy();
    terminals.killAll();
    for (const file of pcSnapshot) {
      expect(readFileSync(file.file, 'utf8')).toBe(file.content);
      expect(statSync(file.file).mtimeMs).toBe(file.mtimeMs);
    }
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('captures a Codex login, verifies it, stores a family, and removes the isolated dir', async () => {
    const started = await generator.start('codex');
    expect(started).toMatchObject({ provider: 'codex', state: 'waiting', finishedAt: null });
    expect(terminals.children.has(started.sessionId)).toBe(true);

    const done = await settle(started.id);

    expect(done.state).toBe('stored');
    expect(done.entries).toHaveLength(1);
    expect(done.entries[0]).toMatchObject({
      provider: 'codex',
      kind: 'family',
      payloadKind: 'files',
    });
    expect(done.entries[0].lastVerifiedAt).not.toBeNull();
    const payload = await storage.readProviderAuthPayload(done.entries[0].id);
    expect(payload).toEqual({
      payloadKind: 'files',
      content: expect.stringContaining(CODEX_REFRESH),
    });
    expect(readdirSync(baseDir)).toEqual([]);
    expect(terminals.ended.get(started.sessionId)).toBe('Login stored in the provider auth vault.');
    expect(stdinLines()).toEqual(['stdin=/dev/null']);
  });

  it('runs a configured provider binary instead of the name on PATH', async () => {
    const custom = join(root, 'bin', 'codex-custom');
    writeFileSync(custom, `#!/bin/sh\n${FAKE_CLIS.codex}\n`);
    chmodSync(custom, 0o755);
    rmSync(join(root, 'bin', 'codex'));
    providerBins = [{ name: 'codex', binPath: custom }];

    const done = await settle((await generator.start('codex')).id);

    expect(done.state).toBe('stored');
  });

  it('logs Antigravity in with an isolated HOME, no bus variable, and an empty runtime dir', async () => {
    const started = await generator.start('agy');
    const done = await settle(started.id);

    expect(done.state).toBe('stored');
    expect(done.entries).toEqual([
      expect.objectContaining({ provider: 'agy', kind: 'family', payloadKind: 'files' }),
    ]);
    const payload = await storage.readProviderAuthPayload(done.entries[0].id);
    expect(payload.payloadKind === 'files' && JSON.parse(payload.content)).toMatchObject({
      token: { refresh_token: AGY_REFRESH },
    });

    const env = readFileSync(join(root, 'agy-env'), 'utf8').split('\n');
    const isolatedDir = join(baseDir, `${process.pid}-${started.id}`);
    expect(env.some((line) => line.startsWith('DBUS_SESSION_BUS_ADDRESS='))).toBe(false);
    expect(env).toContain(`XDG_RUNTIME_DIR=${isolatedDir}/run`);
    expect(env).toContain(`HOME=${isolatedDir}/home`);
    expect(readFileSync(join(root, 'agy-env.runtime'), 'utf8').trim()).toBe('0');
    // The login kept running (agy stays in its REPL); the terminal is ended for it.
    expect(terminals.ended.has(started.sessionId)).toBe(true);
    expect(existsSync(isolatedDir)).toBe(false);
  });

  it('stores Copilot as one static COPILOT_GITHUB_TOKEN entry from gh auth token', async () => {
    const done = await settle((await generator.start('copilot')).id);

    expect(done.state).toBe('stored');
    expect(done.entries).toEqual([
      expect.objectContaining({ provider: 'copilot', kind: 'static', payloadKind: 'env' }),
    ]);
    expect(await storage.readProviderAuthPayload(done.entries[0].id)).toEqual({
      payloadKind: 'env',
      envKey: 'COPILOT_GITHUB_TOKEN',
      value: GH_TOKEN,
    });
    expect(await storage.listProviderAuthEntries()).toHaveLength(1);
    expect(readFileSync(log, 'utf8')).toContain(
      'login-args=auth login -h github.com -p https -w --insecure-storage',
    );
    expect(stdinLines()).toEqual(['stdin=/dev/null']);
  });

  it('stores one OpenCode family per oauth provider id and ignores api ids', async () => {
    const done = await settle((await generator.start('opencode', 'Work OpenCode')).id);

    expect(done.state).toBe('stored');
    const stored = await Promise.all(
      done.entries.map(async (entry) => ({
        label: entry.label,
        kind: entry.kind,
        payload: await storage.readProviderAuthPayload(entry.id),
      })),
    );
    expect(stored).toEqual([
      {
        label: 'Work OpenCode · openai',
        kind: 'family',
        payload: {
          payloadKind: 'opencode-entry',
          providerId: 'openai',
          entry: expect.objectContaining({ type: 'oauth', refresh: 'oc-refresh-0123456' }),
        },
      },
      {
        label: 'Work OpenCode · github-copilot',
        kind: 'family',
        payload: expect.objectContaining({ providerId: 'github-copilot' }),
      },
    ]);
  });

  it('cancel ends the terminal, removes the isolated dir, and stores nothing', async () => {
    process.env.FAKE_CODEX_NEVER = '1';
    const started = await generator.start('codex');
    const isolatedDir = join(baseDir, `${process.pid}-${started.id}`);
    expect(existsSync(isolatedDir)).toBe(true);

    const cancelled = await generator.cancel(started.id);

    expect(cancelled).toMatchObject({ state: 'cancelled', entries: [] });
    expect(existsSync(isolatedDir)).toBe(false);
    expect(terminals.ended.get(started.sessionId)).toBe('Login cancelled.');
    expect(await storage.listProviderAuthEntries()).toEqual([]);
  });

  it('times out, removes the isolated dir, and stores nothing', async () => {
    process.env.FAKE_CODEX_NEVER = '1';
    generator = makeGenerator({ timeoutMs: 100 });
    const started = await generator.start('codex');

    const done = await settle(started.id);

    expect(done.state).toBe('timed_out');
    expect(readdirSync(baseDir)).toEqual([]);
    expect(await storage.listProviderAuthEntries()).toEqual([]);
  });

  it('fails when the login command exits without a login', async () => {
    process.env.FAKE_CODEX_GIVE_UP = '1';
    const done = await settle((await generator.start('codex')).id);

    expect(done.state).toBe('failed');
    expect(done.error).toBe('The login terminal closed before a login was captured.');
    expect(await storage.listProviderAuthEntries()).toEqual([]);
  });

  it('a failed verify blocks storage and reports the output with secrets redacted', async () => {
    process.env.FAKE_CODEX_STATUS_FAIL = '1';
    const done = await settle((await generator.start('codex')).id);

    expect(done.state).toBe('failed');
    expect(done.error).toContain('codex login status exited 1');
    expect(done.error).toContain('refresh failed for');
    expect(done.error).toContain('[redacted]');
    expect(done.error).not.toContain(CODEX_REFRESH);
    expect(done.error).not.toContain(GH_TOKEN);
    expect(await storage.listProviderAuthEntries()).toEqual([]);
    expect(readdirSync(baseDir)).toEqual([]);
    expect(stdinLines()).toEqual(['stdin=/dev/null']);
  });

  it.each(['copilot', 'gh'])('refuses missing %s before creating resources', async (cli) => {
    rmSync(join(root, 'bin', cli));

    await expect(generator.start('copilot')).rejects.toMatchObject({
      details: { reason: 'provider_cli_missing', cli },
    });
    expect(existsSync(baseDir)).toBe(false);
    expect(terminals.children.size).toBe(0);
  });

  it('refuses Claude (paste only), unsupported providers, and a second login for one provider', async () => {
    await expect(generator.start('claude')).rejects.toThrow(ValidationError);
    await expect(generator.start('claude')).rejects.toThrow(/paste its token/);
    await expect(generator.start('gemini')).rejects.toThrow(ValidationError);

    process.env.FAKE_CODEX_NEVER = '1';
    const [first, second] = await Promise.allSettled([
      generator.start('codex'),
      generator.start('codex'),
    ]);
    expect(first.status).toBe('fulfilled');
    expect(second).toMatchObject({ status: 'rejected', reason: expect.any(ConflictError) });
    await expect(generator.start('codex')).rejects.toThrow(ConflictError);
  });

  it('on start removes isolated dirs of processes that no longer run, and only those', async () => {
    const dead = join(baseDir, '999999999-leftover');
    const live = join(baseDir, `${process.pid}-running`);
    mkdirSync(dead, { recursive: true });
    mkdirSync(live, { recursive: true });

    await generator.onModuleInit();

    expect(existsSync(dead)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });
});

describe('loginArgv', () => {
  it('sets and unsets the isolation variables through env, with no shell', () => {
    expect(
      loginArgv(['/opt/agy bin/agy', "it's"], {
        set: { HOME: '/x/home', XDG_RUNTIME_DIR: '/x/run' },
        unset: ['DBUS_SESSION_BUS_ADDRESS'],
      }),
    ).toEqual([
      '/usr/bin/env',
      '-u',
      'DBUS_SESSION_BUS_ADDRESS',
      'HOME=/x/home',
      'XDG_RUNTIME_DIR=/x/run',
      '/opt/agy bin/agy',
      "it's",
    ]);
  });
});

describe('resolveExecutable', () => {
  it('finds a command on PATH or checks an absolute path, and reports a missing one', async () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'devchain-resolve-'));
    try {
      writeFileSync(join(dir, 'tool'), '#!/bin/sh\n');
      chmodSync(join(dir, 'tool'), 0o755);
      writeFileSync(join(dir, 'plain'), '');
      await expect(resolveExecutable('tool', `/nonexistent:${dir}`)).resolves.toBe(
        join(dir, 'tool'),
      );
      await expect(resolveExecutable(join(dir, 'tool'), '')).resolves.toBe(join(dir, 'tool'));
      await expect(resolveExecutable('plain', dir)).resolves.toBeNull();
      await expect(resolveExecutable('missing', dir)).resolves.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('redactSecrets', () => {
  it('removes captured values and generic token shapes', () => {
    const text = `bad ${CODEX_REFRESH} and ${GH_TOKEN} and sk-${'x'.repeat(20)} end`;
    expect(redactSecrets(text, [CODEX_REFRESH])).toBe(
      'bad [redacted] and [redacted] and [redacted] end',
    );
  });
});
