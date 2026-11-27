import type { IntegrationProvider } from '../../storage/models/domain.models';
import { ExternalProviderError } from '../errors/external-provider.errors';
import type {
  ExternalSubtaskSnapshot,
  ExternalSubtaskSyncCapability,
} from '../models/external-provider.models';
import type { ExternalTaskProvider } from '../ports/external-task-provider';

/**
 * In-memory vendor for managed-subtask sync tests. `calls` records every
 * mutating vendor request in order, as `<provider>:create|update|delete`.
 */
export interface FakeSubtaskSyncProvider {
  adapter: ExternalTaskProvider;
  remotes: Map<string, ExternalSubtaskSnapshot>;
  create: jest.Mock;
  update: jest.Mock;
  delete: jest.Mock;
  listOwned: jest.Mock;
  calls: string[];
}

export function fakeSubtaskSyncProvider(provider: IntegrationProvider): FakeSubtaskSyncProvider {
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
