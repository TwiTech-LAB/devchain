import { useMemo, useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { ConfirmDialog, PageHeader } from '@/ui/components/shared';
import { Button } from '@/ui/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/components/ui/tabs';
import { useAllProjects } from '@/ui/hooks/useAllProjects';
import { useConfirmDialog } from '@/ui/hooks/useFormDialog';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';
import { useToastHelpers } from '@/ui/lib/toast-helpers';
import {
  createVaultEntry,
  deleteVaultEntry,
  replaceVaultEntryValue,
  updateVaultEntry,
  vaultErrorMessage,
  vaultQueryKeys,
  type CreateVaultEntryInput,
  type UpdateVaultEntryInput,
  type VaultEntry,
} from '@/ui/lib/vault';
import { VaultSection } from './settings/VaultSection';
import type { ProjectOption } from './vault/ProjectAccessEditor';
import { VaultEntriesTable } from './vault/VaultEntriesTable';
import { CreateEntryDialog, FormError, ReplaceValueDialog } from './vault/VaultEntryDialogs';
import { VaultEntryPanel } from './vault/VaultEntryPanel';
import { VaultProjectsTab, type ProjectRequest } from './vault/VaultProjectsTab';
import { useVaultEntries, useVaultGrants, useVaultStatus } from './vault/useVaultQueries';

const VALUE_WRITES_LOCKED = 'Unlock the Vault to add entries or replace values.';

/** `projectId` starts the create dialog with that project. */
type CreateRequest = { projectId?: string };

export function VaultPage() {
  const status = useVaultStatus();
  const claimed = status.data?.reason === 'claimed_host';
  const entries = useVaultEntries(status.isSuccess);
  const grants = useVaultGrants(status.isSuccess);
  const { projects } = useAllProjects();
  const { selectedProjectId } = useSelectedProject();
  const queryClient = useHomeQueryClient();
  const { showSuccess } = useToastHelpers();

  const [creating, setCreating] = useState<CreateRequest | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [replacing, setReplacing] = useState<VaultEntry | null>(null);
  const deleting = useConfirmDialog<VaultEntry>();
  const [tab, setTab] = useState('entries');
  const [projectsDirty, setProjectsDirty] = useState(false);
  const [leavingProjects, setLeavingProjects] = useState(false);
  const [projectRequest, setProjectRequest] = useState<ProjectRequest>();

  const projectOptions: ProjectOption[] = useMemo(
    () =>
      projects
        .filter((project) => !project.isTemplate)
        .map((project) => ({ id: project.id, name: project.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [projects],
  );
  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );
  const valueWritesEnabled = status.data?.state === 'unlocked';
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: vaultQueryKeys.entries() }),
      queryClient.invalidateQueries({ queryKey: vaultQueryKeys.grants() }),
    ]);

  const create = useMutation(
    {
      mutationFn: (input: CreateVaultEntryInput) => createVaultEntry(input),
      onSuccess: (entry) => {
        setCreating(null);
        void refresh();
        showSuccess({ title: 'Entry added', description: `${entry.name} is saved.` });
      },
    },
    queryClient,
  );
  const update = useMutation(
    {
      mutationFn: ({ id, data }: { id: string; data: UpdateVaultEntryInput }) =>
        updateVaultEntry(id, data),
      onSuccess: (entry) => {
        setEditingId(null);
        void refresh();
        showSuccess({ title: 'Entry updated', description: `${entry.name} is saved.` });
      },
    },
    queryClient,
  );
  const replace = useMutation(
    {
      mutationFn: ({ id, value }: { id: string; value: string }) =>
        replaceVaultEntryValue(id, value),
      onSuccess: (entry) => {
        setReplacing(null);
        void refresh();
        showSuccess({
          title: 'Value replaced',
          description: `${entry.name} is now at revision ${entry.revision}.`,
        });
      },
    },
    queryClient,
  );
  const remove = useMutation(
    {
      mutationFn: (entry: VaultEntry) => deleteVaultEntry(entry.id),
      onSuccess: (_result, entry) => {
        deleting.close();
        setEditingId((current) => (current === entry.id ? null : current));
        void refresh();
        showSuccess({ title: 'Entry deleted', description: `${entry.name} is deleted.` });
      },
    },
    queryClient,
  );

  const list = entries.data ?? [];
  const editing = list.find((entry) => entry.id === editingId) ?? null;
  const openEntry = (entry: VaultEntry) => {
    update.reset();
    setEditingId(entry.id);
  };
  const startReplace = (entry: VaultEntry) => {
    replace.reset();
    setReplacing(entry);
  };
  const startDelete = (entry: VaultEntry) => {
    remove.reset();
    deleting.open(entry);
  };
  const startCreate = (projectId?: string) => {
    create.reset();
    setCreating({ projectId });
  };
  const openProjectAccess = (projectId: string) => {
    setCreating(null);
    setEditingId(null);
    setProjectRequest({ projectId });
    setTab('projects');
  };

  // Both tabs wait for the entries list the same way.
  let entriesNotice: ReactNode = null;
  if (entries.isLoading) {
    entriesNotice = (
      <p role="status" className="text-sm text-muted-foreground">
        Loading entries…
      </p>
    );
  } else if (entries.error) {
    entriesNotice = (
      <FormError error={entries.error} fallback="Vault entries could not be loaded." />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Vault"
        description="Encrypted secrets and files for agents. DevChain never shows a saved value."
        actions={
          claimed ? undefined : (
            <Button onClick={() => startCreate()} disabled={!valueWritesEnabled}>
              <Plus className="mr-2 h-4 w-4" />
              Add entry
            </Button>
          )
        }
      />
      <VaultSection />
      {!status.isSuccess ? null : (
        <>
          {valueWritesEnabled || claimed ? null : (
            <p className="text-sm text-muted-foreground">{VALUE_WRITES_LOCKED}</p>
          )}
          <Tabs
            value={tab}
            onValueChange={(next) =>
              tab === 'projects' && projectsDirty ? setLeavingProjects(true) : setTab(next)
            }
          >
            <TabsList>
              <TabsTrigger value="entries">Entries</TabsTrigger>
              <TabsTrigger value="projects">Projects</TabsTrigger>
            </TabsList>
            <TabsContent value="entries" className="mt-4">
              {entriesNotice ??
                (list.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {claimed
                      ? 'Home gives no entries to the projects of this VM.'
                      : 'No entries yet.'}
                  </p>
                ) : (
                  <>
                    <FormError
                      error={grants.error}
                      fallback="Grants could not be loaded."
                      className="mb-2"
                    />
                    <VaultEntriesTable
                      entries={list}
                      grants={grants.data ?? []}
                      grantsLoading={grants.isLoading}
                      projectNames={projectNames}
                      readOnly={claimed}
                      valueWritesEnabled={valueWritesEnabled}
                      onOpen={openEntry}
                      onReplaceValue={startReplace}
                      onDelete={startDelete}
                    />
                  </>
                ))}
            </TabsContent>
            <TabsContent value="projects" className="mt-4">
              {entriesNotice ?? (
                <VaultProjectsTab
                  projects={projectOptions}
                  entries={list}
                  grants={grants.data}
                  grantsLoading={grants.isLoading}
                  grantsError={grants.error}
                  readOnly={claimed}
                  canAddEntry={valueWritesEnabled}
                  onAddEntry={startCreate}
                  onDirtyChange={setProjectsDirty}
                  request={projectRequest}
                  defaultProjectId={selectedProjectId}
                />
              )}
            </TabsContent>
          </Tabs>
        </>
      )}

      <CreateEntryDialog
        open={creating !== null && valueWritesEnabled}
        onOpenChange={(open) => (open ? undefined : setCreating(null))}
        projects={projectOptions}
        entries={list}
        initialProjectId={creating?.projectId}
        onSubmit={(input) => create.mutate(input)}
        onOpenProjectAccess={openProjectAccess}
        pending={create.isPending}
        error={create.error}
      />
      <VaultEntryPanel
        entry={editing}
        grants={grants.data}
        grantsError={grants.error}
        entries={list}
        projects={projectOptions}
        readOnly={claimed}
        valueWritesEnabled={valueWritesEnabled}
        onClose={() => setEditingId(null)}
        onSave={(entry, data) => update.mutate({ id: entry.id, data })}
        pending={update.isPending}
        error={update.error}
        onReplaceValue={startReplace}
        onDelete={startDelete}
        onOpenProjectAccess={openProjectAccess}
      />
      <ReplaceValueDialog
        entry={valueWritesEnabled ? replacing : null}
        onOpenChange={(open) => (open ? undefined : setReplacing(null))}
        onSubmit={(entry, value) => replace.mutate({ id: entry.id, value })}
        pending={replace.isPending}
        error={replace.error}
      />
      <ConfirmDialog
        open={leavingProjects}
        onOpenChange={setLeavingProjects}
        onConfirm={() => {
          setLeavingProjects(false);
          setTab('entries');
        }}
        title="Discard unsaved changes?"
        description="Your changes on the Projects tab are not saved."
        confirmText="Discard"
        variant="destructive"
      />
      <ConfirmDialog
        open={deleting.isOpen}
        onOpenChange={deleting.onOpenChange}
        onConfirm={() => deleting.target && remove.mutate(deleting.target)}
        title={`Delete ${deleting.target?.name ?? 'entry'}?`}
        description={
          remove.error
            ? vaultErrorMessage(remove.error, 'The entry could not be deleted.')
            : 'Agents lose this entry at once: the next devchain vault exec no longer includes it. This cannot be undone.'
        }
        confirmText="Delete"
        variant="destructive"
        loading={remove.isPending}
      />
    </div>
  );
}
