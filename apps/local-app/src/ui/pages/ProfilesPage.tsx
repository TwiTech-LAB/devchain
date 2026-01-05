import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/ui/components/ui/button';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/label';
import { Badge } from '@/ui/components/ui/badge';
import { Textarea } from '@/ui/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/ui/components/ui/dialog';
import { useToast } from '@/ui/hooks/use-toast';
import { Plus, GripVertical, X, ArrowUp, ArrowDown, Users } from 'lucide-react';
import { cn } from '@/ui/lib/utils';
import { MarkdownReferenceInput } from '@/ui/components/shared';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';

interface Prompt {
  id: string;
  title: string;
  content: string;
}

interface ProfilePrompt {
  promptId: string;
  order: number;
  prompt: Prompt;
}

interface Provider {
  id: string;
  name: string;
  binPath: string | null;
}

interface AgentProfile {
  id: string;
  name: string;
  providerId: string;
  familySlug?: string | null;
  options?: string | null;
  provider?: Provider;
  instructions?: string | null;
  prompts?: ProfilePrompt[];
  agentCount?: number;
  createdAt: string;
  updatedAt: string;
}

interface ProfilesQueryData {
  items: AgentProfile[];
  total?: number;
  limit?: number;
  offset?: number;
}

async function fetchProfiles(projectId: string) {
  const res = await fetch(`/api/profiles?projectId=${encodeURIComponent(projectId)}`);
  if (!res.ok) throw new Error('Failed to fetch profiles');
  return res.json();
}

async function fetchPrompts(projectId: string) {
  const res = await fetch(`/api/prompts?projectId=${encodeURIComponent(projectId)}`);
  if (!res.ok) throw new Error('Failed to fetch prompts');
  return res.json();
}

async function fetchProviders() {
  const res = await fetch('/api/providers');
  if (!res.ok) throw new Error('Failed to fetch providers');
  return res.json();
}

async function createProfile(data: {
  projectId: string;
  name: string;
  providerId: string;
  familySlug?: string | null;
  options?: string | null;
  promptIds?: string[];
  instructions?: string | null;
}) {
  const res = await fetch('/api/profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('Failed to create profile');
  return res.json();
}

async function updateProfile(
  id: string,
  data: {
    name?: string;
    providerId?: string;
    familySlug?: string | null;
    options?: string | null;
    promptIds?: string[];
    instructions?: string | null;
  },
) {
  const res = await fetch(`/api/profiles/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('Failed to update profile');
  return res.json();
}

async function replaceProfilePrompts(id: string, promptIds: string[]) {
  const res = await fetch(`/api/profiles/${id}/prompts`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ promptIds }),
  });
  if (!res.ok) throw new Error('Failed to update profile prompts');
  return res.json();
}

async function deleteProfile(id: string) {
  const res = await fetch(`/api/profiles/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete profile');
}

// Drag and Drop Prompt List Component
function PromptOrderList({
  prompts,
  orderedPromptIds,
  onReorder,
}: {
  prompts: Prompt[];
  orderedPromptIds: string[];
  onReorder: (ids: string[]) => void;
}) {
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);

  const orderedPrompts = orderedPromptIds
    .map((id) => prompts.find((p) => p.id === id))
    .filter((p): p is Prompt => p !== undefined);

  const handleDragStart = (index: number) => {
    setDraggedIndex(index);
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === index) return;

    const newOrder = [...orderedPromptIds];
    const [removed] = newOrder.splice(draggedIndex, 1);
    newOrder.splice(index, 0, removed);

    setDraggedIndex(index);
    onReorder(newOrder);
  };

  const handleDragEnd = () => {
    setDraggedIndex(null);
  };

  const moveUp = (index: number) => {
    if (index === 0) return;
    const newOrder = [...orderedPromptIds];
    [newOrder[index - 1], newOrder[index]] = [newOrder[index], newOrder[index - 1]];
    onReorder(newOrder);
    setFocusedIndex(index - 1);
  };

  const moveDown = (index: number) => {
    if (index === orderedPromptIds.length - 1) return;
    const newOrder = [...orderedPromptIds];
    [newOrder[index], newOrder[index + 1]] = [newOrder[index + 1], newOrder[index]];
    onReorder(newOrder);
    setFocusedIndex(index + 1);
  };

  const handleRemove = (index: number) => {
    const newOrder = [...orderedPromptIds];
    newOrder.splice(index, 1);
    onReorder(newOrder);
  };

  if (orderedPrompts.length === 0) {
    return (
      <div className="text-center text-muted-foreground py-4 border rounded-md">
        No prompts assigned. Select prompts below to add them.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {orderedPrompts.map((prompt, index) => (
        <div
          key={prompt.id}
          draggable
          onDragStart={() => handleDragStart(index)}
          onDragOver={(e) => handleDragOver(e, index)}
          onDragEnd={handleDragEnd}
          className={cn(
            'flex items-center gap-2 p-3 border rounded-md bg-card cursor-move transition-colors',
            draggedIndex === index && 'opacity-50',
            focusedIndex === index && 'ring-2 ring-ring',
          )}
        >
          <GripVertical className="h-4 w-4 text-muted-foreground" />
          <div className="flex-1">
            <div className="font-medium text-sm">{prompt.title}</div>
            <div className="text-xs text-muted-foreground">Order: {index + 1}</div>
          </div>
          <div className="flex gap-1">
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
              disabled={index === orderedPrompts.length - 1}
              aria-label="Move down"
            >
              <ArrowDown className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => handleRemove(index)}
              aria-label="Remove"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

export function ProfilesPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { selectedProjectId } = useSelectedProject();
  const [showDialog, setShowDialog] = useState(false);
  const [editingProfile, setEditingProfile] = useState<AgentProfile | null>(null);
  const [formData, setFormData] = useState({
    name: '',
    providerId: '',
    familySlug: '',
    options: '',
    instructions: '',
    orderedPromptIds: [] as string[],
  });

  const { data: profilesData, isLoading: profilesLoading } = useQuery({
    queryKey: ['profiles', selectedProjectId],
    queryFn: () => fetchProfiles(selectedProjectId as string),
    enabled: !!selectedProjectId,
  });

  const { data: promptsData } = useQuery({
    queryKey: ['prompts', selectedProjectId],
    queryFn: () => fetchPrompts(selectedProjectId as string),
    enabled: !!selectedProjectId,
  });

  const { data: providersData } = useQuery({
    queryKey: ['providers'],
    queryFn: fetchProviders,
  });

  const providersById = useMemo(() => {
    const map = new Map<string, Provider>();
    if (providersData?.items) {
      providersData.items.forEach((provider: Provider) => {
        map.set(provider.id, provider);
      });
    }
    return map;
  }, [providersData]);

  const createMutation = useMutation({
    mutationFn: createProfile,
    onMutate: async (newProfile) => {
      await queryClient.cancelQueries({ queryKey: ['profiles', selectedProjectId] });
      const previousData = queryClient.getQueryData(['profiles', selectedProjectId]);

      queryClient.setQueryData(
        ['profiles', selectedProjectId],
        (old: ProfilesQueryData | undefined) => ({
          ...old,
          items: [
            {
              id: 'temp-' + Date.now(),
              name: newProfile.name,
              providerId: newProfile.providerId,
              options: newProfile.options ?? null,
              instructions: newProfile.instructions ?? null,
              prompts: [],
              agentCount: 0,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            ...(old?.items || []),
          ],
        }),
      );

      return { previousData };
    },
    onSuccess: async (created) => {
      try {
        if (formData.orderedPromptIds.length > 0 && created?.id) {
          await replaceProfilePrompts(created.id, formData.orderedPromptIds);
        }
      } catch (e) {
        toast({
          title: 'Warning',
          description: e instanceof Error ? e.message : 'Failed to persist prompt ordering',
          variant: 'destructive',
        });
      } finally {
        queryClient.invalidateQueries({ queryKey: ['profiles', selectedProjectId] });
        setShowDialog(false);
        resetForm();
        toast({
          title: 'Success',
          description: 'Profile created successfully',
        });
      }
    },
    onError: (error, variables, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(['profiles', selectedProjectId], context.previousData);
      }
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to create profile',
        variant: 'destructive',
      });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: {
        name?: string;
        providerId?: string;
        familySlug?: string | null;
        options?: string | null;
        promptIds?: string[];
        instructions?: string | null;
      };
    }) => updateProfile(id, data),
    onMutate: async ({ id, data }) => {
      await queryClient.cancelQueries({ queryKey: ['profiles', selectedProjectId] });
      const previousData = queryClient.getQueryData(['profiles', selectedProjectId]);

      queryClient.setQueryData(
        ['profiles', selectedProjectId],
        (old: ProfilesQueryData | undefined) => ({
          ...old,
          items: (old?.items || []).map((p: AgentProfile) =>
            p.id === id
              ? {
                  ...p,
                  name: data.name ?? p.name,
                  providerId: data.providerId ?? p.providerId,
                  options:
                    data.options !== undefined ? (data.options ?? null) : (p.options ?? null),
                  instructions:
                    data.instructions !== undefined ? (data.instructions ?? null) : p.instructions,
                  updatedAt: new Date().toISOString(),
                }
              : p,
          ),
        }),
      );

      return { previousData };
    },
    onSuccess: async (_updated, variables) => {
      try {
        if (formData.orderedPromptIds.length >= 0 && variables?.id) {
          await replaceProfilePrompts(variables.id, formData.orderedPromptIds);
        }
      } catch (e) {
        toast({
          title: 'Warning',
          description: e instanceof Error ? e.message : 'Failed to persist prompt ordering',
          variant: 'destructive',
        });
      } finally {
        queryClient.invalidateQueries({ queryKey: ['profiles', selectedProjectId] });
        setShowDialog(false);
        setEditingProfile(null);
        resetForm();
        toast({
          title: 'Success',
          description: 'Profile updated successfully',
        });
      }
    },
    onError: (error, variables, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(['profiles', selectedProjectId], context.previousData);
      }
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to update profile',
        variant: 'destructive',
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteProfile,
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ['profiles', selectedProjectId] });
      const previousData = queryClient.getQueryData(['profiles', selectedProjectId]);

      queryClient.setQueryData(
        ['profiles', selectedProjectId],
        (old: ProfilesQueryData | undefined) => ({
          ...old,
          items: (old?.items || []).filter((p: AgentProfile) => p.id !== id),
        }),
      );

      return { previousData };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profiles', selectedProjectId] });
      toast({
        title: 'Success',
        description: 'Profile deleted successfully',
      });
    },
    onError: (error, variables, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(['profiles', selectedProjectId], context.previousData);
      }
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to delete profile',
        variant: 'destructive',
      });
    },
  });

  const resetForm = () => {
    setFormData({
      name: '',
      providerId: '',
      familySlug: '',
      options: '',
      instructions: '',
      orderedPromptIds: [],
    });
    setEditingProfile(null);
  };

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

    const instructionsValue =
      formData.instructions.trim().length > 0 ? formData.instructions : null;
    const optionsValue = formData.options.trim();
    const optionsPayload = optionsValue.length > 0 ? optionsValue : null;
    const familySlugValue = formData.familySlug.trim();
    const familySlugPayload = familySlugValue.length > 0 ? familySlugValue : null;

    if (editingProfile) {
      updateMutation.mutate({
        id: editingProfile.id,
        data: {
          name: formData.name,
          providerId: formData.providerId,
          familySlug: familySlugPayload,
          options: optionsPayload,
          promptIds: formData.orderedPromptIds,
          instructions: instructionsValue,
        },
      });
    } else {
      createMutation.mutate({
        projectId: selectedProjectId,
        name: formData.name,
        providerId: formData.providerId,
        familySlug: familySlugPayload,
        options: optionsPayload,
        promptIds: formData.orderedPromptIds,
        instructions: instructionsValue,
      });
    }
  };

  const handleEdit = (profile: AgentProfile) => {
    setEditingProfile(profile);
    setFormData({
      name: profile.name,
      providerId: profile.providerId,
      familySlug: profile.familySlug ?? '',
      options: profile.options ?? '',
      instructions: profile.instructions ?? '',
      orderedPromptIds: (profile.prompts || [])
        .sort((a, b) => a.order - b.order)
        .map((pp) => pp.promptId),
    });
    setShowDialog(true);
  };

  const handleDelete = (id: string, agentCount: number) => {
    if (agentCount > 0) {
      toast({
        title: 'Cannot delete',
        description: `This profile is used by ${agentCount} agent(s). Remove agent assignments first.`,
        variant: 'destructive',
      });
      return;
    }
    if (confirm('Are you sure you want to delete this profile?')) {
      deleteMutation.mutate(id);
    }
  };

  const availablePrompts = useMemo(() => {
    return promptsData?.items || [];
  }, [promptsData]);

  const unassignedPrompts = useMemo(() => {
    return availablePrompts.filter((p: Prompt) => !formData.orderedPromptIds.includes(p.id));
  }, [availablePrompts, formData.orderedPromptIds]);

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold">Agent Profiles</h1>
        <Button
          onClick={() => {
            resetForm();
            setShowDialog(true);
          }}
        >
          <Plus className="h-4 w-4 mr-2" />
          Create Profile
        </Button>
      </div>

      {profilesLoading && <p className="text-muted-foreground">Loading...</p>}

      {selectedProjectId && profilesData && (
        <div className="grid gap-4">
          {profilesData.items.map((profile: AgentProfile) => (
            <div key={profile.id} className="border rounded-lg p-4 bg-card">
              <div className="flex justify-between items-start mb-3">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="text-lg font-semibold">
                      {profile.name}
                      {profile.familySlug && (
                        <span className="ml-2 text-sm font-normal text-muted-foreground">
                          ({profile.familySlug})
                        </span>
                      )}
                    </h3>
                    <Badge variant="secondary">
                      {profile.provider?.name ||
                        providersById.get(profile.providerId)?.name ||
                        'Unknown Provider'}
                    </Badge>
                    {profile.options ? <Badge variant="outline">{profile.options}</Badge> : null}
                    {profile.agentCount && profile.agentCount > 0 && (
                      <Badge variant="outline" className="gap-1">
                        <Users className="h-3 w-3" />
                        {profile.agentCount} agent{profile.agentCount !== 1 ? 's' : ''}
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {(profile.prompts || []).length} prompt
                    {(profile.prompts || []).length !== 1 ? 's' : ''} assigned
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => handleEdit(profile)}>
                    Edit
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => handleDelete(profile.id, profile.agentCount || 0)}
                  >
                    Delete
                  </Button>
                </div>
              </div>
              {profile.prompts && profile.prompts.length > 0 && (
                <div className="mt-3 space-y-2">
                  <p className="text-sm font-medium">Prompts (in order):</p>
                  <div className="space-y-1">
                    {profile.prompts
                      .sort((a, b) => a.order - b.order)
                      .map((pp, idx) => (
                        <div
                          key={pp.promptId}
                          className="flex items-center gap-2 text-sm p-2 bg-muted/50 rounded"
                        >
                          <span className="text-muted-foreground">{idx + 1}.</span>
                          <span>{pp.prompt.title}</span>
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </div>
          ))}
          {profilesData.items.length === 0 && (
            <p className="text-center text-muted-foreground py-8">
              No profiles found. Create your first profile to get started.
            </p>
          )}
        </div>
      )}

      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-5xl w-full max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingProfile ? 'Edit Profile' : 'Create Profile'}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid gap-6 lg:grid-cols-[1fr_1.5fr]">
              {/* Left Column */}
              <div className="space-y-4">
                <div>
                  <Label htmlFor="name">Name *</Label>
                  <Input
                    id="name"
                    type="text"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    required
                    placeholder="Enter profile name"
                  />
                </div>

                <div>
                  <Label htmlFor="provider">Provider *</Label>
                  <select
                    id="provider"
                    value={formData.providerId}
                    onChange={(e) => setFormData({ ...formData, providerId: e.target.value })}
                    required
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option value="">-- Select a provider --</option>
                    {providersData?.items.map((provider: Provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.name}
                      </option>
                    ))}
                  </select>
                  {providersData?.items.length === 0 && (
                    <p className="text-sm text-muted-foreground mt-1">
                      No providers available. Create a provider first.
                    </p>
                  )}
                </div>

                <div>
                  <Label htmlFor="familySlug">Family Slug</Label>
                  <Input
                    id="familySlug"
                    type="text"
                    value={formData.familySlug}
                    onChange={(e) => setFormData({ ...formData, familySlug: e.target.value })}
                    placeholder="e.g., coder, architect"
                  />
                  <p className="mt-1 text-sm text-muted-foreground">
                    Groups equivalent profiles across providers. Profiles with the same family slug
                    can be switched between providers.
                  </p>
                </div>

                <div>
                  <Label htmlFor="options">Options</Label>
                  <Textarea
                    id="options"
                    value={formData.options}
                    onChange={(e) => setFormData({ ...formData, options: e.target.value })}
                    placeholder="e.g. --model sonnet --max-tokens 4000"
                    rows={3}
                  />
                  <p className="mt-1 text-sm text-muted-foreground">
                    These flags are appended to the provider binary when launching this agent. Use
                    space-separated options like <span className="font-mono">--model sonnet</span>.
                  </p>
                </div>

                <div>
                  <Label>Assigned Prompts (ordered)</Label>
                  <p className="text-sm text-muted-foreground mb-2">
                    Drag to reorder, or use arrow buttons for keyboard navigation
                  </p>
                  <PromptOrderList
                    prompts={availablePrompts}
                    orderedPromptIds={formData.orderedPromptIds}
                    onReorder={(ids) => setFormData({ ...formData, orderedPromptIds: ids })}
                  />
                </div>

                {unassignedPrompts.length > 0 && (
                  <div>
                    <Label>Add Prompts</Label>
                    <div className="grid grid-cols-2 gap-2 mt-2">
                      {unassignedPrompts.map((prompt: Prompt) => (
                        <button
                          key={prompt.id}
                          type="button"
                          onClick={() =>
                            setFormData({
                              ...formData,
                              orderedPromptIds: [...formData.orderedPromptIds, prompt.id],
                            })
                          }
                          className="text-left p-2 border rounded-md hover:bg-muted transition-colors text-sm"
                        >
                          {prompt.title}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Right Column - Instructions */}
              <div className="space-y-2">
                <Label htmlFor="instructions">Instructions</Label>
                <p className="text-sm text-muted-foreground">
                  Use <span className="font-mono">#</span> for grouped references and{' '}
                  <span className="font-mono">@</span> to search documents while you type.
                </p>
                <MarkdownReferenceInput
                  id="instructions"
                  value={formData.instructions}
                  onChange={(instructions) => setFormData({ ...formData, instructions })}
                  placeholder="Add guidance for this profile..."
                  rows={22}
                  projectId={selectedProjectId}
                />
              </div>
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setShowDialog(false);
                  resetForm();
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={createMutation.isPending || updateMutation.isPending}>
                {editingProfile ? 'Update' : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
