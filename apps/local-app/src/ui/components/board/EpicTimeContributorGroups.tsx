import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { EpicTimeTaskItem } from '@/modules/epic-time/models/epic-time.models';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/ui/components/ui/collapsible';
import {
  formatEpicTimeMinutes,
  groupEpicTimeContributors,
  type EpicTimeContributorGroup,
  type EpicTimeContributorRow,
} from '@/ui/lib/epic-time';

const INCLUDED_TOTAL_EXPLANATION =
  'Only DevChain activity that rolls into this remote task is shown.';

interface EpicTimeContributorGroupsProps {
  taskItems: readonly EpicTimeTaskItem[];
  /** Linked focal Epic; the panel remounts this list by it so a relink resets expansion. */
  focalEpicId: string;
}

function ContributorRow({ row, label }: { row: EpicTimeContributorRow; label?: string }) {
  return (
    <li className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
      <span className="min-w-0 break-words">{label ?? row.epicTitle}</span>
      <span className="shrink-0 tabular-nums">{formatEpicTimeMinutes(row.minutes)}</span>
    </li>
  );
}

function ContributorGroupSummary({
  label,
  includedTotalMinutes,
  open,
  emphasized = false,
}: {
  label: string;
  includedTotalMinutes: number;
  open?: boolean;
  emphasized?: boolean;
}) {
  return (
    <>
      <span
        className={
          emphasized ? 'min-w-0 break-words font-medium text-foreground' : 'min-w-0 break-words'
        }
      >
        {label}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        <span className="font-medium tabular-nums">
          {formatEpicTimeMinutes(includedTotalMinutes)}
        </span>
        {open !== undefined ? (
          <ChevronRight
            className={open ? 'h-4 w-4 shrink-0 rotate-90' : 'h-4 w-4 shrink-0'}
            aria-hidden="true"
          />
        ) : null}
      </span>
    </>
  );
}

/**
 * Estimate contributors under a linked remote task. A payload where every
 * row carries valid group metadata renders display-owner groups — "This
 * task" first, then related groups — each starting collapsed behind a Radix
 * disclosure; any degraded row falls back to the exact legacy flat list and
 * claims no relationship. Disclosure state is one local Set of group IDs,
 * reset purely by the focalEpicId remount key.
 */
export function EpicTimeContributorGroups({
  taskItems,
  focalEpicId,
}: EpicTimeContributorGroupsProps) {
  if (taskItems.length === 0) {
    return null;
  }
  const groups = groupEpicTimeContributors(taskItems, focalEpicId);
  if (groups === null) {
    return (
      <ul className="space-y-1" aria-label="Contributing DevChain tasks">
        {taskItems.map((item) => (
          <ContributorRow key={item.epicId} row={item} />
        ))}
      </ul>
    );
  }
  return <ContributorGroupList groups={groups} />;
}

function ContributorGroupList({ groups }: { groups: readonly EpicTimeContributorGroup[] }) {
  const [expandedGroupIds, setExpandedGroupIds] = useState<ReadonlySet<string>>(() => new Set());
  const toggleGroup = (groupEpicId: string, open: boolean) => {
    setExpandedGroupIds((previous) => {
      const next = new Set(previous);
      if (open) {
        next.add(groupEpicId);
      } else {
        next.delete(groupEpicId);
      }
      return next;
    });
  };
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{INCLUDED_TOTAL_EXPLANATION}</p>
      <ul className="space-y-1" aria-label="Contributing DevChain task groups">
        {groups.map((group) => {
          const label = group.isFocal ? 'This task' : `Related: ${group.groupEpicTitle}`;
          const open = expandedGroupIds.has(group.groupEpicId);
          return (
            <li key={group.groupEpicId}>
              {group.disclosable ? (
                <Collapsible
                  open={open}
                  onOpenChange={(nextOpen) => toggleGroup(group.groupEpicId, nextOpen)}
                >
                  <CollapsibleTrigger className="flex w-full items-center justify-between gap-3 rounded-md px-1 py-1 text-left text-sm transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
                    <ContributorGroupSummary
                      label={label}
                      includedTotalMinutes={group.includedTotalMinutes}
                      open={open}
                      emphasized
                    />
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <ul className="space-y-1 py-1 pl-3">
                      {group.ownActivity ? (
                        <ContributorRow row={group.ownActivity} label="Own activity" />
                      ) : null}
                      {group.children.map((child) => (
                        <ContributorRow key={child.epicId} row={child} />
                      ))}
                    </ul>
                  </CollapsibleContent>
                </Collapsible>
              ) : (
                <p className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
                  <ContributorGroupSummary
                    label={label}
                    includedTotalMinutes={group.includedTotalMinutes}
                  />
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
