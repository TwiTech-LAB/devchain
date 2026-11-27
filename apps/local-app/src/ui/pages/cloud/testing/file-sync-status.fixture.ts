import type { FileSyncStatusScope } from '../lib/remote-vm-contracts';

/** A measured file sync scope with nothing pending and nothing failed. */
export function syncScope(overrides: Partial<FileSyncStatusScope> = {}): FileSyncStatusScope {
  return {
    projectId: 'p1',
    remoteId: 'r1',
    verdict: 'in-sync',
    reason: null,
    toVm: { items: 0, bytes: 0 },
    fromVm: { items: 0, bytes: 0 },
    failed: { home: 0, vm: 0 },
    files: 1,
    bytes: 1,
    lastReceived: null,
    ...overrides,
  };
}
