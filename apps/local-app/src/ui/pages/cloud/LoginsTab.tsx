import { useId, useState, type FormEvent } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { PROVIDER_AUTH_LABEL_MAX_LENGTH } from '@/modules/provider-auth/provider-auth.dto';
import type { RemoteListItemDto } from '@/modules/remotes/dtos/remote.dto';
import { ConfirmDialog } from '@/ui/components/shared/ConfirmDialog';
import { Badge } from '@/ui/components/ui/badge';
import { Button } from '@/ui/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/components/ui/card';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/label';
import { useProviderAuth, type ProviderAuthEntryItem } from '@/ui/hooks/useProviderAuth';
import { getErrorMessage } from '@/ui/lib/toast-helpers';
import { AddLoginDialog, type AddLoginProvider } from './AddLoginDialog';
import { PROVIDER_NAMES } from './login-choices';

const SECTION_ORDER = ['claude', 'codex', 'copilot', 'agy', 'opencode'] as const;
type SectionProvider = (typeof SECTION_ORDER)[number];

function formatTime(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toLocaleString();
}

function EntryRow({
  entry,
  remotes,
  releasing,
  deleting,
  onRename,
  onRelease,
  onDelete,
}: {
  entry: ProviderAuthEntryItem;
  remotes: readonly RemoteListItemDto[];
  releasing: boolean;
  deleting: boolean;
  /** Resolves when the server accepted the label; a refusal rejects with the server's error. */
  onRename: (label: string) => Promise<void>;
  onRelease: () => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldId = useId();

  const nameOf = (remoteId: string | null) =>
    (remoteId && remotes.find((remote) => remote.id === remoteId)?.name) || 'a VM';
  const login = entry.kind === 'family';
  const holder = login ? entry.checkedOutRemoteId : null;
  const usedBy = login
    ? []
    : remotes
        .filter((remote) =>
          Object.values(remote.logins ?? {}).some((recorded) =>
            recorded.entryIds.includes(entry.id),
          ),
        )
        .map((remote) => remote.name);
  let place: string;
  if (login) place = holder ? `On ${nameOf(holder)}` : 'Free';
  else place = usedBy.length > 0 ? `Used by ${usedBy.join(', ')}` : 'Not used';
  const checked = formatTime(entry.lastVerifiedAt);
  const saved = login ? formatTime(entry.lastWritebackAt) : null;

  const trimmed = (draft ?? '').trim();
  const canSave = !saving && trimmed.length > 0 && trimmed !== entry.label;
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await onRename(trimmed);
      setDraft(null);
    } catch (cause) {
      setError(getErrorMessage(cause, 'Could not rename the login.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <li
      aria-label={entry.label}
      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2 text-sm"
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          {draft === null ? (
            <span className="break-all font-medium">{entry.label}</span>
          ) : (
            <form
              onSubmit={(event) => void save(event)}
              className="flex flex-wrap items-center gap-2"
            >
              <Label htmlFor={fieldId} className="sr-only">
                Name
              </Label>
              <Input
                id={fieldId}
                value={draft}
                maxLength={PROVIDER_AUTH_LABEL_MAX_LENGTH}
                autoFocus
                disabled={saving}
                aria-invalid={error ? true : undefined}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.stopPropagation();
                    setDraft(null);
                  }
                }}
                className="h-7 w-56 max-w-full"
              />
              <Button type="submit" size="sm" disabled={!canSave}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={saving}
                onClick={() => setDraft(null)}
              >
                Cancel
              </Button>
              {error && (
                <p role="alert" className="w-full text-sm text-destructive">
                  {error}
                </p>
              )}
            </form>
          )}
          <Badge variant="secondary">{login ? 'Login' : 'Token'}</Badge>
          <span className="text-muted-foreground">{place}</span>
        </div>
        <p className="text-xs text-muted-foreground">
          {checked ? `Checked ${checked}` : 'Not checked yet'}
          {saved && ` · Saved from ${nameOf(holder)} ${saved}`}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {draft === null && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Rename ${entry.label}`}
            onClick={() => {
              setError(null);
              setDraft(entry.label);
            }}
          >
            <Pencil aria-hidden="true" className="h-4 w-4" />
          </Button>
        )}
        {holder && (
          <Button
            variant="outline"
            size="sm"
            aria-label={`Release ${entry.label}`}
            onClick={onRelease}
            disabled={releasing}
          >
            Release
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Delete ${entry.label}`}
          onClick={onDelete}
          disabled={deleting}
        >
          <Trash2 aria-hidden="true" className="h-4 w-4" />
        </Button>
      </div>
    </li>
  );
}

/**
 * The vault by provider: each login with its type, where it is used and when
 * it was last checked, plus one Add login dialog for every provider.
 */
export function LoginsTab({ remotes }: { remotes: readonly RemoteListItemDto[] }) {
  const { entries, entriesLoading, remove, rename, release } = useProviderAuth();
  const [adding, setAdding] = useState<{ provider?: AddLoginProvider } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProviderAuthEntryItem | null>(null);
  const [releaseTarget, setReleaseTarget] = useState<ProviderAuthEntryItem | null>(null);

  const known = new Set<string>(SECTION_ORDER);
  const sections: Array<{
    key: string;
    title: string;
    provider: AddLoginProvider;
    items: ProviderAuthEntryItem[];
  }> = [
    ...SECTION_ORDER.map((provider: SectionProvider) => ({
      key: provider,
      title: PROVIDER_NAMES[provider],
      provider: provider as AddLoginProvider,
      items: entries.filter((entry) => entry.provider === provider),
    })),
    {
      key: 'other',
      title: 'Other keys',
      provider: 'other',
      items: entries.filter((entry) => !known.has(entry.provider)),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
          Logins for your VMs, stored encrypted on this PC. A token can serve every VM; a login
          belongs to one VM at a time.
        </p>
        <Button size="sm" onClick={() => setAdding({})}>
          <Plus aria-hidden="true" className="mr-1 h-4 w-4" />
          Add login
        </Button>
      </div>
      {entriesLoading ? (
        <p className="text-sm text-muted-foreground">Loading logins…</p>
      ) : (
        sections.map((section) => (
          <Card key={section.key}>
            <CardHeader className="pb-2">
              <CardTitle id={`logins-${section.key}`} className="text-base">
                {section.title}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {section.items.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No login yet.{' '}
                  <Button
                    variant="link"
                    className="h-auto p-0"
                    onClick={() => setAdding({ provider: section.provider })}
                  >
                    {section.provider === 'other' ? 'Add a key' : `Add a ${section.title} login`}
                  </Button>
                </p>
              ) : (
                <ul aria-labelledby={`logins-${section.key}`} className="divide-y">
                  {section.items.map((entry) => (
                    <EntryRow
                      key={entry.id}
                      entry={entry}
                      remotes={remotes}
                      releasing={release.isPending && release.variables === entry.id}
                      deleting={remove.isPending && remove.variables === entry.id}
                      onRename={async (label) => {
                        await rename.mutateAsync({ id: entry.id, label });
                      }}
                      onRelease={() => setReleaseTarget(entry)}
                      onDelete={() => setDeleteTarget(entry)}
                    />
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        ))
      )}
      {adding && (
        <AddLoginDialog initialProvider={adding.provider} onClose={() => setAdding(null)} />
      )}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        onConfirm={() => {
          if (deleteTarget) remove.mutate(deleteTarget.id);
        }}
        title={`Delete ${deleteTarget?.label ?? 'this login'}?`}
        description="The stored login is removed. A login on a VM is released for reuse."
        confirmText="Delete"
        cancelText="Cancel"
        variant="destructive"
      />
      <ConfirmDialog
        open={releaseTarget !== null}
        onOpenChange={(open) => {
          if (!open) setReleaseTarget(null);
        }}
        onConfirm={() => {
          if (releaseTarget) release.mutate(releaseTarget.id);
        }}
        title={`Release ${releaseTarget?.label ?? 'this login'}?`}
        description="The VM's copy will stop being written back to this login. If the VM is online, DevChain pulls its newest login before releasing it."
        confirmText="Release"
        cancelText="Cancel"
        loading={release.isPending}
        confirmDisabled={releaseTarget === null}
      />
    </div>
  );
}
