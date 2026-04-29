import { useEffect, useMemo, useState } from 'react';
import { Settings2, AlertTriangle, RotateCcw } from 'lucide-react';
import type {
  FolderPurpose,
  FolderScopeEntry,
} from '@/modules/codebase-overview-analyzer/types/scope.types';
import { useScopeConfig } from '@/ui/hooks/useScopeConfig';
import { useSaveScopeConfig } from '@/ui/hooks/useSaveScopeConfig';
import { useToast } from '@/ui/hooks/use-toast';
import { SessionApiError } from '@/ui/lib/sessions';
import { EmptyState, LoadingSkeleton } from '../../primitives';
import { Button } from '@/ui/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import { cn } from '@/ui/lib/utils';

export interface ScopeSectionProps {
  projectId: string;
}

const PURPOSE_LABELS: Record<FolderPurpose, string> = {
  source: 'Source',
  'test-source': 'Test Source',
  generated: 'Generated',
  resources: 'Resources',
  excluded: 'Excluded',
};

const ALL_PURPOSES: FolderPurpose[] = [
  'source',
  'test-source',
  'generated',
  'resources',
  'excluded',
];

interface PermissionBannerInfo {
  message: string;
  manualEditPath?: string;
}

export function ScopeSection({ projectId }: ScopeSectionProps) {
  const { data, isPending, isError } = useScopeConfig(projectId);
  const saveMutation = useSaveScopeConfig(projectId);
  const { toast } = useToast();

  const [draftEntries, setDraftEntries] = useState<FolderScopeEntry[]>([]);
  const [permissionBanner, setPermissionBanner] = useState<PermissionBannerInfo | null>(null);

  useEffect(() => {
    if (data?.entries) {
      setDraftEntries(data.entries);
      setPermissionBanner(null);
    }
  }, [data?.entries]);

  const isDirty = useMemo(() => {
    if (!data?.entries) return false;
    const originalByFolder = new Map(data.entries.map((e) => [e.folder, e]));
    return draftEntries.some((e) => {
      const orig = originalByFolder.get(e.folder);
      return !orig || orig.purpose !== e.purpose || orig.origin !== e.origin;
    });
  }, [draftEntries, data?.entries]);

  function handlePurposeChange(folder: string, value: string) {
    setDraftEntries((prev) =>
      prev.map((e) => {
        if (e.folder !== folder) return e;
        if (value === '__auto__') {
          const original = data?.entries.find((orig) => orig.folder === folder);
          if (original) {
            // Revert to original purpose/reason; if original was user-origin, force default
            // so it's excluded from the PUT payload (clearing the stored override)
            return original.origin === 'user'
              ? { ...original, origin: 'default' as const }
              : original;
          }
          return { ...e, origin: 'default' as const };
        }
        return { ...e, purpose: value as FolderPurpose, origin: 'user' as const };
      }),
    );
  }

  function handleSave() {
    saveMutation.mutate(draftEntries, {
      onSuccess: () => {
        setPermissionBanner(null);
        toast({ title: 'Scope saved. Re-analyzing…' });
      },
      onError: (error) => {
        if (error instanceof SessionApiError && error.status === 422) {
          const details = error.payload?.details;
          const code = String(details?.code ?? '');
          if (
            code === 'PERMISSION_DENIED' ||
            code === 'READ_ONLY_FILESYSTEM' ||
            code === 'DISK_FULL' ||
            code === 'INVALID_PATH'
          ) {
            setPermissionBanner({
              message: error.message,
              manualEditPath: details?.manualEditPath as string | undefined,
            });
            return;
          }
        }
        toast({
          title: 'Failed to save scope',
          description: error instanceof Error ? error.message : 'Unknown error',
          variant: 'destructive',
        });
      },
    });
  }

  if (isPending) {
    return (
      <div className="space-y-6">
        <SectionHeader />
        <div className="space-y-4">
          <LoadingSkeleton variant="card" />
          <LoadingSkeleton variant="card" />
        </div>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="space-y-6">
        <SectionHeader />
        <EmptyState
          icon={AlertTriangle}
          headline="Couldn't load scope config"
          reason="Try refresh; if persistent, see logs."
        />
      </div>
    );
  }

  if (data.entries.length === 0) {
    return (
      <div className="space-y-6">
        <SectionHeader />
        <StorageModeBanner storageMode={data.storageMode} />
        <EmptyState
          icon={Settings2}
          headline="No folders detected"
          reason="Run analysis to detect project folders."
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SectionHeader />
      <StorageModeBanner storageMode={data.storageMode} />

      {permissionBanner && (
        <div
          role="alert"
          data-testid="permission-denied-banner"
          className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive space-y-1"
        >
          <p className="font-medium">{permissionBanner.message}</p>
          {permissionBanner.manualEditPath && (
            <p className="text-muted-foreground">
              Edit manually:{' '}
              <span className="font-mono text-xs">{permissionBanner.manualEditPath}</span>
            </p>
          )}
        </div>
      )}

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm" role="table" aria-label="Folder scope configuration">
          <thead className="bg-muted/40">
            <tr className="border-b">
              <th className="text-left px-4 py-2.5 font-medium text-muted-foreground w-2/5">
                Folder
              </th>
              <th className="text-left px-4 py-2.5 font-medium text-muted-foreground w-2/5">
                Detected role
              </th>
              <th className="text-left px-4 py-2.5 font-medium text-muted-foreground w-1/5">
                Override
              </th>
            </tr>
          </thead>
          <tbody>
            {draftEntries.map((entry) => {
              const isUserOverride = entry.origin === 'user';
              const original = data.entries.find((e) => e.folder === entry.folder);
              return (
                <tr key={entry.folder} className="border-b last:border-b-0 hover:bg-muted/20">
                  <td className="px-4 py-1.5">
                    <span className="font-mono text-xs">{entry.folder}</span>
                  </td>
                  <td className="px-4 py-1.5 text-muted-foreground">
                    {original
                      ? `${PURPOSE_LABELS[original.purpose]} — ${original.reason}`
                      : `${PURPOSE_LABELS[entry.purpose]} — ${entry.reason}`}
                  </td>
                  <td className="px-4 py-1.5">
                    <div className="flex items-center gap-1.5">
                      <Select
                        value={isUserOverride ? entry.purpose : '__auto__'}
                        onValueChange={(v) => handlePurposeChange(entry.folder, v)}
                      >
                        <SelectTrigger
                          className="h-10 w-44 text-sm focus-visible:ring-2 focus-visible:ring-ring"
                          aria-label={`Override purpose for ${entry.folder}`}
                        >
                          <SelectValue>
                            {isUserOverride ? (
                              PURPOSE_LABELS[entry.purpose]
                            ) : (
                              <span className="text-muted-foreground">
                                (auto) {PURPOSE_LABELS[entry.purpose]}
                              </span>
                            )}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__auto__">
                            <span className="text-muted-foreground">(auto)</span>
                          </SelectItem>
                          {ALL_PURPOSES.map((p) => (
                            <SelectItem key={p} value={p}>
                              {PURPOSE_LABELS[p]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {isUserOverride && (
                        <button
                          type="button"
                          onClick={() => handlePurposeChange(entry.folder, '__auto__')}
                          className={cn(
                            'inline-flex h-10 w-10 items-center justify-center rounded-md',
                            'text-muted-foreground hover:text-foreground transition-colors',
                            'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          )}
                          aria-label={`Reset ${entry.folder} to auto`}
                        >
                          <RotateCcw className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={!isDirty || saveMutation.isPending}>
          {saveMutation.isPending ? 'Saving…' : 'Save & Re-analyze'}
        </Button>
      </div>
    </div>
  );
}

function StorageModeBanner({ storageMode }: { storageMode: 'repo-file' | 'local-only' }) {
  if (storageMode === 'repo-file') {
    return (
      <div
        data-testid="storage-mode-banner"
        className="rounded-md border bg-muted/40 px-4 py-3 text-sm text-foreground"
      >
        Reading scope from <span className="font-mono text-xs">.devchain/overview.json</span>
      </div>
    );
  }
  return (
    <div
      data-testid="storage-mode-banner"
      className="rounded-md border bg-muted/20 px-4 py-3 text-sm text-muted-foreground"
    >
      Local-only mode — no <span className="font-mono text-xs">.devchain/overview.json</span>{' '}
      present. Settings are stored locally.
    </div>
  );
}

function SectionHeader() {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <Settings2 className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-lg font-semibold">Scope</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        Control which folders are included in analysis, classified as generated code, or excluded
        entirely.
      </p>
    </div>
  );
}
