import { useState, type ChangeEvent, type FormEvent } from 'react';
import { Alert, AlertDescription } from '@/ui/components/ui/alert';
import { Button } from '@/ui/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/label';
import { Switch } from '@/ui/components/ui/switch';
import { Textarea } from '@/ui/components/ui/textarea';
import { cn } from '@/ui/lib/utils';
import {
  vaultErrorMessage,
  type CreateVaultEntryInput,
  type VaultEntry,
  type VaultEntryKind,
  type VaultEntryProjectAccess,
} from '@/ui/lib/vault';
import {
  isProjectAccessValid,
  ProjectAccessEditor,
  type ProjectOption,
} from './ProjectAccessEditor';

export const DESCRIPTION_WARNING = 'Do not put secrets in the description.';
const SELECT_CLASS =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

interface ValueFieldProps {
  id: string;
  kind: VaultEntryKind;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

/** The value never comes back from the server, so this field always starts empty. */
export function ValueField({ id, kind, value, onChange, disabled }: ValueFieldProps) {
  const [fileError, setFileError] = useState<string | null>(null);

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setFileError(null);
    try {
      onChange(await file.text());
    } catch {
      setFileError('The file could not be read.');
    }
  };

  if (kind === 'secret') {
    return (
      <div className="space-y-1">
        <Label htmlFor={id}>Value</Label>
        <Input
          id={id}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>File content</Label>
      <Textarea
        id={id}
        rows={6}
        spellCheck={false}
        autoComplete="off"
        className="font-mono"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
      <Label htmlFor={`${id}-upload`} className="sr-only">
        Upload file
      </Label>
      <input
        id={`${id}-upload`}
        type="file"
        disabled={disabled}
        onChange={handleFile}
        className="text-sm"
      />
      {fileError ? <p className="text-sm text-destructive">{fileError}</p> : null}
    </div>
  );
}

/** The error text of a failed request, or nothing when there is no error. */
export function FormError({
  error,
  fallback = 'The request failed.',
  className,
}: {
  error: unknown;
  fallback?: string;
  className?: string;
}) {
  if (!error) return null;
  return (
    <p role="alert" className={cn('text-sm text-destructive', className)}>
      {vaultErrorMessage(error, fallback)}
    </p>
  );
}

export function NameField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor="vault-entry-name">Name</Label>
      <Input
        id="vault-entry-name"
        value={value}
        spellCheck={false}
        className="font-mono"
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

export function DescriptionField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor="vault-entry-description">Description</Label>
      <Textarea
        id="vault-entry-description"
        rows={2}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <Alert variant="warn" className="py-2">
        <AlertDescription>{DESCRIPTION_WARNING}</AlertDescription>
      </Alert>
    </div>
  );
}

export const APPROVAL_REQUIRED_LABEL = 'Require approval on use';

/** The per-entry gate: a session asks the user before it first gets the value. */
export function ApprovalRequiredField({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <Switch
          id="vault-entry-approval"
          checked={checked}
          onCheckedChange={onChange}
          disabled={disabled}
          aria-describedby="vault-entry-approval-hint"
        />
        <Label htmlFor="vault-entry-approval">{APPROVAL_REQUIRED_LABEL}</Label>
      </div>
      <p id="vault-entry-approval-hint" className="text-sm text-muted-foreground">
        Each agent session asks you before it first gets the value.
      </p>
    </div>
  );
}

interface CreateEntryFormProps {
  projects: ProjectOption[];
  /** Existing entries, for the same-name warning of a project row. */
  entries: VaultEntry[];
  /** Starts the project list with this project and All agents. */
  initialProjectId?: string;
  onSubmit: (input: CreateVaultEntryInput) => void;
  /** Leaves the dialog for the project's access on the Projects tab. */
  onOpenProjectAccess: (projectId: string) => void;
  pending: boolean;
  error: unknown;
}

export function CreateEntryDialog({
  open,
  onOpenChange,
  ...formProps
}: CreateEntryFormProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        {open ? <CreateEntryForm {...formProps} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function CreateEntryForm({
  projects,
  entries,
  initialProjectId,
  onSubmit,
  onOpenProjectAccess,
  pending,
  error,
}: CreateEntryFormProps) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<VaultEntryKind>('secret');
  const [access, setAccess] = useState<VaultEntryProjectAccess[]>(() =>
    initialProjectId ? [{ projectId: initialProjectId, mode: 'all' }] : [],
  );
  const [description, setDescription] = useState('');
  const [value, setValue] = useState('');
  const [approvalRequired, setApprovalRequired] = useState(false);
  const valid =
    name.trim() !== '' && description.trim() !== '' && value !== '' && isProjectAccessValid(access);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!valid) return;
    onSubmit({
      projects: access,
      name: name.trim(),
      kind,
      description: description.trim(),
      value,
      approvalRequired,
    });
  };

  return (
    <form onSubmit={handleSubmit} autoComplete="off" className="space-y-4">
      <DialogHeader>
        <DialogTitle>Add Vault entry</DialogTitle>
        <DialogDescription>
          Agents with a grant get the value as an environment variable or a file.
        </DialogDescription>
      </DialogHeader>
      <NameField value={name} onChange={setName} />
      <div className="space-y-1">
        <Label htmlFor="vault-entry-kind">Kind</Label>
        <select
          id="vault-entry-kind"
          className={SELECT_CLASS}
          value={kind}
          onChange={(event) => {
            setKind(event.target.value as VaultEntryKind);
            setValue('');
          }}
        >
          <option value="secret">secret</option>
          <option value="file">file</option>
        </select>
      </div>
      <DescriptionField value={description} onChange={setDescription} />
      <ValueField id="vault-entry-value" kind={kind} value={value} onChange={setValue} />
      <ApprovalRequiredField checked={approvalRequired} onChange={setApprovalRequired} />
      <ProjectAccessEditor
        value={access}
        onChange={setAccess}
        projects={projects}
        entryName={name}
        entries={entries}
        onOpenProjectAccess={onOpenProjectAccess}
      />
      <FormError error={error} />
      <DialogFooter>
        <Button type="submit" disabled={!valid || pending}>
          Add entry
        </Button>
      </DialogFooter>
    </form>
  );
}

export function ReplaceValueDialog({
  entry,
  onOpenChange,
  onSubmit,
  pending,
  error,
}: {
  entry: VaultEntry | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (entry: VaultEntry, value: string) => void;
  pending: boolean;
  error: unknown;
}) {
  return (
    <Dialog open={entry !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        {entry ? (
          <ReplaceValueForm entry={entry} onSubmit={onSubmit} pending={pending} error={error} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ReplaceValueForm({
  entry,
  onSubmit,
  pending,
  error,
}: {
  entry: VaultEntry;
  onSubmit: (entry: VaultEntry, value: string) => void;
  pending: boolean;
  error: unknown;
}) {
  const [value, setValue] = useState('');

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (value !== '') onSubmit(entry, value);
  };

  return (
    <form onSubmit={handleSubmit} autoComplete="off" className="space-y-4">
      <DialogHeader>
        <DialogTitle>Replace value of {entry.name}</DialogTitle>
        <DialogDescription>
          The new value replaces the old one and the revision goes up. The old value is not shown.
        </DialogDescription>
      </DialogHeader>
      <ValueField id="vault-entry-value" kind={entry.kind} value={value} onChange={setValue} />
      <FormError error={error} />
      <DialogFooter>
        <Button type="submit" disabled={value === '' || pending}>
          Replace value
        </Button>
      </DialogFooter>
    </form>
  );
}
