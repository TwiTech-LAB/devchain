import { MoreHorizontal } from 'lucide-react';
import { Badge } from '@/ui/components/ui/badge';
import { Button } from '@/ui/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/components/ui/dropdown-menu';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/ui/components/ui/table';
import type { VaultEntry, VaultGrant } from '@/ui/lib/vault';
import {
  AccessChips,
  accessFromGrants,
  accessScopeLabel,
  type AccessChip,
} from './ProjectAccessEditor';
import { APPROVAL_REQUIRED_LABEL } from './VaultEntryDialogs';
import { formatVaultTime } from './VaultEntryPanel';

const MAX_CHIPS = 3;

function ProjectChips({
  grants,
  projectNames,
  loading,
}: {
  grants: VaultGrant[];
  projectNames: Map<string, string>;
  loading: boolean;
}) {
  if (loading) return <span className="text-sm text-muted-foreground">Loading…</span>;
  const chips: AccessChip[] = accessFromGrants(grants).map((access) => ({
    key: access.projectId,
    tone: 'neutral',
    label: `${projectNames.get(access.projectId) ?? access.projectId}: ${accessScopeLabel(access)}`,
  }));
  if (chips.length === 0) return <span className="text-sm text-muted-foreground">No projects</span>;
  const hidden = chips.slice(MAX_CHIPS);
  return (
    <AccessChips
      chips={[
        ...chips.slice(0, MAX_CHIPS),
        ...(hidden.length > 0
          ? [
              {
                key: 'hidden',
                tone: 'neutral' as const,
                label: `+${hidden.length}`,
                title: hidden.map((chip) => chip.label).join('\n'),
              },
            ]
          : []),
      ]}
    />
  );
}

export function VaultEntriesTable({
  entries,
  grants,
  grantsLoading,
  projectNames,
  readOnly,
  valueWritesEnabled,
  onOpen,
  onReplaceValue,
  onDelete,
}: {
  entries: VaultEntry[];
  grants: VaultGrant[];
  grantsLoading: boolean;
  projectNames: Map<string, string>;
  readOnly: boolean;
  valueWritesEnabled: boolean;
  onOpen: (entry: VaultEntry) => void;
  onReplaceValue: (entry: VaultEntry) => void;
  onDelete: (entry: VaultEntry) => void;
}) {
  const grantsByEntry = new Map<string, VaultGrant[]>();
  for (const grant of grants) {
    const list = grantsByEntry.get(grant.entryId) ?? [];
    list.push(grant);
    grantsByEntry.set(grant.entryId, list);
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Kind</TableHead>
          <TableHead>Description</TableHead>
          <TableHead>Projects</TableHead>
          <TableHead>Last used</TableHead>
          {readOnly ? null : (
            <TableHead className="w-12">
              <span className="sr-only">Actions</span>
            </TableHead>
          )}
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((entry) => (
          <TableRow key={entry.id} className="cursor-pointer" onClick={() => onOpen(entry)}>
            <TableCell>
              <button
                type="button"
                className="rounded-sm text-left font-mono hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {entry.name}
              </button>
            </TableCell>
            <TableCell>
              <div className="flex flex-wrap gap-1">
                <Badge variant="secondary" className="font-normal">
                  {entry.kind}
                </Badge>
                {entry.approvalRequired ? (
                  <Badge variant="outline" className="font-normal" title={APPROVAL_REQUIRED_LABEL}>
                    approval
                  </Badge>
                ) : null}
              </div>
            </TableCell>
            <TableCell className="max-w-xs break-words text-muted-foreground">
              {entry.description}
            </TableCell>
            <TableCell>
              <ProjectChips
                grants={grantsByEntry.get(entry.id) ?? []}
                projectNames={projectNames}
                loading={grantsLoading}
              />
            </TableCell>
            <TableCell className="whitespace-nowrap text-muted-foreground">
              {formatVaultTime(entry.lastUsedAt)}
            </TableCell>
            {readOnly ? null : (
              // Menu items render in a portal but their events still bubble here, not to the row.
              <TableCell className="text-right" onClick={(event) => event.stopPropagation()}>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      aria-label={`Actions for ${entry.name}`}
                    >
                      <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => onOpen(entry)}>Edit</DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={!valueWritesEnabled}
                      onSelect={() => onReplaceValue(entry)}
                    >
                      Replace value
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onSelect={() => onDelete(entry)}
                    >
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
