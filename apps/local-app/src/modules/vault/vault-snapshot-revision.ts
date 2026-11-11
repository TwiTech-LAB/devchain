import { createHash } from 'node:crypto';
import type { VaultSnapshot } from '../storage/models/domain.models';

/** Code-unit order, the same on every host (no locale compare). */
function byKey(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Rows as tuples in one order, so the hash ignores row order. */
function sortedRows<T>(rows: readonly T[], tuple: (row: T) => unknown[]): unknown[][] {
  return rows.map(tuple).sort((a, b) => byKey(JSON.stringify(a), JSON.stringify(b)));
}

/**
 * Home and VM compute the same revision for the same entries, grants, access rows and
 * family approvals, in any order. It covers names, descriptions, approval flags, grants,
 * access and approvals as well as entry revisions, so a change to any of them alone also
 * reaches the VM. It never covers values. A snapshot field missing here is never pushed
 * again after its first change.
 */
export function vaultSnapshotRevision(snapshot: VaultSnapshot): string {
  const entries = [...snapshot.entries]
    .sort((a, b) => byKey(a.id, b.id))
    .map((entry) => [
      entry.id,
      entry.projectId,
      entry.name,
      entry.kind,
      entry.description,
      entry.revision,
      entry.approvalRequired,
    ]);
  const grants = sortedRows(snapshot.grants, (grant) => [
    grant.entryId,
    grant.projectId,
    grant.familySlug,
  ]);
  const access = sortedRows(snapshot.access, (row) => [row.projectId, row.familySlug]);
  const approvals = sortedRows(snapshot.approvals, (row) => [
    row.entryId,
    row.projectId,
    row.familySlug,
  ]);
  return createHash('sha256')
    .update(JSON.stringify({ entries, grants, access, approvals }))
    .digest('hex');
}
