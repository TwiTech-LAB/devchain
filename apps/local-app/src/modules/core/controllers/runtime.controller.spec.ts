import { homedir } from 'node:os';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetEnvConfig } from '../../../common/config/env.config';
import type { SyncthingManager, SyncthingState } from '../../file-sync/syncthing-manager.service';
import type { HostEnvOverrideReportStorage } from '../../remotes/host/host-env-override-report';
import { renderHostEnvFile } from '../../remotes/host/host-provider-auth.service';
import { RuntimeController } from './runtime.controller';
import { createMockProvider } from '../../../../test/factories';

const fileSyncState: SyncthingState = {
  available: false,
  version: null,
  running: false,
  deviceId: null,
  apiPort: null,
  error: 'Syncthing was not found on PATH or in ~/.devchain/bin.',
};

jest.mock('./host-cli-versions', () => ({ readHostCliVersions: () => null }));
jest.mock('./docker-runtime', () => ({
  readDockerRuntime: async () => ({
    installed: false,
    engineVersion: null,
    composeVersion: null,
    userInGroup: false,
    dataRootFreeBytes: null,
  }),
}));

function makeStorage(
  overrides: Partial<HostEnvOverrideReportStorage> = {},
): HostEnvOverrideReportStorage {
  return {
    listProviders: async () => ({ items: [], total: 0, limit: 100, offset: 0 }),
    listEnvScopesByProviderIds: () => new Map(),
    listAllProfileProviderConfigs: async () => [],
    listProjects: async () => ({ items: [], total: 0, limit: 100, offset: 0 }),
    ...overrides,
  } as HostEnvOverrideReportStorage;
}

const cliStatus = {
  desiredVersion: 'latest',
  installedVersion: null,
  state: 'idle',
  error: null,
  checkedAt: null,
};
const providerClis = { getStatus: () => cliStatus } as never;

describe('RuntimeController', () => {
  const originalEnv = process.env;
  let controller: RuntimeController;
  let claimDir: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    claimDir = mkdtempSync(join(tmpdir(), 'devchain-runtime-claim-'));
    process.env.DEVCHAIN_HOST_ETC_DIR = claimDir;
    delete process.env.HOST;
    delete process.env.DATABASE_URL;
    delete process.env.RUNTIME_TOKEN;
    delete process.env.DEVCHAIN_CLOUD_UI_ENABLED;
    resetEnvConfig();
    const syncthing = { getState: () => fileSyncState } as unknown as SyncthingManager;
    controller = new RuntimeController(syncthing, providerClis, makeStorage());
  });

  afterAll(() => {
    process.env = originalEnv;
    resetEnvConfig();
  });

  afterEach(() => rmSync(claimDir, { recursive: true, force: true }));

  // Filesystem-backed controller coverage proves projection of the real record;
  // process ids remain authoritative even when a record contains different ids.
  it.each(['ubuntu', null])(
    'reports requested ids and the actual conflict holder %p',
    async (holder) => {
      writeFileSync(
        join(claimDir, 'claim.json'),
        JSON.stringify({
          requestedUid: 501,
          requestedGid: 20,
          uid: 1999,
          gid: 2999,
          primaryGroup: 'dialout',
          uidConflict: { requestedUid: 501, holder },
          userName: 'alice',
        }),
      );
      expect(await controller.getRuntime()).toMatchObject({
        uid: process.getuid?.() ?? null,
        gid: process.getgid?.() ?? null,
        requestedUid: 501,
        requestedGid: 20,
        primaryGroup: 'dialout',
        uidConflict: { requestedUid: 501, holder },
      });
    },
  );

  it.each(['{}', '{invalid', '{"uidConflict":{"holder":42}}'])(
    'omits claim identity metadata for an old or unreadable record %s',
    async (record) => {
      writeFileSync(join(claimDir, 'claim.json'), record);
      const runtime = await controller.getRuntime();
      expect(runtime).not.toHaveProperty('requestedUid');
      expect(runtime).not.toHaveProperty('uidConflict');
      expect(runtime.uid).toBe(process.getuid?.() ?? null);
    },
  );

  it('returns version, bootId, features and admission for the local runtime', async () => {
    const result = await controller.getRuntime();

    expect(result).toEqual({
      version: expect.any(String),
      homePath: homedir(),
      uid: process.getuid?.(),
      gid: process.getgid?.(),
      bootId: expect.any(String),
      features: {
        cloudUi: true,
      },
      integrationAdmission: {
        allowed: true,
        reason: null,
      },
      fileSync: fileSyncState,
      cliVersions: null,
      providerClis: {
        claude: cliStatus,
        codex: cliStatus,
        copilot: cliStatus,
        opencode: cliStatus,
      },
      build: null,
      docker: {
        installed: false,
        engineVersion: null,
        composeVersion: null,
        userInGroup: false,
        dataRootFreeBytes: null,
      },
      providerEnvOverrides: [],
    });
  });

  it('returns the same bootId across multiple calls', async () => {
    const result1 = await controller.getRuntime();
    const result2 = await controller.getRuntime();

    expect(result1.bootId).toBe(result2.bootId);
    expect(typeof result1.bootId).toBe('string');
    expect(result1.bootId.length).toBeGreaterThan(0);
  });

  it('reports why integration operations are unavailable on a non-loopback host', async () => {
    process.env.HOST = '0.0.0.0';
    resetEnvConfig();

    const result = await controller.getRuntime();

    expect(result.integrationAdmission).toEqual({
      allowed: false,
      reason: 'non_loopback_host',
    });
  });

  it('includes runtimeToken when RUNTIME_TOKEN is set', async () => {
    process.env.RUNTIME_TOKEN = 'token-123';
    resetEnvConfig();

    const result = await controller.getRuntime();

    expect(result.runtimeToken).toBe('token-123');
  });

  it('reports stored keys overriding host.env logins, with names only and never values', async () => {
    const home = mkdtempSync(join(tmpdir(), 'devchain-runtime-report-'));
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    try {
      mkdirSync(join(home, '.devchain'), { recursive: true });
      writeFileSync(
        join(home, '.devchain', 'host.env'),
        renderHostEnvFile({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-host-secret-token-value' }),
      );
      const syncthing = { getState: () => fileSyncState } as unknown as SyncthingManager;
      controller = new RuntimeController(
        syncthing,
        providerClis,
        makeStorage({
          listProviders: async () => ({
            items: [
              createMockProvider({
                id: 'p-claude',
                name: 'claude',
                env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-shadow-secret-token-value' },
              }),
            ],
            total: 1,
            limit: 100,
            offset: 0,
          }),
        }),
      );

      const result = await controller.getRuntime();

      expect(result.providerEnvOverrides).toEqual([
        { key: 'CLAUDE_CODE_OAUTH_TOKEN', source: 'provider-env', provider: 'claude' },
      ]);
      expect(JSON.stringify(result)).not.toContain('sk-shadow-secret-token-value');
      expect(JSON.stringify(result)).not.toContain('sk-host-secret-token-value');
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
