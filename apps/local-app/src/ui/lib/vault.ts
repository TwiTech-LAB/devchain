// The REST contract types are the server's own (docs/ui-kit-guide.md Part 1, item 1).
import type {
  UpdateVaultEntry as UpdateVaultEntryInput,
  VaultEntry,
  VaultEntryGrant,
  VaultEntryKind,
  VaultEntryProjectAccess,
  VaultFamilyAccess,
  VaultGivenAccess,
  VaultGrant,
  VaultGrantAccess,
  VaultProjectGrantChange,
  VaultUseFamilyApproval,
} from '@/modules/storage/models/domain.models';
import type { CreateVaultEntryInput } from '@/modules/vault/vault-entries.service';
import { fetchAgents } from './agents';
import { HOME_BACKEND, apiFetch } from './api-transport';
import { fetchJsonOrThrow, fetchOrThrow, SessionApiError } from './http-json';
import { getErrorMessage } from './toast-helpers';
import { fetchProfiles } from './profiles';

export type VaultState = 'not_set_up' | 'unlocking' | 'locked' | 'unlocked';
export type VaultProtection = 'keystore' | 'file' | 'recovery';
export type VaultSetupMode = 'file' | 'recovery';
export type VaultStateReason =
  | 'claimed_host'
  | 'keystore_unavailable'
  | 'keystore_missing'
  | 'keystore_timeout'
  | 'keystore_error'
  | 'key_mismatch'
  | 'file_key_missing'
  | 'recovery_required';

export interface VaultRuntimeStatus {
  protection: 'memory' | 'disk';
  lingerHint: boolean;
}

/** `recoveryCode` is present only until the user confirms it was saved. */
export interface VaultStatus {
  state: VaultState;
  protection: VaultProtection | null;
  reason: VaultStateReason | null;
  keystoreAvailable: boolean;
  recoveryCodePending: boolean;
  recoveryCode?: string;
  runtime?: VaultRuntimeStatus;
  /** Claimed VM only: the cache of the values that home pushed. */
  vmCache?: VaultVmCacheStatus;
}

export interface VaultVmCacheStatus {
  /** True when the VM holds every value of home's snapshot. */
  cacheReady: boolean;
  /** Set when the VM has no memory-only runtime directory for values. */
  cacheUnavailable: 'runtime_directory_missing' | 'runtime_directory_not_tmpfs' | null;
}

export type {
  CreateVaultEntryInput,
  UpdateVaultEntryInput,
  VaultEntry,
  VaultEntryGrant,
  VaultEntryKind,
  VaultEntryProjectAccess,
  VaultFamilyAccess,
  VaultGivenAccess,
  VaultGrant,
  VaultGrantAccess,
  VaultProjectGrantChange,
  VaultUseFamilyApproval,
};

/** A role is a profile family slug; its profiles and their agents are listed by name. */
export interface VaultRole {
  familySlug: string;
  profileNames: string[];
  agentNames: string[];
}

/** A project's roles. */
export interface VaultProjectContext {
  roles: VaultRole[];
  /** Profiles with no family slug: their agents get only "all agents" entries. */
  profilesWithoutRole: number;
}

export const vaultQueryKeys = {
  all: () => ['vault'] as const,
  status: () => ['vault', 'status'] as const,
  entries: () => ['vault', 'entries'] as const,
  grants: () => ['vault', 'grants'] as const,
  access: () => ['vault', 'access'] as const,
  approvals: (entryId: string) => ['vault', 'approvals', entryId] as const,
  projectContext: (projectId: string) => ['vault', 'project-context', projectId] as const,
};

export const vaultStatusQueryKey = vaultQueryKeys.status();

const homeFetch = (input: RequestInfo | URL, init?: RequestInit) =>
  apiFetch(input, init, { backend: HOME_BACKEND });

function send<T = VaultStatus>(
  path: string,
  body?: unknown,
  fallback = 'Vault request failed',
  method = 'POST',
) {
  return fetchJsonOrThrow<T>(
    path,
    {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    },
    fallback,
    homeFetch,
  );
}

export function fetchVaultStatus(): Promise<VaultStatus> {
  return fetchJsonOrThrow<VaultStatus>(
    '/api/vault/status',
    {},
    'Vault status could not be loaded',
    homeFetch,
  );
}

export function setupVault(mode: VaultSetupMode): Promise<VaultStatus> {
  return send('/api/vault/setup', { mode }, 'The Vault could not be set up');
}

export function unlockVault(recoveryCode: string): Promise<VaultStatus> {
  return send('/api/vault/unlock', { recoveryCode }, 'The Vault could not be unlocked');
}

export function confirmVaultRecoveryCode(): Promise<VaultStatus> {
  return send('/api/vault/recovery/confirm', undefined, 'The confirmation was not saved');
}

function entryPath(id: string): string {
  return `/api/vault/entries/${encodeURIComponent(id)}`;
}

export function listVaultEntries(): Promise<VaultEntry[]> {
  return fetchJsonOrThrow<VaultEntry[]>(
    '/api/vault/entries',
    {},
    'Vault entries could not be loaded',
    homeFetch,
  );
}

export function createVaultEntry(input: CreateVaultEntryInput): Promise<VaultEntry> {
  return send<VaultEntry>('/api/vault/entries', input, 'The entry could not be saved');
}

export function updateVaultEntry(id: string, data: UpdateVaultEntryInput): Promise<VaultEntry> {
  return send<VaultEntry>(entryPath(id), data, 'The entry could not be saved', 'PATCH');
}

export function replaceVaultEntryValue(id: string, value: string): Promise<VaultEntry> {
  return send<VaultEntry>(
    `${entryPath(id)}/value`,
    { value },
    'The value could not be replaced',
    'PUT',
  );
}

export function deleteVaultEntry(id: string): Promise<void> {
  return fetchOrThrow(
    entryPath(id),
    { method: 'DELETE' },
    'The entry could not be deleted',
    homeFetch,
  );
}

export function listVaultGrants(projectId?: string): Promise<VaultGrant[]> {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  return fetchJsonOrThrow<VaultGrant[]>(
    `/api/vault/grants${query}`,
    {},
    'Grants could not be loaded',
    homeFetch,
  );
}

/**
 * Changes only the listed entries in the project, all or none. With `access`, the
 * project's Vault access saves in the same transaction; `none` turns the Vault off.
 */
export function setVaultProjectGrants(
  projectId: string,
  entries: VaultProjectGrantChange[],
  access?: VaultGrantAccess,
): Promise<VaultGrant[]> {
  return send<VaultGrant[]>(
    `/api/vault/projects/${encodeURIComponent(projectId)}/grants`,
    // JSON.stringify drops an undefined `access`.
    { entries, access },
    'The grants could not be saved',
    'PUT',
  );
}

/** The families that skip the approval prompt of the entry ("never ask again"). */
export function listVaultUseApprovals(entryId: string): Promise<VaultUseFamilyApproval[]> {
  return fetchJsonOrThrow<VaultUseFamilyApproval[]>(
    `${entryPath(entryId)}/approvals`,
    {},
    'Approvals could not be loaded',
    homeFetch,
  );
}

/** Agents of the family get the approval prompt again. Returns the remaining approvals. */
export function removeVaultUseApproval(
  approval: Pick<VaultUseFamilyApproval, 'entryId' | 'projectId' | 'familySlug'>,
): Promise<VaultUseFamilyApproval[]> {
  const path = [approval.projectId, approval.familySlug].map(encodeURIComponent).join('/');
  return fetchJsonOrThrow<VaultUseFamilyApproval[]>(
    `${entryPath(approval.entryId)}/approvals/${path}`,
    { method: 'DELETE' },
    'The approval could not be removed',
    homeFetch,
  );
}

export function listVaultAccess(): Promise<VaultFamilyAccess[]> {
  return fetchJsonOrThrow<VaultFamilyAccess[]>(
    '/api/vault/access',
    {},
    'Vault access could not be loaded',
    homeFetch,
  );
}

/**
 * Grant or access rows grouped by `keyOf`, one access per group, in the order the
 * groups first appear. A null slug in a group makes it `all`.
 */
export function accessByKey<Row extends { familySlug: string | null }>(
  rows: Row[],
  keyOf: (row: Row) => string,
): Map<string, VaultGivenAccess> {
  const access = new Map<string, VaultGivenAccess>();
  for (const row of rows) {
    const key = keyOf(row);
    const current = access.get(key);
    if (current?.mode === 'all') continue;
    if (row.familySlug === null) access.set(key, { mode: 'all' });
    else if (current) current.familySlugs.push(row.familySlug);
    else access.set(key, { mode: 'families', familySlugs: [row.familySlug] });
  }
  return access;
}

/** The access of one project from the access rows: no row is `none`, a null row is `all`. */
export function projectAccessFromRows(
  rows: VaultFamilyAccess[],
  projectId: string,
): VaultGrantAccess {
  return accessByKey(rows, (row) => row.projectId).get(projectId) ?? { mode: 'none' };
}

/** True when agents of the family `slug` can use the Vault under `access`. */
export function accessCoversFamily(access: VaultGrantAccess, slug: string): boolean {
  if (access.mode === 'all') return true;
  return access.mode === 'families' && access.familySlugs.includes(slug);
}

/** The role slugs an access names; `all` and `none` name none. */
export function chosenSlugs(access: VaultGrantAccess): string[] {
  return access.mode === 'families' ? access.familySlugs : [];
}

/** `access` with the family `slug` added; `all` already covers it. */
export function addFamilyToAccess(access: VaultGrantAccess, slug: string): VaultGrantAccess {
  if (accessCoversFamily(access, slug)) return access;
  return { mode: 'families', familySlugs: [...chosenSlugs(access), slug] };
}

export const LOCKED_REMOTE_ACCESS_MESSAGE =
  'Unlock the Vault to change access. A connected VM must receive the change.';

/** The error text for a Vault write, with a clear message for the locked-write refusal. */
export function vaultErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof SessionApiError && error.hasCode('VAULT_LOCKED_REMOTE_ACCESS')) {
    return LOCKED_REMOTE_ACCESS_MESSAGE;
  }
  return getErrorMessage(error, fallback);
}

/** The roles of the project's profiles with their profile and agent names. */
export async function fetchVaultProjectContext(projectId: string): Promise<VaultProjectContext> {
  const [profiles, agents] = await Promise.all([
    fetchProfiles(homeFetch, projectId),
    fetchAgents(homeFetch, projectId),
  ]);

  const roles = new Map<string, { profileIds: Set<string>; profileNames: Set<string> }>();
  let profilesWithoutRole = 0;
  for (const profile of profiles.items) {
    const slug = profile.familySlug?.trim().toLowerCase();
    if (!slug) {
      profilesWithoutRole += 1;
      continue;
    }
    const role = roles.get(slug) ?? { profileIds: new Set(), profileNames: new Set() };
    role.profileIds.add(profile.id);
    role.profileNames.add(profile.name);
    roles.set(slug, role);
  }
  const byName = (a: string, b: string) => a.localeCompare(b);
  return {
    roles: [...roles]
      .map(([familySlug, role]) => ({
        familySlug,
        profileNames: [...role.profileNames].sort(byName),
        agentNames: agents.items
          .filter((agent) => role.profileIds.has(agent.profileId))
          .map((agent) => agent.name)
          .sort(byName),
      }))
      .sort((a, b) => byName(a.familySlug, b.familySlug)),
    profilesWithoutRole,
  };
}
