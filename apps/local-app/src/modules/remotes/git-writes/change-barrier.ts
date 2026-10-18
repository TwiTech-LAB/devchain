/**
 * Waits until every item the source changed up to its recorded sequence has reached the
 * destination, or is one of the destination's failed items (those show in the file sync warning
 * and are never waited on). Global completion is not used: it never settles while the other
 * side keeps saving. See docs/git-coordinator.md (Home writes).
 */
export async function waitForChangeBarrier(options: {
  /** Folder id → the source's local Syncthing sequence after its scan. */
  sequences: Record<string, number>;
  /** Names the destination still needs from the source, of changes up to `sequence`. */
  needed: (folderId: string, sequence: number) => Promise<string[]>;
  /** Paths the destination failed to sync in this folder. */
  failed: (folderId: string) => Promise<string[]>;
  timeoutMs: number;
  pollMs: number;
  sleep: (ms: number) => Promise<void>;
}): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const counts = await Promise.all(
      Object.entries(options.sequences).map(async ([folderId, sequence]) => {
        const needed = await options.needed(folderId, sequence);
        if (needed.length === 0) return 0;
        const failed = new Set(await options.failed(folderId));
        return needed.filter((name) => !failed.has(name)).length;
      }),
    );
    const pending = counts.reduce((sum, count) => sum + count, 0);
    if (pending === 0) return;
    if (Date.now() >= deadline)
      throw new ChangeBarrierTimeoutError(`${pending} changed items have not arrived yet`);
    await options.sleep(options.pollMs);
  }
}

export class ChangeBarrierTimeoutError extends Error {}

/**
 * Scans the folders in parallel and reads each one's local sequence after its scan. Returns once
 * every scan has ended; a failure is thrown in folder order.
 */
export async function scanSequences(
  files: {
    rescan(folderId: string): Promise<void>;
    status(folderId: string): Promise<{ sequence?: number }>;
  },
  folderIds: string[],
): Promise<Record<string, number | undefined>> {
  const scans = await Promise.allSettled(
    folderIds.map(async (folderId) => {
      await files.rescan(folderId);
      return (await files.status(folderId)).sequence;
    }),
  );
  const sequences: Record<string, number | undefined> = {};
  scans.forEach((scan, index) => {
    if (scan.status === 'rejected') throw scan.reason;
    sequences[folderIds[index]] = scan.value;
  });
  return sequences;
}
