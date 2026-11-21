import { ConflictError } from '../../common/errors/error-types';
import { canAccessWorkspace } from '../e2ee/services/paired-device-workspace-access.service';
import type { ProjectStorage, VaultEntryStorage } from '../storage/interfaces/storage.interface';
import type { VaultEntry } from '../storage/models/domain.models';
import type { VaultSessionValueStore } from '../vault/vault-session-values';
import type { VaultRequest } from './vault-request.store';

/**
 * The workspaces of a paired phone with limited access. No scope (the web, or a phone
 * with full access) admits every entry.
 */
export interface VaultDeviceScope {
  readonly allowedWorkspaceIds: ReadonlySet<string>;
}

export type VaultScopeStorage = Pick<VaultEntryStorage, 'getVaultEntry' | 'listVaultGrants'> &
  Pick<ProjectStorage, 'getProject'>;

export type VaultRequestSelectionStorage = Pick<
  VaultEntryStorage,
  'listVaultEntries' | 'resolveVaultGrantsForAgent'
> &
  VaultScopeStorage;

/** The scope tests of one call. Each one is false for a row that cannot be read. */
export interface VaultScopeTest {
  /** Whether the project is in a workspace of the scope. */
  project(projectId: string): Promise<boolean>;
  /**
   * An entry is in scope when its owner project is, or when it is shared and a project
   * in scope has a grant of it. A shared entry without grants is out.
   */
  entry(entry: Pick<VaultEntry, 'id' | 'projectId'>): Promise<boolean>;
  /** `entry` for the entry of this id. False for no id. */
  entryId(entryId: string | null): Promise<boolean>;
}

/** The one owner of the device scope rule. Reads the grant rows and each project once, on first use. */
export function vaultScopeTest(
  storage: VaultScopeStorage,
  scope: VaultDeviceScope,
): VaultScopeTest {
  const access = { workspaceIds: [...scope.allowedWorkspaceIds] };
  const projects = new Map<string, Promise<boolean>>();
  const project = (projectId: string) => {
    let inScope = projects.get(projectId);
    if (!inScope) {
      inScope = storage
        .getProject(projectId)
        .then((row) => canAccessWorkspace(access, row.workspaceId))
        .catch(() => false);
      projects.set(projectId, inScope);
    }
    return inScope;
  };
  let grantProjects: Promise<Map<string, Set<string>>> | undefined;
  const grantProjectsOf = async (entryId: string) => {
    grantProjects ??= storage.listVaultGrants().then((grants) => {
      const byEntry = new Map<string, Set<string>>();
      for (const grant of grants) {
        const ids = byEntry.get(grant.entryId) ?? new Set<string>();
        ids.add(grant.projectId);
        byEntry.set(grant.entryId, ids);
      }
      return byEntry;
    });
    return (await grantProjects).get(entryId) ?? new Set<string>();
  };
  const entry: VaultScopeTest['entry'] = async ({ id, projectId }) => {
    if (projectId !== null) return project(projectId);
    for (const grantProjectId of await grantProjectsOf(id)) {
      if (await project(grantProjectId)) return true;
    }
    return false;
  };
  const entryId: VaultScopeTest['entryId'] = (id) => {
    if (!id) return Promise.resolve(false);
    return storage
      .getVaultEntry(id)
      .then(entry)
      .catch(() => false);
  };
  return { project, entry, entryId };
}

/** The items that pass an asynchronous test, in their order. */
export async function keepWhere<T>(
  items: readonly T[],
  test: (item: T) => Promise<boolean>,
): Promise<T[]> {
  const admitted = await Promise.all(items.map(test));
  return items.filter((_, index) => admitted[index]);
}

/** An existing entry the user can give in place of a new value. Never holds a value. */
export interface VaultRequestSelectableEntry {
  entry: VaultEntry;
  /** The requester already resolves this entry, so the answer writes nothing. */
  alreadyAvailable: boolean;
}

export function vaultRequestEntryNotSelectable(): ConflictError {
  return new ConflictError(
    'This entry cannot answer the request. Its name is already in use for the agent, or it cannot become a shared entry. Choose another entry.',
    { code: 'VAULT_REQUEST_ENTRY_NOT_SELECTABLE' },
  );
}

/**
 * The entries that can answer a `create` request, in `listVaultEntries` order. An entry
 * is left out when a different entry or a session-only value already gives its name to
 * the requester, or when it belongs to another project and a shared entry has its name
 * (the answer makes it shared). With `scope`, an entry outside it is also left out; the
 * name check still counts every shared entry. Session values are this instance's only:
 * on home, the values of a VM session are not visible.
 */
export async function listSelectableEntries(
  storage: VaultRequestSelectionStorage,
  sessionValues: Pick<VaultSessionValueStore, 'valuesFor'>,
  request: VaultRequest,
  scope?: VaultDeviceScope,
): Promise<VaultRequestSelectableEntry[]> {
  if (request.type !== 'create') return [];
  const [entries, resolved] = await Promise.all([
    storage.listVaultEntries(),
    storage.resolveVaultGrantsForAgent(request.projectId, request.familySlug),
  ]);
  const resolvedIds = new Map(resolved.map((entry) => [entry.name, entry.id]));
  const sessionNames = new Set(sessionValues.valuesFor(request.sessionId).map((v) => v.name));
  const sharedNames = new Set(
    entries.filter((entry) => entry.projectId === null).map((entry) => entry.name),
  );
  const selectable = entries.flatMap((entry) => {
    const resolvedId = resolvedIds.get(entry.name);
    if (resolvedId !== undefined && resolvedId !== entry.id) return [];
    if (sessionNames.has(entry.name)) return [];
    const otherProject = entry.projectId !== null && entry.projectId !== request.projectId;
    if (otherProject && sharedNames.has(entry.name)) return [];
    return [{ entry, alreadyAvailable: resolvedId === entry.id }];
  });
  if (!scope) return selectable;
  const inScope = vaultScopeTest(storage, scope);
  return keepWhere(selectable, ({ entry }) => inScope.entry(entry));
}

/** The selectable entry `entryId`, or 409 `VAULT_REQUEST_ENTRY_NOT_SELECTABLE`. */
export async function requireSelectableEntry(
  storage: VaultRequestSelectionStorage,
  sessionValues: Pick<VaultSessionValueStore, 'valuesFor'>,
  request: VaultRequest,
  entryId: string,
  scope?: VaultDeviceScope,
): Promise<VaultRequestSelectableEntry> {
  const selected = (await listSelectableEntries(storage, sessionValues, request)).find(
    (candidate) => candidate.entry.id === entryId,
  );
  // The scope test of the one entry gives the same answer as the scoped list.
  if (!selected || (scope && !(await vaultScopeTest(storage, scope).entry(selected.entry)))) {
    throw vaultRequestEntryNotSelectable();
  }
  return selected;
}
