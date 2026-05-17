import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ScheduleEditorDialog } from './ScheduleEditorDialog';
import { RunHistoryPanel } from './RunHistoryPanel';
import {
  Plus,
  MoreHorizontal,
  Pencil,
  Trash2,
  Play,
  Loader2,
  Clock,
  AlertCircle,
  History,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import { Badge } from '@/ui/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/components/ui/card';
import { Switch } from '@/ui/components/ui/switch';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { useToast } from '@/ui/hooks/use-toast';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';
import {
  fetchScheduledEpics,
  toggleScheduledEpic,
  deleteScheduledEpic,
  runScheduledEpicNow,
  ScheduledEpicApiError,
  type ScheduledEpic,
} from '@/ui/lib/scheduled-epics';

function formatNextRun(nextRunAt: string | null): string {
  if (!nextRunAt) return '—';
  const date = new Date(nextRunAt);
  return date.toLocaleString();
}

function lastOutcomeBadge(status: string | null) {
  if (!status) return <Badge variant="secondary">No runs yet</Badge>;
  const variant =
    status === 'completed' ? 'default' : status === 'failed' ? 'destructive' : 'secondary';
  return <Badge variant={variant}>{status}</Badge>;
}

export function ScheduledEpicsTab() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { selectedProjectId } = useSelectedProject();
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const {
    data: schedules,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['scheduled-epics', selectedProjectId],
    queryFn: () => fetchScheduledEpics(selectedProjectId as string),
    enabled: !!selectedProjectId,
  });

  const toggleMutation = useMutation({
    mutationFn: ({
      id,
      enabled,
      configVersion,
    }: {
      id: string;
      enabled: boolean;
      configVersion: number;
    }) => toggleScheduledEpic(id, enabled, configVersion),
    onMutate: async ({ id, enabled }) => {
      await queryClient.cancelQueries({ queryKey: ['scheduled-epics', selectedProjectId] });
      const previous = queryClient.getQueryData<ScheduledEpic[]>([
        'scheduled-epics',
        selectedProjectId,
      ]);
      queryClient.setQueryData<ScheduledEpic[]>(['scheduled-epics', selectedProjectId], (old) =>
        old?.map((s) => (s.id === id ? { ...s, enabled } : s)),
      );
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['scheduled-epics', selectedProjectId], context.previous);
      }
      const isConflict = err instanceof ScheduledEpicApiError && err.isVersionConflict;
      toast({
        title: isConflict ? 'Conflict' : 'Error',
        description: isConflict
          ? 'Schedule was modified by another process. Refreshing…'
          : err instanceof Error
            ? err.message
            : 'Failed to toggle schedule',
        variant: 'destructive',
      });
      if (isConflict) {
        queryClient.invalidateQueries({ queryKey: ['scheduled-epics', selectedProjectId] });
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['scheduled-epics', selectedProjectId] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteScheduledEpic,
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ['scheduled-epics', selectedProjectId] });
      const previous = queryClient.getQueryData<ScheduledEpic[]>([
        'scheduled-epics',
        selectedProjectId,
      ]);
      queryClient.setQueryData<ScheduledEpic[]>(['scheduled-epics', selectedProjectId], (old) =>
        old?.filter((s) => s.id !== id),
      );
      return { previous };
    },
    onSuccess: () => {
      setDeleteConfirmId(null);
      toast({ title: 'Deleted', description: 'Schedule removed.' });
    },
    onError: (err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['scheduled-epics', selectedProjectId], context.previous);
      }
      toast({
        title: 'Error',
        description: err instanceof Error ? err.message : 'Failed to delete schedule',
        variant: 'destructive',
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['scheduled-epics', selectedProjectId] });
    },
  });

  const runNowMutation = useMutation({
    mutationFn: runScheduledEpicNow,
    onSuccess: (result) => {
      toast({
        title: result.claimed ? 'Run started' : 'Already running',
        description: result.claimed ? 'A run has been triggered.' : 'A run is already in progress.',
      });
      queryClient.invalidateQueries({ queryKey: ['scheduled-epics', selectedProjectId] });
    },
    onError: (err) => {
      toast({
        title: 'Error',
        description: err instanceof Error ? err.message : 'Failed to trigger run',
        variant: 'destructive',
      });
    },
  });

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<ScheduledEpic | null>(null);
  const [historyOpenId, setHistoryOpenId] = useState<string | null>(null);

  const handleEditSchedule = useCallback((schedule: ScheduledEpic) => {
    setEditingSchedule(schedule);
    setEditorOpen(true);
  }, []);

  const handleAddSchedule = useCallback(() => {
    setEditingSchedule(null);
    setEditorOpen(true);
  }, []);

  if (!selectedProjectId) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12">
          <Clock className="h-8 w-8 text-muted-foreground mb-2" />
          <p className="text-muted-foreground">Please select a project to view scheduled epics</p>
        </CardContent>
      </Card>
    );
  }

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          <span className="ml-2 text-muted-foreground">Loading schedules…</span>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12">
          <AlertCircle className="h-8 w-8 text-destructive mb-2" />
          <p className="text-destructive">
            {error instanceof Error ? error.message : 'Failed to load schedules'}
          </p>
          <Button
            variant="outline"
            className="mt-4"
            onClick={() =>
              queryClient.invalidateQueries({ queryKey: ['scheduled-epics', selectedProjectId] })
            }
          >
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!schedules || schedules.length === 0) {
    return (
      <>
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Scheduled Epics</CardTitle>
                <CardDescription>
                  Automatically create epics on a recurring schedule.
                </CardDescription>
              </div>
              <Button onClick={handleAddSchedule}>
                <Plus className="h-4 w-4 mr-2" />
                Add Schedule
              </Button>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Clock className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No schedules yet</h3>
            <p className="text-muted-foreground text-center max-w-md">
              Create a schedule to automatically generate epics on a cron cadence.
            </p>
            <Button className="mt-4" onClick={handleAddSchedule}>
              <Plus className="h-4 w-4 mr-2" />
              Create Schedule
            </Button>
          </CardContent>
        </Card>

        <ScheduleEditorDialog
          open={editorOpen}
          onOpenChange={setEditorOpen}
          schedule={editingSchedule}
          projectId={selectedProjectId}
        />
      </>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Scheduled Epics</CardTitle>
              <CardDescription>Automatically create epics on a recurring schedule.</CardDescription>
            </div>
            <Button onClick={handleAddSchedule}>
              <Plus className="h-4 w-4 mr-2" />
              Add Schedule
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {schedules.map((schedule) => (
              <div key={schedule.id} className="border rounded-lg overflow-hidden">
                <div className="flex items-start justify-between p-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h4 className="font-semibold truncate">{schedule.name}</h4>
                      <Badge variant={schedule.enabled ? 'default' : 'secondary'}>
                        {schedule.enabled ? 'Enabled' : 'Disabled'}
                      </Badge>
                      {lastOutcomeBadge(schedule.lastRunStatus)}
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs mt-2">
                      <Badge variant="outline" className="font-mono">
                        {schedule.cronExpression}
                      </Badge>
                      <Badge variant="outline">{schedule.timezone}</Badge>
                      <Badge variant="outline">Next: {formatNextRun(schedule.nextRunAt)}</Badge>
                      <Badge variant="outline">
                        Runs: {schedule.runCount !== null ? schedule.runCount : '—'}
                      </Badge>
                    </div>
                    {schedule.lastError && (
                      <p className="text-xs text-destructive mt-1 truncate">{schedule.lastError}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 ml-4">
                    <Switch
                      checked={schedule.enabled}
                      onCheckedChange={(checked) =>
                        toggleMutation.mutate({
                          id: schedule.id,
                          enabled: checked,
                          configVersion: schedule.configVersion,
                        })
                      }
                      disabled={toggleMutation.isPending}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => runNowMutation.mutate(schedule.id)}
                      disabled={runNowMutation.isPending}
                      title="Run now"
                    >
                      {runNowMutation.isPending && runNowMutation.variables === schedule.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Play className="h-4 w-4" />
                      )}
                      <span className="ml-1">Run now</span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setHistoryOpenId((prev) => (prev === schedule.id ? null : schedule.id))
                      }
                      title="View run history"
                    >
                      <History className="h-4 w-4" />
                      {historyOpenId === schedule.id ? (
                        <ChevronUp className="h-3 w-3 ml-1" />
                      ) : (
                        <ChevronDown className="h-3 w-3 ml-1" />
                      )}
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="sm">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => handleEditSchedule(schedule)}>
                          <Pencil className="h-4 w-4 mr-2" />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-destructive"
                          onClick={() => setDeleteConfirmId(schedule.id)}
                        >
                          <Trash2 className="h-4 w-4 mr-2" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
                {historyOpenId === schedule.id && (
                  <div className="border-t bg-muted/30">
                    <div className="px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      Run History
                    </div>
                    <RunHistoryPanel scheduleId={schedule.id} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!deleteConfirmId} onOpenChange={() => setDeleteConfirmId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Schedule</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this schedule? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirmId(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteConfirmId && deleteMutation.mutate(deleteConfirmId)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {selectedProjectId && (
        <ScheduleEditorDialog
          open={editorOpen}
          onOpenChange={setEditorOpen}
          schedule={editingSchedule}
          projectId={selectedProjectId}
        />
      )}
    </>
  );
}
