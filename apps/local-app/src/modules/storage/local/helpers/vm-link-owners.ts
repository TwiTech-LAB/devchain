import type Database from 'better-sqlite3';
import { readSettingMap, writeSetting } from './external-link-receipts';

/**
 * Home's record of the `remote` projects whose ordinary links a VM owns:
 * `{ projectId: { remoteId, bindingCreatedAt, since } }`. An entry counts only for the
 * binding it names, so it never outlives a detach into a later attach. Every helper runs
 * inside the caller's transaction.
 */
const OWNERS_KEY = 'remotes.home.vmLinkOwners';

interface VmLinkOwner {
  remoteId: string;
  bindingCreatedAt: string;
  since: string;
}

interface BindingIdentity {
  remoteId: string;
  createdAt: string;
}

function readOwners(db: Database.Database): Record<string, VmLinkOwner> {
  return readSettingMap<VmLinkOwner>(db, OWNERS_KEY, 'VM link owners');
}

function writeOwners(db: Database.Database, owners: Record<string, VmLinkOwner>): void {
  writeSetting(db, OWNERS_KEY, JSON.stringify(owners), new Date().toISOString());
}

/** When the VM came to own the links of `binding`'s project, or null. */
export function readVmLinkOwner(
  db: Database.Database,
  projectId: string,
  binding: BindingIdentity,
): string | null {
  const owner = readOwners(db)[projectId];
  return owner?.remoteId === binding.remoteId && owner.bindingCreatedAt === binding.createdAt
    ? owner.since
    : null;
}

/** Records the VM of `binding` as the owner of `projectId`'s links; an earlier record stays. */
export function markVmLinkOwner(
  db: Database.Database,
  projectId: string,
  binding: BindingIdentity,
): void {
  if (readVmLinkOwner(db, projectId, binding) !== null) return;
  const owners = readOwners(db);
  owners[projectId] = {
    remoteId: binding.remoteId,
    bindingCreatedAt: binding.createdAt,
    since: new Date().toISOString(),
  };
  writeOwners(db, owners);
}

export function forgetVmLinkOwner(db: Database.Database, projectId: string): void {
  const owners = readOwners(db);
  if (!(projectId in owners)) return;
  delete owners[projectId];
  writeOwners(db, owners);
}
