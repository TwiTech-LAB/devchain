import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus,
  MoreHorizontal,
  Pencil,
  Trash2,
  Loader2,
  Clock,
  AlertCircle,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import { Badge } from '@/ui/components/ui/badge';
import { Card, CardContent } from '@/ui/components/ui/card';
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
  fetchCronPresets,
  toggleScheduledEpic,
  deleteScheduledEpic,
  describeCron,
  formatNextRun,
  type ScheduledEpic,
} from '@/ui/lib/schedules';
import { ScheduleDialog } from './ScheduleDialog';

export function ScheduledTab() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { selectedProjectId } = useSelectedProject();
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<ScheduledEpic | null>(null);

  const { data: schedules, isLoading, error } = useQuery({
    queryKey: ['scheduledEpics', selectedProjectId],
    queryFn: () => fetchScheduledEpics(selectedProjectId as string),
    enabled: !!selectedProjectId,
  });

  const { data: presets } = useQuery({
    queryKey: ['cronPresets'],
    queryFn: fetchCronPresets,
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      toggleScheduledEpic(id, enabled),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scheduledEpics'] });
    },
    onError: () => {
      toast({ title: 'Error', description: 'Failed to toggle schedule', variant: 'destructive' });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteScheduledEpic(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scheduledEpics'] });
      setDeleteConfirmId(null);
      toast({ title: 'Schedule deleted' });
    },
    onError: () => {
      toast({ title: 'Error', description: 'Failed to delete schedule', variant: 'destructive' });
    },
  });

  const handleCreate = () => {
    setEditingSchedule(null);
    setDialogOpen(true);
  };

  const handleEdit = (schedule: ScheduledEpic) => {
    setEditingSchedule(schedule);
    setDialogOpen(true);
  };

  const handleDialogClose = (success?: boolean) => {
    setDialogOpen(false);
    setEditingSchedule(null);
    if (success) {
      queryClient.invalidateQueries({ queryKey: ['scheduledEpics'] });
    }
  };

  if (!selectedProjectId) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        Select a project to manage scheduled epics
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 justify-center py-12 text-destructive">
        <AlertCircle className="w-5 h-5" />
        <span>Failed to load schedules</span>
      </div>
    );
  }

  if (!schedules?.length) {
    return (
      <div className="text-center py-12">
        <Clock className="w-12 h-12 mx-auto mb-4 text-muted-foreground/50" />
        <h3 className="text-lg font-medium mb-1">No scheduled epics</h3>
        <p className="text-muted-foreground mb-4">
          Create recurring epics that are automatically generated on a schedule
        </p>
        <Button onClick={handleCreate}>
          <Plus className="w-4 h-4 mr-2" />
          Create Schedule
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={handleCreate} size="sm">
          <Plus className="w-4 h-4 mr-2" />
          Create Schedule
        </Button>
      </div>

      <div className="space-y-3">
        {schedules.map((schedule) => (
          <Card key={schedule.id} className={!schedule.enabled ? 'opacity-60' : undefined}>
            <CardContent className="flex items-center gap-4 py-3 px-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-medium truncate">{schedule.name}</span>
                  <Badge variant="outline" className="text-xs shrink-0">
                    <Clock className="w-3 h-3 mr-1" />
                    {describeCron(schedule.cronExpression, presets ?? [])}
                  </Badge>
                  {schedule.maxOccurrences && (
                    <Badge variant="secondary" className="text-xs shrink-0">
                      {schedule.occurrenceCount}/{schedule.maxOccurrences}
                    </Badge>
                  )}
                </div>
                <div className="text-sm text-muted-foreground truncate">
                  <span className="font-mono text-xs">{schedule.templateTitle}</span>
                  <span className="mx-2">&middot;</span>
                  <span>Next: {formatNextRun(schedule.nextRunAt)}</span>
                  {schedule.lastRunAt && (
                    <>
                      <span className="mx-2">&middot;</span>
                      <span>Last: {new Date(schedule.lastRunAt).toLocaleDateString()}</span>
                    </>
                  )}
                </div>
              </div>

              <Switch
                checked={schedule.enabled}
                onCheckedChange={(checked) =>
                  toggleMutation.mutate({ id: schedule.id, enabled: checked })
                }
              />

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0">
                    <MoreHorizontal className="w-4 h-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => handleEdit(schedule)}>
                    <Pencil className="w-4 h-4 mr-2" />
                    Edit
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive"
                    onClick={() => setDeleteConfirmId(schedule.id)}
                  >
                    <Trash2 className="w-4 h-4 mr-2" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog open={!!deleteConfirmId} onOpenChange={() => setDeleteConfirmId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Schedule</DialogTitle>
            <DialogDescription>
              This will permanently delete this scheduled epic. Past runs and created epics will not
              be affected.
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
              {deleteMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ScheduleDialog
        open={dialogOpen}
        onClose={handleDialogClose}
        schedule={editingSchedule}
        projectId={selectedProjectId}
        presets={presets ?? []}
      />
    </div>
  );
}
