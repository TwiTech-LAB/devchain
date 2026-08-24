import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { ExternalManagedSubtaskLink } from '../../storage/models/domain.models';
import type { ExternalSubtaskSyncSubscriber } from './external-subtask-sync.subscriber';
import { MANAGED_SUBTASK_RETRY_BLOCKED_REASONS } from './managed-subtask-recovery-policy';
import { ManagedSubtaskSyncHealthService } from './managed-subtask-sync-health.service';

function row(overrides: Partial<ExternalManagedSubtaskLink> = {}): ExternalManagedSubtaskLink {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    epicId: 'epic-1',
    epicIdSnapshot: 'epic-1',
    parentEpicIdSnapshot: 'parent-1',
    parentSourceLinkIdSnapshot: 'source-1',
    connectionIdSnapshot: 'connection-1',
    provider: 'clickup',
    remoteScopeKey: 'workspace-1',
    workAreaRemoteId: 'list-1',
    parentRemoteTaskId: 'parent-task',
    connectionGeneration: 1,
    syncSettingRevision: 1,
    ownershipToken: 'ownership-token',
    remoteTaskId: 'remote-task',
    remoteKey: 'REMOTE-1',
    desiredVersion: 2,
    confirmedVersion: 1,
    desiredFingerprint: 'desired',
    confirmedFingerprint: 'confirmed',
    operationPhase: 'outcome_unknown',
    safeErrorCode: 'provider_timeout',
    retryAt: null,
    tombstoneState: 'active',
    tombstonedAt: null,
    createdAt: '2026-08-23T00:00:00.000Z',
    updatedAt: '2026-08-23T00:00:00.000Z',
    ...overrides,
  };
}

describe('ManagedSubtaskSyncHealthService', () => {
  let storage: {
    getIntegrationConnection: jest.Mock;
    listExternalManagedSubtaskLinksByProvider: jest.Mock;
    getIntegrationConnectionCredentials: jest.Mock;
    listExternalTaskLinksForEpics: jest.Mock;
    getExternalManagedSubtaskLink: jest.Mock;
  };
  let subscriber: {
    verifyManagedLink: jest.Mock;
    retryManagedLink: jest.Mock;
  };
  let service: ManagedSubtaskSyncHealthService;

  beforeEach(() => {
    storage = {
      getIntegrationConnection: jest.fn().mockResolvedValue({
        id: 'connection-1',
        provider: 'clickup',
        generation: 1,
        subtaskSyncEnabled: true,
        syncSettingRevision: 1,
      }),
      listExternalManagedSubtaskLinksByProvider: jest.fn(),
      getIntegrationConnectionCredentials: jest
        .fn()
        .mockResolvedValue({ provider: 'clickup', token: 'secret-token' }),
      listExternalTaskLinksForEpics: jest.fn().mockResolvedValue([
        {
          epicId: 'epic-1',
          provider: 'clickup',
          remoteScopeKey: 'workspace-1',
          remoteTaskId: 'remote-task',
          sourceSnapshot: { webUrl: 'https://app.clickup.com/t/remote-task' },
        },
      ]),
      getExternalManagedSubtaskLink: jest.fn(),
    };
    subscriber = {
      verifyManagedLink: jest.fn(),
      retryManagedLink: jest.fn(),
    };
    service = new ManagedSubtaskSyncHealthService(
      storage as unknown as StorageService,
      subscriber as unknown as ExternalSubtaskSyncSubscriber,
    );
  });

  it('returns bounded provider health without credentials or handler internals', async () => {
    storage.listExternalManagedSubtaskLinksByProvider.mockResolvedValue([
      row(),
      row({
        id: '22222222-2222-4222-8222-222222222222',
        operationPhase: 'needs_attention',
        tombstoneState: 'orphan_risk',
        safeErrorCode: 'ownership_marker_missing',
      }),
    ]);

    const result = await service.getHealth('clickup');

    expect(result).toMatchObject({
      provider: 'clickup',
      enabled: true,
      status: 'orphan_risk',
      counts: {
        total: 2,
        pending: 0,
        outcomeUnknown: 1,
        needsAttention: 1,
        orphanRisk: 1,
      },
      items: [
        expect.objectContaining({
          canVerify: true,
          canRetry: false,
          openInSourceUrl: 'https://app.clickup.com/t/remote-task',
        }),
        expect.objectContaining({ canVerify: true, canRetry: false }),
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/secret-token|delivery_key|handler/i);
  });

  it('bounds detail rows at 100 while counts remain authoritative', async () => {
    storage.listExternalManagedSubtaskLinksByProvider.mockResolvedValue(
      Array.from({ length: 101 }, (_, index) =>
        row({ id: `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111` }),
      ),
    );

    const result = await service.getHealth('clickup');

    expect(result.counts.total).toBe(101);
    expect(result.items).toHaveLength(100);
    expect(result.truncated).toBe(true);
  });

  it.each(MANAGED_SUBTASK_RETRY_BLOCKED_REASONS)(
    'hides Retry but preserves Verify and Open in source for blocked reason %s',
    async (safeErrorCode) => {
      storage.listExternalManagedSubtaskLinksByProvider.mockResolvedValue([
        row({ operationPhase: 'needs_attention', safeErrorCode }),
      ]);

      const result = await service.getHealth('clickup');

      expect(result.items[0]).toMatchObject({
        safeErrorCode,
        canRetry: false,
        canVerify: true,
        openInSourceUrl: 'https://app.clickup.com/t/remote-task',
      });
    },
  );

  it('shows Retry for an otherwise retryable needs-attention reason', async () => {
    storage.listExternalManagedSubtaskLinksByProvider.mockResolvedValue([
      row({ operationPhase: 'needs_attention', safeErrorCode: 'provider_request_rejected' }),
    ]);

    const result = await service.getHealth('clickup');

    expect(result.items[0]).toMatchObject({ canRetry: true, canVerify: true });
  });

  it('routes Verify and Retry only to a matching provider row', async () => {
    storage.getExternalManagedSubtaskLink.mockResolvedValue(row());
    subscriber.verifyManagedLink.mockResolvedValue({ outcome: 'confirmed' });
    subscriber.retryManagedLink.mockResolvedValue({ outcome: 'confirmed' });

    await expect(
      service.verify('clickup', '11111111-1111-4111-8111-111111111111'),
    ).resolves.toEqual({ outcome: 'confirmed' });
    await expect(service.retry('clickup', '11111111-1111-4111-8111-111111111111')).resolves.toEqual(
      { outcome: 'confirmed' },
    );
    await expect(service.verify('jira', '11111111-1111-4111-8111-111111111111')).rejects.toThrow(
      'Managed subtask link',
    );
  });
});
