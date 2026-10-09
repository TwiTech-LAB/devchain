import { useEffect, useState, type FormEvent } from 'react';
import { X } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { isGiveOwnershipEligible } from '@/modules/file-sync/sync-path-inspection.dto';
import { SYNC_CHOWN_PATHS_MAX } from '@/modules/file-sync/sync-chown.dto';
import { useRemoteVmApi } from './lib/remote-vm-api-context';
import { fileSyncAutoFixQueryKey } from './lib/remote-vm-query-keys';
import type {
  FailedSyncFile,
  ForceSyncOffer,
  ProjectPatternPreview,
} from '@/modules/remotes/sync/remote-file-sync.dto';
import {
  IGNORE_PATTERNS_MAX,
  IGNORE_PATTERN_MAX_LENGTH,
  IgnorePatternsSchema,
} from '@/modules/file-sync/file-sync.dto';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import {
  compileIgnoreList,
  ignorePatternProblem,
} from '@/modules/file-sync/ignore-pattern-matcher';
import { Badge } from '@/ui/components/ui/badge';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/label';
import { Button } from '@/ui/components/ui/button';
import { Checkbox } from '@/ui/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { BusyStatus } from '@/ui/components/ui/spinner';
import { getErrorMessage } from '@/ui/lib/toast-helpers';
import { useProjectIgnores, useSaveProjectIgnores } from './connect-ignores';
import { FileListChangedError } from './lib/remote-vm-errors';
import { FileSyncAutoFixControls } from './FileSyncAutoFixControls';
import { isSelectableExclusion, useProjectFileSyncFailures } from './file-sync-failures';
import { useFileSyncPatternPreview } from './file-sync-pattern-preview';

const SIDES = ['home', 'vm'] as const;
const SIDE_LABELS = { home: 'This PC', vm: 'The VM' };
function failureReason(file: FailedSyncFile) {
  if (/hashing/i.test(file.error)) return 'cannot read';
  if (/syncing/i.test(file.error)) return 'cannot change';
  return file.error;
}
function gitState(file: FailedSyncFile) {
  if (!file.git || file.git.state === 'error') return 'Git could not be checked';
  if (file.git.state === 'no-repo') return 'No Git repository';
  if (file.git.tracked) return 'Tracked by Git';
  return file.git.ignored ? 'Git ignores it' : 'Not tracked by Git';
}

const UNCHECKED_REASONS: Record<'unavailable' | 'error' | 'no-root' | 'no-repo', string> = {
  unavailable: 'unavailable',
  error: 'Git could not be checked',
  'no-root': 'project folder does not exist',
  'no-repo': 'no Git repository',
};
function PatternWarnings({ result }: { result: ProjectPatternPreview }) {
  return (
    <div aria-label="Pattern preview" className="space-y-2">
      {SIDES.map((side) => {
        const preview = result[side];
        if (preview.state !== 'checked') {
          const reason = UNCHECKED_REASONS[preview.state];
          return (
            <p key={side} role="status">
              {SIDE_LABELS[side]}: {reason}. Pattern matches are unknown.
            </p>
          );
        }
        return (
          <div key={side} className="space-y-1">
            {(['tracked', 'kept'] as const).map((kind) => {
              const matches = preview[kind];
              if (matches.count === 0) return null;
              return (
                <div key={kind} role="status" className="text-status-warn">
                  <p>
                    {SIDE_LABELS[side]}: this pattern excludes {matches.count}{' '}
                    {kind === 'tracked' ? 'tracked' : 'Git-kept'}{' '}
                    {matches.count === 1 ? 'file' : 'files'}.
                  </p>
                  <ul>
                    {matches.sample.slice(0, 5).map((path) => (
                      <li key={path}>
                        <code className="break-all">{path}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

export function FixFileSyncDialog({
  projectId,
  projectName,
  onClose,
  onEditSettings,
  warning,
  onForceSync,
}: {
  projectId: string;
  projectName: string;
  onClose: () => void;
  onEditSettings: () => void;
  warning?: string | null;
  onForceSync: (offer: ForceSyncOffer) => void;
}) {
  const api = useRemoteVmApi();
  const failed = useProjectFileSyncFailures(projectId);
  const queryClient = useHomeQueryClient();
  const ignores = useProjectIgnores(projectId);
  const saveIgnores = useSaveProjectIgnores();
  const [baseline, setBaseline] = useState<{ list: string[]; revision: number } | null>(null);
  useEffect(() => {
    if (!baseline && !ignores.isFetching && ignores.data && ignores.revision !== undefined)
      setBaseline({ list: ignores.data, revision: ignores.revision });
  }, [baseline, ignores.isFetching, ignores.data, ignores.revision]);
  const [ownPatterns, setOwnPatterns] = useState<string[]>([]);
  const [pattern, setPattern] = useState('');
  const [selections, setSelections] = useState<Record<string, boolean>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const groupKey = (group: { side: string; path: string }) => `${group.side}:${group.path}`;
  const selected =
    failed.data?.groups.filter(
      (group) => isSelectableExclusion(group) && (selections[groupKey(group)] ?? group.selected),
    ) ?? [];
  const list = [
    ...new Set([
      ...(baseline?.list ?? []),
      ...ownPatterns,
      ...selected.flatMap((group) => group.patterns),
    ]),
  ];
  const validDraft = IgnorePatternsSchema.safeParse(list).success;
  const savedChanged =
    !!baseline &&
    (baseline.list.length !== ignores.data?.length ||
      baseline.list.some((item, index) => item !== ignores.data?.[index]));
  const trimmed = pattern.trim();
  const problem = trimmed ? ignorePatternProblem(list, trimmed) : null;
  const candidate = trimmed && !problem ? trimmed : null;
  const draftPatterns = [
    ...(failed.data?.installedPrefix ?? []),
    ...(baseline?.list ?? []),
    ...ownPatterns,
    ...(candidate ? [candidate] : []),
    ...selected.flatMap((group) => group.patterns),
  ];
  // Compiled once per render, not once per failed file.
  const matchDraft = compileIgnoreList(draftPatterns);
  const preview = useFileSyncPatternPreview(
    projectId,
    failed.data && ignores.data ? candidate : null,
  );
  const addPattern = (event: FormEvent) => {
    event.preventDefault();
    if (!candidate) return;
    setOwnPatterns((previous) => [...previous, candidate]);
    setPattern('');
  };
  const owners = [
    ...new Set(
      SIDES.flatMap(
        (side) =>
          failed.data?.[side].entries.flatMap((file) => (file.owner ? [file.owner.name] : [])) ??
          [],
      ),
    ),
  ];
  const mutation = useMutation(
    {
      mutationFn: () => saveIgnores(projectId, list, baseline!.revision),
      onError: (error) => {
        if (error instanceof FileListChangedError) setBaseline(null);
      },
      onSuccess: async (result) => {
        setMessage(result.message);
        setBaseline({ list: result.ignores, revision: result.revision });
        await failed.refetch();
        setSelections({});
        setOwnPatterns([]);
        setPattern('');
      },
    },
    useHomeQueryClient(),
  );
  const copyCommand = async (command: string) => {
    setCopyError(null);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable.');
      await navigator.clipboard.writeText(command);
      setCopied(command);
    } catch (error) {
      setCopyError(getErrorMessage(error, 'Could not copy the command.'));
    }
  };
  const give = useMutation(
    {
      mutationFn: async (paths: string[]) => {
        const outcomes = [];
        for (let offset = 0; offset < paths.length; offset += SYNC_CHOWN_PATHS_MAX) {
          const result = await api.giveFileOwnership(
            projectId,
            paths.slice(offset, offset + SYNC_CHOWN_PATHS_MAX),
          );
          outcomes.push(...result.items);
        }
        return outcomes;
      },
      onSuccess: async (items) => {
        const reasons = [...new Set(items.flatMap((item) => (item.reason ? [item.reason] : [])))];
        setMessage(reasons.length ? reasons.join(' ') : 'The VM user now owns these files.');
        await failed.refetch();
        await queryClient.invalidateQueries({
          queryKey: fileSyncAutoFixQueryKey(projectId),
        });
      },
    },
    queryClient,
  );
  const eligible = failed.data?.groups.filter(isGiveOwnershipEligible) ?? [];
  const vmUser = failed.data?.vmUser?.name ?? 'VM user';
  const busy = mutation.isPending || give.isPending;
  const forceSync = failed.data?.forceSync;
  const openForceSync = () => {
    if (forceSync?.offered) onForceSync(forceSync);
  };
  const count = SIDES.reduce((total, side) => total + (failed.data?.[side].entries.length ?? 0), 0);
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Fix file sync · {projectName}</DialogTitle>
          <DialogDescription>
            Review files that cannot sync and choose exclusions for runtime output.
          </DialogDescription>
        </DialogHeader>
        {warning && <p className="text-sm">{warning}</p>}
        {failed.isFetching && <BusyStatus>Reading file sync failures…</BusyStatus>}
        {failed.error && (
          <p role="alert" className="text-sm text-destructive">
            {failed.error.message}
          </p>
        )}
        {ignores.error && (
          <p role="alert" className="text-sm text-destructive">
            {ignores.error.message}
          </p>
        )}
        {failed.data && (
          <div className="space-y-4 text-sm">
            {count > 0 && (
              <section aria-label="Why this happens" className="space-y-1">
                <h3 className="font-medium">Why this happens</h3>
                <p>
                  File sync cannot read or change files owned by another user. A program, often a
                  Docker container, may have written these files as{' '}
                  {owners.length ? owners.join(', ') : 'another user'}.
                </p>
              </section>
            )}
            {count === 0 && !SIDES.some((side) => failed.data?.[side].readError) && (
              <p>No files currently fail to sync.</p>
            )}
            {baseline && baseline.list.length > 0 && (
              <section aria-label="Saved patterns" className="space-y-2">
                <h3 className="font-medium">Saved patterns</h3>
                <div className="flex flex-wrap gap-2">
                  {baseline.list.map((item, index) => (
                    <Badge key={`${index}:${item}`} variant="secondary" className="gap-1 font-mono">
                      {item}
                      <button
                        type="button"
                        aria-label={`Remove ${item}`}
                        disabled={busy}
                        onClick={() =>
                          setBaseline({
                            ...baseline,
                            list: baseline.list.filter((_, position) => position !== index),
                          })
                        }
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              </section>
            )}
            <section aria-label="Your own patterns" className="space-y-2">
              <form onSubmit={addPattern} className="flex flex-wrap items-end gap-2">
                <div className="min-w-[12rem] flex-1 space-y-1.5">
                  <Label htmlFor="fix-sync-pattern">Add your own pattern</Label>
                  <Input
                    id="fix-sync-pattern"
                    value={pattern}
                    placeholder="(?d)*.egg-info or !/keep.txt"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={busy || !ignores.data}
                    aria-invalid={problem ? true : undefined}
                    aria-describedby={problem ? 'fix-sync-pattern-problem' : undefined}
                    onChange={(event) => setPattern(event.target.value)}
                    className="font-mono"
                  />
                </div>
                <Button
                  type="submit"
                  variant="outline"
                  disabled={busy || !candidate || !ignores.data}
                >
                  Add
                </Button>
              </form>
              {problem && (
                <p id="fix-sync-pattern-problem" role="alert" className="text-destructive">
                  {problem}
                </p>
              )}
              {ownPatterns.length > 0 && (
                <ul aria-label="Own patterns" className="flex flex-wrap gap-1.5">
                  {ownPatterns.map((item) => (
                    <li key={item}>
                      <Badge variant="secondary" className="gap-1 pr-1 font-mono font-normal">
                        <span className="break-all">{item}</span>
                        <button
                          type="button"
                          aria-label={`Remove ${item}`}
                          disabled={busy}
                          onClick={() =>
                            setOwnPatterns((previous) => previous.filter((kept) => kept !== item))
                          }
                          className="rounded-sm p-0.5 hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                        >
                          <X aria-hidden="true" className="h-3 w-3" />
                        </button>
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
              {preview?.kind === 'loading' && <BusyStatus>Checking pattern…</BusyStatus>}
              {preview?.kind === 'error' && (
                <p role="status">{preview.message} Pattern matches are unknown.</p>
              )}
              {preview?.kind === 'result' && <PatternWarnings result={preview.result} />}
            </section>
            {SIDES.filter(
              (side) =>
                failed.data?.[side].entries.length ||
                failed.data?.[side].readError ||
                (side === 'vm' && eligible.length > 0) ||
                failed.data?.groups.some((group) => group.side === side || group.chown?.[side]),
            ).map((side) => (
              <section key={side} aria-label={SIDE_LABELS[side]} className="space-y-2">
                <h3 className="font-medium">{SIDE_LABELS[side]}</h3>
                {side === 'vm' && eligible.length > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => give.mutate([...new Set(eligible.map((group) => group.path))])}
                  >
                    Give all to {vmUser}
                  </Button>
                )}
                {failed.data?.[side].readError && <p role="alert">{failed.data[side].readError}</p>}
                <ul className="space-y-2">
                  {failed.data?.[side].entries.map((file) => {
                    const match = matchDraft(file.path);
                    return (
                      <li
                        key={file.path}
                        className={`space-y-1 rounded-md p-2 ${match.kind === 'matched' ? 'bg-selected text-selected-foreground' : ''}`}
                      >
                        <code className="break-all">{file.path}</code>
                        <p>
                          owned by {file.owner?.name ?? 'an unknown user'} · {failureReason(file)} ·{' '}
                          {gitState(file)}
                        </p>
                        {match.kind === 'matched' && (
                          <p>
                            {match.ignored ? 'excluded by' : 'kept by'}{' '}
                            <code>{draftPatterns[match.index]}</code>
                          </p>
                        )}
                        {match.kind === 'unknown' && <p>unknown</p>}
                      </li>
                    );
                  })}
                </ul>
                {failed.data?.groups
                  .filter(
                    (group) =>
                      group.side === side || (side === 'vm' && isGiveOwnershipEligible(group)),
                  )
                  .map((group) => (
                    <div key={groupKey(group)} className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        {group.side !== side && <code className="break-all">{group.path}</code>}
                        {group.side === side && isSelectableExclusion(group) && (
                          <label className="flex items-center gap-2">
                            <Checkbox
                              aria-label={`Exclude ${group.path} on ${SIDE_LABELS[side]}`}
                              checked={selections[groupKey(group)] ?? group.selected}
                              disabled={busy}
                              onCheckedChange={(checked) =>
                                setSelections((previous) => ({
                                  ...previous,
                                  [groupKey(group)]: checked === true,
                                }))
                              }
                            />
                            <code className="break-all">{group.pattern ?? group.path}</code>
                          </label>
                        )}
                        {side === 'vm' && isGiveOwnershipEligible(group) && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() => give.mutate([group.path])}
                          >
                            Give to {vmUser}
                          </Button>
                        )}
                      </div>
                      {side === 'vm' && isGiveOwnershipEligible(group) && (
                        <p>
                          Give to {vmUser} makes your VM user the owner of these files. Then file
                          sync can read and change them, and they sync to this PC like your own
                          files. Use it for files that belong to your code, for example a new
                          migration. For data or build output, exclude them instead. DevChain never
                          does this automatically.
                        </p>
                      )}
                      {group.pathCount !== undefined && (
                        <p>
                          covers {group.pathCount} {group.pathCount === 1 ? 'path' : 'paths'} ·{' '}
                          {group.fileCount} {group.fileCount === 1 ? 'file' : 'files'}
                        </p>
                      )}
                      {group.pathSample && group.pathSample.length > 0 && (
                        <ul className="space-y-1">
                          {group.pathSample.map((path) => (
                            <li key={path}>
                              <code className="break-all">{path}</code>
                            </li>
                          ))}
                        </ul>
                      )}
                      {group.patterns
                        .filter((item) => !item.startsWith('!') && item !== group.pattern)
                        .map((item) => (
                          <p key={item}>
                            <code className="break-all">{item}</code>
                          </p>
                        ))}
                      {group.patterns
                        .filter((pattern) => pattern.startsWith('!'))
                        .map((pattern) => (
                          <p key={pattern}>
                            keeps tracked files: <code>{pattern.slice(1)}</code>
                          </p>
                        ))}
                      {group.blockedBy && (
                        <>
                          <p>
                            Your list has <code>{group.blockedBy}</code>, which keeps these files in
                            sync.
                          </p>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={onEditSettings}
                          >
                            Edit file sync settings
                          </Button>
                        </>
                      )}
                      {group.gitUnchecked && <p>Git could not be checked.</p>}
                      {group.patternError && <p>{group.patternError}</p>}
                    </div>
                  ))}
                {failed.data?.groups
                  .flatMap((group) => (group.chown?.[side] ? [group.chown[side]!] : []))
                  .map((command) => (
                    <div key={command} className="flex flex-wrap items-center gap-2">
                      <code className="break-all">{command}</code>
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`Copy command on ${SIDE_LABELS[side]}: ${command}`}
                        onClick={() => void copyCommand(command)}
                      >
                        {copied === command ? 'Copied' : 'Copy'}
                      </Button>
                    </div>
                  ))}
              </section>
            ))}
            <FileSyncAutoFixControls projectId={projectId} disabled={busy} />
            {failed.data.ownershipNotes?.map((note) => (
              <p key={note} role="status">
                {note}
              </p>
            ))}
            {failed.data.overLimit && (
              <p role="alert">
                These suggestions would pass the limit of {IGNORE_PATTERNS_MAX} patterns.
              </p>
            )}
            {!validDraft && (
              <p role="alert" className="text-destructive">
                The final list must have at most {IGNORE_PATTERNS_MAX} patterns, each from 1 to{' '}
                {IGNORE_PATTERN_MAX_LENGTH} characters.
              </p>
            )}
          </div>
        )}
        {message && (
          <p role="status" className="text-sm">
            {message}
          </p>
        )}
        {mutation.error && (
          <p role="alert" className="text-sm text-destructive">
            {mutation.error.message}
          </p>
        )}
        {give.error && (
          <p role="alert" className="text-sm text-destructive">
            {give.error.message}
          </p>
        )}
        {copyError && (
          <p role="alert" className="text-sm text-destructive">
            {copyError}
          </p>
        )}
        {forceSync?.offered && (
          <section
            aria-label="Last resort: Force sync"
            className="space-y-2 rounded-md border border-destructive/40 p-3 text-sm"
          >
            <h3 className="font-medium">Last resort: Force sync</h3>
            <p>Use this only when the fixes above do not help.</p>
            <Button
              variant="destructive"
              onClick={openForceSync}
              disabled={busy || failed.isFetching}
            >
              Force sync…
            </Button>
          </section>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Close
          </Button>
          <Button
            pending={busy}
            disabled={
              !failed.data ||
              !baseline ||
              !ignores.data ||
              failed.isFetching ||
              failed.isError ||
              ignores.isError ||
              !validDraft ||
              (selected.length === 0 && ownPatterns.length === 0 && !savedChanged)
            }
            onClick={() => mutation.mutate()}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
