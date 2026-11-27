import type { FolderSyncStatus } from '../../file-sync/file-sync.dto';
import {
  scopeStatus,
  type ScopeFacts,
  type ScopeMemory,
  type ScopeOutcome,
  type VerdictFolder,
} from './file-sync-verdict';

// A pure function of its inputs: a unit table covers the verdict order without Syncthing.
const NOW = 1_000_000;

function status(
  fields: Partial<FolderSyncStatus> = {},
  peer: Partial<NonNullable<FolderSyncStatus['peer']>> = {},
): FolderSyncStatus {
  return {
    folderId: 'code:p',
    state: 'idle',
    localFiles: 1,
    localDirectories: 0,
    globalFiles: 1,
    globalDirectories: 0,
    needTotalItems: 0,
    needBytes: 0,
    receiveOnlyChangedFiles: 0,
    ...fields,
    peer: {
      deviceId: 'VM',
      completion: 100,
      needItems: 0,
      needBytes: 0,
      needDeletes: 0,
      remoteState: 'valid',
      ...peer,
    },
  };
}

const folder = (type = 'sendreceive', folderStatus = status()): VerdictFolder => ({
  type,
  paused: false,
  status: folderStatus,
});

const upkeepDone = {
  remoteId: 'vm',
  done: true,
  problem: null,
  warning: null,
  vmFailed: null,
};

function facts(fields: Partial<ScopeFacts> = {}): ScopeFacts {
  return {
    syncthing: { running: true, error: null },
    readFailed: false,
    codeConfigured: true,
    connected: true,
    forceSync: null,
    upkeepTrusted: true,
    upkeep: upkeepDone,
    folders: [folder()],
    ...fields,
  };
}

const sample = (items: number, ageMs: number, progressAgeMs?: number): ScopeMemory => ({
  fromVm: {
    items,
    bytes: items * 10,
    at: NOW - ageMs,
    ...(progressAgeMs !== undefined && { progressAt: NOW - progressAgeMs }),
  },
});
const pendingFromVm = (items: number) =>
  facts({
    folders: [folder('sendreceive', status({ needTotalItems: items, needBytes: items * 10 }))],
  });

const upkeepProblem = {
  ...upkeepDone,
  problem: 'stalled' as const,
  warning: 'Files from the VM made no progress for 10 minutes.',
};

describe('scopeStatus verdict order', () => {
  it.each<[string, ScopeFacts, ScopeMemory | undefined, Partial<ScopeOutcome>]>([
    [
      'Syncthing down',
      facts({ syncthing: { running: false, error: 'Syncthing exited unexpectedly' } }),
      undefined,
      { verdict: 'unknown', reason: 'Syncthing exited unexpectedly', toVm: null, fromVm: null },
    ],
    [
      'code folder absent',
      facts({ codeConfigured: false, folders: [] }),
      undefined,
      { verdict: 'problem', reason: 'File sync is not set up for this project on this PC.' },
    ],
    [
      'code folder absent while upkeep sets it up',
      facts({ codeConfigured: false, folders: [], upkeep: { ...upkeepDone, done: false } }),
      undefined,
      { verdict: 'busy', reason: 'File sync is being set up.' },
    ],
    [
      'VM device not connected with pending work',
      facts({ connected: false, folders: [folder('sendreceive', status({ needTotalItems: 3 }))] }),
      undefined,
      { verdict: 'disconnected', reason: 'No file sync connection to the VM.' },
    ],
    [
      'force_sync failed',
      facts({ forceSync: 'failed' }),
      undefined,
      { verdict: 'problem', reason: 'Force sync stopped. Open Activity to continue.' },
    ],
    [
      'force_sync running',
      facts({ forceSync: 'running' }),
      undefined,
      { verdict: 'busy', reason: 'Force sync is running.' },
    ],
    [
      'upkeep trusted with a problem',
      facts({ upkeep: upkeepProblem }),
      undefined,
      { verdict: 'problem', reason: upkeepProblem.warning },
    ],
    [
      'upkeep not trusted with an old problem',
      facts({ upkeepTrusted: false, upkeep: upkeepProblem }),
      undefined,
      { verdict: 'in-sync', reason: null },
    ],
    [
      'folder paused in config with state ""',
      facts({ folders: [folder(), { type: 'sendreceive', paused: true, status: null }] }),
      undefined,
      { verdict: 'busy', reason: 'File sync is paused on this PC.' },
    ],
    [
      'remoteState paused',
      facts({ folders: [folder('sendreceive', status({}, { remoteState: 'paused' }))] }),
      undefined,
      { verdict: 'busy', reason: 'File sync is paused on the VM.' },
    ],
    [
      'remoteState notSharing',
      facts({ folders: [folder('sendreceive', status({}, { remoteState: 'notSharing' }))] }),
      undefined,
      { verdict: 'problem', reason: 'The VM does not share this folder.' },
    ],
    [
      'home folder state syncing',
      facts({ folders: [folder('sendreceive', status({ state: 'syncing' }))] }),
      undefined,
      { verdict: 'syncing', reason: null },
    ],
    [
      'pending work whose count went down',
      pendingFromVm(3),
      sample(5, 5_000),
      { verdict: 'syncing', fromVm: { items: 3, bytes: 30 } },
    ],
    [
      'pending work whose count did not go down',
      pendingFromVm(3),
      sample(3, 5_000),
      { verdict: 'waiting', reason: null, fromVm: { items: 3, bytes: 30 } },
    ],
    [
      'pending work whose count stayed the same after a recent decrease',
      pendingFromVm(3),
      sample(3, 5_000, 5_000),
      { verdict: 'syncing' },
    ],
    [
      'pending work whose count went up after a decrease',
      pendingFromVm(4),
      sample(3, 5_000, 5_000),
      { verdict: 'waiting', memory: { fromVm: { items: 4, bytes: 40, at: NOW } } },
    ],
    [
      'a direction that became unreadable after a decrease',
      facts({ folders: [folder('sendonly')] }),
      sample(3, 5_000, 5_000),
      {
        verdict: 'in-sync',
        fromVm: null,
        memory: { fromVm: { items: 3, bytes: 30, at: NOW - 5_000 } },
      },
    ],
    [
      'pending work that went from 1 to 0',
      facts(),
      sample(1, 5_000),
      { verdict: 'in-sync', fromVm: { items: 0, bytes: 0 } },
    ],
    [
      'need on a sendonly folder',
      facts({
        folders: [folder(), folder('sendonly', status({ needTotalItems: 4, needBytes: 9 }))],
      }),
      undefined,
      { verdict: 'in-sync', fromVm: { items: 0, bytes: 0 } },
    ],
    [
      'deletions pending for the VM',
      facts({ folders: [folder('sendreceive', status({}, { needItems: 1, needDeletes: 2 }))] }),
      undefined,
      { verdict: 'waiting', toVm: { items: 3, bytes: 0 } },
    ],
    [
      'failed.home > 0 with nothing pending',
      facts({ folders: [folder('sendreceive', status({ errors: 2 }))] }),
      undefined,
      { verdict: 'problem', reason: '2 files on this PC fail to sync.', failedHome: 2 },
    ],
    [
      'all valid with nothing pending',
      facts(),
      undefined,
      { verdict: 'in-sync', reason: null, toVm: { items: 0, bytes: 0 }, failedHome: 0 },
    ],
  ])('%s', (_name, input, memory, expected) => {
    const { memory: expectedMemory, ...fields } = expected;
    const outcome = scopeStatus(input, memory, NOW);
    expect(outcome).toMatchObject(fields);
    // Strict, so a kept progressAt fails the row.
    if (expectedMemory) expect(outcome.memory.fromVm).toEqual(expectedMemory.fromVm);
  });
});
