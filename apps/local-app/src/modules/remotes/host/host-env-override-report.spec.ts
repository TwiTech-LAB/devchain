import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProfileProviderConfig, Project, Provider } from '../../storage/models/domain.models';
import { renderHostEnvFile } from './host-provider-auth.service';
import {
  buildHostEnvOverrideReport,
  readHostEnvOverrideReport,
  type HostEnvOverrideReportStorage,
} from './host-env-override-report';

// Layer: backend unit. The report is a pure join of rows the caller supplies;
// the reading wrapper is exercised against a temp home below.
function provider(overrides: Partial<Provider>): Provider {
  return {
    id: 'provider-1',
    name: 'claude',
    binPath: null,
    mcpConfigured: false,
    mcpEndpoint: null,
    mcpRegisteredAt: null,
    autoCompactThreshold: null,
    claudeLaunchSettingsJson: null,
    env: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function config(overrides: Partial<ProfileProviderConfig>): ProfileProviderConfig {
  return {
    id: 'config-1',
    profileId: 'profile-1',
    providerId: 'provider-1',
    name: 'Main config',
    description: null,
    options: null,
    env: null,
    model: null,
    effort: null,
    position: 0,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function project(id: string, name: string): Project {
  return {
    id,
    workspaceId: 'workspace-1',
    name,
    description: null,
    rootPath: `/tmp/${id}`,
    isTemplate: false,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
}

const HOST_ENV = {
  CLAUDE_CODE_OAUTH_TOKEN: 'host-token',
  COPILOT_GITHUB_TOKEN: 'host-gh',
  UNRELATED_HOST_KEY: 'host-value',
};

describe('buildHostEnvOverrideReport', () => {
  it('reports nothing when host.env holds no logins', () => {
    expect(
      buildHostEnvOverrideReport({
        hostEnv: {},
        providers: [provider({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'db-value' } })],
        envScopesByProvider: new Map(),
        configs: [],
        projects: [],
      }),
    ).toEqual([]);
  });

  it('reports an unscoped provider env key as overriding in every project', () => {
    const entries = buildHostEnvOverrideReport({
      hostEnv: HOST_ENV,
      providers: [
        provider({ id: 'p-claude', name: 'claude', env: { CLAUDE_CODE_OAUTH_TOKEN: 'db-value' } }),
      ],
      envScopesByProvider: new Map(),
      configs: [],
      projects: [],
    });
    expect(entries).toEqual([
      { key: 'CLAUDE_CODE_OAUTH_TOKEN', source: 'provider-env', provider: 'claude' },
    ]);
  });

  it('reports a scoped provider env key with its project names', () => {
    const entries = buildHostEnvOverrideReport({
      hostEnv: HOST_ENV,
      providers: [
        provider({
          id: 'p-claude',
          name: 'claude',
          env: { CLAUDE_CODE_OAUTH_TOKEN: 'db-value', OTHER_KEY: 'db-value' },
        }),
      ],
      envScopesByProvider: new Map([
        ['p-claude', { CLAUDE_CODE_OAUTH_TOKEN: ['project-b', 'project-a', 'project-b'] }],
      ]),
      configs: [],
      projects: [project('project-a', 'Alpha'), project('project-b', 'Beta')],
    });
    expect(entries).toEqual([
      {
        key: 'CLAUDE_CODE_OAUTH_TOKEN',
        source: 'provider-env-scoped',
        provider: 'claude',
        projects: ['Alpha', 'Beta'],
      },
    ]);
  });

  it('falls back to the project id when the scoped project is gone', () => {
    const entries = buildHostEnvOverrideReport({
      hostEnv: HOST_ENV,
      providers: [
        provider({ id: 'p-copilot', name: 'copilot', env: { COPILOT_GITHUB_TOKEN: 'x' } }),
      ],
      envScopesByProvider: new Map([['p-copilot', { COPILOT_GITHUB_TOKEN: ['deleted-project'] }]]),
      configs: [],
      projects: [],
    });
    expect(entries).toEqual([
      {
        key: 'COPILOT_GITHUB_TOKEN',
        source: 'provider-env-scoped',
        provider: 'copilot',
        projects: ['deleted-project'],
      },
    ]);
  });

  it('reports provider-config env keys with the config name and resolved provider', () => {
    const entries = buildHostEnvOverrideReport({
      hostEnv: HOST_ENV,
      providers: [provider({ id: 'p-claude', name: 'claude', env: null })],
      envScopesByProvider: new Map(),
      configs: [
        config({
          id: 'config-1',
          providerId: 'p-claude',
          name: 'Team login',
          env: { CLAUDE_CODE_OAUTH_TOKEN: 'config-value' },
        }),
        config({
          id: 'config-2',
          providerId: 'p-missing',
          providerName: 'copilot',
          name: 'Second login',
          env: { COPILOT_GITHUB_TOKEN: 'config-value' },
        }),
        config({ id: 'config-3', env: { UNRELATED_CONFIG_KEY: 'x' } }),
      ],
      projects: [],
    });
    expect(entries).toEqual([
      {
        key: 'CLAUDE_CODE_OAUTH_TOKEN',
        source: 'provider-config',
        provider: 'claude',
        config: 'Team login',
      },
      {
        key: 'COPILOT_GITHUB_TOKEN',
        source: 'provider-config',
        provider: 'copilot',
        config: 'Second login',
      },
    ]);
  });

  it('ignores stored keys that are not host.env logins and sorts deterministically', () => {
    const entries = buildHostEnvOverrideReport({
      hostEnv: HOST_ENV,
      providers: [
        provider({
          id: 'p-copilot',
          name: 'copilot',
          env: { COPILOT_GITHUB_TOKEN: 'x', IGNORED_KEY: 'x' },
        }),
        provider({ id: 'p-claude', name: 'claude', env: { CLAUDE_CODE_OAUTH_TOKEN: 'y' } }),
      ],
      envScopesByProvider: new Map(),
      configs: [config({ providerId: 'p-claude', name: 'Zed', env: { ALSO_IGNORED: 'z' } })],
      projects: [],
    });
    expect(entries.map(({ key, provider }) => `${key}:${provider}`)).toEqual([
      'CLAUDE_CODE_OAUTH_TOKEN:claude',
      'COPILOT_GITHUB_TOKEN:copilot',
    ]);
  });
});

describe('readHostEnvOverrideReport', () => {
  let home: string;
  let savedHome: string | undefined;
  let storage: {
    listProviders: jest.Mock;
    listEnvScopesByProviderIds: jest.Mock;
    listAllProfileProviderConfigs: jest.Mock;
    listProjects: jest.Mock;
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'devchain-override-report-'));
    savedHome = process.env.HOME;
    process.env.HOME = home;
    storage = {
      listProviders: jest.fn(),
      listEnvScopesByProviderIds: jest.fn().mockReturnValue(new Map()),
      listAllProfileProviderConfigs: jest.fn().mockResolvedValue([]),
      listProjects: jest.fn().mockResolvedValue({ items: [] }),
    };
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('answers empty without touching storage when there is no host.env', async () => {
    await expect(
      readHostEnvOverrideReport(storage as unknown as HostEnvOverrideReportStorage),
    ).resolves.toEqual([]);
    expect(storage.listProviders).not.toHaveBeenCalled();
  });

  it('joins host.env with the stored provider env', async () => {
    mkdirSync(join(home, '.devchain'), { recursive: true });
    writeFileSync(
      join(home, '.devchain', 'host.env'),
      renderHostEnvFile({ CLAUDE_CODE_OAUTH_TOKEN: 'host-token' }),
    );
    storage.listProviders.mockResolvedValue({
      items: [provider({ id: 'p-claude', name: 'claude', env: { CLAUDE_CODE_OAUTH_TOKEN: 'x' } })],
    });

    await expect(
      readHostEnvOverrideReport(storage as unknown as HostEnvOverrideReportStorage),
    ).resolves.toEqual([
      { key: 'CLAUDE_CODE_OAUTH_TOKEN', source: 'provider-env', provider: 'claude' },
    ]);
    expect(storage.listEnvScopesByProviderIds).toHaveBeenCalledWith(['p-claude']);
  });
});
