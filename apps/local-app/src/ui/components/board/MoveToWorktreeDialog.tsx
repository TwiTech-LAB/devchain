import { useState, useEffect, useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/ui/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import { Button } from '@/ui/components/ui/button';
import { Badge } from '@/ui/components/ui/badge';
import { useToast } from '@/ui/hooks/use-toast';
import { Loader2, AlertTriangle, GitBranch, CheckCircle2 } from 'lucide-react';
import { listWorktrees, type WorktreeSummary } from '@/modules/orchestrator/ui/app/lib/worktrees';
import { moveEpicToWorktree, type MoveProgress } from '@/ui/lib/move-epic-to-worktree';
import type { Epic, Status, Agent } from '@/ui/types';

// ── Types ──────────────────────────────────────────────────────────

interface PreflightData {
  totalDescendants: number;
  totalComments: number;
}

interface StatusMapping {
  sourceId: string;
  sourceLabel: string;
  sourceColor: string;
  destId: string | null;
  destLabel: string | null;
  destColor: string | null;
  ambiguous: boolean;
  candidates: { id: string; label: string; color: string }[];
}

interface AgentMapping {
  sourceId: string;
  sourceName: string;
  destId: string | null;
  destName: string | null;
  ambiguous: boolean;
}

interface MappingData {
  statuses: StatusMapping[];
  agents: AgentMapping[];
}

type Phase = 'preflight' | 'select' | 'mapping' | 'confirm' | 'moving' | 'error';

// ── Fetch helpers ──────────────────────────────────────────────────

async function fetchSubEpicCounts(epicId: string): Promise<Record<string, number>> {
  const res = await fetch(`/api/epics/${epicId}/sub-epics/counts`);
  if (!res.ok) throw new Error('Failed to fetch sub-epic counts');
  return res.json();
}

async function fetchCommentCount(epicId: string): Promise<number> {
  const res = await fetch(`/api/epics/${epicId}/comments?limit=1`);
  if (!res.ok) return 0;
  const data = await res.json();
  return data.total ?? 0;
}

async function fetchDestStatuses(worktreeName: string, projectId: string): Promise<Status[]> {
  const res = await fetch(
    `/wt/${encodeURIComponent(worktreeName)}/api/statuses?projectId=${encodeURIComponent(projectId)}`,
  );
  if (!res.ok) throw new Error('Failed to fetch destination statuses');
  const data = await res.json();
  return data.items ?? data;
}

async function fetchDestAgents(worktreeName: string, projectId: string): Promise<Agent[]> {
  const res = await fetch(
    `/wt/${encodeURIComponent(worktreeName)}/api/agents?projectId=${encodeURIComponent(projectId)}`,
  );
  if (!res.ok) throw new Error('Failed to fetch destination agents');
  const data = await res.json();
  return data.items ?? data;
}

// ── Mapping logic ──────────────────────────────────────────────────

function computeStatusMappings(source: Status[], dest: Status[]): StatusMapping[] {
  return source.map((src) => {
    const matches = dest.filter((d) => d.label.toLowerCase() === src.label.toLowerCase());
    if (matches.length === 1) {
      return {
        sourceId: src.id,
        sourceLabel: src.label,
        sourceColor: src.color,
        destId: matches[0].id,
        destLabel: matches[0].label,
        destColor: matches[0].color,
        ambiguous: false,
        candidates: [],
      };
    }
    if (matches.length > 1) {
      return {
        sourceId: src.id,
        sourceLabel: src.label,
        sourceColor: src.color,
        destId: null,
        destLabel: null,
        destColor: null,
        ambiguous: true,
        candidates: matches.map((m) => ({
          id: m.id,
          label: m.label,
          color: m.color,
        })),
      };
    }
    return {
      sourceId: src.id,
      sourceLabel: src.label,
      sourceColor: src.color,
      destId: null,
      destLabel: null,
      destColor: null,
      ambiguous: false,
      candidates: [],
    };
  });
}

function computeAgentMappings(source: Agent[], dest: Agent[]): AgentMapping[] {
  return source.map((src) => {
    const matches = dest.filter((d) => d.name.toLowerCase() === src.name.toLowerCase());
    if (matches.length >= 1) {
      return {
        sourceId: src.id,
        sourceName: src.name,
        destId: matches[0].id,
        destName: matches[0].name,
        ambiguous: matches.length > 1,
      };
    }
    return {
      sourceId: src.id,
      sourceName: src.name,
      destId: null,
      destName: null,
      ambiguous: false,
    };
  });
}

// ── Component ──────────────────────────────────────────────────────

export interface MoveToWorktreeDialogProps {
  /** The parent epic to move (null when dialog is closed) */
  epic: Epic | null;
  /** Whether the dialog is open */
  open: boolean;
  /** Callback to open/close the dialog */
  onOpenChange: (open: boolean) => void;
  /** Source project statuses (for mapping comparison) */
  sourceStatuses: Status[];
  /** Source project agents (for mapping comparison) */
  sourceAgents: Agent[];
}

export function MoveToWorktreeDialog({
  epic,
  open,
  onOpenChange,
  sourceStatuses,
  sourceAgents,
}: MoveToWorktreeDialogProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [phase, setPhase] = useState<Phase>('preflight');
  const [preflight, setPreflight] = useState<PreflightData | null>(null);
  const [selectedWorktreeId, setSelectedWorktreeId] = useState<string | null>(null);
  const [mapping, setMapping] = useState<MappingData | null>(null);
  const [disambiguations, setDisambiguations] = useState<Record<string, string>>({});
  const [moveProgress, setMoveProgress] = useState<MoveProgress | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Share worktree cache with WorktreeTabProvider
  const { data: allWorktrees = [] } = useQuery<WorktreeSummary[]>({
    queryKey: ['worktree-tabs-worktrees'],
    queryFn: () => listWorktrees(),
    staleTime: 30_000,
  });

  const runningWorktrees = useMemo(
    () => allWorktrees.filter((wt) => wt.status === 'running'),
    [allWorktrees],
  );

  const selectedWorktree = useMemo(
    () => runningWorktrees.find((wt) => wt.id === selectedWorktreeId) ?? null,
    [runningWorktrees, selectedWorktreeId],
  );

  // Reset on open/close or epic change
  useEffect(() => {
    if (open && epic) {
      setPhase('preflight');
      setPreflight(null);
      setSelectedWorktreeId(null);
      setMapping(null);
      setDisambiguations({});
      setMoveProgress(null);
      setErrorMessage(null);
    }
  }, [open, epic?.id]);

  // Fetch preflight data
  useEffect(() => {
    if (!open || !epic || phase !== 'preflight') return;
    let cancelled = false;

    (async () => {
      try {
        const [counts, commentCount] = await Promise.all([
          fetchSubEpicCounts(epic.id),
          fetchCommentCount(epic.id),
        ]);
        if (cancelled) return;
        const totalDescendants = Object.values(counts).reduce((sum, n) => sum + n, 0);
        setPreflight({ totalDescendants, totalComments: commentCount });
        setPhase('select');
      } catch (err) {
        if (cancelled) return;
        setErrorMessage(err instanceof Error ? err.message : 'Failed to load preflight data');
        setPhase('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, epic, phase]);

  // Fetch destination mapping
  const handleWorktreeSelect = useCallback(
    async (worktreeId: string) => {
      setSelectedWorktreeId(worktreeId);
      const wt = runningWorktrees.find((w) => w.id === worktreeId);
      if (!wt?.devchainProjectId) {
        setErrorMessage('Selected worktree has no project configured');
        setPhase('error');
        return;
      }
      setPhase('mapping');
      setDisambiguations({});

      try {
        const [destStatuses, destAgents] = await Promise.all([
          fetchDestStatuses(wt.name, wt.devchainProjectId),
          fetchDestAgents(wt.name, wt.devchainProjectId),
        ]);
        setMapping({
          statuses: computeStatusMappings(sourceStatuses, destStatuses),
          agents: computeAgentMappings(sourceAgents, destAgents),
        });
        setPhase('confirm');
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : 'Failed to load destination data');
        setPhase('error');
      }
    },
    [runningWorktrees, sourceStatuses, sourceAgents],
  );

  const hasUnresolvedDisambiguations = useMemo(() => {
    if (!mapping) return false;
    return mapping.statuses.some((s) => s.ambiguous && !disambiguations[s.sourceId]);
  }, [mapping, disambiguations]);

  const buildMaps = useCallback(() => {
    if (!mapping) return { statusMap: {}, agentMap: {} };
    const statusMap: Record<string, string> = {};
    for (const sm of mapping.statuses) {
      if (sm.ambiguous && disambiguations[sm.sourceId]) {
        statusMap[sm.sourceId] = disambiguations[sm.sourceId];
      } else if (sm.destId) {
        statusMap[sm.sourceId] = sm.destId;
      }
    }
    const agentMap: Record<string, string | null> = {};
    for (const am of mapping.agents) {
      agentMap[am.sourceId] = am.destId;
    }
    return { statusMap, agentMap };
  }, [mapping, disambiguations]);

  const handleConfirm = useCallback(async () => {
    if (!epic || !selectedWorktree?.devchainProjectId) return;
    setPhase('moving');
    setMoveProgress(null);
    const { statusMap, agentMap } = buildMaps();

    try {
      await moveEpicToWorktree({
        epicId: epic.id,
        destWorktreeName: selectedWorktree.name,
        destProjectId: selectedWorktree.devchainProjectId,
        statusMap,
        agentMap,
        onProgress: setMoveProgress,
      });
      toast({
        title: 'Epic moved',
        description: `"${epic.title}" moved to ${selectedWorktree.name}`,
      });
      queryClient.invalidateQueries({ queryKey: ['epics'] });
      queryClient.invalidateQueries({
        queryKey: ['epics', epic.id, 'sub-counts'],
      });
      onOpenChange(false);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Move failed');
      setPhase('error');
    }
  }, [epic, selectedWorktree, buildMaps, toast, queryClient, onOpenChange]);

  const handleDisambiguate = useCallback((sourceStatusId: string, destStatusId: string) => {
    setDisambiguations((prev) => ({
      ...prev,
      [sourceStatusId]: destStatusId,
    }));
  }, []);

  const handleRetry = useCallback(() => {
    setErrorMessage(null);
    if (!preflight) {
      setPhase('preflight');
    } else if (!selectedWorktreeId) {
      setPhase('select');
    } else if (!mapping) {
      void handleWorktreeSelect(selectedWorktreeId);
    } else {
      setPhase('confirm');
    }
  }, [preflight, selectedWorktreeId, mapping, handleWorktreeSelect]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (phase === 'moving' && !nextOpen) return;
      onOpenChange(nextOpen);
    },
    [phase, onOpenChange],
  );

  if (!epic) return null;

  // Compute warnings for mapping preview
  const warnings: string[] = [];
  if (mapping) {
    const newStatuses = mapping.statuses.filter((s) => !s.destId && !s.ambiguous);
    if (newStatuses.length > 0) {
      warnings.push(
        `${newStatuses.length} status${newStatuses.length > 1 ? 'es' : ''} will be created in destination`,
      );
    }
    const unmappedAgents = mapping.agents.filter((a) => !a.destId);
    if (unmappedAgents.length > 0) {
      warnings.push(
        `${unmappedAgents.length} agent${unmappedAgents.length > 1 ? 's' : ''} not found in destination (will be unassigned)`,
      );
    }
    const ambiguousAgents = mapping.agents.filter((a) => a.ambiguous);
    if (ambiguousAgents.length > 0) {
      warnings.push(
        `${ambiguousAgents.length} agent${ambiguousAgents.length > 1 ? 's' : ''} matched multiple agents (using first match)`,
      );
    }
  }

  const canConfirm = phase === 'confirm' && !hasUnresolvedDisambiguations;
  const hasIssues =
    mapping &&
    (mapping.statuses.some((s) => !s.destId || s.ambiguous) ||
      mapping.agents.some((a) => !a.destId));
  const allMapped = mapping && !hasIssues;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="h-5 w-5" />
            Move to Worktree
          </DialogTitle>
          <DialogDescription>
            Move this epic and all its sub-epics to a running worktree.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Epic summary */}
          <div className="rounded-lg border p-3 space-y-1">
            <p className="text-sm font-medium leading-tight">{epic.title}</p>
            {phase === 'preflight' ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Loading summary…
              </div>
            ) : (
              preflight && (
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span>
                    {preflight.totalDescendants} sub-epic
                    {preflight.totalDescendants !== 1 ? 's' : ''}
                  </span>
                  <span>
                    {preflight.totalComments} comment
                    {preflight.totalComments !== 1 ? 's' : ''}
                  </span>
                </div>
              )
            )}
          </div>

          {/* Worktree selector */}
          {phase !== 'preflight' && phase !== 'moving' && (
            <div className="space-y-2">
              <label className="text-sm font-medium">Destination worktree</label>
              <Select
                value={selectedWorktreeId ?? ''}
                onValueChange={handleWorktreeSelect}
                disabled={phase === 'mapping'}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a worktree…" />
                </SelectTrigger>
                <SelectContent>
                  {runningWorktrees.map((wt) => (
                    <SelectItem key={wt.id} value={wt.id} disabled={!wt.devchainProjectId}>
                      <span className="flex items-center gap-2">
                        <span>{wt.name}</span>
                        <span className="text-muted-foreground text-xs">{wt.branchName}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Mapping loading */}
          {phase === 'mapping' && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading destination mappings…
            </div>
          )}

          {/* Mapping preview */}
          {phase === 'confirm' && mapping && (
            <div className="space-y-3">
              {/* Warnings */}
              {warnings.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30 p-3 space-y-1">
                  {warnings.map((w, i) => (
                    <div
                      key={i}
                      className="flex items-start gap-2 text-xs text-amber-800 dark:text-amber-200"
                    >
                      <AlertTriangle className="h-3 w-3 mt-0.5 flex-shrink-0" />
                      <span>{w}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* All mapped - success banner */}
              {allMapped && (
                <div className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400">
                  <CheckCircle2 className="h-4 w-4" />
                  All statuses and agents mapped successfully
                </div>
              )}

              {/* Status mappings needing attention */}
              {mapping.statuses.some((s) => !s.destId || s.ambiguous) && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Status mappings
                  </p>
                  <div className="space-y-1.5">
                    {mapping.statuses
                      .filter((s) => !s.destId || s.ambiguous)
                      .map((sm) => (
                        <div key={sm.sourceId} className="flex items-center gap-2 text-sm">
                          <div className="flex items-center gap-1.5 min-w-0 shrink-0">
                            <span
                              className="h-2.5 w-2.5 rounded-full flex-shrink-0"
                              style={{ backgroundColor: sm.sourceColor }}
                            />
                            <span className="truncate">{sm.sourceLabel}</span>
                          </div>
                          <span className="text-muted-foreground shrink-0">→</span>
                          {sm.ambiguous ? (
                            <Select
                              value={disambiguations[sm.sourceId] ?? ''}
                              onValueChange={(v) => handleDisambiguate(sm.sourceId, v)}
                            >
                              <SelectTrigger className="h-7 text-xs w-[160px]">
                                <SelectValue placeholder="Pick status…" />
                              </SelectTrigger>
                              <SelectContent>
                                {sm.candidates.map((c) => (
                                  <SelectItem key={c.id} value={c.id}>
                                    <span className="flex items-center gap-1.5">
                                      <span
                                        className="h-2 w-2 rounded-full"
                                        style={{ backgroundColor: c.color }}
                                      />
                                      {c.label}
                                    </span>
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            <Badge variant="outline" className="text-xs">
                              New
                            </Badge>
                          )}
                        </div>
                      ))}
                  </div>
                </div>
              )}

              {/* Unmapped agents */}
              {mapping.agents.some((a) => !a.destId) && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Agent mappings
                  </p>
                  <div className="space-y-1">
                    {mapping.agents
                      .filter((a) => !a.destId)
                      .map((am) => (
                        <div key={am.sourceId} className="flex items-center gap-2 text-sm">
                          <span>{am.sourceName}</span>
                          <span className="text-muted-foreground">→</span>
                          <span className="text-muted-foreground italic">Unassigned</span>
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Move progress */}
          {phase === 'moving' && (
            <div className="flex items-center gap-3 rounded-lg border p-3">
              <Loader2 className="h-4 w-4 animate-spin flex-shrink-0" />
              <div className="text-sm">
                {moveProgress ? (
                  <>
                    <p className="font-medium">{moveProgress.message}</p>
                    {moveProgress.total > 0 && (
                      <p className="text-muted-foreground text-xs">
                        {moveProgress.current}/{moveProgress.total}
                      </p>
                    )}
                  </>
                ) : (
                  <p>Starting move…</p>
                )}
              </div>
            </div>
          )}

          {/* Error */}
          {phase === 'error' && errorMessage && (
            <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3">
              <div className="flex items-start gap-2 text-sm text-destructive">
                <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <span>{errorMessage}</span>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          {phase === 'error' && (
            <Button variant="outline" onClick={handleRetry}>
              Retry
            </Button>
          )}
          {phase !== 'moving' && (
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
          )}
          {phase === 'confirm' && (
            <Button onClick={handleConfirm} disabled={!canConfirm}>
              Move Epic
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
