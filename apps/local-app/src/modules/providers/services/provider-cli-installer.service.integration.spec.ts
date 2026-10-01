import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
  chmod,
  readlink,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  PROVIDER_CLI_NAMES,
  PROVIDER_CLI_NPM_PACKAGES,
  type ProviderCliName,
  type ProviderCliVersionSettingsMap,
} from '@devchain/shared';
import { resetEnvConfig } from '../../../common/config/env.config';
import { resolveBinary } from '../../../common/resolve-binary';
import { ChildProcessExecutor } from '../../terminal/services/process-executor/child-process-executor';
import type {
  ProcessExecutor,
  ProcessExecutorOptions,
} from '../../terminal/services/process-executor/process-executor.port';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { SettingsService } from '../../settings/services/settings.service';
import type { Provider } from '../../storage/models/domain.models';
import type { ActiveSessionLookup } from '../../sessions/services/active-session-lookup.service';
import type { ProviderEffortSeedingService } from './provider-effort-seeding.service';
import type { ProviderProjectSyncService } from './provider-project-sync.service';
import { ProviderCliInstallStateService } from './provider-cli-install-state.service';
import {
  ProviderCliInstallerService,
  providerCliInstallArgs,
} from './provider-cli-installer.service';

jest.mock('../../../common/resolve-binary', () => ({ resolveBinary: jest.fn() }));
const resolve = jest.mocked(resolveBinary);
const success = {
  success: true,
  exitCode: 0,
  stdout: '',
  stderr: '',
  timedOut: false,
  truncated: false,
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Integration: real directories, symlinks, persistence and probe subprocesses expose
// activation/retention bugs that argv snapshots or an in-memory filesystem cannot.
describe('ProviderCliInstallerService', () => {
  let root: string;
  let savedEnv: NodeJS.ProcessEnv;
  let state: ProviderCliInstallStateService;
  let service: ProviderCliInstallerService;
  let settingsMap: ProviderCliVersionSettingsMap;
  let rows: Provider[];
  let sessions: { listRunningProviderSessions: jest.Mock };
  let seeding: { seedForProvider: jest.Mock };
  let sync: { syncProviderToAllProjects: jest.Mock };
  let storage: { listProviders: jest.Mock; createProvider: jest.Mock; updateProvider: jest.Mock };
  let executor: { run: jest.Mock };
  let install: (options: ProcessExecutorOptions) => Promise<typeof success>;
  const realExecutor = new ChildProcessExecutor();

  async function fixture(prefix: string, provider: ProviderCliName, version: string, exitCode = 0) {
    const pkg = join(prefix, 'lib/node_modules', PROVIDER_CLI_NPM_PACKAGES[provider]);
    await mkdir(pkg, { recursive: true });
    await writeFile(
      join(pkg, 'package.json'),
      JSON.stringify({ name: PROVIDER_CLI_NPM_PACKAGES[provider], version }),
    );
    await mkdir(join(prefix, 'bin'), { recursive: true });
    const binary = join(prefix, 'bin', provider);
    await writeFile(
      binary,
      `#!/bin/sh\necho 'provider-specific version output'\nexit ${exitCode}\n`,
    );
    await chmod(binary, 0o755);
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-provider-clis-'));
    savedEnv = { ...process.env };
    process.env.DEVCHAIN_HOST_ETC_DIR = join(root, 'etc');
    resetEnvConfig();
    state = new ProviderCliInstallStateService(join(root, 'provider-clis'));
    settingsMap = Object.fromEntries(
      PROVIDER_CLI_NAMES.map((provider) => [provider, { version: 'latest', homeManaged: false }]),
    ) as ProviderCliVersionSettingsMap;
    settingsMap.claude = { version: '1.0.0', homeManaged: true };
    rows = [{ id: 'claude-id', name: 'claude', binPath: '/own/claude' } as Provider];
    sessions = { listRunningProviderSessions: jest.fn().mockResolvedValue([]) };
    seeding = { seedForProvider: jest.fn().mockResolvedValue(undefined) };
    sync = { syncProviderToAllProjects: jest.fn().mockResolvedValue(undefined) };
    storage = {
      listProviders: jest.fn(async () => ({ items: rows })),
      createProvider: jest.fn(async (value) => {
        const row = { id: `${value.name}-id`, ...value };
        rows.push(row);
        return row;
      }),
      updateProvider: jest.fn(async (id, value) => {
        const row = rows.find((row) => row.id === id)!;
        Object.assign(row, value);
        return row;
      }),
    };
    install = async (options) => {
      const prefix = options.argv[options.argv.indexOf('--prefix') + 1];
      const spec = options.argv.at(-1)!;
      const provider = PROVIDER_CLI_NAMES.find((name) =>
        spec.startsWith(`${PROVIDER_CLI_NPM_PACKAGES[name]}@`),
      )!;
      await fixture(prefix, provider, spec.slice(spec.lastIndexOf('@') + 1));
      return success;
    };
    executor = {
      run: jest.fn(async (options: ProcessExecutorOptions) =>
        options.argv[1] === 'install' ? install(options) : realExecutor.run(options),
      ),
    };
    resolve.mockReset().mockResolvedValue('/fixture/npm');
    service = new ProviderCliInstallerService(
      state,
      {
        getProviderCliVersions: () => settingsMap,
        setProviderCliVersion: (
          provider: ProviderCliName,
          entry: ProviderCliVersionSettingsMap[ProviderCliName],
        ) => {
          settingsMap[provider] = entry;
          return entry;
        },
      } as SettingsService,
      executor as unknown as ProcessExecutor,
      storage as unknown as StorageService,
      sessions as unknown as ActiveSessionLookup,
      seeding as unknown as ProviderEffortSeedingService,
      sync as unknown as ProviderProjectSyncService,
    );
    await service.onModuleInit();
  });

  afterEach(async () => {
    process.env = savedEnv;
    resetEnvConfig();
    await rm(root, { recursive: true, force: true });
  });

  it('installs exact packages in versioned folders, switches atomically and persists only local recovery paths', async () => {
    await service.reconcile('claude', null);
    expect(await readlink(state.link('claude'))).toBe(
      join(state.directory('claude'), '1.0.0/bin/claude'),
    );
    expect(rows[0].binPath).toBe(state.link('claude'));
    expect(service.getStatus('claude')).toMatchObject({
      installedVersion: '1.0.0',
      state: 'idle',
      error: null,
    });
    expect(new ProviderCliInstallStateService(state.root).read('claude').originalBinPath).toBe(
      '/own/claude',
    );
    expect(service.getStatus('claude')).not.toHaveProperty('originalBinPath');
    expect(executor.run.mock.calls[0][0]).toMatchObject({
      mode: 'pipe',
      cwd: expect.stringContaining('.staging-'),
    });
    expect(resolve.mock.calls[0][0]).toMatch(/\/npm$/);
    expect(executor.run.mock.calls[1][0].env.DISABLE_AUTOUPDATER).toBe('1');
    const installs = executor.run.mock.calls.filter(
      ([options]) => options.argv[1] === 'install',
    ).length;
    await service.reconcile('claude', null);
    expect(
      executor.run.mock.calls.filter(([options]) => options.argv[1] === 'install'),
    ).toHaveLength(installs);
  });

  it('falls back to PATH when the npm sibling of Node is absent', async () => {
    resolve.mockResolvedValueOnce(null).mockResolvedValueOnce('/fixture/npm');
    await service.reconcile('claude', null);
    expect(resolve.mock.calls[1][0]).toBe('npm');
    expect(service.getStatus('claude').installedVersion).toBe('1.0.0');
  });

  it('does not activate a download that finishes after application shutdown', async () => {
    const started = deferred();
    const gate = deferred();
    const originalInstall = install;
    install = async (options) => {
      started.resolve();
      await gate.promise;
      return originalInstall(options);
    };
    const job = service.reconcile('claude', null);
    await started.promise;
    service.onModuleDestroy();
    gate.resolve();
    await job;
    expect(existsSync(state.link('claude'))).toBe(false);
    expect(storage.updateProvider).not.toHaveBeenCalled();
  });

  it('creates a missing provider and seeds efforts and project configs', async () => {
    rows = [];
    await service.reconcile('claude', null);
    expect(storage.createProvider).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'claude', binPath: state.link('claude') }),
    );
    expect(seeding.seedForProvider).toHaveBeenCalledWith(rows[0]);
    expect(sync.syncProviderToAllProjects).toHaveBeenCalledWith(rows[0].id);
    expect(state.read('claude').originalBinPath).toBeNull();
  });

  it.each(['network', 'version mismatch', 'probe failure', 'missing npm'])(
    'keeps the working link and row on %s',
    async (failure) => {
      await service.reconcile('claude', null);
      const original = await readlink(state.link('claude'));
      settingsMap.claude.version = '2.0.0';
      if (failure === 'missing npm') resolve.mockResolvedValue(null);
      else
        install = async (options) => {
          if (failure === 'network') return { ...success, success: false, exitCode: 1 };
          await fixture(
            options.cwd!,
            'claude',
            failure === 'version mismatch' ? '9.9.9' : '2.0.0',
            failure === 'probe failure' ? 1 : 0,
          );
          return success;
        };
      await service.reconcile('claude', null);
      expect(await readlink(state.link('claude'))).toBe(original);
      expect(rows[0].binPath).toBe(state.link('claude'));
      expect(service.getStatus('claude')).toMatchObject({
        installedVersion: '1.0.0',
        state: 'failed',
        error: expect.any(String),
      });
      if (failure === 'missing npm')
        expect(service.getStatus('claude').error).toBe('npm not found; stays on own install');
      expect(
        (await readdir(state.directory('claude'))).filter((name) => name.startsWith('.staging-')),
      ).toEqual([]);
    },
  );

  it('rolls back the link if the provider-row mutation fails', async () => {
    await service.reconcile('claude', null);
    const oldLink = await readlink(state.link('claude'));
    settingsMap.claude.version = '2.0.0';
    storage.updateProvider.mockRejectedValueOnce(new Error('database unavailable'));
    await service.reconcile('claude', null);
    expect(await readlink(state.link('claude'))).toBe(oldLink);
    expect(service.getStatus('claude')).toMatchObject({
      state: 'failed',
      installedVersion: '1.0.0',
    });
  });

  it('re-reads the policy after an awaited provider lookup, immediately before activation', async () => {
    const activation = deferred();
    const gate = deferred();
    storage.listProviders
      .mockResolvedValueOnce({ items: rows })
      .mockImplementationOnce(async () => {
        activation.resolve();
        await gate.promise;
        return { items: rows };
      });
    const job = service.reconcile('claude', null);
    await activation.promise;
    settingsMap.claude.homeManaged = false;
    gate.resolve();
    await job;
    expect(storage.updateProvider).not.toHaveBeenCalled();
    expect(existsSync(state.link('claude'))).toBe(false);
  });

  it('never activates a superseded install and serializes npm jobs', async () => {
    const started = deferred();
    const gate = deferred();
    const originalInstall = install;
    let concurrent = 0;
    let peak = 0;
    install = async (options) => {
      peak = Math.max(peak, ++concurrent);
      if (options.argv.at(-1)?.endsWith('@1.0.0')) {
        started.resolve();
        await gate.promise;
      }
      const result = await originalInstall(options);
      concurrent--;
      return result;
    };
    const first = service.reconcile('claude', null);
    await started.promise;
    settingsMap.claude.version = '2.0.0';
    await service.policyChanged('claude');
    const second = service.reconcile('claude', null);
    gate.resolve();
    await Promise.all([first, second]);
    expect(peak).toBe(1);
    expect(storage.updateProvider).toHaveBeenCalledTimes(1);
    expect(service.getStatus('claude').installedVersion).toBe('2.0.0');
    expect(await readlink(state.link('claude'))).toContain('/2.0.0/');
  });

  it.each(['/own/claude', null])(
    'restores the saved path %s when opting out during npm work',
    async (ownPath) => {
      rows[0].binPath = ownPath;
      await service.reconcile('claude', null);
      const gate = deferred();
      const started = deferred();
      const originalInstall = install;
      install = async (options) => {
        started.resolve();
        await gate.promise;
        return originalInstall(options);
      };
      settingsMap.claude.version = '2.0.0';
      const job = service.reconcile('claude', null);
      await started.promise;
      settingsMap.claude.homeManaged = false;
      await service.policyChanged('claude');
      expect(rows[0].binPath).toBe(ownPath);
      gate.resolve();
      await job;
      expect(rows[0].binPath).toBe(ownPath);
      expect(service.getStatus('claude').installedVersion).toBe('1.0.0');
      expect(await readlink(state.link('claude'))).toContain('/1.0.0/');
    },
  );

  it('treats a Binary Path edit as own-install policy and fences the pending download', async () => {
    const started = deferred();
    const gate = deferred();
    const originalInstall = install;
    install = async (options) => {
      started.resolve();
      await gate.promise;
      return originalInstall(options);
    };
    const job = service.reconcile('claude', null);
    await started.promise;
    await service.editBinaryPath('claude', '/custom/claude', () =>
      storage.updateProvider('claude-id', { binPath: '/custom/claude' }),
    );
    gate.resolve();
    await job;
    expect(settingsMap.claude.homeManaged).toBe(false);
    expect(rows[0].binPath).toBe('/custom/claude');
    expect(existsSync(state.link('claude'))).toBe(false);
  });

  it('retains all versions while this provider runs, then keeps active and previous', async () => {
    for (const version of ['1.0.0', '2.0.0', '3.0.0']) {
      settingsMap.claude.version = version;
      sessions.listRunningProviderSessions.mockResolvedValue([{ providerNameAtLaunch: 'claude' }]);
      await service.reconcile('claude', null);
    }
    expect(existsSync(join(state.directory('claude'), '1.0.0/bin/claude'))).toBe(true);
    sessions.listRunningProviderSessions.mockResolvedValue([{ providerNameAtLaunch: null }]);
    await service.reconcile('claude', null);
    expect(existsSync(join(state.directory('claude'), '1.0.0'))).toBe(true);
    sessions.listRunningProviderSessions.mockResolvedValue([{ providerNameAtLaunch: 'codex' }]);
    await service.reconcile('claude', null);
    expect(existsSync(join(state.directory('claude'), '1.0.0'))).toBe(false);
    for (const version of ['2.0.0', '3.0.0'])
      expect(existsSync(join(state.directory('claude'), version))).toBe(true);
  });

  it('cleans abandoned staging and recovers installing status at startup', async () => {
    const other = new ProviderCliInstallStateService(join(root, 'abandoned'));
    await mkdir(join(other.directory('claude'), '.staging-old'), { recursive: true });
    other.write('claude', { ...other.read('claude'), state: 'installing' });
    const restarted = new ProviderCliInstallerService(
      other,
      {} as SettingsService,
      executor as unknown as ProcessExecutor,
      storage as unknown as StorageService,
      sessions as unknown as ActiveSessionLookup,
      seeding as unknown as ProviderEffortSeedingService,
      sync as unknown as ProviderProjectSyncService,
    );
    await restarted.onModuleInit();
    expect(existsSync(join(other.directory('claude'), '.staging-old'))).toBe(false);
    expect(other.read('claude').state).toBe('idle');
  });

  it('runs on a claimed VM even when homeManaged is false, and applies Codex probe flags', async () => {
    await mkdir(process.env.DEVCHAIN_HOST_ETC_DIR!, { recursive: true });
    await writeFile(join(process.env.DEVCHAIN_HOST_ETC_DIR!, 'claim.json'), '{}');
    settingsMap.codex = { version: 'latest', homeManaged: false };
    await service.reconcile('codex', '4.0.0');
    expect(service.getStatus('codex').installedVersion).toBe('4.0.0');
    expect(
      executor.run.mock.calls.some(
        ([options]) =>
          options.argv.slice(1).join(' ') === '-c check_for_update_on_startup=false --version',
      ),
    ).toBe(true);
  });

  it('rejects unsupported providers and non-exact versions before building install arguments', () => {
    expect(() => providerCliInstallArgs('agy' as ProviderCliName, '1.0.0', root)).toThrow();
    for (const version of ['latest', '../escape', '1.0.0-beta', '1.0.0;echo x'])
      expect(() => providerCliInstallArgs('claude', version, root)).toThrow();
  });
  it('real npm honors scripts and optional dependencies over inherited config, preserving userconfig', async () => {
    const npm = join(dirname(process.execPath), 'npm');
    const optionalDir = join(root, 'optional');
    const mainDir = join(root, 'main');
    const optionalTar = join(root, 'optional.tgz');
    const mainTar = join(root, 'main.tgz');
    for (const dir of [optionalDir, mainDir])
      await mkdir(join(dir, 'package'), { recursive: true });
    await writeFile(
      join(optionalDir, 'package/package.json'),
      JSON.stringify({
        name: '@anthropic-ai/fixture-platform',
        version: '1.0.0',
        main: 'index.js',
      }),
    );
    await writeFile(
      join(optionalDir, 'package/index.js'),
      'module.exports = "platform-installed";',
    );
    const packedOptional = await realExecutor.run({
      argv: ['tar', '-czf', optionalTar, '-C', optionalDir, 'package'],
      mode: 'pipe',
    });
    expect(packedOptional.success).toBe(true);
    await writeFile(
      join(mainDir, 'package/package.json'),
      JSON.stringify({
        name: '@anthropic-ai/claude-code',
        version: '1.0.0',
        optionalDependencies: { '@anthropic-ai/fixture-platform': `file:${optionalTar}` },
        scripts: { postinstall: 'node postinstall.js' },
      }),
    );
    await writeFile(
      join(mainDir, 'package/postinstall.js'),
      `require('fs').writeFileSync('installed.txt', require('@anthropic-ai/fixture-platform') + ':' + process.env.npm_config_userconfig);`,
    );
    expect(
      (
        await realExecutor.run({
          argv: ['tar', '-czf', mainTar, '-C', mainDir, 'package'],
          mode: 'pipe',
        })
      ).success,
    ).toBe(true);
    const userconfig = join(root, 'user.npmrc');
    await writeFile(
      userconfig,
      'ignore-scripts=true\noptional=false\n@anthropic-ai:registry=http://127.0.0.1:1/\n',
    );
    const prefix = join(root, 'npm-fixture');
    const args = providerCliInstallArgs('claude', '1.0.0', prefix);
    expect(args.at(-1)).toBe('@anthropic-ai/claude-code@1.0.0');
    for (const scope of ['@anthropic-ai', '@openai', '@github'])
      expect(args).toContain(`--${scope}:registry=https://registry.npmjs.org/`);
    expect(args.some((arg) => arg.startsWith('--userconfig'))).toBe(false);
    // Supply local package bytes so the real npm precedence check stays offline.
    args[args.length - 1] = mainTar;
    const result = await realExecutor.run({
      argv: [npm, ...args],
      cwd: root,
      mode: 'pipe',
      timeout: 30_000,
      env: {
        PATH: process.env.PATH!,
        HOME: root,
        npm_config_userconfig: userconfig,
        npm_config_ignore_scripts: 'true',
        npm_config_optional: 'false',
        npm_config_registry: 'http://127.0.0.1:1/',
        npm_config_update_notifier: 'false',
      },
    });
    expect({ code: result.exitCode, error: result.stderr }).toMatchObject({ code: 0 });
    expect(
      await readFile(
        join(prefix, 'lib/node_modules/@anthropic-ai/claude-code/installed.txt'),
        'utf8',
      ),
    ).toBe(`platform-installed:${userconfig}`);
  });
});
