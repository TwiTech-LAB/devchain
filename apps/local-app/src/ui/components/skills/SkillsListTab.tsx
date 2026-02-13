import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ArrowUpDown, Loader2, Search } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/ui/components/ui/alert-dialog';
import { Badge } from '@/ui/components/ui/badge';
import { Button } from '@/ui/components/ui/button';
import { Input } from '@/ui/components/ui/input';
import { Switch } from '@/ui/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/ui/components/ui/table';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';
import { useToast } from '@/ui/hooks/use-toast';
import {
  disableAllSkills,
  disableSkill,
  enableAllSkills,
  enableSkill,
  fetchSkills,
  type SkillListItem,
  type SkillStatus,
} from '@/ui/lib/skills';
import { cn } from '@/ui/lib/utils';
import { CategoryBadge } from './CategoryBadge';
import { getSourceDisplay } from './source-display';
import { SyncButton } from './SyncButton';

export interface SkillsListTabProps {
  onSelectSkill?: (skillId: string) => void;
}

type SkillSortField = 'name' | 'category' | 'source' | 'enabled';
type SortDirection = 'asc' | 'desc';

const SKILL_STATUS_BADGES: Record<SkillStatus, { label: string; className: string }> = {
  available: {
    label: 'Available',
    className: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  },
  outdated: {
    label: 'Outdated',
    className: 'border-amber-200 bg-amber-50 text-amber-800',
  },
  sync_error: {
    label: 'Sync Error',
    className: 'border-red-200 bg-red-50 text-red-800',
  },
};

function getSearchValue(skill: SkillListItem): string {
  return [skill.name, skill.displayName, skill.description, skill.shortDescription]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
    .toLowerCase();
}

export function SkillsListTab({ onSelectSkill }: SkillsListTabProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { selectedProjectId } = useSelectedProject();
  const [search, setSearch] = useState('');
  const [sortField, setSortField] = useState<SkillSortField>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [isDisableAllDialogOpen, setIsDisableAllDialogOpen] = useState(false);
  const [isEnableAllDialogOpen, setIsEnableAllDialogOpen] = useState(false);

  const {
    data: skills,
    isLoading: skillsLoading,
    error: skillsError,
  } = useQuery({
    queryKey: ['skills', selectedProjectId],
    queryFn: () => fetchSkills(selectedProjectId as string),
    enabled: Boolean(selectedProjectId),
  });

  const filteredAndSortedSkills = useMemo(() => {
    const trimmedSearch = search.trim().toLowerCase();
    const filtered =
      trimmedSearch.length === 0
        ? (skills ?? [])
        : (skills ?? []).filter((skill) => getSearchValue(skill).includes(trimmedSearch));

    const sorted = [...filtered];
    sorted.sort((left, right) => {
      let result = 0;
      switch (sortField) {
        case 'name': {
          const leftName = left.displayName || left.name;
          const rightName = right.displayName || right.name;
          result = leftName.localeCompare(rightName, undefined, { sensitivity: 'base' });
          break;
        }
        case 'category': {
          const leftCategory = left.category ?? '';
          const rightCategory = right.category ?? '';
          result = leftCategory.localeCompare(rightCategory, undefined, {
            sensitivity: 'base',
          });
          break;
        }
        case 'source': {
          const leftSource = getSourceDisplay(left.source).label;
          const rightSource = getSourceDisplay(right.source).label;
          result = leftSource.localeCompare(rightSource, undefined, { sensitivity: 'base' });
          break;
        }
        case 'enabled': {
          const leftDisabled = Number(left.disabled);
          const rightDisabled = Number(right.disabled);
          result = leftDisabled - rightDisabled;
          break;
        }
        default:
          result = 0;
      }

      return sortDirection === 'asc' ? result : -result;
    });

    return sorted;
  }, [search, skills, sortField, sortDirection]);

  const toggleSort = (field: SkillSortField) => {
    if (sortField === field) {
      setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'));
      return;
    }

    setSortField(field);
    setSortDirection('asc');
  };

  const renderSortHeader = (
    field: SkillSortField,
    label: string,
    className?: string,
    iconClassName?: string,
  ) => (
    <TableHead className={className}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-1 text-xs font-semibold text-muted-foreground hover:text-foreground"
        onClick={() => toggleSort(field)}
      >
        {label}
        <ArrowUpDown className={cn('h-3.5 w-3.5', iconClassName)} aria-hidden="true" />
        {sortField === field ? <span>{sortDirection === 'asc' ? '↑' : '↓'}</span> : null}
      </Button>
    </TableHead>
  );

  const toggleDisableMutation = useMutation({
    mutationFn: async ({ skillId, nextEnabled }: { skillId: string; nextEnabled: boolean }) => {
      if (!selectedProjectId) {
        throw new Error('Please select a project first');
      }

      if (nextEnabled) {
        await enableSkill(selectedProjectId, skillId);
      } else {
        await disableSkill(selectedProjectId, skillId);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['skills', selectedProjectId] });
    },
    onError: (error) => {
      toast({
        title: 'Failed to update skill status',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    },
  });

  const disableAllMutation = useMutation({
    mutationFn: async () => {
      if (!selectedProjectId) {
        throw new Error('Please select a project first');
      }

      return disableAllSkills(selectedProjectId);
    },
    onSuccess: (result) => {
      setIsDisableAllDialogOpen(false);
      queryClient.invalidateQueries({ queryKey: ['skills', selectedProjectId] });
      toast({
        title: 'Skills disabled',
        description: `Disabled ${result.disabledCount} skill${result.disabledCount === 1 ? '' : 's'}.`,
      });
    },
    onError: (error) => {
      toast({
        title: 'Failed to disable all skills',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    },
  });

  const enableAllMutation = useMutation({
    mutationFn: async () => {
      if (!selectedProjectId) {
        throw new Error('Please select a project first');
      }

      return enableAllSkills(selectedProjectId);
    },
    onSuccess: (result) => {
      setIsEnableAllDialogOpen(false);
      queryClient.invalidateQueries({ queryKey: ['skills', selectedProjectId] });
      toast({
        title: 'Skills enabled',
        description: `Enabled ${result.enabledCount} skill${result.enabledCount === 1 ? '' : 's'}.`,
      });
    },
    onError: (error) => {
      toast({
        title: 'Failed to enable all skills',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    },
  });

  if (!selectedProjectId) {
    return (
      <div className="flex min-h-[220px] items-center justify-center rounded-md border border-dashed">
        <p className="text-sm text-muted-foreground">Select a project to browse skills.</p>
      </div>
    );
  }

  if (skillsError) {
    return (
      <div className="flex min-h-[220px] flex-col items-center justify-center gap-3 rounded-md border border-dashed">
        <AlertCircle className="h-5 w-5 text-destructive" />
        <p className="text-sm text-destructive">
          {skillsError instanceof Error ? skillsError.message : 'Failed to load skills'}
        </p>
      </div>
    );
  }

  const hasSkills = (skills?.length ?? 0) > 0;
  const hasPendingBulkMutation = disableAllMutation.isPending || enableAllMutation.isPending;

  return (
    <>
      <div className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative w-full max-w-sm">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search skills by name or description"
              className="pl-8"
              aria-label="Search skills"
            />
          </div>

          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsDisableAllDialogOpen(true)}
              disabled={!hasSkills || hasPendingBulkMutation}
            >
              {disableAllMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Disabling...
                </>
              ) : (
                'Disable All'
              )}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsEnableAllDialogOpen(true)}
              disabled={!hasSkills || hasPendingBulkMutation}
            >
              {enableAllMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Enabling...
                </>
              ) : (
                'Enable All'
              )}
            </Button>
            <SyncButton />
          </div>
        </div>

        <div className="rounded-md border">
          <div className="max-h-[620px] overflow-auto">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  {renderSortHeader('name', 'Name')}
                  <TableHead>Description</TableHead>
                  {renderSortHeader('category', 'Category', 'w-[120px]')}
                  {renderSortHeader('source', 'Source', 'w-[120px]')}
                  {renderSortHeader('enabled', 'Enabled', 'w-[80px] text-right', 'shrink-0')}
                </TableRow>
              </TableHeader>
              <TableBody>
                {skillsLoading ? (
                  <TableRow>
                    <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                      <div className="inline-flex items-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Loading skills...
                      </div>
                    </TableCell>
                  </TableRow>
                ) : filteredAndSortedSkills.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                      {search.trim() ? 'No skills match your search.' : 'No skills available.'}
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredAndSortedSkills.map((skill) => {
                    const sourceDisplay = getSourceDisplay(skill.source);
                    const SourceIcon = sourceDisplay.icon;
                    const isDisabled = skill.disabled;
                    const descriptionText =
                      skill.shortDescription || skill.description || 'No description';
                    const isMutatingThisSkill =
                      toggleDisableMutation.isPending &&
                      toggleDisableMutation.variables?.skillId === skill.id;

                    return (
                      <TableRow
                        key={skill.id}
                        className={cn(
                          'cursor-pointer',
                          isDisabled && 'bg-muted/30 text-muted-foreground',
                        )}
                        onClick={() => onSelectSkill?.(skill.id)}
                        onKeyDown={(event) => {
                          if (event.currentTarget !== event.target) {
                            return;
                          }
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            onSelectSkill?.(skill.id);
                          }
                        }}
                        tabIndex={0}
                      >
                        <TableCell className="font-medium">
                          <div className="flex flex-col">
                            <span className="max-w-[200px] truncate">
                              {skill.displayName || skill.name}
                            </span>
                            {skill.status !== 'available' ? (
                              <Badge
                                variant="outline"
                                className={cn(
                                  'mt-1 w-fit text-[10px]',
                                  SKILL_STATUS_BADGES[skill.status].className,
                                )}
                              >
                                {SKILL_STATUS_BADGES[skill.status].label}
                              </Badge>
                            ) : null}
                            {isDisabled ? (
                              <Badge variant="secondary" className="mt-1 w-fit">
                                Disabled
                              </Badge>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell className={cn(!isDisabled && 'text-muted-foreground')}>
                          <span className="line-clamp-1 max-w-[300px]" title={descriptionText}>
                            {descriptionText}
                          </span>
                        </TableCell>
                        <TableCell>
                          <CategoryBadge category={skill.category} />
                        </TableCell>
                        <TableCell>
                          <span
                            className={cn(
                              'inline-flex items-center gap-2 text-sm',
                              sourceDisplay.className,
                            )}
                          >
                            <SourceIcon className="h-4 w-4" aria-hidden="true" />
                            {sourceDisplay.label}
                          </span>
                        </TableCell>
                        <TableCell
                          className="text-right"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <Switch
                            checked={!isDisabled}
                            onCheckedChange={(checked) =>
                              toggleDisableMutation.mutate({
                                skillId: skill.id,
                                nextEnabled: checked,
                              })
                            }
                            disabled={isMutatingThisSkill || hasPendingBulkMutation}
                            aria-label={`Enable or disable skill ${skill.displayName || skill.name}`}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      </div>

      <AlertDialog open={isDisableAllDialogOpen} onOpenChange={setIsDisableAllDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disable all skills for this project?</AlertDialogTitle>
            <AlertDialogDescription>
              This will disable every skill in the selected project. You can enable individual
              skills later from this list.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disableAllMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => disableAllMutation.mutate()}
              disabled={disableAllMutation.isPending}
            >
              {disableAllMutation.isPending ? 'Disabling...' : 'Disable All'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={isEnableAllDialogOpen} onOpenChange={setIsEnableAllDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Enable all skills for this project?</AlertDialogTitle>
            <AlertDialogDescription>
              This will re-enable every disabled skill in the selected project.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={enableAllMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => enableAllMutation.mutate()}
              disabled={enableAllMutation.isPending}
            >
              {enableAllMutation.isPending ? 'Enabling...' : 'Enable All'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
