import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { EventsService } from '../../events/services/events.service';
import type {
  ExternalManagedSubtaskLink,
  IntegrationProvider,
} from '../../storage/models/domain.models';
import { IntegrationCredentialCipher } from '../../storage/local/integration-credential-cipher';
import { LocalStorageService } from '../../storage/local/local-storage.service';
import { ExternalProviderError } from '../errors/external-provider.errors';
import { ExternalTaskProviderRegistry } from '../external-task-provider.registry';
import type {
  ExternalSubtaskSnapshot,
  ExternalSubtaskSyncCapability,
} from '../models/external-provider.models';
import type { ExternalTaskProvider } from '../ports/external-task-provider';
import { ProviderOperationGate } from '../sessions/provider-operation-gate';
import {
  ExternalSubtaskSyncSubscriber,
  MANAGED_SUBTASK_DELIVERY_KEY,
} from './external-subtask-sync.subscriber';
import { MANAGED_SUBTASK_RETRY_BLOCKED_REASONS } from './managed-subtask-recovery-policy';

const MIGRATIONS_FOLDER = join(__dirname, '../../../../drizzle');

interface FakeProvider {
  adapter: ExternalTaskProvider;
  remotes: Map<string, ExternalSubtaskSnapshot>;
  create: jest.Mock;
  update: jest.Mock;
  delete: jest.Mock;
  listOwned: jest.Mock;
  calls: string[];
}

function fakeProvider(provider: IntegrationProvider): FakeProvider {
  const remotes = new Map<string, ExternalSubtaskSnapshot>();
  const calls: string[] = [];
  let sequence = 0;
  const create = jest.fn(async (_credentials, _context, input) => {
    calls.push(`${provider}:create`);
    const remoteTaskId = `${provider}-child-${++sequence}`;
    const snapshot: ExternalSubtaskSnapshot = {
      remoteTaskId,
      remoteKey: remoteTaskId.toUpperCase(),
      parentRemoteTaskId: input.parentRemoteTaskId,
      workAreaRemoteId: provider === 'clickup' ? 'list-clickup' : 'board-jira',
      ownershipToken: input.ownershipToken,
      title: input.title,
      description: input.description,
    };
    remotes.set(remoteTaskId, snapshot);
    return snapshot;
  });
  const readExact = jest.fn(async (_credentials, _context, remoteTaskId: string) => {
    const snapshot = remotes.get(remoteTaskId);
    return snapshot ? { ...snapshot } : null;
  });
  const update = jest.fn(async (_credentials, _context, input) => {
    calls.push(`${provider}:update`);
    const current = remotes.get(input.remoteTaskId);
    if (!current || current.ownershipToken !== input.ownershipToken) {
      throw new ExternalProviderError(provider, 'ownership_mismatch');
    }
    remotes.set(input.remoteTaskId, {
      ...current,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
    });
  });
  const remove = jest.fn(async (_credentials, _context, proof) => {
    calls.push(`${provider}:delete`);
    const current = remotes.get(proof.remoteTaskId);
    if (!current) return { outcome: 'already_absent' as const };
    if (current.ownershipToken !== proof.ownershipToken) {
      throw new ExternalProviderError(provider, 'ownership_mismatch');
    }
    remotes.delete(proof.remoteTaskId);
    return { outcome: 'deleted' as const };
  });
  const listOwned = jest.fn(async (_credentials, _context, parentId, ownershipToken) => ({
    items: [...remotes.values()].filter(
      (item) => item.parentRemoteTaskId === parentId && item.ownershipToken === ownershipToken,
    ),
    complete: true,
  }));
  const capability: ExternalSubtaskSyncCapability = {
    create,
    readExact,
    update,
    delete: remove,
    listOwnedDirectChildren: listOwned,
    assertOwned: jest.fn(async (_credentials, _context, proof) => {
      const current = remotes.get(proof.remoteTaskId);
      if (!current || current.ownershipToken !== proof.ownershipToken) {
        throw new ExternalProviderError(provider, 'ownership_mismatch');
      }
      return { ...current };
    }),
  };
  return {
    adapter: {
      provider,
      descriptor: {
        provider,
        displayName: provider === 'clickup' ? 'ClickUp' : 'Jira',
        capabilities: { myWork: false },
      },
      subtaskSync: capability,
      verifyCredentials: jest.fn(),
    },
    remotes,
    create,
    update,
    delete: remove,
    listOwned,
    calls,
  };
}

// Layer: backend integration. Reconciliation correctness depends on real
// transaction hooks, cascade behavior, recognition joins, and persisted phases.
describe('ExternalSubtaskSyncSubscriber', () => {
  let sqlite: Database.Database;
  let storage: LocalStorageService;
  let secretDirectory: string;
  let clickup: FakeProvider;
  let jira: FakeProvider;
  let subscriber: ExternalSubtaskSyncSubscriber;
  let events: { registerDurableSubscriber: jest.Mock };
  let providerGate: ProviderOperationGate;
  let projectId: string;
  let statusId: string;
  let parentId: string;
  let childId: string;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    sqlite.pragma('foreign_keys = ON');
    secretDirectory = mkdtempSync(join(tmpdir(), 'devchain-sync-subscriber-'));
    storage = new LocalStorageService(
      db,
      new IntegrationCredentialCipher({
        secretDirectory,
        machineIdentity: 'sync-subscriber-test:test-user',
      }),
    );
    clickup = fakeProvider('clickup');
    jira = fakeProvider('jira');
    events = { registerDurableSubscriber: jest.fn().mockReturnValue(jest.fn()) };
    providerGate = new ProviderOperationGate();
    subscriber = new ExternalSubtaskSyncSubscriber(
      storage,
      events as unknown as EventsService,
      new ExternalTaskProviderRegistry([clickup.adapter, jira.adapter]),
      providerGate,
    );

    const project = await storage.createProject({
      name: 'Subscriber project',
      rootPath: '/tmp/subscriber-project',
      description: null,
    });
    projectId = project.id;
    statusId = (await storage.listStatuses(project.id)).items[0]!.id;
    const parent = await storage.createEpic({ projectId, statusId, title: 'Parent' });
    parentId = parent.id;
    const child = await storage.createEpic({
      projectId,
      statusId,
      title: 'Child',
      description: 'Description',
      parentId,
    });
    childId = child.id;
    const connection = await storage.replaceIntegrationConnection(
      {
        provider: 'clickup',
        credentials: { provider: 'clickup', token: 'clickup-token' },
        subtaskSyncEnabled: true,
      },
      async () => undefined,
    );
    await storage.createExternalTaskLink({
      epicId: parentId,
      connectionId: connection.id,
      provider: 'clickup',
      remoteScopeKey: 'workspace-clickup',
      remoteTaskId: 'clickup-parent',
      sourceSnapshot: { workAreaId: 'list-clickup', workAreaName: 'ClickUp List' },
    });
  });

  afterEach(() => {
    sqlite.close();
    rmSync(secretDirectory, { recursive: true, force: true });
  });

  async function managed(
    provider: IntegrationProvider = 'clickup',
  ): Promise<ExternalManagedSubtaskLink> {
    return (await storage.listExternalManagedSubtaskLinksByProvider(provider))[0]!;
  }

  it('registers exactly one durable identity for factual Epic and connection events', () => {
    subscriber.onModuleInit();

    expect(events.registerDurableSubscriber).toHaveBeenCalledTimes(1);
    expect(events.registerDurableSubscriber).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryKey: MANAGED_SUBTASK_DELIVERY_KEY,
        ordered: false,
        eventNames: [
          'epic.created',
          'epic.updated',
          'epic.deleted',
          'integration.connection.created',
          'integration.connection.updated',
          'integration.connection.deleted',
        ],
      }),
    );
  });

  it('uses a factual event only as a wake-up and reconciles current local state', async () => {
    await subscriber.handleCommittedEvent({
      id: 'event-1',
      name: 'epic.created',
      payload: {
        epicId: childId,
        projectId,
        title: 'Stale event title',
        statusId,
        parentId,
      },
      requestId: null,
      publishedAt: '2026-08-23T00:00:00.000Z',
    });

    expect([...clickup.remotes.values()][0]).toMatchObject({
      title: 'Child',
      description: 'Description',
    });
  });

  it('creates once, repairs recognition from persisted state, and updates title and description', async () => {
    await expect(subscriber.reconcileEpic(childId)).resolves.toEqual([
      expect.objectContaining({ outcome: 'confirmed' }),
    ]);
    expect(clickup.create).toHaveBeenCalledTimes(1);
    const first = await managed();
    expect(
      await storage.findRecognizedManagedSubtask(
        childId,
        'clickup',
        first.remoteScopeKey,
        first.remoteTaskId!,
      ),
    ).toMatchObject({ id: first.id });

    await subscriber.reconcileEpic(childId);
    expect(clickup.create).toHaveBeenCalledTimes(1);

    const child = await storage.getEpic(childId);
    await storage.updateEpic(
      childId,
      { title: 'Changed title', description: 'Changed description' },
      child.version,
    );
    await subscriber.reconcileEpic(childId);

    expect(clickup.update).toHaveBeenCalledTimes(1);
    expect(clickup.remotes.get(first.remoteTaskId!)).toMatchObject({
      title: 'Changed title',
      description: 'Changed description',
    });
  });

  it('advances a version-only change without dispatching a remote update', async () => {
    await subscriber.reconcileEpic(childId);
    const nextStatus = await storage.createStatus({
      projectId,
      label: 'Review',
      color: '#64748b',
      position: 10,
    });
    const child = await storage.getEpic(childId);
    const updated = await storage.updateEpic(childId, { statusId: nextStatus.id }, child.version);

    await subscriber.reconcileEpic(childId);

    expect(clickup.update).not.toHaveBeenCalled();
    expect(await managed()).toMatchObject({
      operationPhase: 'confirmed',
      desiredVersion: updated.version,
      confirmedVersion: updated.version,
    });
  });

  it('serializes concurrent reconciliation behind an unresolved create', async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const createEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const originalCreate = clickup.create.getMockImplementation()!;
    clickup.create.mockImplementationOnce(async (...args) => {
      entered();
      await gate;
      return originalCreate(...args);
    });

    const first = subscriber.reconcileEpic(childId);
    await createEntered;
    const second = subscriber.reconcileEpic(childId);
    release();
    await Promise.all([first, second]);

    expect(clickup.create).toHaveBeenCalledTimes(1);
    expect(clickup.update).not.toHaveBeenCalled();
    expect((await managed()).operationPhase).toBe('confirmed');
  });

  it('releases provider admission before network I/O and records a disable race as unknown', async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const createEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const originalCreate = clickup.create.getMockImplementation()!;
    clickup.create.mockImplementationOnce(async (...args) => {
      expect(providerGate.isHeld('clickup')).toBe(false);
      entered();
      await gate;
      return originalCreate(...args);
    });

    const reconciliation = subscriber.reconcileEpic(childId);
    await createEntered;
    await providerGate.run('clickup', () =>
      storage.updateIntegrationConnectionSyncSetting('clickup', false).then(() => undefined),
    );
    release();

    await expect(reconciliation).resolves.toEqual([
      expect.objectContaining({ outcome: 'retry', reason: 'connection_changed_after_dispatch' }),
    ]);
    expect(await managed()).toMatchObject({
      operationPhase: 'outcome_unknown',
      safeErrorCode: 'connection_changed_after_dispatch',
    });
  });

  it('skips an unmatched imported child and never duplicates it', async () => {
    const connection = await storage.getIntegrationConnection('clickup');
    await storage.createExternalTaskLink({
      epicId: childId,
      connectionId: connection!.id,
      provider: 'clickup',
      remoteScopeKey: 'workspace-clickup',
      remoteTaskId: 'imported-child',
      sourceSnapshot: { workAreaId: 'list-clickup' },
    });

    await expect(subscriber.reconcileEpic(childId)).resolves.toEqual([
      expect.objectContaining({ outcome: 'already_remote_unmanaged' }),
    ]);
    expect(clickup.create).not.toHaveBeenCalled();
    expect(await storage.listExternalManagedSubtaskLinksByProvider('clickup')).toEqual([]);
  });

  it('keeps ClickUp import classification global during Jira enable catch-up', async () => {
    const clickupConnection = await storage.getIntegrationConnection('clickup');
    await storage.createExternalTaskLink({
      epicId: childId,
      connectionId: clickupConnection!.id,
      provider: 'clickup',
      remoteScopeKey: 'workspace-clickup',
      remoteTaskId: 'imported-clickup-child',
      sourceSnapshot: { workAreaId: 'list-clickup' },
    });
    const jiraConnection = await storage.replaceIntegrationConnection(
      {
        provider: 'jira',
        credentials: {
          provider: 'jira',
          siteUrl: 'https://acme.atlassian.net',
          email: 'user@example.com',
          token: 'jira-token',
        },
        subtaskSyncEnabled: false,
      },
      async () => undefined,
    );
    await storage.createExternalTaskLink({
      epicId: parentId,
      connectionId: jiraConnection.id,
      provider: 'jira',
      remoteScopeKey: 'acme.atlassian.net',
      remoteTaskId: 'JIRA-PARENT',
      sourceSnapshot: { workAreaId: 'board-jira', workAreaName: 'Jira Board' },
    });
    await storage.updateIntegrationConnectionSyncSetting('jira', true);

    await expect(subscriber.reconcileProvider('jira')).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'clickup',
          outcome: 'already_remote_unmanaged',
        }),
      ]),
    );

    expect(jira.create).not.toHaveBeenCalled();
    expect(await storage.listExternalManagedSubtaskLinksByProvider('jira')).toEqual([]);
  });

  it('verifies an admitted failed create before dropping it after local deletion', async () => {
    clickup.create.mockRejectedValueOnce(new ExternalProviderError('clickup', 'request_rejected'));
    await subscriber.reconcileEpic(childId);
    const unknown = await managed();
    expect(unknown.operationPhase).toBe('outcome_unknown');
    await storage.deleteEpic(childId);

    await expect(subscriber.retryManagedLink(unknown.id)).rejects.toMatchObject({
      details: { reason: 'verification_required' },
    });
    await subscriber.verifyManagedLink(unknown.id);

    expect(clickup.delete).not.toHaveBeenCalled();
    expect(clickup.listOwned).toHaveBeenCalledTimes(1);
    expect(await storage.listExternalManagedSubtaskLinksByProvider('clickup')).toEqual([]);
  });

  it('deletes the old owned projection before creating under a newly linked parent', async () => {
    await subscriber.reconcileEpic(childId);
    const secondParent = await storage.createEpic({
      projectId,
      statusId,
      title: 'Second parent',
    });
    const connection = await storage.getIntegrationConnection('clickup');
    await storage.createExternalTaskLink({
      epicId: secondParent.id,
      connectionId: connection!.id,
      provider: 'clickup',
      remoteScopeKey: 'workspace-clickup',
      remoteTaskId: 'clickup-parent-2',
      sourceSnapshot: { workAreaId: 'list-clickup', workAreaName: 'ClickUp List' },
    });
    const child = await storage.getEpic(childId);
    await storage.updateEpic(childId, { parentId: secondParent.id }, child.version);
    clickup.calls.length = 0;

    await subscriber.reconcileEpic(childId);

    expect(clickup.calls).toEqual(['clickup:delete', 'clickup:create']);
    expect((await managed()).parentEpicIdSnapshot).toBe(secondParent.id);

    const moved = await storage.getEpic(childId);
    await storage.updateEpic(childId, { parentId: null }, moved.version);
    await subscriber.reconcileEpic(childId);
    expect(await storage.listExternalManagedSubtaskLinksByProvider('clickup')).toEqual([]);
  });

  it('blocks replacement while the old-parent delete retries, then creates exactly once', async () => {
    await subscriber.reconcileEpic(childId);
    const secondParent = await storage.createEpic({
      projectId,
      statusId,
      title: 'Retry destination',
    });
    const connection = await storage.getIntegrationConnection('clickup');
    await storage.createExternalTaskLink({
      epicId: secondParent.id,
      connectionId: connection!.id,
      provider: 'clickup',
      remoteScopeKey: 'workspace-clickup',
      remoteTaskId: 'clickup-retry-parent',
      sourceSnapshot: { workAreaId: 'list-clickup', workAreaName: 'ClickUp List' },
    });
    const child = await storage.getEpic(childId);
    await storage.updateEpic(childId, { parentId: secondParent.id }, child.version);
    clickup.delete.mockRejectedValueOnce(
      new ExternalProviderError('clickup', 'timeout', { dispatched: true }),
    );

    await expect(subscriber.reconcileEpic(childId)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ outcome: 'retry', provider: 'clickup' })]),
    );

    expect(clickup.create).toHaveBeenCalledTimes(1);
    expect(clickup.remotes.size).toBe(1);
    const unresolved = await managed();
    expect(unresolved).toMatchObject({
      parentEpicIdSnapshot: parentId,
      operationPhase: 'outcome_unknown',
    });

    await storage.updateExternalManagedSubtaskLink(unresolved.id, { retryAt: null });
    await subscriber.reconcileEpic(childId);
    await subscriber.reconcileEpic(childId);

    expect(clickup.delete).toHaveBeenCalledTimes(2);
    expect(clickup.create).toHaveBeenCalledTimes(2);
    expect(clickup.remotes.size).toBe(1);
    expect((await managed()).parentEpicIdSnapshot).toBe(secondParent.id);
  });

  it('blocks replacement while an old-parent delete needs attention', async () => {
    await subscriber.reconcileEpic(childId);
    const old = await managed();
    const secondParent = await storage.createEpic({
      projectId,
      statusId,
      title: 'Blocked destination',
    });
    const connection = await storage.getIntegrationConnection('clickup');
    await storage.createExternalTaskLink({
      epicId: secondParent.id,
      connectionId: connection!.id,
      provider: 'clickup',
      remoteScopeKey: 'workspace-clickup',
      remoteTaskId: 'clickup-blocked-parent',
      sourceSnapshot: { workAreaId: 'list-clickup', workAreaName: 'ClickUp List' },
    });
    clickup.remotes.set(old.remoteTaskId!, {
      ...clickup.remotes.get(old.remoteTaskId!)!,
      ownershipToken: null,
    });
    const child = await storage.getEpic(childId);
    await storage.updateEpic(childId, { parentId: secondParent.id }, child.version);

    await expect(subscriber.reconcileEpic(childId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outcome: 'needs_attention', provider: 'clickup' }),
      ]),
    );

    expect(clickup.delete).not.toHaveBeenCalled();
    expect(clickup.create).toHaveBeenCalledTimes(1);
    expect(await managed()).toMatchObject({
      parentEpicIdSnapshot: parentId,
      operationPhase: 'needs_attention',
    });
  });

  it('lets Jira replace after its old delete while ClickUp deletion remains unresolved', async () => {
    const jiraConnection = await storage.replaceIntegrationConnection(
      {
        provider: 'jira',
        credentials: {
          provider: 'jira',
          siteUrl: 'https://acme.atlassian.net',
          email: 'user@example.com',
          token: 'jira-token',
        },
        subtaskSyncEnabled: true,
      },
      async () => undefined,
    );
    await storage.createExternalTaskLink({
      epicId: parentId,
      connectionId: jiraConnection.id,
      provider: 'jira',
      remoteScopeKey: 'acme.atlassian.net',
      remoteTaskId: 'JIRA-PARENT',
      sourceSnapshot: { workAreaId: 'board-jira', workAreaName: 'Jira Board' },
    });
    await subscriber.reconcileEpic(childId);
    const secondParent = await storage.createEpic({
      projectId,
      statusId,
      title: 'Fan-out destination',
    });
    const clickupConnection = await storage.getIntegrationConnection('clickup');
    await storage.createExternalTaskLink({
      epicId: secondParent.id,
      connectionId: clickupConnection!.id,
      provider: 'clickup',
      remoteScopeKey: 'workspace-clickup',
      remoteTaskId: 'clickup-fanout-parent',
      sourceSnapshot: { workAreaId: 'list-clickup', workAreaName: 'ClickUp List' },
    });
    await storage.createExternalTaskLink({
      epicId: secondParent.id,
      connectionId: jiraConnection.id,
      provider: 'jira',
      remoteScopeKey: 'acme.atlassian.net',
      remoteTaskId: 'JIRA-DESTINATION',
      sourceSnapshot: { workAreaId: 'board-jira', workAreaName: 'Jira Board' },
    });
    const child = await storage.getEpic(childId);
    await storage.updateEpic(childId, { parentId: secondParent.id }, child.version);
    clickup.delete.mockRejectedValueOnce(
      new ExternalProviderError('clickup', 'timeout', { dispatched: true }),
    );
    clickup.calls.length = 0;
    jira.calls.length = 0;

    const results = await subscriber.reconcileEpic(childId);

    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'clickup', outcome: 'retry' }),
        expect.objectContaining({ provider: 'jira', outcome: 'deleted' }),
        expect.objectContaining({ provider: 'jira', outcome: 'confirmed' }),
      ]),
    );
    expect(clickup.calls).toEqual([]);
    expect(clickup.delete).toHaveBeenCalledTimes(1);
    expect(jira.calls).toEqual(['jira:delete', 'jira:create']);
    expect(clickup.create).toHaveBeenCalledTimes(1);
    expect(jira.create).toHaveBeenCalledTimes(2);
  });

  it('recognizes unresolved ClickUp ownership during provider-filtered Jira move fan-out', async () => {
    const jiraConnection = await storage.replaceIntegrationConnection(
      {
        provider: 'jira',
        credentials: {
          provider: 'jira',
          siteUrl: 'https://acme.atlassian.net',
          email: 'user@example.com',
          token: 'jira-token',
        },
        subtaskSyncEnabled: true,
      },
      async () => undefined,
    );
    await storage.createExternalTaskLink({
      epicId: parentId,
      connectionId: jiraConnection.id,
      provider: 'jira',
      remoteScopeKey: 'acme.atlassian.net',
      remoteTaskId: 'JIRA-PARENT',
      sourceSnapshot: { workAreaId: 'board-jira', workAreaName: 'Jira Board' },
    });
    await subscriber.reconcileEpic(childId);
    const clickupOld = await managed('clickup');
    const secondParent = await storage.createEpic({
      projectId,
      statusId,
      title: 'Filtered fan-out destination',
    });
    const clickupConnection = await storage.getIntegrationConnection('clickup');
    await storage.createExternalTaskLink({
      epicId: secondParent.id,
      connectionId: clickupConnection!.id,
      provider: 'clickup',
      remoteScopeKey: 'workspace-clickup',
      remoteTaskId: 'clickup-filtered-parent',
      sourceSnapshot: { workAreaId: 'list-clickup', workAreaName: 'ClickUp List' },
    });
    await storage.createExternalTaskLink({
      epicId: secondParent.id,
      connectionId: jiraConnection.id,
      provider: 'jira',
      remoteScopeKey: 'acme.atlassian.net',
      remoteTaskId: 'JIRA-FILTERED-DESTINATION',
      sourceSnapshot: { workAreaId: 'board-jira', workAreaName: 'Jira Board' },
    });
    const child = await storage.getEpic(childId);
    await storage.updateEpic(childId, { parentId: secondParent.id }, child.version);
    await storage.updateExternalManagedSubtaskLink(clickupOld.id, {
      operationPhase: 'outcome_unknown',
      safeErrorCode: 'provider_timeout',
      retryAt: null,
    });
    clickup.calls.length = 0;
    jira.calls.length = 0;

    const results = await subscriber.reconcileEpic(childId, 'jira');

    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'jira', outcome: 'deleted' }),
        expect.objectContaining({ provider: 'jira', outcome: 'confirmed' }),
      ]),
    );
    expect(results).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ outcome: 'already_remote_unmanaged' })]),
    );
    expect(clickup.calls).toEqual([]);
    expect(jira.calls).toEqual(['jira:delete', 'jira:create']);
    expect(await storage.getExternalManagedSubtaskLink(clickupOld.id)).toMatchObject({
      operationPhase: 'outcome_unknown',
      parentEpicIdSnapshot: parentId,
    });
  });

  it('isolates fan-out failure so another provider still confirms', async () => {
    const jiraConnection = await storage.replaceIntegrationConnection(
      {
        provider: 'jira',
        credentials: {
          provider: 'jira',
          siteUrl: 'https://acme.atlassian.net',
          email: 'user@example.com',
          token: 'jira-token',
        },
        subtaskSyncEnabled: true,
      },
      async () => undefined,
    );
    await storage.createExternalTaskLink({
      epicId: parentId,
      connectionId: jiraConnection.id,
      provider: 'jira',
      remoteScopeKey: 'acme.atlassian.net',
      remoteTaskId: 'JIRA-PARENT',
      sourceSnapshot: { workAreaId: 'board-jira', workAreaName: 'Jira Board' },
    });
    clickup.create.mockRejectedValueOnce(new ExternalProviderError('clickup', 'request_rejected'));

    const results = await subscriber.reconcileEpic(childId);

    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'clickup', outcome: 'retry' }),
        expect.objectContaining({ provider: 'jira', outcome: 'confirmed' }),
      ]),
    );
    expect(jira.create).toHaveBeenCalledTimes(1);
    const clickupRow = await managed('clickup');
    await expect(subscriber.retryManagedLink(clickupRow.id)).rejects.toMatchObject({
      details: { reason: 'verification_required' },
    });
    await expect(subscriber.verifyManagedLink(clickupRow.id)).resolves.toMatchObject({
      outcome: 'confirmed',
    });
  });

  it('pauses without dispatch and catches up after the connection is enabled', async () => {
    await storage.updateIntegrationConnectionSyncSetting('clickup', false);
    await subscriber.reconcileProvider('clickup');
    expect(clickup.create).not.toHaveBeenCalled();

    const enabled = await storage.updateIntegrationConnectionSyncSetting('clickup', true);
    await subscriber.handleCommittedEvent({
      id: 'connection-event',
      name: 'integration.connection.updated',
      payload: {
        connectionId: enabled.id,
        provider: 'clickup',
        previousGeneration: enabled.generation,
        generation: enabled.generation,
        previousSubtaskSyncEnabled: true,
        subtaskSyncEnabled: false,
        previousSyncSettingRevision: enabled.syncSettingRevision - 1,
        syncSettingRevision: enabled.syncSettingRevision,
        createdAt: enabled.createdAt,
        updatedAt: enabled.updatedAt,
      },
      requestId: null,
      publishedAt: new Date().toISOString(),
    });

    expect(clickup.create).toHaveBeenCalledTimes(1);
    expect((await managed()).operationPhase).toBe('confirmed');
  });

  it('adopts one proven unknown create and never blindly creates twice', async () => {
    clickup.create.mockImplementationOnce(async (_credentials, _context, input) => {
      clickup.calls.push('clickup:create');
      const snapshot: ExternalSubtaskSnapshot = {
        remoteTaskId: 'unknown-created-child',
        remoteKey: 'UNKNOWN-CHILD',
        parentRemoteTaskId: input.parentRemoteTaskId,
        workAreaRemoteId: 'list-clickup',
        ownershipToken: input.ownershipToken,
        title: input.title,
        description: input.description,
      };
      clickup.remotes.set(snapshot.remoteTaskId, snapshot);
      throw new ExternalProviderError('clickup', 'timeout', { dispatched: true });
    });

    await expect(subscriber.reconcileEpic(childId)).resolves.toEqual([
      expect.objectContaining({ outcome: 'retry' }),
    ]);
    const unknown = await managed();
    expect(unknown.operationPhase).toBe('outcome_unknown');
    await expect(subscriber.retryManagedLink(unknown.id)).rejects.toMatchObject({
      details: { reason: 'verification_required' },
    });
    await subscriber.verifyManagedLink(unknown.id);

    expect(clickup.create).toHaveBeenCalledTimes(1);
    expect(clickup.update).not.toHaveBeenCalled();
    expect((await managed()).remoteTaskId).toBe('unknown-created-child');
    expect(await managed()).toMatchObject({
      operationPhase: 'confirmed',
      confirmedFingerprint: unknown.desiredFingerprint,
    });
  });

  it('adopts actual stale create content and performs one owned update to current content', async () => {
    clickup.create.mockImplementationOnce(async (_credentials, _context, input) => {
      clickup.calls.push('clickup:create');
      const snapshot: ExternalSubtaskSnapshot = {
        remoteTaskId: 'stale-created-child',
        remoteKey: 'STALE-CHILD',
        parentRemoteTaskId: input.parentRemoteTaskId,
        workAreaRemoteId: 'list-clickup',
        ownershipToken: input.ownershipToken,
        title: input.title,
        description: input.description,
      };
      clickup.remotes.set(snapshot.remoteTaskId, snapshot);
      throw new ExternalProviderError('clickup', 'timeout', { dispatched: true });
    });
    await subscriber.reconcileEpic(childId);
    const unknown = await managed();
    const child = await storage.getEpic(childId);
    await storage.updateEpic(
      childId,
      { title: 'Current title', description: 'Current description' },
      child.version,
    );
    const confirm = jest.spyOn(storage, 'confirmExternalManagedSubtaskLink');

    await subscriber.verifyManagedLink(unknown.id);

    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm.mock.calls[0]?.[0]).toMatchObject({
      sourceSnapshot: { title: 'Child', description: 'Description' },
    });
    expect(confirm.mock.calls[0]?.[0].confirmedFingerprint).not.toBe(
      confirm.mock.calls[1]?.[0].confirmedFingerprint,
    );
    expect(clickup.create).toHaveBeenCalledTimes(1);
    expect(clickup.update).toHaveBeenCalledTimes(1);
    expect(clickup.remotes.get('stale-created-child')).toMatchObject({
      title: 'Current title',
      description: 'Current description',
    });
    const converged = await managed();
    expect(converged).toMatchObject({
      operationPhase: 'confirmed',
      confirmedFingerprint: converged.desiredFingerprint,
    });
  });

  it('replays a persisted adopted-content mismatch after a crash before update', async () => {
    clickup.create.mockImplementationOnce(async (_credentials, _context, input) => {
      clickup.calls.push('clickup:create');
      const snapshot: ExternalSubtaskSnapshot = {
        remoteTaskId: 'crash-adopted-child',
        remoteKey: 'CRASH-CHILD',
        parentRemoteTaskId: input.parentRemoteTaskId,
        workAreaRemoteId: 'list-clickup',
        ownershipToken: input.ownershipToken,
        title: input.title,
        description: input.description,
      };
      clickup.remotes.set(snapshot.remoteTaskId, snapshot);
      throw new ExternalProviderError('clickup', 'timeout', { dispatched: true });
    });
    await subscriber.reconcileEpic(childId);
    const unknown = await managed();
    const child = await storage.getEpic(childId);
    const updated = await storage.updateEpic(
      childId,
      { title: 'Replay title', description: 'Replay description' },
      child.version,
    );
    const desiredFingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          title: updated.title,
          description: updated.description,
          parentSourceLinkId: unknown.parentSourceLinkIdSnapshot,
          parentRemoteTaskId: unknown.parentRemoteTaskId,
        }),
      )
      .digest('hex');
    const current = await storage.updateExternalManagedSubtaskLink(unknown.id, {
      desiredVersion: updated.version,
      desiredFingerprint,
      retryAt: null,
    });
    const snapshot = clickup.remotes.get('crash-adopted-child')!;
    const adoptedFingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          title: snapshot.title,
          description: snapshot.description,
          parentSourceLinkId: current.parentSourceLinkIdSnapshot,
          parentRemoteTaskId: current.parentRemoteTaskId,
        }),
      )
      .digest('hex');
    await storage.confirmExternalManagedSubtaskLink({
      managedLinkId: current.id,
      remoteTaskId: snapshot.remoteTaskId,
      remoteKey: snapshot.remoteKey,
      confirmedVersion: current.desiredVersion,
      confirmedFingerprint: adoptedFingerprint,
      sourceSnapshot: {
        remoteKey: snapshot.remoteKey,
        title: snapshot.title,
        description: snapshot.description,
        ownershipToken: current.ownershipToken,
        parentRemoteTaskId: current.parentRemoteTaskId,
        workAreaRemoteId: current.workAreaRemoteId,
      },
    });
    const afterCrash = await managed();
    expect(afterCrash).toMatchObject({
      operationPhase: 'confirmed',
      confirmedFingerprint: adoptedFingerprint,
    });
    expect(afterCrash.confirmedFingerprint).not.toBe(afterCrash.desiredFingerprint);

    await subscriber.reconcileEpic(childId);

    expect(clickup.create).toHaveBeenCalledTimes(1);
    expect(clickup.update).toHaveBeenCalledTimes(1);
    expect(clickup.remotes.get('crash-adopted-child')).toMatchObject({
      title: 'Replay title',
      description: 'Replay description',
    });
    const replayed = await managed();
    expect(replayed.confirmedFingerprint).toBe(replayed.desiredFingerprint);
  });

  it('verifies ownership before retrying when create succeeds but local confirmation fails', async () => {
    jest
      .spyOn(storage, 'confirmExternalManagedSubtaskLink')
      .mockRejectedValueOnce(new Error('local confirmation failed'));

    await expect(subscriber.reconcileEpic(childId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outcome: 'retry', reason: 'post_dispatch_local_failure' }),
      ]),
    );
    const unknown = await managed();
    expect(unknown).toMatchObject({
      operationPhase: 'outcome_unknown',
      safeErrorCode: 'post_dispatch_local_failure',
      remoteTaskId: null,
    });
    expect(clickup.create).toHaveBeenCalledTimes(1);

    await expect(subscriber.retryManagedLink(unknown.id)).rejects.toMatchObject({
      details: { reason: 'verification_required' },
    });
    expect(clickup.create).toHaveBeenCalledTimes(1);
    expect(clickup.listOwned).not.toHaveBeenCalled();

    await subscriber.verifyManagedLink(unknown.id);

    expect(clickup.listOwned).toHaveBeenCalledTimes(1);
    expect(clickup.create).toHaveBeenCalledTimes(1);
    expect(await managed()).toMatchObject({
      operationPhase: 'confirmed',
      remoteTaskId: 'clickup-child-1',
    });
  });

  it.each(MANAGED_SUBTASK_RETRY_BLOCKED_REASONS)(
    'rejects manual Retry for blocked reason %s',
    async (safeErrorCode) => {
      await subscriber.reconcileEpic(childId);
      const managedRow = await managed();
      await storage.updateExternalManagedSubtaskLink(managedRow.id, {
        operationPhase: 'needs_attention',
        safeErrorCode,
      });

      await expect(subscriber.retryManagedLink(managedRow.id)).rejects.toMatchObject({
        details: { reason: safeErrorCode },
      });
      expect(clickup.update).not.toHaveBeenCalled();
      expect(clickup.create).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects manual Retry when the projection is already confirmed', async () => {
    await subscriber.reconcileEpic(childId);
    const managedRow = await managed();

    await expect(subscriber.retryManagedLink(managedRow.id)).rejects.toMatchObject({
      details: { reason: 'retry_not_available' },
    });

    expect(clickup.create).toHaveBeenCalledTimes(1);
    expect(clickup.update).not.toHaveBeenCalled();
  });

  it('retries an unknown create only after a complete zero-match ownership scan', async () => {
    clickup.create.mockRejectedValueOnce(
      new ExternalProviderError('clickup', 'timeout', { dispatched: true }),
    );

    await subscriber.reconcileEpic(childId);
    const unknown = await managed();
    await storage.updateExternalManagedSubtaskLink(unknown.id, { retryAt: null });
    await subscriber.reconcileEpic(childId);

    expect(clickup.create).toHaveBeenCalledTimes(2);
    expect((await managed()).operationPhase).toBe('confirmed');
  });

  it.each([
    ['multiple_owned_children', 'multiple'] as const,
    ['ownership_scan_incomplete', 'incomplete'] as const,
  ])('requires attention for unknown create verification: %s', async (expectedCode, mode) => {
    clickup.create.mockRejectedValueOnce(
      new ExternalProviderError('clickup', 'timeout', { dispatched: true }),
    );
    await subscriber.reconcileEpic(childId);
    const unknown = await managed();
    if (mode === 'multiple') {
      for (const suffix of ['a', 'b']) {
        clickup.remotes.set(`ambiguous-${suffix}`, {
          remoteTaskId: `ambiguous-${suffix}`,
          remoteKey: `AMBIGUOUS-${suffix}`,
          parentRemoteTaskId: unknown.parentRemoteTaskId,
          workAreaRemoteId: unknown.workAreaRemoteId,
          ownershipToken: unknown.ownershipToken,
          title: 'Child',
          description: 'Description',
        });
      }
    } else {
      clickup.listOwned.mockResolvedValueOnce({ items: [], complete: false });
    }

    await subscriber.verifyManagedLink(unknown.id);

    expect(await managed()).toMatchObject({
      operationPhase: 'needs_attention',
      safeErrorCode: expectedCode,
    });
    expect(clickup.create).toHaveBeenCalledTimes(1);
  });

  it('recovers dispatch admission and repairs a missing ordinary recognition link', async () => {
    await subscriber.reconcileEpic(childId);
    const row = await managed();
    sqlite.prepare('DELETE FROM external_task_links WHERE epic_id = ?').run(childId);
    await storage.updateExternalManagedSubtaskLink(row.id, {
      operationPhase: 'dispatch_admitted',
      safeErrorCode: null,
    });

    await subscriber.reconcileEpic(childId);

    expect(clickup.create).toHaveBeenCalledTimes(1);
    expect(clickup.update).not.toHaveBeenCalled();
    expect(
      await storage.findRecognizedManagedSubtask(
        childId,
        'clickup',
        row.remoteScopeKey,
        row.remoteTaskId!,
      ),
    ).toMatchObject({ id: row.id, operationPhase: 'confirmed' });
  });

  it('verifies an unknown update exactly instead of dispatching it twice', async () => {
    await subscriber.reconcileEpic(childId);
    const row = await managed();
    const child = await storage.getEpic(childId);
    await storage.updateEpic(childId, { title: 'Unknown update landed' }, child.version);
    clickup.update.mockImplementationOnce(async (_credentials, _context, input) => {
      clickup.calls.push('clickup:update');
      const current = clickup.remotes.get(input.remoteTaskId)!;
      clickup.remotes.set(input.remoteTaskId, { ...current, title: input.title! });
      throw new ExternalProviderError('clickup', 'timeout', { dispatched: true });
    });

    await subscriber.reconcileEpic(childId);
    await storage.updateExternalManagedSubtaskLink(row.id, { retryAt: null });
    await subscriber.reconcileEpic(childId);

    expect(clickup.update).toHaveBeenCalledTimes(1);
    expect(await managed()).toMatchObject({
      operationPhase: 'confirmed',
      confirmedVersion: child.version + 1,
    });
  });

  it('accepts ClickUp canonical Markdown while verifying an unknown update', async () => {
    await subscriber.reconcileEpic(childId);
    const child = await storage.getEpic(childId);
    await storage.updateEpic(
      childId,
      { description: '### Context\n- Rationale: use devchain_get_prompt' },
      child.version,
    );
    clickup.update.mockImplementationOnce(async (_credentials, _context, input) => {
      clickup.calls.push('clickup:update');
      const current = clickup.remotes.get(input.remoteTaskId)!;
      clickup.remotes.set(input.remoteTaskId, {
        ...current,
        description: '### Context\n*   Rationale: use devchain\\_get\\_prompt',
      });
      throw new ExternalProviderError('clickup', 'timeout', { dispatched: true });
    });

    await subscriber.reconcileEpic(childId);
    const unknown = await managed();
    expect(unknown.operationPhase).toBe('outcome_unknown');

    await subscriber.verifyManagedLink(unknown.id);

    expect(clickup.update).toHaveBeenCalledTimes(1);
    expect(await managed()).toMatchObject({
      operationPhase: 'confirmed',
      safeErrorCode: null,
    });
  });

  it('verifies an update before retrying when local confirmation fails after dispatch', async () => {
    await subscriber.reconcileEpic(childId);
    const row = await managed();
    const child = await storage.getEpic(childId);
    await storage.updateEpic(childId, { title: 'Confirmed remotely only' }, child.version);
    jest
      .spyOn(storage, 'confirmExternalManagedSubtaskLink')
      .mockRejectedValueOnce(new Error('local confirmation failed'));

    await expect(subscriber.reconcileEpic(childId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outcome: 'retry', reason: 'post_dispatch_local_failure' }),
      ]),
    );
    expect(await managed()).toMatchObject({
      operationPhase: 'outcome_unknown',
      remoteTaskId: row.remoteTaskId,
    });
    await expect(subscriber.retryManagedLink(row.id)).rejects.toMatchObject({
      details: { reason: 'verification_required' },
    });

    await subscriber.verifyManagedLink(row.id);

    expect(clickup.update).toHaveBeenCalledTimes(1);
    expect((await managed()).operationPhase).toBe('confirmed');
  });

  it('re-fences a confirmed projection after credential generation changes only with exact proof', async () => {
    await subscriber.reconcileEpic(childId);
    const before = await managed();
    const replacement = await storage.replaceIntegrationConnection(
      {
        provider: 'clickup',
        credentials: { provider: 'clickup', token: 'replacement-token' },
      },
      async () => undefined,
    );

    await subscriber.reconcileProvider('clickup');

    expect(await managed()).toMatchObject({
      id: before.id,
      connectionGeneration: replacement.generation,
      operationPhase: 'confirmed',
    });
    expect(clickup.update).not.toHaveBeenCalled();
  });

  it('blocks writes when the ownership marker disappears', async () => {
    await subscriber.reconcileEpic(childId);
    const row = await managed();
    clickup.remotes.set(row.remoteTaskId!, {
      ...clickup.remotes.get(row.remoteTaskId!)!,
      ownershipToken: null,
    });
    const child = await storage.getEpic(childId);
    await storage.updateEpic(childId, { title: 'Must not dispatch' }, child.version);

    await subscriber.reconcileEpic(childId);

    expect(clickup.update).not.toHaveBeenCalled();
    expect(await managed()).toMatchObject({
      operationPhase: 'needs_attention',
      safeErrorCode: 'ownership_marker_missing',
    });
  });

  it('converges an unknown delete and a linked-root cascade through exact absence', async () => {
    await subscriber.reconcileEpic(childId);
    clickup.delete.mockImplementationOnce(async (_credentials, _context, proof) => {
      clickup.calls.push('clickup:delete');
      clickup.remotes.delete(proof.remoteTaskId);
      throw new ExternalProviderError('clickup', 'timeout', { dispatched: true });
    });
    await storage.deleteEpic(parentId);

    await expect(subscriber.reconcileEpic(childId)).resolves.toEqual([
      expect.objectContaining({ outcome: 'retry' }),
    ]);
    const unknown = await managed();
    await storage.updateExternalManagedSubtaskLink(unknown.id, { retryAt: null });
    await subscriber.reconcileEpic(childId);

    expect(clickup.delete).toHaveBeenCalledTimes(1);
    expect(await storage.listExternalManagedSubtaskLinksByProvider('clickup')).toEqual([]);
  });

  it('verifies exact absence before retrying when local cleanup fails after delete', async () => {
    await subscriber.reconcileEpic(childId);
    const row = await managed();
    await storage.deleteEpic(childId);
    jest
      .spyOn(storage, 'removeExternalManagedSubtaskLink')
      .mockRejectedValueOnce(new Error('local cleanup failed'));

    await expect(subscriber.reconcileEpic(childId)).resolves.toEqual([
      expect.objectContaining({ outcome: 'retry', reason: 'post_dispatch_local_failure' }),
    ]);
    expect((await managed()).operationPhase).toBe('outcome_unknown');
    await expect(subscriber.retryManagedLink(row.id)).rejects.toMatchObject({
      details: { reason: 'verification_required' },
    });

    await subscriber.verifyManagedLink(row.id);

    expect(clickup.delete).toHaveBeenCalledTimes(1);
    expect(await storage.listExternalManagedSubtaskLinksByProvider('clickup')).toEqual([]);
  });
});
