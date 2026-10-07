import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  EXCLUSION_LIMIT_ERROR,
  exclusionGroupKey,
  isSelectableExclusion,
  type ExclusionSuggestion,
} from '@/modules/file-sync/sync-path-inspection.dto';
import { IGNORE_PATTERNS_MAX } from '@/modules/file-sync/file-sync.dto';
import { Button } from '@/ui/components/ui/button';
import { Checkbox } from '@/ui/components/ui/checkbox';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/ui/components/ui/collapsible';
import { BusyStatus } from '@/ui/components/ui/spinner';
import { useConnectExclusionContributions } from './useConnectExclusionContributions';
import { useFileSyncSuggestions } from './useFileSyncSuggestions';

const NO_MANUAL_PATTERNS: readonly string[] = [];
const sideName = (side: 'home' | 'vm') => (side === 'home' ? 'this PC' : 'the VM');
const foreignOwners = (group: ExclusionSuggestion, side: 'home' | 'vm') => {
  const facts = group[side];
  return [
    ...new Set(
      facts
        ? [
            ...(facts.foreignOwner ? [facts.owner.name] : []),
            ...facts.foreignOwners.map((owner) => owner.name),
          ]
        : [],
    ),
  ];
};

function LimitedList({ items, name }: { items: ReactNode[]; name: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="space-y-2">
      <ul aria-label={name} className="space-y-2">
        {items.slice(0, 5)}
      </ul>
      {items.length > 5 && (
        <>
          <CollapsibleContent>
            <ul aria-label={`More ${name.toLowerCase()}`} className="space-y-2">
              {items.slice(5)}
            </ul>
          </CollapsibleContent>
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={
                open
                  ? `Show fewer ${name.toLowerCase()}`
                  : `Show ${items.length - 5} more ${name.toLowerCase()}`
              }
            >
              {open ? 'Show less' : `Show ${items.length - 5} more`}
            </Button>
          </CollapsibleTrigger>
        </>
      )}
    </Collapsible>
  );
}

function GroupDetails({ group }: { group: ExclusionSuggestion }) {
  const keeps = group.patterns.filter((pattern) => pattern.startsWith('!'));
  return (
    <Collapsible className="space-y-1">
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Details for ${group.path} on ${sideName(group.side)}`}
        >
          Details
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 border-t pt-2 text-muted-foreground">
        {(['home', 'vm'] as const).map((side) => {
          const owners = foreignOwners(group, side);
          const own = side === group.side && group[side] !== null;
          return (
            (owners.length > 0 || own) && (
              <p key={side}>
                {sideName(side)}
                {owners.length > 0 && ` · owned by ${owners.join(', ')}`}
                {own &&
                  ` · ${group.reasonKind === 'foreignOwner' ? 'owned by another user' : 'not ignored by Git'}`}
              </p>
            )
          );
        })}
        {group.pathSample && group.pathSample.length > 0 && (
          <LimitedList
            name={`Paths in ${group.path}`}
            items={group.pathSample.map((path) => (
              <li key={path}>
                <code className="break-all">{path}</code>
              </li>
            ))}
          />
        )}
        {keeps.length > 0 && (
          <div>
            <p>
              keeps {keeps.length} tracked {keeps.length === 1 ? 'file' : 'files'}
            </p>
            <LimitedList
              name={`Tracked files kept for ${group.path}`}
              items={keeps.map((pattern) => (
                <li key={pattern}>
                  <code className="break-all">{pattern.slice(1)}</code>
                </li>
              ))}
            />
          </div>
        )}
        {group.gitUnchecked && <p>Git could not be checked.</p>}
        {group.patternError && <p>{group.patternError}</p>}
      </CollapsibleContent>
    </Collapsible>
  );
}

function RepairRow({ group }: { group: ExclusionSuggestion }) {
  const [copied, setCopied] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  return (
    <li className="space-y-2">
      <code className="break-all">{group.path}</code>
      {(['home', 'vm'] as const).map((side) => {
        const command = group.chown?.[side];
        return (
          command && (
            <div key={side} className="space-y-1">
              <p>
                {sideName(side)}: <code className="break-all select-text">{command}</code>
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-label={`Copy command for ${group.path} on ${sideName(side)}`}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(command);
                    setCopied(side);
                    setFailed(false);
                  } catch {
                    setFailed(true);
                  }
                }}
              >
                {copied === side ? 'Copied' : 'Copy command'}
              </Button>
            </div>
          )
        );
      })}
      {failed && <p role="alert">Could not copy this command. Select and copy it.</p>}
      <GroupDetails group={group} />
    </li>
  );
}

export function ConnectOwnerProblems({
  projectId,
  remoteId,
  list,
  disabled,
  onPatterns,
  onPending,
  refreshKey = 0,
  manualPatterns = NO_MANUAL_PATTERNS,
}: {
  projectId: string;
  remoteId: string;
  list: readonly string[] | undefined;
  disabled: boolean;
  onPatterns: (patterns: string[], selected: boolean) => void;
  onPending: (pending: boolean) => void;
  refreshKey?: number;
  manualPatterns?: readonly string[];
}) {
  const scan = useFileSyncSuggestions(projectId, remoteId, onPending, refreshKey);
  const contributions = useConnectExclusionContributions(
    scan.result,
    list,
    manualPatterns,
    onPatterns,
  );
  const groups = scan.result?.groups ?? [];
  const selectable = groups.filter(isSelectableExclusion);
  const repairs = groups.filter((group) => group.chown);
  const diagnostic = groups.filter((group) => !isSelectableExclusion(group) && !group.chown);
  const hasProblems = groups.length > 0;
  const limitError =
    contributions.overLimit || groups.some((group) => group.patternError === EXCLUSION_LIMIT_ERROR);
  const status = scan.pending || scan.failed || scan.result?.vm === 'unavailable' || limitError;
  const show = hasProblems || status;

  return (
    <>
      {show && (
        <section
          aria-label="Files that cannot sync"
          className="space-y-3 rounded-md border bg-card p-4 text-sm"
        >
          <h3 className="font-medium">Files that cannot sync</h3>
          {scan.pending && <BusyStatus>Scanning for suggested exclusions…</BusyStatus>}
          {scan.failed && <p role="status">DevChain could not scan this PC.</p>}
          {scan.result?.vm === 'unavailable' && (
            <p role="status">DevChain could not scan the VM.</p>
          )}
          {limitError && (
            <p role="status">
              These suggestions would pass the limit of {IGNORE_PATTERNS_MAX} patterns.
            </p>
          )}
          {hasProblems && (
            <div className="space-y-1">
              {(['home', 'vm'] as const).map((side) => {
                const affected = groups.filter((group) => foreignOwners(group, side).length > 0);
                const owners = [
                  ...new Set(affected.flatMap((group) => foreignOwners(group, side))),
                ];
                return (
                  owners.length > 0 && (
                    <p key={side}>
                      {owners.join(', ')} {owners.length === 1 ? 'owns' : 'own'} files in{' '}
                      {affected.length} {affected.length === 1 ? 'group' : 'groups'} on{' '}
                      {sideName(side)}. File sync cannot change them.
                    </p>
                  )
                );
              })}
            </div>
          )}
          {selectable.length > 0 && (
            <section aria-label="Exclude them" className="space-y-2 rounded-md border p-3">
              <h4 className="font-medium">Exclude them (on now)</h4>
              <LimitedList
                name="Exclusion groups"
                items={selectable.map((group) => (
                  <li key={exclusionGroupKey(group)} className="space-y-1">
                    <div className="flex items-start gap-2">
                      <Checkbox
                        aria-label={`Exclude ${group.path} on ${sideName(group.side)}`}
                        checked={contributions.checked(group)}
                        disabled={disabled || !list}
                        onCheckedChange={(selected) =>
                          contributions.toggle(group, selected === true)
                        }
                      />
                      <code className="break-all">{group.pattern ?? group.path}</code>
                    </div>
                    <p>
                      {sideName(group.side)} · {group.fileCount}{' '}
                      {group.fileCount === 1 ? 'file' : 'files'} in this group
                      {group.pathCount !== undefined &&
                        ` · ${group.pathCount} ${group.pathCount === 1 ? 'path' : 'paths'}`}
                    </p>
                    <GroupDetails group={group} />
                  </li>
                ))}
              />
            </section>
          )}
          {repairs.length > 0 && (
            <Collapsible className="space-y-2">
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-auto whitespace-normal text-left"
                >
                  Files Git tracks (cannot be excluded) · {repairs.length}
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <LimitedList
                  name="Tracked files to repair"
                  items={repairs.map((group) => (
                    <RepairRow key={exclusionGroupKey(group)} group={group} />
                  ))}
                />
              </CollapsibleContent>
            </Collapsible>
          )}
          {diagnostic.length > 0 && (
            <section aria-label="Scan details" className="space-y-2">
              <h4 className="font-medium">Scan details</h4>
              <LimitedList
                name="Scan details"
                items={diagnostic.map((group) => (
                  <li key={exclusionGroupKey(group)} className="space-y-1">
                    <p>
                      <code className="break-all">{group.path}</code> · {sideName(group.side)}
                    </p>
                    {group.blockedBy && (
                      <p>
                        Your list has <code>{group.blockedBy}</code>, which keeps these files in
                        sync. Edit the list below.
                      </p>
                    )}
                    <GroupDetails group={group} />
                  </li>
                ))}
              />
            </section>
          )}
        </section>
      )}
    </>
  );
}
