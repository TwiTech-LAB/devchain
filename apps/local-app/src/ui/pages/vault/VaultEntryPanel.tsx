import { useState, type FormEvent, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { ConfirmDialog } from '@/ui/components/shared';
import { Badge } from '@/ui/components/ui/badge';
import { Button } from '@/ui/components/ui/button';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/ui/components/ui/drawer';
import { useConfirmDialog } from '@/ui/hooks/useFormDialog';
import type {
  UpdateVaultEntryInput,
  VaultEntry,
  VaultEntryProjectAccess,
  VaultGrant,
} from '@/ui/lib/vault';
import {
  accessFromGrants,
  isProjectAccessValid,
  ownerLabel,
  ProjectAccessEditor,
  sameProjectAccess,
  type ProjectOption,
} from './ProjectAccessEditor';
import { ApprovalRequiredField, DescriptionField, FormError, NameField } from './VaultEntryDialogs';
import { VaultUseApprovals } from './VaultUseApprovals';

interface Fields {
  name: string;
  description: string;
  projects: VaultEntryProjectAccess[];
  approvalRequired: boolean;
}

interface Draft extends Fields {
  entryId: string;
  /** What the panel opened with; later query refreshes do not move it. */
  initial: Fields;
}

function openDraft(entry: VaultEntry, grants: VaultGrant[]): Draft {
  const initial: Fields = {
    name: entry.name,
    description: entry.description,
    projects: accessFromGrants(grants.filter((grant) => grant.entryId === entry.id)),
    approvalRequired: entry.approvalRequired,
  };
  return { entryId: entry.id, initial, ...initial };
}

/** Only the fields that differ from what the panel opened with. */
function changedFields(draft: Draft): UpdateVaultEntryInput {
  const name = draft.name.trim();
  const description = draft.description.trim();
  return {
    ...(name !== draft.initial.name ? { name } : {}),
    ...(description !== draft.initial.description ? { description } : {}),
    ...(sameProjectAccess(draft.projects, draft.initial.projects)
      ? {}
      : { projects: draft.projects }),
    ...(draft.approvalRequired !== draft.initial.approvalRequired
      ? { approvalRequired: draft.approvalRequired }
      : {}),
  };
}

export function formatVaultTime(value: string | null): string {
  return value ? new Date(value).toLocaleString() : 'Never';
}

interface VaultEntryPanelProps {
  /** The open entry, as the latest entries query has it; null closes the panel. */
  entry: VaultEntry | null;
  /** Grant rows of every entry; undefined while they load. */
  grants: VaultGrant[] | undefined;
  grantsError: unknown;
  entries: VaultEntry[];
  projects: ProjectOption[];
  readOnly: boolean;
  valueWritesEnabled: boolean;
  onClose: () => void;
  onSave: (entry: VaultEntry, data: UpdateVaultEntryInput) => void;
  pending: boolean;
  error: unknown;
  onReplaceValue: (entry: VaultEntry) => void;
  onDelete: (entry: VaultEntry) => void;
  /** Leaves the panel for the project's access on the Projects tab. */
  onOpenProjectAccess: (projectId: string) => void;
}

export function VaultEntryPanel({
  entry,
  grants,
  grantsError,
  entries,
  projects,
  readOnly,
  valueWritesEnabled,
  onClose,
  onSave,
  pending,
  error,
  onReplaceValue,
  onDelete,
  onOpenProjectAccess,
}: VaultEntryPanelProps) {
  const [draft, setDraft] = useState<Draft | null>(null);
  /** Holds what runs once the user agrees to discard unsaved changes. */
  const discard = useConfirmDialog<{ then: () => void }>();

  if (entry === null) {
    if (draft !== null) setDraft(null);
  } else if (grants && draft?.entryId !== entry.id) {
    setDraft(openDraft(entry, grants));
  }

  const ready = entry !== null && draft?.entryId === entry.id ? draft : null;
  const changes = ready ? changedFields(ready) : {};
  const dirty = Object.keys(changes).length > 0;
  const valid =
    ready !== null &&
    ready.name.trim() !== '' &&
    ready.description.trim() !== '' &&
    isProjectAccessValid(ready.projects);
  const update = (fields: Partial<Fields>) =>
    setDraft((current) => (current ? { ...current, ...fields } : current));

  const requestClose = (then: () => void = onClose) => {
    if (dirty && !readOnly) discard.open({ then });
    else then();
  };
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (entry && dirty && valid && !readOnly) onSave(entry, changes);
  };

  let body: ReactNode;
  if (entry !== null && ready) {
    body = (
      <fieldset disabled={readOnly} className="space-y-5">
        <NameField value={ready.name} onChange={(name) => update({ name })} />
        <DescriptionField
          value={ready.description}
          onChange={(description) => update({ description })}
        />
        <section aria-labelledby="vault-entry-access" className="space-y-4 border-t pt-5">
          <h3 id="vault-entry-access" className="text-base font-semibold">
            Access
          </h3>
          <ProjectAccessEditor
            value={ready.projects}
            onChange={(projects) => update({ projects })}
            projects={projects}
            entryName={ready.name}
            entryId={ready.entryId}
            entries={entries}
            disabled={readOnly}
            onOpenProjectAccess={(projectId) => requestClose(() => onOpenProjectAccess(projectId))}
          />
          <ApprovalRequiredField
            checked={ready.approvalRequired}
            onChange={(approvalRequired) => update({ approvalRequired })}
            disabled={readOnly}
          />
          <VaultUseApprovals
            entryId={ready.entryId}
            gated={entry.approvalRequired}
            projects={projects}
            readOnly={readOnly}
          />
        </section>
      </fieldset>
    );
  } else if (grantsError) {
    body = <FormError error={grantsError} fallback="Grants could not be loaded." />;
  } else {
    body = (
      <p role="status" className="text-sm text-muted-foreground">
        Loading projects…
      </p>
    );
  }

  return (
    <>
      <Drawer open={entry !== null} onOpenChange={(open) => (open ? undefined : requestClose())}>
        <DrawerContent side="right" className="gap-0 p-0">
          {entry ? (
            <form onSubmit={handleSubmit} autoComplete="off" className="flex h-full flex-col">
              <DrawerHeader className="gap-2 border-b p-6">
                <div className="flex items-start gap-2">
                  <DrawerTitle className="mr-auto break-all font-mono">{entry.name}</DrawerTitle>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="-mr-2 -mt-2 h-8 w-8"
                    aria-label="Close"
                    onClick={() => requestClose()}
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </div>
                <DrawerDescription asChild>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    <Badge variant="secondary">{entry.kind}</Badge>
                    <span>{ownerLabel(entry.projectId, projects)}</span>
                    <span>Revision {entry.revision}</span>
                    <span>Last used: {formatVaultTime(entry.lastUsedAt)}</span>
                  </div>
                </DrawerDescription>
              </DrawerHeader>
              <div className="flex-1 space-y-5 overflow-y-auto p-6">
                {body}
                {readOnly ? null : <FormError error={error} />}
              </div>
              {readOnly ? null : (
                <DrawerFooter className="border-t p-6 sm:justify-between">
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={!valueWritesEnabled}
                      onClick={() => onReplaceValue(entry)}
                    >
                      Replace value
                    </Button>
                    <Button type="button" variant="outline" onClick={() => onDelete(entry)}>
                      Delete
                    </Button>
                  </div>
                  <Button type="submit" disabled={!dirty || !valid || pending}>
                    Save changes
                  </Button>
                </DrawerFooter>
              )}
            </form>
          ) : null}
        </DrawerContent>
      </Drawer>
      <ConfirmDialog
        open={discard.isOpen}
        onOpenChange={discard.onOpenChange}
        onConfirm={() => {
          discard.target?.then();
          discard.close();
        }}
        title="Discard unsaved changes?"
        description="The changes to this entry are not saved."
        confirmText="Discard changes"
        cancelText="Keep editing"
        variant="destructive"
      />
    </>
  );
}
