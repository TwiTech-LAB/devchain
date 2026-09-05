import { NotFoundError } from '../../../common/errors/error-types';
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
  const projectId = 'project-1';
  let storage: {
    getProject: jest.Mock;
    getIntegrationConnection: jest.Mock;
    getIntegrationConnectionById: jest.Mock;
    listExternalManagedSubtaskLinksByConnection: jest.Mock;
    getIntegrationConnectionCredentialsById: jest.Mock;
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
      getProject: jest.fn().mockResolvedValue({ id: projectId }),
      getIntegrationConnection: jest.fn().mockResolvedValue({
        id: 'connection-1',
        projectId,
        provider: 'clickup',
        generation: 1,
        subtaskSyncEnabled: true,
        syncSettingRevision: 1,
      }),
      getIntegrationConnectionById: jest.fn().mockResolvedValue(null),
      listExternalManagedSubtaskLinksByConnection: jest.fn(),
      getIntegrationConnectionCredentialsById: jest
        .fn()
        .mockResolvedValue({ provider: 'clickup', token: 'secret-token' }),
      listExternalTaskLinksForEpics: jest.fn().mockResolvedValue([
        {
          epicId: 'epic-1',
          connectionId: 'connection-1',
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
    storage.listExternalManagedSubtaskLinksByConnection.mockResolvedValue([
      row(),
      row({
        id: '22222222-2222-4222-8222-222222222222',
        operationPhase: 'needs_attention',
        tombstoneState: 'orphan_risk',
        safeErrorCode: 'ownership_marker_missing',
      }),
    ]);

    const result = await service.getHealth(projectId, 'clickup');

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
    expect(storage.getIntegrationConnection).toHaveBeenCalledWith({
      projectId,
      provider: 'clickup',
    });
    expect(storage.listExternalManagedSubtaskLinksByConnection).toHaveBeenCalledWith(
      'connection-1',
    );
  });

  it('bounds detail rows at 100 while counts remain authoritative', async () => {
    storage.listExternalManagedSubtaskLinksByConnection.mockResolvedValue(
      Array.from({ length: 101 }, (_, index) =>
        row({ id: `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111` }),
      ),
    );

    const result = await service.getHealth(projectId, 'clickup');

    expect(result.counts.total).toBe(101);
    expect(result.items).toHaveLength(100);
    expect(result.truncated).toBe(true);
  });

  it.each(MANAGED_SUBTASK_RETRY_BLOCKED_REASONS)(
    'hides Retry but preserves Verify and Open in source for blocked reason %s',
    async (safeErrorCode) => {
      storage.listExternalManagedSubtaskLinksByConnection.mockResolvedValue([
        row({ operationPhase: 'needs_attention', safeErrorCode }),
      ]);

      const result = await service.getHealth(projectId, 'clickup');

      expect(result.items[0]).toMatchObject({
        safeErrorCode,
        canRetry: false,
        canVerify: true,
        openInSourceUrl: 'https://app.clickup.com/t/remote-task',
      });
    },
  );

  it('shows Retry for an otherwise retryable needs-attention reason', async () => {
    storage.listExternalManagedSubtaskLinksByConnection.mockResolvedValue([
      row({ operationPhase: 'needs_attention', safeErrorCode: 'provider_request_rejected' }),
    ]);

    const result = await service.getHealth(projectId, 'clickup');

    expect(result.items[0]).toMatchObject({ canRetry: true, canVerify: true });
  });

  it('derives Jira source URLs only from the exact project connection credentials', async () => {
    storage.getIntegrationConnection.mockResolvedValue({
      id: 'jira-connection-1',
      projectId,
      provider: 'jira',
      generation: 1,
      subtaskSyncEnabled: true,
      syncSettingRevision: 1,
    });
    storage.listExternalManagedSubtaskLinksByConnection.mockResolvedValue([
      row({
        connectionIdSnapshot: 'jira-connection-1',
        provider: 'jira',
        remoteTaskId: '10001',
        remoteKey: 'ENG-1',
      }),
    ]);
    storage.getIntegrationConnectionCredentialsById.mockResolvedValue({
      provider: 'jira',
      siteUrl: 'https://acme.atlassian.net',
      email: 'user@example.com',
      token: 'jira-secret-token',
    });

    const result = await service.getHealth(projectId, 'jira');

    expect(result.items[0]?.openInSourceUrl).toBe('https://acme.atlassian.net/browse/ENG-1');
    expect(storage.getIntegrationConnectionCredentialsById).toHaveBeenCalledWith(
      'jira-connection-1',
    );
    expect(JSON.stringify(result)).not.toContain('jira-secret-token');
  });

  it('routes Verify and Retry only to a matching project connection row', async () => {
    storage.getExternalManagedSubtaskLink.mockResolvedValue(row());
    subscriber.verifyManagedLink.mockResolvedValue({ outcome: 'confirmed' });
    subscriber.retryManagedLink.mockResolvedValue({ outcome: 'confirmed' });

    await expect(
      service.verify(projectId, 'clickup', '11111111-1111-4111-8111-111111111111'),
    ).resolves.toEqual({ outcome: 'confirmed' });
    await expect(
      service.retry(projectId, 'clickup', '11111111-1111-4111-8111-111111111111'),
    ).resolves.toEqual({ outcome: 'confirmed' });
    expect(subscriber.verifyManagedLink).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      'connection-1',
    );
    expect(subscriber.retryManagedLink).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      'connection-1',
    );

    storage.getIntegrationConnection.mockResolvedValueOnce({
      id: 'connection-other',
      projectId: 'project-other',
      provider: 'clickup',
    });
    await expect(
      service.verify('project-other', 'clickup', '11111111-1111-4111-8111-111111111111'),
    ).rejects.toThrow('Managed subtask link');
  });

  it('returns health for one exact unassigned connection without provider fallback', async () => {
    storage.getIntegrationConnectionById.mockResolvedValue({
      id: 'legacy-connection-1',
      projectId: null,
      provider: 'clickup',
      generation: 1,
      subtaskSyncEnabled: true,
      syncSettingRevision: 1,
    });
    storage.listExternalManagedSubtaskLinksByConnection.mockResolvedValue([
      row({ connectionIdSnapshot: 'legacy-connection-1' }),
    ]);

    const result = await service.getLegacyHealth('legacy-connection-1');

    expect(result).toMatchObject({
      provider: 'clickup',
      enabled: true,
      counts: { total: 1, outcomeUnknown: 1 },
    });
    expect(storage.listExternalManagedSubtaskLinksByConnection).toHaveBeenCalledWith(
      'legacy-connection-1',
    );
    expect(storage.getIntegrationConnection).not.toHaveBeenCalled();
  });

  it('rejects project-owned rows from every exact legacy health and recovery action', async () => {
    storage.getIntegrationConnectionById.mockResolvedValue({
      id: 'connection-1',
      projectId,
      provider: 'clickup',
    });

    await expect(service.getLegacyHealth('connection-1')).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      service.verifyLegacy('connection-1', '11111111-1111-4111-8111-111111111111'),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      service.retryLegacy('connection-1', '11111111-1111-4111-8111-111111111111'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('routes legacy Verify and Retry only when row and exact connection match', async () => {
    storage.getIntegrationConnectionById.mockResolvedValue({
      id: 'legacy-connection-1',
      projectId: null,
      provider: 'clickup',
    });
    storage.getExternalManagedSubtaskLink.mockResolvedValue(
      row({ connectionIdSnapshot: 'legacy-connection-1' }),
    );
    subscriber.verifyManagedLink.mockResolvedValue({ outcome: 'confirmed' });
    subscriber.retryManagedLink.mockResolvedValue({ outcome: 'confirmed' });

    await expect(
      service.verifyLegacy('legacy-connection-1', '11111111-1111-4111-8111-111111111111'),
    ).resolves.toEqual({ outcome: 'confirmed' });
    await expect(
      service.retryLegacy('legacy-connection-1', '11111111-1111-4111-8111-111111111111'),
    ).resolves.toEqual({ outcome: 'confirmed' });
    expect(subscriber.verifyManagedLink).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      'legacy-connection-1',
    );
    expect(subscriber.retryManagedLink).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      'legacy-connection-1',
    );

    storage.getExternalManagedSubtaskLink.mockResolvedValue(
      row({ connectionIdSnapshot: 'different-connection' }),
    );
    await expect(
      service.verifyLegacy('legacy-connection-1', '11111111-1111-4111-8111-111111111111'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
