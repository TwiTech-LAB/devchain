import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus,
  MoreHorizontal,
  Pencil,
  Trash2,
  Loader2,
  Bell,
  AlertCircle,
  ChevronUp,
  ChevronDown,
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/components/ui/tooltip';
import { useToast } from '@/ui/hooks/use-toast';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';
import {
  fetchSubscribers,
  fetchSubscribableEvents,
  toggleSubscriber,
  deleteSubscriber,
  updateSubscriber,
  type Subscriber,
} from '@/ui/lib/subscribers';
import { SubscriberDialog } from './SubscriberDialog';

/** Grouped subscribers with group metadata */
interface SubscriberGroup {
  groupKey: string;
  label: string;
  subscribers: Subscriber[];
}

export function SubscribersTab() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { selectedProjectId } = useSelectedProject();
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSubscriber, setEditingSubscriber] = useState<Subscriber | null>(null);

  // Fetch subscribers
  const {
    data: subscribers,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['subscribers', selectedProjectId],
    queryFn: () => fetchSubscribers(selectedProjectId as string),
    enabled: !!selectedProjectId,
  });

  // Fetch subscribable events for friendly labels
  const { data: subscribableEvents } = useQuery({
    queryKey: ['subscribableEvents'],
    queryFn: fetchSubscribableEvents,
  });

  // Group and sort subscribers
  const groupedSubscribers = useMemo((): SubscriberGroup[] => {
    if (!subscribers || subscribers.length === 0) return [];

    // Create a map of event names to friendly labels
    const eventLabels = new Map<string, string>();
    subscribableEvents?.forEach((e) => {
      eventLabels.set(e.name, e.label);
    });

    // Group by groupKey
    const groups = new Map<string, Subscriber[]>();
    for (const sub of subscribers) {
      const groupKey = sub.groupName ?? `event:${sub.eventName}`;
      if (!groups.has(groupKey)) {
        groups.set(groupKey, []);
      }
      groups.get(groupKey)!.push(sub);
    }

    // Sort within each group by position ASC, then createdAt ASC
    for (const subs of groups.values()) {
      subs.sort((a, b) => {
        if (a.position !== b.position) return a.position - b.position;
        return a.createdAt.localeCompare(b.createdAt);
      });
    }

    // Build result with friendly labels
    const result: SubscriberGroup[] = [];
    for (const [groupKey, subs] of groups) {
      let label: string;
      if (groupKey.startsWith('event:')) {
        const eventName = groupKey.slice(6); // Remove 'event:' prefix
        const friendlyLabel = eventLabels.get(eventName);
        label = friendlyLabel ? `Event: ${friendlyLabel}` : `Event: ${eventName}`;
      } else {
        label = `Group: ${groupKey}`;
      }
      result.push({ groupKey, label, subscribers: subs });
    }

    // Sort groups alphabetically by label
    result.sort((a, b) => a.label.localeCompare(b.label));

    return result;
  }, [subscribers, subscribableEvents]);

  // Toggle mutation
  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      toggleSubscriber(id, enabled),
    onMutate: async ({ id, enabled }) => {
      await queryClient.cancelQueries({ queryKey: ['subscribers', selectedProjectId] });
      const previousSubscribers = queryClient.getQueryData<Subscriber[]>([
        'subscribers',
        selectedProjectId,
      ]);

      queryClient.setQueryData<Subscriber[]>(['subscribers', selectedProjectId], (old) =>
        old?.map((s) => (s.id === id ? { ...s, enabled } : s)),
      );

      return { previousSubscribers };
    },
    onError: (err, variables, context) => {
      if (context?.previousSubscribers) {
        queryClient.setQueryData(['subscribers', selectedProjectId], context.previousSubscribers);
      }
      toast({
        title: 'Error',
        description: err instanceof Error ? err.message : 'Failed to toggle subscriber',
        variant: 'destructive',
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['subscribers', selectedProjectId] });
    },
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: deleteSubscriber,
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ['subscribers', selectedProjectId] });
      const previousSubscribers = queryClient.getQueryData<Subscriber[]>([
        'subscribers',
        selectedProjectId,
      ]);

      queryClient.setQueryData<Subscriber[]>(['subscribers', selectedProjectId], (old) =>
        old?.filter((s) => s.id !== id),
      );

      return { previousSubscribers };
    },
    onSuccess: () => {
      setDeleteConfirmId(null);
      toast({
        title: 'Success',
        description: 'Subscriber deleted successfully',
      });
    },
    onError: (err, variables, context) => {
      if (context?.previousSubscribers) {
        queryClient.setQueryData(['subscribers', selectedProjectId], context.previousSubscribers);
      }
      toast({
        title: 'Error',
        description: err instanceof Error ? err.message : 'Failed to delete subscriber',
        variant: 'destructive',
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['subscribers', selectedProjectId] });
    },
  });

  // Reorder mutation (updates position of two subscribers)
  const reorderMutation = useMutation({
    mutationFn: async ({ updates }: { updates: Array<{ id: string; position: number }> }) => {
      // Apply updates sequentially to avoid request races.
      for (const u of updates) {
        await updateSubscriber(u.id, { position: u.position });
      }
    },
    onMutate: async ({ updates }) => {
      await queryClient.cancelQueries({ queryKey: ['subscribers', selectedProjectId] });
      const previousSubscribers = queryClient.getQueryData<Subscriber[]>([
        'subscribers',
        selectedProjectId,
      ]);

      // Optimistically update positions
      queryClient.setQueryData<Subscriber[]>(['subscribers', selectedProjectId], (old) =>
        old?.map((s) => {
          const next = updates.find((u) => u.id === s.id);
          return next ? { ...s, position: next.position } : s;
        }),
      );

      return { previousSubscribers };
    },
    onError: (err, variables, context) => {
      if (context?.previousSubscribers) {
        queryClient.setQueryData(['subscribers', selectedProjectId], context.previousSubscribers);
      }
      toast({
        title: 'Error',
        description: err instanceof Error ? err.message : 'Failed to reorder subscriber',
        variant: 'destructive',
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['subscribers', selectedProjectId] });
    },
  });

  // Handle reordering within a group
  const handleMoveUp = (group: SubscriberGroup, index: number) => {
    if (index === 0) return; // Already at top

    const current = group.subscribers;
    const subscriber = current[index];
    const aboveSubscriber = current[index - 1];

    const positions = current.map((s) => s.position);
    const hasDuplicatePositions = new Set(positions).size !== positions.length;

    if (hasDuplicatePositions) {
      // Normalize first (position := index), then swap indices
      const currentPositionById = new Map(current.map((s) => [s.id, s.position]));
      const normalized = current.map((s, i) => ({ id: s.id, position: i }));
      normalized[index].position = index - 1;
      normalized[index - 1].position = index;
      const updates = normalized.filter((u) => u.position !== currentPositionById.get(u.id));
      reorderMutation.mutate({ updates });
      return;
    }

    // Swap positions (fast path when positions are already unique)
    reorderMutation.mutate({
      updates: [
        { id: subscriber.id, position: aboveSubscriber.position },
        { id: aboveSubscriber.id, position: subscriber.position },
      ],
    });
  };

  const handleMoveDown = (group: SubscriberGroup, index: number) => {
    if (index === group.subscribers.length - 1) return; // Already at bottom

    const current = group.subscribers;
    const subscriber = current[index];
    const belowSubscriber = current[index + 1];

    const positions = current.map((s) => s.position);
    const hasDuplicatePositions = new Set(positions).size !== positions.length;

    if (hasDuplicatePositions) {
      // Normalize first (position := index), then swap indices
      const currentPositionById = new Map(current.map((s) => [s.id, s.position]));
      const normalized = current.map((s, i) => ({ id: s.id, position: i }));
      normalized[index].position = index + 1;
      normalized[index + 1].position = index;
      const updates = normalized.filter((u) => u.position !== currentPositionById.get(u.id));
      reorderMutation.mutate({ updates });
      return;
    }

    // Swap positions (fast path when positions are already unique)
    reorderMutation.mutate({
      updates: [
        { id: subscriber.id, position: belowSubscriber.position },
        { id: belowSubscriber.id, position: subscriber.position },
      ],
    });
  };

  const handleAddSubscriber = () => {
    setEditingSubscriber(null);
    setDialogOpen(true);
  };

  const handleEditSubscriber = (subscriber: Subscriber) => {
    setEditingSubscriber(subscriber);
    setDialogOpen(true);
  };

  const handleDialogClose = (open: boolean) => {
    setDialogOpen(open);
    if (!open) {
      setEditingSubscriber(null);
    }
  };

  const getActionInputPreview = (subscriber: Subscriber): string | null => {
    const inputs = subscriber.actionInputs;
    if (!inputs) return null;

    // Find the first custom value to display as preview
    for (const [key, input] of Object.entries(inputs)) {
      if (input.source === 'custom' && input.customValue) {
        const value = input.customValue;
        if (value.length > 50) {
          return `${key}: ${value.slice(0, 50)}...`;
        }
        return `${key}: ${value}`;
      }
      if (input.source === 'event_field' && input.eventField) {
        return `${key}: {${input.eventField}}`;
      }
    }
    return null;
  };

  const formatActionType = (actionType: string): string => {
    // Convert snake_case to Title Case
    return actionType
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  };

  // Loading state
  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          <span className="ml-2 text-muted-foreground">Loading subscribers...</span>
        </CardContent>
      </Card>
    );
  }

  // Error state
  if (error) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12">
          <AlertCircle className="h-8 w-8 text-destructive mb-2" />
          <p className="text-destructive">
            {error instanceof Error ? error.message : 'Failed to load subscribers'}
          </p>
          <Button
            variant="outline"
            className="mt-4"
            onClick={() =>
              queryClient.invalidateQueries({ queryKey: ['subscribers', selectedProjectId] })
            }
          >
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  // No project selected
  if (!selectedProjectId) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12">
          <Bell className="h-8 w-8 text-muted-foreground mb-2" />
          <p className="text-muted-foreground">Please select a project to view subscribers</p>
        </CardContent>
      </Card>
    );
  }

  // Empty state
  if (!subscribers || subscribers.length === 0) {
    return (
      <>
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Subscribers</CardTitle>
                <CardDescription>React to events by executing automated actions.</CardDescription>
              </div>
              <Button onClick={handleAddSubscriber}>
                <Plus className="h-4 w-4 mr-2" />
                Add Subscriber
              </Button>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Bell className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No subscribers yet</h3>
            <p className="text-muted-foreground text-center max-w-md">
              Create your first subscriber to start reacting to events with automated actions.
            </p>
            <Button className="mt-4" onClick={handleAddSubscriber}>
              <Plus className="h-4 w-4 mr-2" />
              Create Subscriber
            </Button>
          </CardContent>
        </Card>

        <SubscriberDialog
          open={dialogOpen}
          onOpenChange={handleDialogClose}
          subscriber={editingSubscriber}
        />
      </>
    );
  }

  return (
    <TooltipProvider>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Subscribers</CardTitle>
              <CardDescription>
                React to events by executing automated actions. Delay schedules execution time;
                priority/position break ties when multiple subscribers are due at the same time.
              </CardDescription>
            </div>
            <Button onClick={handleAddSubscriber}>
              <Plus className="h-4 w-4 mr-2" />
              Add Subscriber
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-6">
            {groupedSubscribers.map((group) => (
              <div key={group.groupKey} className="space-y-3">
                {/* Group Header */}
                <div className="flex items-center gap-2 pb-2 border-b">
                  <h3 className="text-sm font-semibold text-muted-foreground">{group.label}</h3>
                  <Badge variant="outline" className="text-xs">
                    {group.subscribers.length}
                  </Badge>
                </div>

                {/* Subscribers in Group */}
                <div className="space-y-3">
                  {group.subscribers.map((subscriber, index) => (
                    <div
                      key={subscriber.id}
                      className="flex items-start justify-between p-4 border rounded-lg"
                    >
                      {/* Reorder Buttons */}
                      <div className="flex flex-col gap-0.5 mr-3">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              onClick={() => handleMoveUp(group, index)}
                              disabled={index === 0 || reorderMutation.isPending}
                            >
                              <ChevronUp className="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Move up</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              onClick={() => handleMoveDown(group, index)}
                              disabled={
                                index === group.subscribers.length - 1 || reorderMutation.isPending
                              }
                            >
                              <ChevronDown className="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Move down</TooltipContent>
                        </Tooltip>
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <h4 className="font-semibold truncate">{subscriber.name}</h4>
                          <Badge variant={subscriber.enabled ? 'default' : 'secondary'}>
                            {subscriber.enabled ? 'Enabled' : 'Disabled'}
                          </Badge>
                        </div>
                        {subscriber.description && (
                          <p className="text-sm text-muted-foreground mb-2 line-clamp-2">
                            {subscriber.description}
                          </p>
                        )}
                        <div className="flex flex-wrap gap-2 text-xs mb-2">
                          <Badge variant="outline">Listens to: {subscriber.eventName}</Badge>
                          <Badge variant="secondary">
                            {formatActionType(subscriber.actionType)}
                          </Badge>
                          {subscriber.delayMs > 0 && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Badge variant="outline">Delay: {subscriber.delayMs}ms</Badge>
                              </TooltipTrigger>
                              <TooltipContent>
                                Schedules execution {subscriber.delayMs}ms after event
                              </TooltipContent>
                            </Tooltip>
                          )}
                          {subscriber.priority !== 0 && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Badge variant="outline">Priority: {subscriber.priority}</Badge>
                              </TooltipTrigger>
                              <TooltipContent>
                                Higher priority runs first when multiple are due at same time
                              </TooltipContent>
                            </Tooltip>
                          )}
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Badge variant="outline">Position: {subscriber.position}</Badge>
                            </TooltipTrigger>
                            <TooltipContent>
                              Order within group when priority is equal
                            </TooltipContent>
                          </Tooltip>
                          {subscriber.retryOnError && (
                            <Badge variant="outline">Retry on error</Badge>
                          )}
                        </div>
                        {getActionInputPreview(subscriber) && (
                          <p className="text-xs text-muted-foreground font-mono bg-muted px-2 py-1 rounded truncate max-w-md">
                            {getActionInputPreview(subscriber)}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-2 ml-4">
                        <Switch
                          checked={subscriber.enabled}
                          onCheckedChange={(checked) =>
                            toggleMutation.mutate({ id: subscriber.id, enabled: checked })
                          }
                          disabled={toggleMutation.isPending}
                        />
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="sm">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => handleEditSubscriber(subscriber)}>
                              <Pencil className="h-4 w-4 mr-2" />
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-destructive"
                              onClick={() => setDeleteConfirmId(subscriber.id)}
                            >
                              <Trash2 className="h-4 w-4 mr-2" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteConfirmId} onOpenChange={() => setDeleteConfirmId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Subscriber</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this subscriber? This action cannot be undone.
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

      {/* Subscriber Create/Edit Dialog */}
      <SubscriberDialog
        open={dialogOpen}
        onOpenChange={handleDialogClose}
        subscriber={editingSubscriber}
      />
    </TooltipProvider>
  );
}
