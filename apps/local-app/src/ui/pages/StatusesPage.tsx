import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/ui/components/ui/button';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/label';
import { Badge } from '@/ui/components/ui/badge';
import { Checkbox } from '@/ui/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/ui/components/ui/dialog';
import {
  TooltipProvider,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/ui/components/ui/tooltip';
import { useToast } from '@/ui/hooks/use-toast';
import {
  Plus,
  GripVertical,
  ArrowUp,
  ArrowDown,
  Pencil,
  Trash2,
  AlertCircle,
  Sparkles,
  EyeOff,
} from 'lucide-react';
import { cn } from '@/ui/lib/utils';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';

/** Check if a status is an Archive status (label contains 'archiv', case-insensitive) */
function isArchiveStatus(label: string): boolean {
  return label.toLowerCase().includes('archiv');
}

interface Status {
  id: string;
  projectId: string;
  label: string;
  color: string;
  position: number;
  mcpHidden: boolean;
  epicCount?: number;
  createdAt: string;
  updatedAt: string;
}

async function fetchStatuses(projectId: string) {
  const res = await fetch(`/api/statuses?projectId=${projectId}`);
  if (!res.ok) throw new Error('Failed to fetch statuses');
  return res.json();
}

async function createStatus(data: {
  projectId: string;
  label: string;
  color: string;
  position: number;
  mcpHidden?: boolean;
}) {
  const res = await fetch('/api/statuses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to create status' }));
    throw new Error(error.message || 'Failed to create status');
  }
  return res.json();
}

async function updateStatus(id: string, data: Partial<Status>) {
  const res = await fetch(`/api/statuses/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to update status' }));
    throw new Error(error.message || 'Failed to update status');
  }
  return res.json();
}

async function deleteStatus(id: string) {
  const res = await fetch(`/api/statuses/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to delete status' }));
    throw new Error(error.message || 'Failed to delete status');
  }
}

async function reorderStatuses(projectId: string, statusIds: string[]) {
  const res = await fetch(`/api/statuses/reorder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, statusIds }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to reorder statuses' }));
    throw new Error(error.message || 'Failed to reorder statuses');
  }
  return res.json();
}

interface Settings {
  autoClean?: {
    statusIds?: Record<string, string[]>;
  };
}

async function fetchSettings(): Promise<Settings> {
  const res = await fetch('/api/settings');
  if (!res.ok) throw new Error('Failed to fetch settings');
  return res.json();
}

async function updateAutoCleanStatusIds(projectId: string, statusIds: string[]): Promise<Settings> {
  const res = await fetch(`/api/settings/autoclean/${projectId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ statusIds }),
  });
  if (!res.ok) {
    const error = await res
      .json()
      .catch(() => ({ message: 'Failed to update auto-clean settings' }));
    throw new Error(error.message || 'Failed to update auto-clean settings');
  }
  return res.json();
}

// Status List with Drag-and-Drop
function StatusList({
  statuses,
  onReorder,
  onEdit,
  onDelete,
  autoCleanStatusIds,
}: {
  statuses: Status[];
  onReorder: (statuses: Status[]) => void;
  onEdit: (status: Status) => void;
  onDelete: (status: Status) => void;
  autoCleanStatusIds: string[];
}) {
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);

  const handleDragStart = (index: number) => {
    setDraggedIndex(index);
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === index) return;

    const newStatuses = [...statuses];
    const [removed] = newStatuses.splice(draggedIndex, 1);
    newStatuses.splice(index, 0, removed);

    setDraggedIndex(index);
    onReorder(newStatuses);
  };

  const handleDragEnd = () => {
    setDraggedIndex(null);
  };

  const moveUp = (index: number) => {
    if (index === 0) return;
    const newStatuses = [...statuses];
    [newStatuses[index - 1], newStatuses[index]] = [newStatuses[index], newStatuses[index - 1]];
    onReorder(newStatuses);
  };

  const moveDown = (index: number) => {
    if (index === statuses.length - 1) return;
    const newStatuses = [...statuses];
    [newStatuses[index], newStatuses[index + 1]] = [newStatuses[index + 1], newStatuses[index]];
    onReorder(newStatuses);
  };

  if (statuses.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center border rounded-lg">
        <AlertCircle className="h-12 w-12 text-muted-foreground mb-4" />
        <p className="text-lg font-medium mb-2">No Statuses</p>
        <p className="text-muted-foreground">Create your first status to get started.</p>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="space-y-2">
        {statuses.map((status, index) => {
          const isAutoClean = autoCleanStatusIds.includes(status.id);
          return (
            <div
              key={status.id}
              draggable
              onDragStart={() => handleDragStart(index)}
              onDragOver={(e) => handleDragOver(e, index)}
              onDragEnd={handleDragEnd}
              className={cn(
                'flex items-center gap-3 p-4 border rounded-lg bg-card cursor-move transition-all',
                draggedIndex === index && 'opacity-50 scale-95',
                isAutoClean && 'border-amber-500/50 bg-amber-500/5',
              )}
            >
              <GripVertical className="h-5 w-5 text-muted-foreground flex-shrink-0" />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <div
                    className="h-3 w-3 rounded-full flex-shrink-0"
                    style={{ backgroundColor: status.color }}
                    aria-hidden="true"
                  />
                  <span className="font-medium">{status.label}</span>
                  <Badge variant="outline">{index + 1}</Badge>
                  {status.epicCount !== undefined && status.epicCount > 0 && (
                    <Badge variant="secondary">
                      {status.epicCount} epic{status.epicCount !== 1 ? 's' : ''}
                    </Badge>
                  )}
                  {isAutoClean && (
                    <Badge variant="outline" className="text-amber-600 border-amber-500/50">
                      <Sparkles className="h-3 w-3 mr-1" />
                      Auto-clean
                    </Badge>
                  )}
                  {status.mcpHidden && (
                    <Badge variant="outline" className="text-blue-600 border-blue-500/50">
                      <EyeOff className="h-3 w-3 mr-1" />
                      MCP Hidden
                    </Badge>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => moveUp(index)}
                  disabled={index === 0}
                  aria-label="Move up"
                >
                  <ArrowUp className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => moveDown(index)}
                  disabled={index === statuses.length - 1}
                  aria-label="Move down"
                >
                  <ArrowDown className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onEdit(status)}
                  aria-label="Edit"
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                {isArchiveStatus(status.label) ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled
                          aria-label="Delete (disabled - Archive status is required)"
                          className="text-muted-foreground opacity-50 cursor-not-allowed"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Archive status is required for filtering</p>
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => onDelete(status)}
                    aria-label="Delete"
                    className="text-destructive hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </TooltipProvider>
  );
}

export function StatusesPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { selectedProjectId, selectedProject: activeProject } = useSelectedProject();
  const [showDialog, setShowDialog] = useState(false);
  const [editingStatus, setEditingStatus] = useState<Status | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<Status | null>(null);
  const [formData, setFormData] = useState({
    label: '',
    color: '#6c757d',
    autoClean: false,
    mcpHidden: false,
  });
  const reorderTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const { data: statusesData, isLoading } = useQuery({
    queryKey: ['statuses', selectedProjectId],
    queryFn: () => fetchStatuses(selectedProjectId as string),
    enabled: !!selectedProjectId,
  });

  const { data: settingsData } = useQuery({
    queryKey: ['settings'],
    queryFn: fetchSettings,
  });

  const autoCleanStatusIds = useMemo(() => {
    if (!selectedProjectId || !settingsData?.autoClean?.statusIds) return [];
    return settingsData.autoClean.statusIds[selectedProjectId] ?? [];
  }, [selectedProjectId, settingsData]);

  const autoCleanMutation = useMutation({
    mutationFn: ({ projectId, statusIds }: { projectId: string; statusIds: string[] }) =>
      updateAutoCleanStatusIds(projectId, statusIds),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (error) => {
      toast({
        title: 'Error',
        description:
          error instanceof Error ? error.message : 'Failed to update auto-clean settings',
        variant: 'destructive',
      });
    },
  });

  const createMutation = useMutation({
    mutationFn: createStatus,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['statuses', selectedProjectId] });
      setShowDialog(false);
      setFormData({ label: '', color: '#6c757d', autoClean: false, mcpHidden: false });
      toast({
        title: 'Success',
        description: 'Status created successfully',
      });
    },
    onError: (error) => {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to create status',
        variant: 'destructive',
      });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<Status> }) => updateStatus(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['statuses', selectedProjectId] });
      setShowDialog(false);
      setEditingStatus(null);
      setFormData({ label: '', color: '#6c757d', autoClean: false, mcpHidden: false });
      toast({
        title: 'Success',
        description: 'Status updated successfully',
      });
    },
    onError: (error) => {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to update status',
        variant: 'destructive',
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteStatus,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['statuses', selectedProjectId] });
      setDeleteConfirm(null);
      toast({
        title: 'Success',
        description: 'Status deleted successfully',
      });
    },
    onError: (error) => {
      setDeleteConfirm(null);
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to delete status',
        variant: 'destructive',
      });
    },
  });

  const reorderMutation = useMutation({
    mutationFn: ({ projectId, statusIds }: { projectId: string; statusIds: string[] }) =>
      reorderStatuses(projectId, statusIds),
    onError: (error) => {
      queryClient.invalidateQueries({ queryKey: ['statuses', selectedProjectId] });
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to reorder statuses',
        variant: 'destructive',
      });
    },
  });

  const sortedStatuses = useMemo(() => {
    return (statusesData?.items || []).sort((a: Status, b: Status) => a.position - b.position);
  }, [statusesData]);

  // Validation error for editing Archive status labels
  const labelValidationError = useMemo(() => {
    if (!editingStatus) return null;
    // Only validate if editing an existing Archive status
    if (!isArchiveStatus(editingStatus.label)) return null;
    // Error if new label doesn't contain 'archiv'
    if (!isArchiveStatus(formData.label)) {
      return "Label must contain 'Archive' for filtering to work";
    }
    return null;
  }, [editingStatus, formData.label]);

  // Debounced reorder handler
  const handleReorder = useCallback(
    (newStatuses: Status[]) => {
      if (!selectedProjectId) {
        return;
      }
      // Update UI immediately
      queryClient.setQueryData(['statuses', selectedProjectId], {
        items: newStatuses.map((s, idx) => ({ ...s, position: idx })),
      });

      // Debounce API call
      if (reorderTimeoutRef.current) {
        clearTimeout(reorderTimeoutRef.current);
      }

      reorderTimeoutRef.current = setTimeout(() => {
        const statusIds = newStatuses.map((s) => s.id);
        reorderMutation.mutate({ projectId: selectedProjectId, statusIds });
      }, 500);
    },
    [selectedProjectId, queryClient, reorderMutation],
  );

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (reorderTimeoutRef.current) {
        clearTimeout(reorderTimeoutRef.current);
      }
    };
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProjectId) {
      toast({
        title: 'Error',
        description: 'Please select a project first',
        variant: 'destructive',
      });
      return;
    }

    if (editingStatus) {
      // Update status label/color/mcpHidden
      updateMutation.mutate({
        id: editingStatus.id,
        data: { label: formData.label, color: formData.color, mcpHidden: formData.mcpHidden },
      });

      // Update auto-clean setting if changed
      const wasAutoClean = autoCleanStatusIds.includes(editingStatus.id);
      if (formData.autoClean !== wasAutoClean) {
        const newStatusIds = formData.autoClean
          ? [...autoCleanStatusIds, editingStatus.id]
          : autoCleanStatusIds.filter((id) => id !== editingStatus.id);
        autoCleanMutation.mutate({ projectId: selectedProjectId, statusIds: newStatusIds });
      }
    } else {
      const nextPosition = sortedStatuses.length;
      createMutation.mutate({
        projectId: selectedProjectId,
        label: formData.label,
        color: formData.color,
        position: nextPosition,
        mcpHidden: formData.mcpHidden,
      });
    }
  };

  const handleEdit = (status: Status) => {
    setEditingStatus(status);
    setFormData({
      label: status.label,
      color: status.color,
      autoClean: autoCleanStatusIds.includes(status.id),
      mcpHidden: status.mcpHidden,
    });
    setShowDialog(true);
  };

  const handleDelete = (status: Status) => {
    if (status.epicCount && status.epicCount > 0) {
      toast({
        title: 'Cannot delete',
        description: `This status has ${status.epicCount} epic(s). Move or delete them first.`,
        variant: 'destructive',
      });
      return;
    }
    setDeleteConfirm(status);
  };

  const confirmDelete = () => {
    if (deleteConfirm) {
      deleteMutation.mutate(deleteConfirm.id);
    }
  };

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold mb-2">Status Management</h1>
          {selectedProjectId ? (
            <p className="text-muted-foreground">
              Manage statuses for{' '}
              <span className="font-semibold text-foreground">
                {activeProject?.name ?? 'the selected project'}
              </span>
              .
            </p>
          ) : (
            <p className="text-muted-foreground">
              Select a project from the header to manage its statuses.
            </p>
          )}
        </div>
        {selectedProjectId && (
          <Button onClick={() => setShowDialog(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Create Status
          </Button>
        )}
      </div>

      {!selectedProjectId && (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <AlertCircle className="h-12 w-12 text-muted-foreground mb-4" />
          <p className="text-lg font-medium mb-2">No Project Selected</p>
          <p className="text-muted-foreground">
            Use the project selector in the header to choose a project and configure its statuses.
          </p>
        </div>
      )}

      {selectedProjectId && (
        <>
          {isLoading && <p className="text-muted-foreground">Loading statuses...</p>}

          {statusesData && (
            <div>
              <p className="text-sm text-muted-foreground mb-4">
                Drag statuses to reorder them. Changes are saved automatically.
              </p>
              <StatusList
                statuses={sortedStatuses}
                onReorder={handleReorder}
                onEdit={handleEdit}
                onDelete={handleDelete}
                autoCleanStatusIds={autoCleanStatusIds}
              />
            </div>
          )}
        </>
      )}

      {/* Create/Edit Dialog */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingStatus ? 'Edit Status' : 'Create Status'}</DialogTitle>
            <DialogDescription>
              {editingStatus
                ? 'Update the status name'
                : `Create a new status for ${activeProject?.name ?? 'this project'}`}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label htmlFor="status-label">Label *</Label>
              <Input
                id="status-label"
                type="text"
                value={formData.label}
                onChange={(e) => setFormData({ ...formData, label: e.target.value })}
                required
                placeholder="e.g., To Do, In Progress, Done"
                className={cn(labelValidationError && 'border-destructive')}
              />
              {labelValidationError ? (
                <p className="text-sm text-destructive mt-1">{labelValidationError}</p>
              ) : (
                <p className="text-sm text-muted-foreground mt-1">
                  Status labels should be unique within this project
                </p>
              )}
            </div>

            <div>
              <Label htmlFor="status-color">Color *</Label>
              <div className="flex gap-2">
                <Input
                  id="status-color"
                  type="color"
                  value={formData.color}
                  onChange={(e) => setFormData({ ...formData, color: e.target.value })}
                  required
                  className="w-20 h-10"
                />
                <Input
                  type="text"
                  value={formData.color}
                  onChange={(e) => setFormData({ ...formData, color: e.target.value })}
                  placeholder="#6c757d"
                  pattern="^#[0-9a-fA-F]{6}$"
                  className="flex-1 font-mono"
                />
              </div>
            </div>

            <div className="flex items-center gap-3 pt-2">
              <Checkbox
                id="status-autoClean"
                checked={formData.autoClean}
                onCheckedChange={(checked) =>
                  setFormData({ ...formData, autoClean: checked === true })
                }
              />
              <div className="flex-1">
                <Label htmlFor="status-autoClean" className="cursor-pointer">
                  Auto-clean assignments
                </Label>
                <p className="text-sm text-muted-foreground">
                  Clears agent assignment when an epic enters this status
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3 pt-2">
              <Checkbox
                id="status-mcpHidden"
                checked={formData.mcpHidden}
                onCheckedChange={(checked) =>
                  setFormData({ ...formData, mcpHidden: checked === true })
                }
              />
              <div className="flex-1">
                <Label htmlFor="status-mcpHidden" className="cursor-pointer">
                  Hide from MCP tools
                </Label>
                <p className="text-sm text-muted-foreground">
                  Epics in this status (and their descendants) won't appear in agent task lists
                </p>
              </div>
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setShowDialog(false);
                  setEditingStatus(null);
                  setFormData({ label: '', color: '#6c757d', autoClean: false, mcpHidden: false });
                }}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  createMutation.isPending || updateMutation.isPending || !!labelValidationError
                }
              >
                {editingStatus ? 'Update' : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteConfirm} onOpenChange={(open) => !open && setDeleteConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Status</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete <strong>{deleteConfirm?.label}</strong>? This action
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={deleteMutation.isPending}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
