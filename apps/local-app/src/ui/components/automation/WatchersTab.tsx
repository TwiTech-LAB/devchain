import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus,
  MoreHorizontal,
  Pencil,
  Trash2,
  Play,
  Loader2,
  Eye,
  AlertCircle,
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
  fetchWatchers,
  toggleWatcher,
  deleteWatcher,
  testWatcher,
  getConditionTypeLabel,
  type Watcher,
  type WatcherTestResult,
} from '@/ui/lib/watchers';
import { WatcherDialog } from './WatcherDialog';

export function WatchersTab() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { selectedProjectId } = useSelectedProject();
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [testResultDialog, setTestResultDialog] = useState<WatcherTestResult | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingWatcher, setEditingWatcher] = useState<Watcher | null>(null);

  // Fetch watchers
  const {
    data: watchers,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['watchers', selectedProjectId],
    queryFn: () => fetchWatchers(selectedProjectId as string),
    enabled: !!selectedProjectId,
  });

  // Toggle mutation
  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => toggleWatcher(id, enabled),
    onMutate: async ({ id, enabled }) => {
      await queryClient.cancelQueries({ queryKey: ['watchers', selectedProjectId] });
      const previousWatchers = queryClient.getQueryData<Watcher[]>(['watchers', selectedProjectId]);

      queryClient.setQueryData<Watcher[]>(['watchers', selectedProjectId], (old) =>
        old?.map((w) => (w.id === id ? { ...w, enabled } : w)),
      );

      return { previousWatchers };
    },
    onError: (err, variables, context) => {
      if (context?.previousWatchers) {
        queryClient.setQueryData(['watchers', selectedProjectId], context.previousWatchers);
      }
      toast({
        title: 'Error',
        description: err instanceof Error ? err.message : 'Failed to toggle watcher',
        variant: 'destructive',
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['watchers', selectedProjectId] });
    },
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: deleteWatcher,
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ['watchers', selectedProjectId] });
      const previousWatchers = queryClient.getQueryData<Watcher[]>(['watchers', selectedProjectId]);

      queryClient.setQueryData<Watcher[]>(['watchers', selectedProjectId], (old) =>
        old?.filter((w) => w.id !== id),
      );

      return { previousWatchers };
    },
    onSuccess: () => {
      setDeleteConfirmId(null);
      toast({
        title: 'Success',
        description: 'Watcher deleted successfully',
      });
    },
    onError: (err, variables, context) => {
      if (context?.previousWatchers) {
        queryClient.setQueryData(['watchers', selectedProjectId], context.previousWatchers);
      }
      toast({
        title: 'Error',
        description: err instanceof Error ? err.message : 'Failed to delete watcher',
        variant: 'destructive',
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['watchers', selectedProjectId] });
    },
  });

  // Test mutation
  const testMutation = useMutation({
    mutationFn: testWatcher,
    onSuccess: (result) => {
      const matchCount = result.results.filter((r) => r.conditionMatched).length;
      if (matchCount > 0) {
        toast({
          title: 'Test Complete',
          description: `Condition matched in ${matchCount} of ${result.sessionsChecked} sessions`,
        });
      } else {
        toast({
          title: 'Test Complete',
          description: `No matches found in ${result.sessionsChecked} sessions`,
        });
      }
      setTestResultDialog(result);
    },
    onError: (err) => {
      toast({
        title: 'Test Failed',
        description: err instanceof Error ? err.message : 'Failed to test watcher',
        variant: 'destructive',
      });
    },
  });

  const handleAddWatcher = () => {
    setEditingWatcher(null);
    setDialogOpen(true);
  };

  const handleEditWatcher = (watcher: Watcher) => {
    setEditingWatcher(watcher);
    setDialogOpen(true);
  };

  const handleDialogClose = (open: boolean) => {
    setDialogOpen(open);
    if (!open) {
      setEditingWatcher(null);
    }
  };

  const formatPollInterval = (ms: number) => {
    if (ms >= 60000) {
      return `${ms / 60000}m`;
    }
    return `${ms / 1000}s`;
  };

  const formatCondition = (watcher: Watcher) => {
    const { condition, idleAfterSeconds } = watcher;
    const truncatedPattern =
      condition.pattern.length > 30 ? condition.pattern.slice(0, 30) + '...' : condition.pattern;
    const conditionDisplay = `${getConditionTypeLabel(condition.type)}: ${truncatedPattern}`;

    if (idleAfterSeconds > 0) {
      return `Idle >= ${idleAfterSeconds}s + ${conditionDisplay}`;
    }

    return conditionDisplay;
  };

  const getScopeLabel = (watcher: Watcher) => {
    if (watcher.scope === 'all') return 'All Sessions';
    if (watcher.scopeFilterId) {
      return `${watcher.scope.charAt(0).toUpperCase() + watcher.scope.slice(1)}: ${watcher.scopeFilterId.slice(0, 8)}...`;
    }
    return watcher.scope.charAt(0).toUpperCase() + watcher.scope.slice(1);
  };

  // Loading state
  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          <span className="ml-2 text-muted-foreground">Loading watchers...</span>
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
            {error instanceof Error ? error.message : 'Failed to load watchers'}
          </p>
          <Button
            variant="outline"
            className="mt-4"
            onClick={() =>
              queryClient.invalidateQueries({ queryKey: ['watchers', selectedProjectId] })
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
          <Eye className="h-8 w-8 text-muted-foreground mb-2" />
          <p className="text-muted-foreground">Please select a project to view watchers</p>
        </CardContent>
      </Card>
    );
  }

  // Empty state
  if (!watchers || watchers.length === 0) {
    return (
      <>
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Watchers</CardTitle>
                <CardDescription>
                  Monitor terminal output and trigger events when conditions are met.
                </CardDescription>
              </div>
              <Button onClick={handleAddWatcher}>
                <Plus className="h-4 w-4 mr-2" />
                Add Watcher
              </Button>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Eye className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No watchers yet</h3>
            <p className="text-muted-foreground text-center max-w-md">
              Create your first watcher to start monitoring terminal output and triggering automated
              actions.
            </p>
            <Button className="mt-4" onClick={handleAddWatcher}>
              <Plus className="h-4 w-4 mr-2" />
              Create Watcher
            </Button>
          </CardContent>
        </Card>

        <WatcherDialog
          open={dialogOpen}
          onOpenChange={handleDialogClose}
          watcher={editingWatcher}
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
              <CardTitle>Watchers</CardTitle>
              <CardDescription>
                Monitor terminal output and trigger events when conditions are met.
              </CardDescription>
            </div>
            <Button onClick={handleAddWatcher}>
              <Plus className="h-4 w-4 mr-2" />
              Add Watcher
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {watchers.map((watcher) => (
              <div
                key={watcher.id}
                className="flex items-start justify-between p-4 border rounded-lg"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <h4 className="font-semibold truncate">{watcher.name}</h4>
                    <Badge variant={watcher.enabled ? 'default' : 'secondary'}>
                      {watcher.enabled ? 'Enabled' : 'Disabled'}
                    </Badge>
                  </div>
                  {watcher.description && (
                    <p className="text-sm text-muted-foreground mb-2 line-clamp-2">
                      {watcher.description}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2 text-xs">
                    <Badge variant="outline">{getScopeLabel(watcher)}</Badge>
                    <Badge variant="outline">
                      Poll: {formatPollInterval(watcher.pollIntervalMs)}
                    </Badge>
                    <Badge variant="outline" className="max-w-[200px] truncate">
                      {formatCondition(watcher)}
                    </Badge>
                    <Badge variant="secondary">{watcher.eventName}</Badge>
                  </div>
                </div>
                <div className="flex items-center gap-2 ml-4">
                  <Switch
                    checked={watcher.enabled}
                    onCheckedChange={(checked) =>
                      toggleMutation.mutate({ id: watcher.id, enabled: checked })
                    }
                    disabled={toggleMutation.isPending}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => testMutation.mutate(watcher.id)}
                    disabled={testMutation.isPending}
                  >
                    {testMutation.isPending && testMutation.variables === watcher.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Play className="h-4 w-4" />
                    )}
                    <span className="ml-1">Test</span>
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="sm">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => handleEditWatcher(watcher)}>
                        <Pencil className="h-4 w-4 mr-2" />
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive"
                        onClick={() => setDeleteConfirmId(watcher.id)}
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
        </CardContent>
      </Card>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteConfirmId} onOpenChange={() => setDeleteConfirmId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Watcher</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this watcher? This action cannot be undone.
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

      {/* Test Results Dialog */}
      <Dialog open={!!testResultDialog} onOpenChange={() => setTestResultDialog(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Test Results: {testResultDialog?.watcher.name}</DialogTitle>
            <DialogDescription>
              Checked {testResultDialog?.sessionsChecked} session
              {testResultDialog?.sessionsChecked !== 1 ? 's' : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[400px] overflow-y-auto">
            {testResultDialog?.results.length === 0 ? (
              <p className="text-muted-foreground text-center py-4">No active sessions to test</p>
            ) : (
              <div className="space-y-2">
                {testResultDialog?.results.map((result, index) => (
                  <div
                    key={index}
                    className={`p-3 rounded-lg border ${
                      result.conditionMatched ? 'border-green-500 bg-green-500/10' : 'border-muted'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-mono text-sm">
                        Session: {result.sessionId.slice(0, 8)}...
                      </span>
                      <Badge variant={result.conditionMatched ? 'default' : 'secondary'}>
                        {result.conditionMatched ? 'Matched' : 'No Match'}
                      </Badge>
                    </div>
                    {result.viewport && (
                      <pre className="text-xs bg-muted p-2 rounded overflow-x-auto max-h-[100px]">
                        {result.viewport.slice(0, 500)}
                        {result.viewport.length > 500 ? '...' : ''}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button onClick={() => setTestResultDialog(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Watcher Create/Edit Dialog */}
      <WatcherDialog open={dialogOpen} onOpenChange={handleDialogClose} watcher={editingWatcher} />
    </>
  );
}
