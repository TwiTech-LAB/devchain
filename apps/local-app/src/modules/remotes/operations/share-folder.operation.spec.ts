import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileSyncService } from '../../file-sync/file-sync.service';
import type { RemoteOperation, RemoteOperationStep } from '../../storage/models/domain.models';
import type { RemoteHealthPort, RemoteHealthState } from '../ports/remote-health.port';
import type { SharedFolderEntriesPort } from '../ports/shared-folder-entries.port';
import type { FileSyncHandoff } from './file-sync-handoff';
import { ShareFolderOperation, shareFolderOperationDetails } from './share-folder.operation';
import type { RemoteOperationStepRun } from './remote-operation.types';

// Unit: the step order, the cancel rule and rollback's effects on both shares and on the
// store entry are this definition's own decisions; the copy itself is covered by the handoff spec.

const root = mkdtempSync(join(tmpdir(), 'devchain-share-op-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ONLINE: RemoteHealthState = {
  online: true,
  version: '1.0.0',
  versionMatches: true,
  homePath: null,
  uid: null,
  gid: null,
  stats: null,
  lastSeenAt: null,
  error: null,
};

function setup(health: RemoteHealthState = ONLINE) {
  const handoff = {
    pair: jest.fn(async () => ({ home: 'HOME', host: 'HOST' })),
    copyShare: jest.fn(async () => undefined),
    syncShareBothWays: jest.fn(async () => undefined),
    removeShare: jest.fn(async (): Promise<string | null> => null),
    ensureAvailable: jest.fn(async () => undefined),
    interrupt: jest.fn(),
  };
  const files = { assertSharePath: jest.fn(async (path: string) => path) };
  const entries = {
    sharedPaths: jest.fn(() => [join(root, 'other'), join(root, 'notes') + '/']),
    remove: jest.fn(),
  };
  const definition = new ShareFolderOperation(
    { refresh: jest.fn(async () => health) } as unknown as RemoteHealthPort,
    files as unknown as FileSyncService,
    handoff as unknown as FileSyncHandoff,
    entries as SharedFolderEntriesPort,
  );
  return { definition, handoff, files, entries };
}

function operation(
  states: Partial<Record<string, RemoteOperationStep['state']>>,
  path = join(root, 'notes'),
  state: RemoteOperation['state'] = 'failed',
): RemoteOperation {
  return {
    id: 'op-1',
    kind: 'share_folder',
    remoteId: 'r1',
    projectId: null,
    state,
    steps: ['preflight', 'pair', 'copy', 'sync'].map((id) => ({
      id,
      label: id,
      state: states[id] ?? 'pending',
      startedAt: states[id] && states[id] !== 'pending' ? '2026-11-17T00:00:00Z' : null,
      endedAt: null,
      error: null,
    })),
    details: { ...shareFolderOperationDetails({ path, ignores: ['/cache'] }) },
    createdAt: '2026-11-17T00:00:00Z',
    updatedAt: '2026-11-17T00:00:00Z',
  };
}

function stepRun(op: RemoteOperation): RemoteOperationStepRun {
  return { operation: op, details: { ...op.details }, progress: async () => undefined };
}

describe('ShareFolderOperation', () => {
  it.each<
    [
      string,
      RemoteOperation['state'],
      Partial<Record<string, RemoteOperationStep['state']>>,
      boolean,
    ]
  >([
    ['before the copy', 'failed', { preflight: 'done', pair: 'failed' }, true],
    ['while the copy runs', 'running', { preflight: 'done', pair: 'done', copy: 'running' }, true],
    ['after a failed copy', 'failed', { preflight: 'done', pair: 'done', copy: 'failed' }, true],
    ['after the copy ends', 'running', { preflight: 'done', pair: 'done', copy: 'done' }, false],
    ['while two-way sync runs', 'running', { copy: 'done', sync: 'running' }, false],
    // A cause that does not go away must not lock the VM and the share for good.
    ['after two-way sync failed', 'failed', { copy: 'done', sync: 'failed' }, true],
  ])('decides Cancel %s', (_case, state, states, allowed) => {
    const { definition } = setup();
    const check = () => definition.assertCancellable(operation(states, join(root, 'notes'), state));
    if (allowed) expect(check).not.toThrow();
    else expect(check).toThrow('already copied');
  });

  it.each<[string, boolean, string | null]>([
    ['a share cancelled before the copy', false, null],
    ['a share cancelled during the copy', true, null],
    ['a copy whose VM folder cannot be removed', true, 'VM offline'],
  ])('rolls back %s', async (_case, copyStarted, hostError) => {
    const { definition, handoff, entries } = setup();
    handoff.removeShare.mockResolvedValue(hostError);
    const op = operation(copyStarted ? { copy: 'failed' } : { pair: 'failed' });

    const result = await definition.rollback(op);

    if (copyStarted) expect(handoff.removeShare).toHaveBeenCalledWith('r1', op.details.shareId);
    else expect(handoff.removeShare).not.toHaveBeenCalled();
    expect(entries.remove).toHaveBeenCalledWith('r1', join(root, 'notes'));
    expect(result).toEqual(hostError ? { hostFolderRemovalError: hostError } : {});
  });

  it('checks the path against the other shares, leaving its own entry out', async () => {
    const { definition, files } = setup();
    const notes = join(root, 'notes');
    mkdirSync(notes, { recursive: true });

    await definition.steps[0].run(stepRun(operation({})));

    expect(files.assertSharePath).toHaveBeenCalledWith(notes, [join(root, 'other')]);
  });

  it.each<[string, () => RemoteOperation, RemoteHealthState, string]>([
    [
      'a missing folder',
      () => operation({}, join(root, 'missing')),
      ONLINE,
      'SHARED_FOLDER_MISSING',
    ],
    [
      'a file',
      () => (writeFileSync(join(root, 'file'), ''), operation({}, join(root, 'file'))),
      ONLINE,
      'SHARED_FOLDER_MISSING',
    ],
    [
      'a share id of another path',
      () => ({ ...operation({}), details: { ...operation({}).details, shareId: '0'.repeat(16) } }),
      ONLINE,
      'SHARE_FOLDER_ID_MISMATCH',
    ],
    ['an offline VM', () => operation({}), { ...ONLINE, online: false }, 'REMOTE_OFFLINE'],
  ])('refuses %s in preflight', async (_case, op, health, code) => {
    const { definition } = setup(health);
    await expect(definition.steps[0].run(stepRun(op()))).rejects.toMatchObject({ code });
  });
});
