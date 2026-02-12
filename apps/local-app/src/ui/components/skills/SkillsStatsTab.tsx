import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownWideNarrow, ArrowUpWideNarrow, Loader2 } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import { Input } from '@/ui/components/ui/input';
import { Button } from '@/ui/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/ui/components/ui/table';
import { Badge } from '@/ui/components/ui/badge';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';
import {
  fetchUsageLog,
  fetchUsageStats,
  type SkillUsageLogEntry,
  type SkillUsageStat,
} from '@/ui/lib/skills';

interface AgentUsageSummary {
  agentId: string | null;
  agentLabel: string;
  totalUsage: number;
  uniqueSkills: number;
}

function toIsoOrUndefined(value: string): string | undefined {
  if (!value.trim()) {
    return undefined;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }

  return parsed.toISOString();
}

function getSkillLabel(stat: SkillUsageStat): string {
  return stat.skillDisplayName || stat.skillName || stat.skillSlug;
}

function buildAgentBreakdown(entries: SkillUsageLogEntry[]): AgentUsageSummary[] {
  const byAgent = new Map<
    string,
    {
      agentId: string | null;
      agentLabel: string;
      totalUsage: number;
      uniqueSkillSlugs: Set<string>;
    }
  >();

  for (const entry of entries) {
    const normalizedAgentId = entry.agentId ?? null;
    const fallbackName = entry.agentNameSnapshot?.trim() || null;
    const agentLabel =
      fallbackName || (normalizedAgentId ? `Agent ${normalizedAgentId.slice(0, 8)}` : 'Unknown');
    const agentKey = normalizedAgentId ?? `unknown:${agentLabel}`;

    const current = byAgent.get(agentKey) ?? {
      agentId: normalizedAgentId,
      agentLabel,
      totalUsage: 0,
      uniqueSkillSlugs: new Set<string>(),
    };

    current.totalUsage += 1;
    current.uniqueSkillSlugs.add(entry.skillSlug);
    byAgent.set(agentKey, current);
  }

  return Array.from(byAgent.values())
    .map((item) => ({
      agentId: item.agentId,
      agentLabel: item.agentLabel,
      totalUsage: item.totalUsage,
      uniqueSkills: item.uniqueSkillSlugs.size,
    }))
    .sort((left, right) => right.totalUsage - left.totalUsage);
}

export function SkillsStatsTab() {
  const { projects, selectedProjectId } = useSelectedProject();

  const [projectFilter, setProjectFilter] = useState<string>('selected');
  const [fromInput, setFromInput] = useState('');
  const [toInput, setToInput] = useState('');
  const [sortDirection, setSortDirection] = useState<'desc' | 'asc'>('desc');

  const resolvedProjectId = useMemo(() => {
    if (projectFilter === 'selected') {
      return selectedProjectId;
    }
    if (projectFilter === 'all') {
      return undefined;
    }
    return projectFilter;
  }, [projectFilter, selectedProjectId]);

  const fromIso = useMemo(() => toIsoOrUndefined(fromInput), [fromInput]);
  const toIso = useMemo(() => toIsoOrUndefined(toInput), [toInput]);

  const {
    data: usageStats,
    isLoading: usageStatsLoading,
    error: usageStatsError,
  } = useQuery({
    queryKey: ['skill-usage', resolvedProjectId ?? 'all', fromIso ?? '', toIso ?? ''],
    queryFn: () =>
      fetchUsageStats({
        projectId: resolvedProjectId,
        from: fromIso,
        to: toIso,
        limit: 500,
      }),
  });

  const {
    data: usageLog,
    isLoading: usageLogLoading,
    error: usageLogError,
  } = useQuery({
    queryKey: ['skill-usage-log', resolvedProjectId ?? 'all', fromIso ?? '', toIso ?? ''],
    queryFn: () =>
      fetchUsageLog({
        projectId: resolvedProjectId,
        from: fromIso,
        to: toIso,
        limit: 1000,
      }),
  });

  const sortedUsageStats = useMemo(() => {
    const items = [...(usageStats ?? [])];
    items.sort((left, right) => {
      const diff = left.usageCount - right.usageCount;
      return sortDirection === 'asc' ? diff : -diff;
    });
    return items;
  }, [sortDirection, usageStats]);

  const agentBreakdown = useMemo(
    () => buildAgentBreakdown(usageLog?.items ?? []),
    [usageLog?.items],
  );

  return (
    <div className="space-y-6">
      <div className="grid gap-3 md:grid-cols-4">
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Project
          </p>
          <Select value={projectFilter} onValueChange={setProjectFilter}>
            <SelectTrigger>
              <SelectValue placeholder="Select project filter" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="selected">Selected Project</SelectItem>
              <SelectItem value="all">All Projects</SelectItem>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">From</p>
          <Input
            type="datetime-local"
            value={fromInput}
            onChange={(event) => setFromInput(event.target.value)}
            aria-label="Usage stats from date"
          />
        </div>

        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">To</p>
          <Input
            type="datetime-local"
            value={toInput}
            onChange={(event) => setToInput(event.target.value)}
            aria-label="Usage stats to date"
          />
        </div>

        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Sort</p>
          <Button
            variant="outline"
            className="w-full justify-start gap-2"
            onClick={() => setSortDirection((current) => (current === 'desc' ? 'asc' : 'desc'))}
          >
            {sortDirection === 'desc' ? (
              <ArrowDownWideNarrow className="h-4 w-4" />
            ) : (
              <ArrowUpWideNarrow className="h-4 w-4" />
            )}
            Usage Count ({sortDirection === 'desc' ? 'High-Low' : 'Low-High'})
          </Button>
        </div>
      </div>

      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Usage Ranking
          </h3>
          {resolvedProjectId ? <Badge variant="outline">Project Scoped</Badge> : null}
        </div>

        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[70px]">Rank</TableHead>
                <TableHead>Skill</TableHead>
                <TableHead className="w-[140px] text-right">Usage Count</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {usageStatsLoading ? (
                <TableRow>
                  <TableCell colSpan={3} className="py-8 text-center text-muted-foreground">
                    <div className="inline-flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading usage stats...
                    </div>
                  </TableCell>
                </TableRow>
              ) : usageStatsError ? (
                <TableRow>
                  <TableCell colSpan={3} className="py-8 text-center text-destructive">
                    {usageStatsError instanceof Error
                      ? usageStatsError.message
                      : 'Failed to load usage stats'}
                  </TableCell>
                </TableRow>
              ) : sortedUsageStats.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="py-8 text-center text-muted-foreground">
                    No usage stats found for the selected filters.
                  </TableCell>
                </TableRow>
              ) : (
                sortedUsageStats.map((stat, index) => (
                  <TableRow key={stat.skillId}>
                    <TableCell className="font-medium">{index + 1}</TableCell>
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="font-medium">{getSkillLabel(stat)}</span>
                        <span className="text-xs text-muted-foreground">{stat.skillSlug}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-semibold">{stat.usageCount}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Usage by Agent
        </h3>

        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Agent</TableHead>
                <TableHead className="w-[150px] text-right">Total Uses</TableHead>
                <TableHead className="w-[150px] text-right">Unique Skills</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {usageLogLoading ? (
                <TableRow>
                  <TableCell colSpan={3} className="py-8 text-center text-muted-foreground">
                    <div className="inline-flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading agent breakdown...
                    </div>
                  </TableCell>
                </TableRow>
              ) : usageLogError ? (
                <TableRow>
                  <TableCell colSpan={3} className="py-8 text-center text-destructive">
                    {usageLogError instanceof Error
                      ? usageLogError.message
                      : 'Failed to load usage log'}
                  </TableCell>
                </TableRow>
              ) : agentBreakdown.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="py-8 text-center text-muted-foreground">
                    No agent usage data found for the selected filters.
                  </TableCell>
                </TableRow>
              ) : (
                agentBreakdown.map((agent) => (
                  <TableRow key={`${agent.agentId ?? 'unknown'}:${agent.agentLabel}`}>
                    <TableCell>{agent.agentLabel}</TableCell>
                    <TableCell className="text-right font-semibold">{agent.totalUsage}</TableCell>
                    <TableCell className="text-right">{agent.uniqueSkills}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
  );
}
