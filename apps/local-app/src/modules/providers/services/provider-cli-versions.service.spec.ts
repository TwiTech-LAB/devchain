import { resetEnvConfig } from '../../../common/config/env.config';
import type { ProviderCliInstallerService } from './provider-cli-installer.service';
import {
  PROVIDER_CLI_CHECK_INTERVAL_MS,
  ProviderCliVersionsService,
} from './provider-cli-versions.service';
import { ProviderCliNpmLookupService } from './provider-cli-npm-lookup.service';
import type { SettingsService } from '../../settings/services/settings.service';
import type { ProviderCliName } from '@devchain/shared';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (e: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createLookupMock() {
  return {
    fetchLatestVersion: jest.fn<Promise<string>, [string]>(),
    fetchStableVersions: jest.fn<Promise<string[]>, [string, number?]>(),
  } as unknown as jest.Mocked<ProviderCliNpmLookupService>;
}

function createSettingsMock() {
  return {
    getProviderCliVersions: jest.fn(),
    setProviderCliVersion: jest.fn(),
  } as unknown as jest.Mocked<SettingsService>;
}

function defaultSettingsMap() {
  return {
    claude: { version: 'latest', homeManaged: false },
    codex: { version: 'latest', homeManaged: false },
    copilot: { version: 'latest', homeManaged: false },
    opencode: { version: 'latest', homeManaged: false },
  };
}

/**
 * Unit layer: the scheduler is a timer/orchestration contract around two
 * injected dependencies; fake timers plus deferred promises observe it without
 * a real clock, registry, or database.
 */
describe('ProviderCliVersionsService', () => {
  let lookup: ReturnType<typeof createLookupMock>;
  let settings: ReturnType<typeof createSettingsMock>;
  let service: ProviderCliVersionsService;
  let installer: {
    getStatus: jest.Mock;
    reconcile: jest.Mock;
    policyChanged: jest.Mock;
    isHost: jest.Mock;
  };

  beforeEach(() => {
    // The backend test setup turns the scheduled checks off; this suite tests them.
    process.env.PROVIDER_CLI_CHECKS_ENABLED = 'true';
    resetEnvConfig();
    lookup = createLookupMock();
    settings = createSettingsMock();
    settings.getProviderCliVersions.mockReturnValue(defaultSettingsMap());
    installer = {
      getStatus: jest.fn().mockReturnValue(null),
      reconcile: jest.fn().mockResolvedValue(undefined),
      policyChanged: jest.fn().mockResolvedValue(undefined),
      isHost: jest.fn().mockReturnValue(false),
    };
    service = new ProviderCliVersionsService(
      lookup,
      settings,
      installer as unknown as ProviderCliInstallerService,
    );
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
  });

  function stubAllProviders(latest: string, versions: string[] = [latest]) {
    lookup.fetchLatestVersion.mockResolvedValue(latest);
    lookup.fetchStableVersions.mockResolvedValue(versions);
  }

  describe('startup', () => {
    it('starts a check at module init without blocking startup on it', async () => {
      jest.useFakeTimers();
      const gate = deferred<string>();
      lookup.fetchLatestVersion.mockReturnValue(gate.promise);
      lookup.fetchStableVersions.mockResolvedValue([]);

      service.onModuleInit();

      // Init returned while the check is still pending: startup never waits.
      expect(lookup.fetchLatestVersion).toHaveBeenCalledTimes(4);
      gate.resolve('2.1.281');
      await flushMicrotasks();
      expect(service.getLookup('claude')?.latestVersion).toBe('2.1.281');
    });

    it('records a network failure instead of throwing during the startup check', async () => {
      jest.useFakeTimers();
      lookup.fetchLatestVersion.mockRejectedValue(new Error('ENOTFOUND registry.npmjs.org'));
      lookup.fetchStableVersions.mockRejectedValue(new Error('ENOTFOUND registry.npmjs.org'));

      service.onModuleInit();
      await flushMicrotasks();

      const result = service.getLookup('claude');
      expect(result?.error).toBe('ENOTFOUND registry.npmjs.org');
      expect(result?.latestVersion).toBeNull();
      expect(result?.versions).toEqual([]);
      expect(result?.checkedAt).not.toBeNull();
    });
  });

  describe('PROVIDER_CLI_CHECKS_ENABLED=false', () => {
    it('starts no check and no timer, and still checks on demand', async () => {
      jest.useFakeTimers();
      process.env.PROVIDER_CLI_CHECKS_ENABLED = 'false';
      resetEnvConfig();
      stubAllProviders('1.0.0', ['1.0.0']);

      service.onModuleInit();
      jest.advanceTimersByTime(PROVIDER_CLI_CHECK_INTERVAL_MS);
      await flushMicrotasks();
      expect(lookup.fetchLatestVersion).not.toHaveBeenCalled();

      await service.checkNow();
      expect(lookup.fetchLatestVersion).toHaveBeenCalledTimes(4);
    });
  });

  describe('interval', () => {
    it('checks again every 6 hours and not before', async () => {
      jest.useFakeTimers();
      stubAllProviders('1.0.0', ['1.0.0']);
      service.onModuleInit();
      await flushMicrotasks();
      expect(lookup.fetchLatestVersion).toHaveBeenCalledTimes(4);

      jest.advanceTimersByTime(PROVIDER_CLI_CHECK_INTERVAL_MS - 1);
      await flushMicrotasks();
      expect(lookup.fetchLatestVersion).toHaveBeenCalledTimes(4);

      jest.advanceTimersByTime(1);
      await flushMicrotasks();
      expect(lookup.fetchLatestVersion).toHaveBeenCalledTimes(8);
    });

    it('stops checking after onModuleDestroy', async () => {
      jest.useFakeTimers();
      stubAllProviders('1.0.0', ['1.0.0']);
      service.onModuleInit();
      await flushMicrotasks();

      service.onModuleDestroy();
      jest.advanceTimersByTime(PROVIDER_CLI_CHECK_INTERVAL_MS * 3);
      await flushMicrotasks();
      expect(lookup.fetchLatestVersion).toHaveBeenCalledTimes(4);
    });
  });

  describe('checkNow', () => {
    it('runs at once and returns fresh results for every provider', async () => {
      stubAllProviders('2.1.281', ['2.1.281', '2.1.280']);
      const results = await service.checkNow();

      expect(Object.keys(results).sort()).toEqual(['claude', 'codex', 'copilot', 'opencode']);
      expect(results.claude).toEqual({
        latestVersion: '2.1.281',
        versions: ['2.1.281', '2.1.280'],
        checkedAt: expect.any(String),
        error: null,
      });
    });

    it('reuses an in-flight run instead of issuing duplicate registry requests', async () => {
      const gate = deferred<string>();
      lookup.fetchLatestVersion.mockReturnValue(gate.promise);
      lookup.fetchStableVersions.mockResolvedValue([]);

      const first = service.checkNow();
      const second = service.checkNow();
      expect(lookup.fetchLatestVersion).toHaveBeenCalledTimes(4);

      gate.resolve('1.2.3');
      const [a, b] = await Promise.all([first, second]);
      expect(a).toEqual(b);
    });

    it('isolates a single provider failure: the others still record results', async () => {
      lookup.fetchLatestVersion.mockImplementation(async (npmPackage: string) => {
        if (npmPackage === '@openai/codex') throw new Error('boom');
        return '1.0.0';
      });
      lookup.fetchStableVersions.mockResolvedValue(['1.0.0']);

      const results = await service.checkNow();
      expect(results.codex.error).toBe('boom');
      expect(results.claude.error).toBeNull();
      expect(results.claude.latestVersion).toBe('1.0.0');
    });

    it('a failed check keeps the last successful versions and stamps checkedAt', async () => {
      lookup.fetchLatestVersion.mockResolvedValueOnce('1.1.0');
      lookup.fetchStableVersions.mockResolvedValueOnce(['1.1.0']);
      await service.checkNow();

      lookup.fetchLatestVersion.mockRejectedValue(new Error('offline'));
      lookup.fetchStableVersions.mockRejectedValue(new Error('offline'));
      const second = await service.checkNow();

      expect(second.claude.error).toBe('offline');
      expect(second.claude.latestVersion).toBe('1.1.0');
      expect(second.claude.versions).toEqual(['1.1.0']);
    });

    it('keeps the fresh latest version when only the version list fails', async () => {
      stubAllProviders('1.1.0', ['1.1.0', '1.0.0']);
      await service.checkNow();

      lookup.fetchLatestVersion.mockResolvedValue('1.2.0');
      lookup.fetchStableVersions.mockRejectedValue(new Error('timed out'));
      const second = await service.checkNow();

      expect(second.claude).toEqual({
        latestVersion: '1.2.0',
        versions: ['1.1.0', '1.0.0'],
        checkedAt: expect.any(String),
        error: null,
      });
      expect(installer.reconcile).toHaveBeenLastCalledWith('opencode', '1.2.0');
    });

    it('fetches only the latest version on a claimed VM', async () => {
      installer.isHost.mockReturnValue(true);
      lookup.fetchLatestVersion.mockResolvedValue('1.2.0');

      const results = await service.checkNow();

      expect(lookup.fetchStableVersions).not.toHaveBeenCalled();
      expect(results.claude).toMatchObject({ latestVersion: '1.2.0', versions: [], error: null });
    });
  });

  describe('getOverview', () => {
    it('combines the stored setting, the lookup result and a null install status', async () => {
      settings.getProviderCliVersions.mockReturnValue({
        ...defaultSettingsMap(),
        claude: { version: '2.1.281', homeManaged: true },
      });
      stubAllProviders('2.1.281', ['2.1.281']);
      await service.checkNow();

      const overview = service.getOverview();
      expect(overview.providers.claude).toEqual({
        provider: 'claude',
        npmPackage: '@anthropic-ai/claude-code',
        setting: { version: '2.1.281', homeManaged: true },
        lookup: {
          latestVersion: '2.1.281',
          versions: ['2.1.281'],
          checkedAt: expect.any(String),
          error: null,
        },
        install: null,
      });
      expect(overview.providers.opencode.npmPackage).toBe('opencode-ai');
      expect(overview.providers.codex.setting).toEqual({
        version: 'latest',
        homeManaged: false,
      });
    });

    it('returns a null lookup before the first check completes', () => {
      const overview = service.getOverview();
      for (const provider of ['claude', 'codex', 'copilot', 'opencode'] as ProviderCliName[]) {
        expect(overview.providers[provider].lookup).toBeNull();
      }
    });
  });

  it('hands successful targets to the installer without awaiting downloads', async () => {
    stubAllProviders('1.2.3');
    installer.reconcile.mockReturnValue(new Promise(() => undefined));
    await service.checkNow();
    expect(installer.reconcile).toHaveBeenCalledWith('claude', '1.2.3');
    const status = {
      desiredVersion: 'latest',
      installedVersion: '1.0.0',
      state: 'installing',
      error: null,
      checkedAt: null,
    };
    installer.getStatus.mockReturnValue(status);
    expect(service.getOverview().providers.claude.install).toEqual(status);
  });

  describe('setVersion', () => {
    it('delegates validation and persistence then immediately fences installer work', async () => {
      settings.setProviderCliVersion.mockReturnValue({ version: '0.156.1', homeManaged: true });

      const entry = await service.setVersion('codex', { version: '0.156.1', homeManaged: true });

      expect(settings.setProviderCliVersion).toHaveBeenCalledWith('codex', {
        version: '0.156.1',
        homeManaged: true,
      });
      expect(entry).toEqual({ version: '0.156.1', homeManaged: true });
      expect(installer.policyChanged).toHaveBeenCalledWith('codex');
    });

    it('checks the registry after a save only when the provider has no latest version', async () => {
      settings.setProviderCliVersion.mockReturnValue({ version: 'latest', homeManaged: true });
      lookup.fetchLatestVersion.mockRejectedValueOnce(new Error('offline'));
      lookup.fetchLatestVersion.mockResolvedValue('1.2.0');
      lookup.fetchStableVersions.mockResolvedValue(['1.2.0']);
      const failed = await service.checkNow();
      expect(failed.claude.latestVersion).toBeNull();
      lookup.fetchLatestVersion.mockClear();

      await service.setVersion('codex', { version: 'latest', homeManaged: true });
      expect(lookup.fetchLatestVersion).not.toHaveBeenCalled();

      await service.setVersion('claude', { version: 'latest', homeManaged: true });
      await flushMicrotasks();
      expect(lookup.fetchLatestVersion).toHaveBeenCalledTimes(4);
    });
  });
});

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}
