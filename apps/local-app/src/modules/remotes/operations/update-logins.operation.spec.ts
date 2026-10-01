import { RemoteApiKeyService } from '../auth/remote-api-key.service';
import { Test } from '@nestjs/testing';
import { NotFoundError } from '../../../common/errors/error-types';
import { fixtureTls } from '../../../common/test/tls-fixture';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { ProviderAuthVaultService } from '../../provider-auth/provider-auth-vault.service';
import { PROVIDER_AUTH_ADAPTERS } from '../../provider-auth/provider-auth-adapters';
import { ProviderAuthWritebackService } from '../../provider-auth/provider-auth-writeback.service';
import { ProviderAuthGeneratorService } from '../../provider-auth/provider-auth-generator.service';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { REMOTE_HEALTH_PORT } from '../ports/remote-health.port';
import { ClaimOperation } from './claim.operation';
import { RemoteHostClient } from './remote-host.client';
import { UpdateLoginsOperation, type UpdateLoginsDetails } from './update-logins.operation';
import type { RemoteOperation } from '../../storage/models/domain.models';

jest.mock('../transport/remote-tls', () => ({
  ...jest.requireActual('../transport/remote-tls'),
  remoteFetch: (url: string, init: RequestInit) => globalThis.fetch(url, init),
}));

// Unit composition keeps the real claim steps while isolating credential/network side effects.
describe('UpdateLoginsOperation', () => {
  let definition: UpdateLoginsOperation;
  let details: UpdateLoginsDetails;
  let operation: RemoteOperation;
  let held: Map<string, string>;
  const entries: Record<string, { provider: string; kind: string }> = {
    old: { provider: 'codex', kind: 'family' },
    fresh: { provider: 'codex', kind: 'family' },
    third: { provider: 'codex', kind: 'family' },
    token: { provider: 'claude', kind: 'static' },
    replacement: { provider: 'claude', kind: 'static' },
    oc1: { provider: 'opencode', kind: 'family' },
    oc2: { provider: 'opencode', kind: 'family' },
    ocGroup: { provider: 'opencode', kind: 'static' },
  };
  const storage = {
    listRemoteOperations: jest.fn(),
    getRemote: jest.fn(),
    updateRemoteOperation: jest.fn(),
    readProviderAuthPayload: jest.fn(),
  };
  const host = {
    remoteRuntime: jest.fn(),
    applyProviderAuth: jest.fn(),
    verifyProviderAuth: jest.fn(),
  };
  const writeback = { pause: jest.fn(), resume: jest.fn(), pullFamiliesNow: jest.fn() };
  const vault = {
    get: jest.fn(),
    familiesOfRemote: jest.fn(),
    release: jest.fn(),
    checkout: jest.fn(),
    buildClaimBundle: jest.fn(),
    opencodeProviderIds: jest.fn(),
  };
  const generator = { cancel: jest.fn() };
  let fetchMock: jest.SpyInstance;
  let apiKeys: RemoteApiKeyService;
  const run = async (id: string) => {
    const step = definition.steps.find((step) => step.id === id)!;
    await step.run({
      operation,
      details: details as unknown as Record<string, unknown>,
      progress: async () => undefined,
    });
  };
  const all = async () => {
    for (const step of definition.steps) await run(step.id);
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    held = new Map([['old', 'remote']]);
    details = {
      bootstrapUrl: '',
      userName: 'dev',
      homePath: '/home/dev',
      version: '1.0.0',
      port: 3000,
      claimed: true,
      force: false,
      changedProviders: ['codex'],
      reauth: ['codex'],
      previousProviderAuth: {
        codex: { choice: 'reuse', entryId: 'old', entryIds: ['old'], checkedOut: ['old'] },
      },
      providerAuth: {
        codex: { choice: 'reuse', entryId: 'fresh', checkedOut: ['old'] },
        claude: { choice: 'reuse', entryId: 'deleted' },
      },
    };
    details.previousProviderAuth.claude = { choice: 'reuse', entryId: 'deleted' };
    operation = {
      id: 'operation',
      remoteId: 'remote',
      kind: 'update_logins',
      state: 'running',
      details,
      steps: [],
    } as unknown as RemoteOperation;
    storage.listRemoteOperations.mockResolvedValue([]);
    storage.getRemote.mockResolvedValue({
      id: 'remote',
      baseUrl: 'https://host',
      name: 'host',
      tlsCertificate: fixtureTls.cert,
    });
    storage.updateRemoteOperation.mockImplementation(async (_id, patch) => ({
      ...operation,
      ...patch,
    }));
    storage.readProviderAuthPayload.mockImplementation(async (id: string) => {
      if (id === 'deleted') throw new NotFoundError('entry', id);
      return id === 'token' || id === 'replacement'
        ? { payloadKind: 'env', envKey: id === 'token' ? 'OLD_KEY' : 'NEW_KEY', value: 'secret' }
        : { payloadKind: 'files', content: '{}' };
    });
    host.remoteRuntime.mockResolvedValue({ version: '1.0.0' });
    host.verifyProviderAuth.mockResolvedValue({ ok: true });
    writeback.pullFamiliesNow.mockResolvedValue({ pulled: true });
    vault.get.mockImplementation(async (id: string) => ({
      id,
      label: id,
      ...entries[id],
      checkedOutRemoteId: held.get(id) ?? null,
    }));
    vault.familiesOfRemote.mockImplementation(async () =>
      [...held]
        .filter(([, remote]) => remote === 'remote')
        .map(([entryId]) => ({ entryId, provider: entries[entryId].provider })),
    );
    vault.release.mockImplementation(async (id: string) => {
      held.delete(id);
    });
    vault.checkout.mockImplementation(async (id: string, remote: string) => {
      held.set(id, remote);
    });
    vault.opencodeProviderIds.mockImplementation(async (ids) => ids);
    vault.buildClaimBundle.mockImplementation(
      async ({ entryIds, homePath }: { entryIds: string[]; homePath: string }) => ({
        env: entryIds.includes('replacement') ? { NEW_KEY: 'secret' } : {},
        files: entryIds
          .filter((id) => entries[id]?.kind === 'family')
          .map((id) => ({
            path: `${homePath}/${entries[id].provider === 'opencode' ? '.local/share/opencode/auth.json' : '.codex/auth.json'}`,
            mode: '0600',
            contentBase64: Buffer.from(id).toString('base64'),
          })),
      }),
    );
    fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue({ ok: true, json: async () => [] } as unknown as Response);
    let key = 'first';
    apiKeys = new RemoteApiKeyService({
      readRemoteApiKey: async () => key,
      saveRemoteApiKey: async (_id: string, value: string) => {
        key = value;
      },
    } as never);
    const module = await Test.createTestingModule({
      providers: [
        { provide: RemoteApiKeyService, useValue: apiKeys },
        UpdateLoginsOperation,
        ClaimOperation,
        { provide: STORAGE_SERVICE, useValue: storage },
        { provide: RemoteHostClient, useValue: host },
        { provide: ProviderAuthVaultService, useValue: vault },
        { provide: ProviderAuthWritebackService, useValue: writeback },
        { provide: ProviderAuthGeneratorService, useValue: generator },
        { provide: ProcessExecutor, useValue: {} },
        { provide: REMOTE_HEALTH_PORT, useValue: {} },
      ],
    }).compile();
    definition = module.get(UpdateLoginsOperation);
  });
  afterEach(() => fetchMock.mockRestore());

  it('checks sessions with the current key, including after replacement', async () => {
    await run('preflight');
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.stringContaining('/api/sessions'),
      expect.objectContaining({ headers: { authorization: 'Bearer first' } }),
    );
    await apiKeys.save(operation.remoteId, 'second');
    await run('preflight');
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.stringContaining('/api/sessions'),
      expect.objectContaining({ headers: { authorization: 'Bearer second' } }),
    );
  });

  it('orders the handover and changes only requested providers, tolerating a deleted unchanged entry', async () => {
    expect(definition.steps.map((step) => step.id)).toEqual([
      'preflight',
      'pull_families',
      'release_replaced',
      'provider_auth_resolve',
      'build_bundle',
      'claim',
      'remove_dropped',
      'verify_providers',
    ]);
    await all();
    expect(vault.buildClaimBundle).toHaveBeenCalledWith({
      entryIds: ['fresh'],
      homePath: '/home/dev',
    });
    expect(host.verifyProviderAuth).toHaveBeenCalledTimes(1);
    expect(host.verifyProviderAuth).toHaveBeenCalledWith('remote', 'codex', []);
    expect(vault.get).not.toHaveBeenCalledWith('deleted');
    expect(writeback.pullFamiliesNow.mock.invocationCallOrder[0]).toBeLessThan(
      vault.release.mock.invocationCallOrder[0],
    );
    expect(writeback.pause.mock.invocationCallOrder[0]).toBeLessThan(
      vault.release.mock.invocationCallOrder[0],
    );
    expect(details.applyStarted).toBe(true);
    expect(details.providerAuth.codex.checkedOut).toEqual(['fresh']);
    expect(details.appliedManifest?.codex.files).toEqual(['/home/dev/.codex/auth.json']);
    await definition.completed(operation);
    expect(writeback.resume).toHaveBeenCalledWith('operation');
  });

  it('refuses another VM family before changing anything', async () => {
    held.set('fresh', 'other');
    await expect(run('preflight')).rejects.toMatchObject({
      code: 'PROVIDER_AUTH_ALREADY_CHECKED_OUT',
    });
    expect(vault.release).not.toHaveBeenCalled();
    expect(writeback.pause).not.toHaveBeenCalled();
    expect(host.applyProviderAuth).not.toHaveBeenCalled();
  });

  it.each([false, true])('gates running agents with force=%s', async (force) => {
    details.force = force;
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [{ status: 'running', agentId: 'agent' }],
    });
    if (force) await run('preflight');
    else await expect(run('preflight')).rejects.toMatchObject({ code: 'REMOTE_AGENTS_RUNNING' });
  });

  it('refuses unknown session counts but ignores sessions without agents', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await expect(run('preflight')).rejects.toMatchObject({ code: 'REMOTE_AGENT_COUNT_UNKNOWN' });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ status: 'running', agentId: null }],
    });
    await run('preflight');
  });

  it('refuses an unknown session count when this PC has no VM certificate', async () => {
    storage.getRemote.mockResolvedValue({
      id: 'remote',
      baseUrl: 'https://host',
      name: 'host',
      tlsCertificate: null,
    });
    await expect(run('preflight')).rejects.toMatchObject({ code: 'REMOTE_AGENT_COUNT_UNKNOWN' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an offline pull without releasing a family', async () => {
    writeback.pullFamiliesNow.mockResolvedValue({ pulled: false });
    await expect(run('pull_families')).rejects.toMatchObject({ code: 'PROVIDER_AUTH_PULL_FAILED' });
    expect(vault.release).not.toHaveBeenCalled();
  });

  it('removes the prior custom env key on replacement without rewriting unchanged providers', async () => {
    details.changedProviders = details.reauth = ['claude'];
    details.previousProviderAuth.claude = { choice: 'reuse', entryId: 'token' };
    details.providerAuth.claude = { choice: 'reuse', entryId: 'replacement' };
    await all();
    expect(host.applyProviderAuth).toHaveBeenLastCalledWith('remote', {
      env: {},
      files: [],
      remove: { envKeys: ['OLD_KEY'], files: [] },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('removes a dropped family file and never verifies skipped providers', async () => {
    details.providerAuth.codex = { choice: 'skip', checkedOut: ['old'] };
    await all();
    expect(host.applyProviderAuth).toHaveBeenLastCalledWith('remote', {
      env: {},
      files: [],
      remove: { envKeys: [], files: ['/home/dev/.codex/auth.json'] },
    });
    expect(host.verifyProviderAuth).not.toHaveBeenCalled();
    expect(details.providerAuth.codex.checkedOut).toEqual([]);
  });

  it.each(['reuse', 'skip'] as const)(
    'reconciles an OpenCode subset or all (%s)',
    async (choice) => {
      held = new Map([
        ['oc1', 'remote'],
        ['oc2', 'remote'],
      ]);
      details.changedProviders = details.reauth = ['opencode'];
      details.previousProviderAuth = {
        opencode: { choice: 'reuse', entryIds: ['oc1', 'oc2'], checkedOut: ['oc1', 'oc2'] },
      };
      details.providerAuth = {
        opencode: {
          choice,
          ...(choice === 'reuse' ? { entryId: 'oc1' } : {}),
          checkedOut: ['oc1', 'oc2'],
        },
      };
      await all();
      expect(vault.release).toHaveBeenCalledWith('oc2');
      if (choice === 'reuse') {
        expect(vault.release).not.toHaveBeenCalledWith('oc1');
        expect(vault.buildClaimBundle).toHaveBeenCalledWith({
          entryIds: ['oc1'],
          homePath: '/home/dev',
        });
      }
      expect(host.applyProviderAuth).toHaveBeenLastCalledWith('remote', {
        env: {},
        files: [],
        remove: {
          envKeys: [],
          files: choice === 'skip' ? ['/home/dev/.local/share/opencode/auth.json'] : [],
        },
      });
    },
  );

  // Module unit: real vault composition catches provider loss while host/storage I/O stays isolated.
  it('changes to one OpenCode group, applies all three providers and verifies each id', async () => {
    const auth = {
      anthropic: { type: 'api', key: 'anthropic-secret' },
      github: { type: 'wellknown', key: 'gh', token: 'github-secret' },
      'zai-coding-plan': { type: 'api', key: 'zai-secret' },
    };
    storage.readProviderAuthPayload.mockResolvedValue({
      payloadKind: 'opencode-entries',
      entries: auth,
    });
    const realVault = new ProviderAuthVaultService(
      {
        getProviderAuthEntry: vault.get,
        readProviderAuthPayload: storage.readProviderAuthPayload,
      } as never,
      { isSupported: (provider: string) => provider in PROVIDER_AUTH_ADAPTERS } as never,
    );
    vault.opencodeProviderIds.mockImplementation((ids: string[]) =>
      realVault.opencodeProviderIds(ids),
    );
    vault.buildClaimBundle.mockImplementation(
      (selection: { entryIds: string[]; homePath: string }) =>
        realVault.buildClaimBundle(selection),
    );
    held = new Map([
      ['oc1', 'remote'],
      ['oc2', 'remote'],
    ]);
    details.changedProviders = details.reauth = ['opencode'];
    details.previousProviderAuth = {
      opencode: { choice: 'reuse', entryIds: ['oc1', 'oc2'], checkedOut: ['oc1', 'oc2'] },
    };
    details.providerAuth = { opencode: { choice: 'reuse', entryId: 'ocGroup' } };

    await all();

    const bundle = host.applyProviderAuth.mock.calls[0][1];
    expect(bundle.env).toEqual({});
    expect(bundle.files).toHaveLength(1);
    expect(bundle.files[0]).toMatchObject({
      path: '/home/dev/.local/share/opencode/auth.json',
      mode: '0600',
    });
    expect(
      JSON.parse(Buffer.from(bundle.files[0].contentBase64, 'base64').toString('utf8')),
    ).toEqual(auth);
    expect(host.verifyProviderAuth).toHaveBeenCalledWith('remote', 'opencode', Object.keys(auth));
    expect(host.applyProviderAuth).toHaveBeenLastCalledWith('remote', {
      env: {},
      files: [],
      remove: { envKeys: [], files: [] },
    });
    expect(vault.release).toHaveBeenCalledWith('oc1');
    expect(vault.release).toHaveBeenCalledWith('oc2');
    expect(vault.checkout).not.toHaveBeenCalled();
    expect(details.providerAuth.opencode.entryIds).toEqual(['ocGroup']);
  });

  it('cancels before apply by releasing acquired and restoring released families', async () => {
    for (const id of ['preflight', 'pull_families', 'release_replaced', 'provider_auth_resolve'])
      await run(id);
    expect([...held.keys()]).toEqual(['fresh']);
    await definition.rollback(operation);
    expect([...held.keys()]).toEqual(['old']);
    expect(writeback.resume).toHaveBeenCalledWith('operation');
  });

  it('keeps applyStarted durable when retry resets steps and allows a replacement choice', async () => {
    host.verifyProviderAuth.mockResolvedValueOnce({ ok: false, hint: 'expired' });
    await expect(all()).rejects.toMatchObject({ code: 'PROVIDER_AUTH_VERIFY_FAILED' });
    operation.steps = [{ id: 'verify_providers', state: 'failed' }] as RemoteOperation['steps'];
    expect(definition.retryFrom(operation)).toBe('provider_auth_resolve');
    operation.steps = [{ id: 'claim', state: 'pending' }] as RemoteOperation['steps'];
    expect(() => definition.assertCancellable(operation)).toThrow('retry');
    details.providerAuth.codex = { choice: 'reuse', entryId: 'third', checkedOut: ['fresh'] };
    for (const id of [
      'provider_auth_resolve',
      'build_bundle',
      'claim',
      'remove_dropped',
      'verify_providers',
    ])
      await run(id);
    expect([...held.keys()]).toEqual(['third']);
    expect(details.applyStarted).toBe(true);
    expect(storage.updateRemoteOperation).toHaveBeenCalledWith('operation', {
      details: expect.objectContaining({ applyStarted: true }),
    });
  });
  it('falls back to the adapter env key for a deleted dropped entry', async () => {
    details.changedProviders = details.reauth = ['claude'];
    details.providerAuth.claude = { choice: 'skip' };
    await all();
    expect(host.applyProviderAuth).toHaveBeenLastCalledWith('remote', {
      env: {},
      files: [],
      remove: { envKeys: ['CLAUDE_CODE_OAUTH_TOKEN'], files: [] },
    });
  });

  it('keeps write-back paused on failure and on resumed steps until forget', async () => {
    host.applyProviderAuth.mockRejectedValueOnce(new Error('connection lost'));
    await expect(all()).rejects.toThrow('connection lost');
    expect(details.writebackPaused).toBe(true);
    expect(writeback.resume).not.toHaveBeenCalled();
    writeback.pause.mockClear();
    await run('claim');
    expect(writeback.pause).toHaveBeenCalledWith('remote', 'operation');
    definition.forget(operation.id);
    expect(writeback.resume).toHaveBeenCalledWith('operation');
  });

  it('never starts apply unless the durable applyStarted write succeeds', async () => {
    for (const id of [
      'preflight',
      'pull_families',
      'release_replaced',
      'provider_auth_resolve',
      'build_bundle',
    ])
      await run(id);
    storage.updateRemoteOperation.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(run('claim')).rejects.toThrow('storage unavailable');
    expect(host.applyProviderAuth).not.toHaveBeenCalled();
  });

  it('leaves a successfully changed family checked out when another provider is retried', async () => {
    details.changedProviders = details.reauth = ['codex', 'claude'];
    details.providerAuth.claude = { choice: 'reuse', entryId: 'replacement' };
    host.verifyProviderAuth
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, hint: 'expired' });
    await expect(all()).rejects.toMatchObject({ code: 'PROVIDER_AUTH_VERIFY_FAILED' });
    expect(details.reauth).toEqual(['claude']);
    vault.release.mockClear();
    await run('provider_auth_resolve');
    expect(held.get('fresh')).toBe('remote');
    expect(details.providerAuth.codex.checkedOut).toEqual(['fresh']);
    expect(vault.release).not.toHaveBeenCalledWith('fresh');
  });
  it.each(['provider_auth_resolve', 'build_bundle', 'claim'])(
    'resolves a replacement before apply after a %s failure',
    async (failedId) => {
      for (const id of ['preflight', 'pull_families', 'release_replaced']) await run(id);
      const boundary =
        failedId === 'provider_auth_resolve'
          ? vault.checkout
          : failedId === 'build_bundle'
            ? vault.buildClaimBundle
            : host.applyProviderAuth;
      boundary.mockRejectedValueOnce(new Error('unavailable'));
      const remaining = [
        'provider_auth_resolve',
        'build_bundle',
        'claim',
        'remove_dropped',
        'verify_providers',
      ];
      await expect(
        (async () => {
          for (const id of remaining) await run(id);
        })(),
      ).rejects.toThrow('unavailable');
      operation.steps = definition.steps.map((step) => ({
        id: step.id,
        state: step.id === failedId ? 'failed' : 'done',
      })) as RemoteOperation['steps'];
      details.choicesReplaced = true;
      details.providerAuth.codex = {
        choice: 'reuse',
        entryId: 'third',
        checkedOut: details.providerAuth.codex.checkedOut,
      };
      expect(definition.retryFrom(operation)).toBe('provider_auth_resolve');
      if (failedId === 'claim')
        expect(() => definition.assertCancellable(operation)).toThrow('retry');
      for (const id of remaining) await run(id);
      expect([...held.keys()]).toEqual(['third']);
      expect(vault.buildClaimBundle).toHaveBeenLastCalledWith({
        entryIds: ['third'],
        homePath: '/home/dev',
      });
      expect(details.choicesReplaced).toBe(false);
    },
  );
});
