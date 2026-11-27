/**
 * Which connections and credentials home sends to one VM, and when it sends nothing.
 * Test layer: unit, with fake storage and host client.
 */
import type { HostIntegrationsPush } from '@devchain/shared';
import { ConflictError, VaultUnavailableError } from '../../../common/errors/error-types';
import { hostIntegrationsRevision } from '../../external-integrations/vm-cache/integration-push-revision';
import type {
  IntegrationConnection,
  IntegrationCredentials,
  RemoteProjectBinding,
} from '../../storage/models/domain.models';
import type { VaultState } from '../../vault/vault-key.service';
import { RemoteIntegrationPushService } from './remote-integration-push.service';

function connection(id: string, projectId: string, generation = 1): IntegrationConnection {
  return {
    id,
    projectId,
    provider: projectId === 'B' ? 'clickup' : 'jira',
    legacySourceConnectionId: null,
    generation,
    subtaskSyncEnabled: true,
    syncSettingRevision: 1,
    createdAt: 'T',
    updatedAt: 'T',
  };
}

const binding = (projectId: string, remoteId: string, state: RemoteProjectBinding['state']) =>
  ({ projectId, remoteId, state }) as RemoteProjectBinding;

const jira = (token: string): IntegrationCredentials => ({
  provider: 'jira',
  siteUrl: 'https://acme.atlassian.net',
  email: 'user@example.com',
  token,
});

function setup(rows: IntegrationConnection[], vaultState: VaultState = 'unlocked') {
  const pushed: HostIntegrationsPush[] = [];
  const generations = new Map(rows.map((row) => [row.id, row.generation]));
  const storage = {
    listRemoteProjectBindings: jest.fn(async () => [
      binding('A', 'vm-1', 'detaching'),
      binding('C', 'vm-1', 'remote'),
      binding('B', 'vm-2', 'remote'),
      binding('D', 'vm-1', 'attaching'),
    ]),
    listIntegrationConnections: jest.fn(async () => rows),
    getIntegrationConnectionCredentialsById: jest.fn(
      async (id: string): Promise<IntegrationCredentials | null> => jira(`token-${id}`),
    ),
    getIntegrationConnectionById: jest.fn(async (id: string) => ({
      ...rows.find((row) => row.id === id)!,
      generation: generations.get(id)!,
    })),
    listOrdinaryExternalTaskLinkRows: jest.fn(async (projectId: string) => [
      { id: `link-${projectId}` },
    ]),
    listExternalLinkReceiptIds: jest.fn(
      async (_projectIds: readonly string[]): Promise<string[]> => [],
    ),
    markVmLinkOwners: jest.fn(async (bindings: readonly { projectId: string }[]) =>
      bindings.map((binding) => binding.projectId),
    ),
  };
  const host = {
    putIntegrations: jest.fn(
      async (_remoteId: string, body: HostIntegrationsPush): Promise<string[] | undefined> => {
        pushed.push(body);
        return undefined;
      },
    ),
  };
  const service = new RemoteIntegrationPushService(
    storage as never,
    { getState: () => vaultState } as never,
    host as never,
  );
  service.useHealth(() => ({ online: true, versionMatches: true, apiKeyRejected: false }) as never);
  // The VM's last poll reported a cache: `pushNow` sends to it.
  service.noteReport('vm-1', {
    kind: 'status',
    status: { appliedRevision: 'none', cacheReady: false, cacheUnavailable: null },
  });
  return { service, storage, host, pushed, generations };
}

const ROWS = [
  connection('conn-a', 'A'),
  connection('conn-b', 'B'),
  connection('conn-c', 'C'),
  connection('conn-d', 'D'),
];
const SENT = [
  { id: 'conn-a', projectId: 'A', provider: 'jira', generation: 1 },
  { id: 'conn-c', projectId: 'C', provider: 'jira', generation: 1 },
] as const;

describe('RemoteIntegrationPushService', () => {
  it('sends the connections of projects bound remote or detaching to this VM, with their credentials', async () => {
    const { service, pushed } = setup(ROWS);

    await service.pushNow('vm-1');

    expect(pushed).toEqual([
      {
        revision: hostIntegrationsRevision(SENT),
        connections: SENT,
        secrets: [
          { connectionId: 'conn-a', generation: 1, credentials: jira('token-conn-a') },
          { connectionId: 'conn-c', generation: 1, credentials: jira('token-conn-c') },
        ],
      },
    ]);
  });

  it.each<VaultState>(['locked', 'unlocking'])(
    'sends metadata only while the Vault is %s',
    async (state) => {
      const { service, storage, pushed } = setup(ROWS, state);

      await service.pushNow('vm-1');

      expect(pushed).toEqual([{ revision: hostIntegrationsRevision(SENT), connections: SENT }]);
      expect(storage.getIntegrationConnectionCredentialsById).not.toHaveBeenCalled();
    },
  );

  it('sends no credentials when the Vault locks during the reads', async () => {
    const { service, storage, pushed } = setup(ROWS);
    storage.getIntegrationConnectionCredentialsById
      .mockResolvedValueOnce(jira('token-conn-a'))
      .mockRejectedValueOnce(new VaultUnavailableError('locked'));

    await service.pushNow('vm-1');

    expect(pushed[0]).not.toHaveProperty('secrets');
  });

  it('leaves out a credential whose token was replaced between the reads', async () => {
    const { service, storage, pushed, generations } = setup(ROWS);
    storage.getIntegrationConnectionCredentialsById.mockImplementation(async (id: string) => {
      if (id === 'conn-a') generations.set('conn-a', 2);
      return jira(`token-${id}`);
    });

    await service.pushNow('vm-1');

    expect(pushed[0].connections).toEqual(SENT);
    expect(pushed[0].secrets?.map((secret) => secret.connectionId)).toEqual(['conn-c']);
  });

  describe('on a health poll', () => {
    const revision = hostIntegrationsRevision(SENT);
    const ready = { appliedRevision: revision, cacheReady: true, cacheUnavailable: null };

    it('sends nothing to a VM that holds the revision and every credential', async () => {
      const { service, host } = setup(ROWS);

      await service.pushIfChanged('vm-1', ready);
      await service.pushIfChanged('vm-1', undefined);

      expect(host.putIntegrations).not.toHaveBeenCalled();
    });

    it('sends the credentials again to a VM whose cache is empty, but not while the Vault is locked', async () => {
      const unlocked = setup(ROWS);
      const locked = setup(ROWS, 'locked');
      const rebooted = { ...ready, cacheReady: false };

      await unlocked.service.pushIfChanged('vm-1', rebooted);
      await locked.service.pushIfChanged('vm-1', rebooted);

      expect(unlocked.pushed[0].secrets).toHaveLength(2);
      expect(locked.host.putIntegrations).not.toHaveBeenCalled();
    });

    it('sends only metadata changes to a VM that cannot hold credentials', async () => {
      const { service, storage, pushed } = setup(ROWS);
      const noTmpfs = {
        cacheReady: false,
        cacheUnavailable: 'runtime_directory_not_tmpfs' as const,
      };

      await service.pushIfChanged('vm-1', { ...noTmpfs, appliedRevision: revision });
      await service.pushIfChanged('vm-1', { ...noTmpfs, appliedRevision: 'old' });

      expect(pushed).toEqual([{ revision, connections: SENT }]);
      expect(storage.getIntegrationConnectionCredentialsById).not.toHaveBeenCalled();
    });

    it('seeds each `remote` project the VM reports unseeded, once, without the credentials it holds', async () => {
      const { service, storage, host, pushed } = setup(ROWS);
      host.putIntegrations.mockImplementationOnce(async (_remoteId, body) => {
        pushed.push(body);
        return ['C'];
      });

      await service.pushIfChanged('vm-1', { ...ready, seededProjectIds: [] });
      // The poll after the push can still read the VM's earlier state.
      await service.pushNow('vm-1');

      expect(pushed[0]).toEqual({
        revision,
        connections: SENT,
        seed: [{ projectId: 'C', links: [{ id: 'link-C' }] }],
      });
      expect(pushed[1]).not.toHaveProperty('seed');
      expect(storage.listOrdinaryExternalTaskLinkRows).toHaveBeenCalledTimes(1);
      expect(storage.getIntegrationConnectionCredentialsById).toHaveBeenCalledTimes(2);
    });

    it('sends no seed to a VM that reports no seeded set, nor for a binding replaced since the push read it', async () => {
      const { service, storage, host, pushed } = setup(ROWS);

      await service.pushIfChanged('vm-1', ready);
      expect(host.putIntegrations).not.toHaveBeenCalled();

      // C's owner is recorded, but its seed never reaches the VM.
      const unseeded = { ...ready, appliedRevision: 'older', seededProjectIds: [] };
      host.putIntegrations.mockRejectedValueOnce(new Error('offline'));
      await service.pushIfChanged('vm-1', unseeded);
      expect(storage.listOrdinaryExternalTaskLinkRows).toHaveBeenCalledTimes(1);

      // C was detached and attached again: its new binding takes no record and no seed.
      storage.markVmLinkOwners.mockResolvedValueOnce([]);
      await service.pushIfChanged('vm-1', unseeded);
      expect(pushed).toHaveLength(1);
      expect(pushed[0]).not.toHaveProperty('seed');
      expect(storage.listOrdinaryExternalTaskLinkRows).toHaveBeenCalledTimes(1);
    });

    it('acknowledges the receipts home applied while the VM has pending ones, and each only once', async () => {
      const { service, storage, host, pushed } = setup(ROWS);
      storage.listExternalLinkReceiptIds.mockResolvedValue(['r-1', 'r-2']);
      const seeded = { ...ready, seededProjectIds: ['C'] };

      await service.pushIfChanged('vm-1', { ...seeded, pendingReceipts: 0 });
      await service.pushIfChanged('vm-1', { ...seeded, pendingReceipts: 2 });
      await service.pushIfChanged('vm-1', { ...seeded, pendingReceipts: 1 });

      expect(storage.listExternalLinkReceiptIds).toHaveBeenCalledWith(['A', 'C']);
      expect(host.putIntegrations).toHaveBeenCalledTimes(1);
      expect(pushed[0]).toEqual({
        revision,
        connections: SENT,
        acks: [{ receiptId: 'r-1' }, { receiptId: 'r-2' }],
      });
    });

    it('sends the acknowledgements again after a failed push', async () => {
      const { service, storage, host, pushed } = setup(ROWS);
      storage.listExternalLinkReceiptIds.mockResolvedValue(['r-1']);
      host.putIntegrations.mockRejectedValueOnce(new Error('offline'));
      const pending = { ...ready, seededProjectIds: ['C'], pendingReceipts: 1 };

      await service.pushIfChanged('vm-1', pending);
      await service.pushIfChanged('vm-1', pending);

      expect(host.putIntegrations).toHaveBeenCalledTimes(2);
      expect(pushed).toEqual([{ revision, connections: SENT, acks: [{ receiptId: 'r-1' }] }]);
    });
  });

  describe('seedConfirmed', () => {
    const answering = (
      host: ReturnType<typeof setup>['host'],
      pushed: HostIntegrationsPush[],
      seeded: string[],
    ) =>
      host.putIntegrations.mockImplementation(async (_remoteId, body) => {
        pushed.push(body);
        return seeded;
      });

    it('seeds the project before the VM ever reported a seeded set, and pushes nothing once it is seeded', async () => {
      const { service, host, pushed } = setup(ROWS);
      answering(host, pushed, ['C']);

      await service.seedConfirmed('vm-1', 'C');
      await service.seedConfirmed('vm-1', 'C');

      expect(host.putIntegrations).toHaveBeenCalledTimes(1);
      expect(pushed[0].seed).toEqual([{ projectId: 'C', links: [{ id: 'link-C' }] }]);
    });

    it('rejects as retryable REMOTE_LINKS_NOT_SEEDED when the VM still lacks the seed', async () => {
      const { service, host, pushed } = setup(ROWS);
      answering(host, pushed, []);

      const error: unknown = await service.seedConfirmed('vm-1', 'C').catch((e) => e);

      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).details).toMatchObject({
        code: 'REMOTE_LINKS_NOT_SEEDED',
        retryable: true,
      });
    });

    it('rejects with the push error instead of logging it', async () => {
      const { service, host } = setup(ROWS);
      host.putIntegrations.mockRejectedValue(new Error('offline'));

      await expect(service.seedConfirmed('vm-1', 'C')).rejects.toThrow('offline');
    });

    it('seeds again after forgetSeeded', async () => {
      const { service, host, pushed } = setup(ROWS);
      answering(host, pushed, ['C']);

      await service.seedConfirmed('vm-1', 'C');
      service.forgetSeeded('vm-1', 'C');
      await service.seedConfirmed('vm-1', 'C');

      expect(pushed.map((body) => body.seed?.map((entry) => entry.projectId))).toEqual([
        ['C'],
        ['C'],
      ]);
    });

    it('reads the seed only after a home link write on the project finishes', async () => {
      const { service, storage, host, pushed } = setup(ROWS);
      answering(host, pushed, ['C']);
      const links = [{ id: 'link-C' }];
      storage.listOrdinaryExternalTaskLinkRows.mockImplementation(async () => [...links]);
      let finishWrite!: () => void;
      const write = service.withProjectLinks(
        ['C'],
        () => new Promise<void>((resolve) => (finishWrite = resolve)),
      );

      const seeding = service.seedConfirmed('vm-1', 'C');
      await new Promise((resolve) => setImmediate(resolve));
      expect(storage.listOrdinaryExternalTaskLinkRows).not.toHaveBeenCalled();
      links.push({ id: 'link-home' });
      finishWrite();
      await Promise.all([write, seeding]);

      expect(pushed[0].seed).toEqual([
        { projectId: 'C', links: [{ id: 'link-C' }, { id: 'link-home' }] },
      ]);
    });
  });
});
