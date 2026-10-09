import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { projectPresetQueries } from '@/ui/lib/project-presets';
import { profileQueries, type ProfileListItem } from '@/ui/lib/profiles';
import { agentQueries, agentQueryKeys, type Agent, type AgentOrGuestItem } from '@/ui/lib/agents';
import type { WsEnvelope } from '@/ui/lib/socket';
import { useAppSocket } from '@/ui/hooks/useAppSocket';
import type { Socket } from 'socket.io-client';
import { providersQueryKeys } from '@/ui/lib/providers-query-keys';
import { Button } from '@/ui/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/ui/components/ui/dialog';
import { getErrorMessage } from '@/ui/lib/toast-helpers';
import { useConfirmDialog } from '@/ui/hooks/useFormDialog';
import {
  optimisticAdd,
  optimisticRemoveById,
  useCrudMutation,
  type ListContainer,
} from '@/ui/hooks/useCrudMutations';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';
import { Plus, Bot, AlertCircle, Save } from 'lucide-react';
import { PresetSelector, PresetDialog, DeletePresetDialog } from '@/ui/components/agents';
import type { Preset } from '@/ui/lib/preset-validation';
import { useAgentsPagePresence } from '@/ui/hooks/useAgentsPagePresence';
import { AgentFormDialog } from '@/ui/components/agent/AgentFormDialog';
import type { AgentFormSubmitData } from '@/ui/components/agent/AgentFormDialog';
import { AgentCard } from '@/ui/components/agent/AgentCard';
import type { FetchFn } from '@/ui/lib/api-transport';
import { useFetchFactory, useHomeFetch } from '@/ui/hooks/useFetchFactory';

// ============================================
// Types
// ============================================

interface Provider {
  id: string;
  name: string;
  binPath?: string | null;
}

// ============================================
// Fetch functions
// ============================================

async function fetchProviders(fetchFn: FetchFn) {
  const res = await fetchFn('/api/providers');
  if (!res.ok) throw new Error('Failed to fetch providers');
  return res.json();
}

async function createAgent(
  fetchFn: FetchFn,
  data: {
    projectId: string;
    profileId: string;
    providerConfigId?: string | null;
    modelOverride?: string | null;
    effortOverride?: string | null;
    name: string;
    description?: string | null;
  },
) {
  const res = await fetchFn('/api/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to create agent' }));
    throw new Error(error.message || 'Failed to create agent');
  }
  return res.json();
}

async function deleteAgent(fetchFn: FetchFn, id: string) {
  const res = await fetchFn(`/api/agents/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to delete agent' }));
    throw new Error(error.message || 'Failed to delete agent');
  }
}

async function updateAgentRequest(
  fetchFn: FetchFn,
  id: string,
  data: {
    name?: string;
    profileId?: string;
    providerConfigId?: string | null;
    modelOverride?: string | null;
    effortOverride?: string | null;
    isProjectOwner: boolean;
    description?: string | null;
  },
): Promise<Agent> {
  const res = await fetchFn(`/api/agents/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to update agent' }));
    throw new Error(error.message || 'Failed to update agent');
  }
  return res.json();
}

// ============================================
// Component
// ============================================

export function AgentsPage() {
  const fetchFn = useFetchFactory();
  const homeFetch = useHomeFetch();
  const queryClient = useQueryClient();
  const { selectedProjectId, selectedProject: activeProject } = useSelectedProject();

  // ---- Data queries ----
  const { data: profilesData } = useQuery({
    ...profileQueries.list(fetchFn, selectedProjectId),
    enabled: !!selectedProjectId,
  });
  const { data: providersData } = useQuery({
    queryKey: providersQueryKeys.list(),
    queryFn: () => fetchProviders(fetchFn),
  });
  const { data: agentsData, isLoading } = useQuery({
    ...agentQueries.withGuests(fetchFn, selectedProjectId),
    enabled: !!selectedProjectId,
  });

  const { data: presetsData } = useQuery({
    ...projectPresetQueries.list(homeFetch, selectedProjectId),
    enabled: !!selectedProjectId,
  });
  const existingPresetNames = (presetsData?.presets ?? []).map((p) => p.name);

  // ---- Read-only agent presence (preset safety) ----
  const agentPresence = useAgentsPagePresence({ projectId: selectedProjectId ?? null });

  // ---- Live-update via events socket ----
  const handleAgentEventEnvelope = useCallback(
    (envelope: WsEnvelope) => {
      if (!envelope) return;
      const { topic, type, payload } = envelope;
      if (
        topic === 'events/logs' &&
        type === 'event_created' &&
        payload &&
        typeof payload === 'object' &&
        (payload as Record<string, unknown>).name === 'agent.created' &&
        ((payload as Record<string, unknown>).payload as Record<string, unknown>)?.projectId ===
          selectedProjectId
      ) {
        queryClient.invalidateQueries({
          queryKey: agentQueryKeys.project(selectedProjectId!),
        });
      }
    },
    [selectedProjectId, queryClient],
  );

  const eventsSocketRef = useRef<Socket | null>(null);
  const agentEventsSocket = useAppSocket(
    {
      connect: () => {
        eventsSocketRef.current?.emit('events:subscribe');
      },
      message: handleAgentEventEnvelope,
    },
    [handleAgentEventEnvelope],
  );
  eventsSocketRef.current = agentEventsSocket;

  useEffect(() => {
    if (agentEventsSocket?.connected) {
      agentEventsSocket.emit('events:subscribe');
    }
  }, [agentEventsSocket]);

  // ---- Derived data ----
  const providersById = useMemo(() => {
    const map = new Map<string, Provider>();
    if (providersData?.items) {
      providersData.items.forEach((provider: Provider) => {
        map.set(provider.id, provider);
      });
    }
    return map;
  }, [providersData]);

  const profilesById = useMemo(() => {
    const map = new Map<string, ProfileListItem>();
    if (profilesData?.items) {
      profilesData.items.forEach((profile) => {
        map.set(profile.id, profile);
      });
    }
    return map;
  }, [profilesData]);

  const availableProfiles = useMemo(() => {
    if (profilesById.size > 0) {
      return Array.from(profilesById.values());
    }
    return profilesData?.items || [];
  }, [profilesById, profilesData]);

  // ---- Dialog state ----
  const [showDialog, setShowDialog] = useState(false);
  const [editAgent, setEditAgent] = useState<AgentOrGuestItem | null>(null);
  const deleteDialog = useConfirmDialog<AgentOrGuestItem>();
  const deleteConfirm = deleteDialog.target;
  const [updatingAgentId, setUpdatingAgentId] = useState<string | null>(null);

  // ---- Preset state ----
  const [presetDialogOpen, setPresetDialogOpen] = useState(false);
  const [presetToEdit, setPresetToEdit] = useState<Preset | null>(null);
  const [deletePresetDialogOpen, setDeletePresetDialogOpen] = useState(false);
  const [presetToDelete, setPresetToDelete] = useState<Preset | null>(null);

  // ---- Preset handlers ----
  const handleEditPreset = (preset: Preset) => {
    setPresetToEdit(preset);
    setPresetDialogOpen(true);
  };

  const handleDeletePreset = (preset: Preset) => {
    setPresetToDelete(preset);
    setDeletePresetDialogOpen(true);
  };

  const handlePresetDialogOpenChange = (open: boolean) => {
    setPresetDialogOpen(open);
    if (!open) {
      setPresetToEdit(null);
    }
  };

  // ---- Create mutation ----
  const agentsKey = agentQueryKeys.withGuests(selectedProjectId);
  const agentsProjectKey = agentQueryKeys.project(selectedProjectId);
  type AgentsList = ListContainer<AgentOrGuestItem>;

  const createMutation = useCrudMutation<Agent, Parameters<typeof createAgent>[1], void>({
    mutationFn: (data) => createAgent(fetchFn, data),
    optimistic: {
      queryKey: agentsKey,
      project: (previous, newAgent) => {
        const list = previous as AgentsList | undefined;
        if (!list) return previous;
        const optimistic: AgentOrGuestItem = {
          id: `temp-${Date.now()}`,
          name: newAgent.name,
          profileId: newAgent.profileId,
          providerConfigId: newAgent.providerConfigId,
          modelOverride: newAgent.modelOverride ?? null,
          effortOverride: newAgent.effortOverride ?? null,
          description: newAgent.description,
          isProjectOwner: false,
          type: 'agent',
          providerConfig: null,
        };
        return optimisticAdd(list, optimistic);
      },
    },
    invalidateKeys: [agentsProjectKey],
    toast: {
      success: () => ({ title: 'Success', description: 'Agent created successfully' }),
      error: (error) => ({
        title: 'Error',
        description: getErrorMessage(error, 'Failed to create agent'),
      }),
    },
    onSuccessSideEffects: () => setShowDialog(false),
  });

  // ---- Delete mutation ----
  const deleteMutation = useCrudMutation<void, string, void>({
    mutationFn: (id: string) => deleteAgent(fetchFn, id),
    optimistic: {
      queryKey: agentsKey,
      // filter-out.
      project: (previous, id) => {
        const list = previous as AgentsList | undefined;
        if (!list) return previous;
        return optimisticRemoveById(list, id);
      },
    },
    invalidateKeys: [agentsProjectKey],
    toast: {
      success: () => ({ title: 'Success', description: 'Agent deleted successfully' }),
      error: (error) => ({
        title: 'Error',
        description: getErrorMessage(error, 'Failed to delete agent'),
      }),
    },
    // The confirm dialog closes on both outcomes (success and error).
    onSuccessSideEffects: () => deleteDialog.close(),
    onErrorSideEffects: () => deleteDialog.close(),
  });

  // ---- Update mutation ----
  type UpdateAgentVars = {
    id: string;
    name: string;
    profileId: string;
    providerConfigId: string | null;
    modelOverride: string | null;
    effortOverride: string | null;
    isProjectOwner: boolean;
    description: string | null;
  };

  const updateMutation = useCrudMutation<Agent, UpdateAgentVars, void>({
    mutationFn: (vars) =>
      updateAgentRequest(fetchFn, vars.id, {
        name: vars.name,
        profileId: vars.profileId,
        providerConfigId: vars.providerConfigId,
        modelOverride: vars.modelOverride,
        effortOverride: vars.effortOverride,
        isProjectOwner: vars.isProjectOwner,
        description: vars.description,
      }),
    optimistic: {
      queryKey: agentsKey,
      project: (previous, vars) => {
        const list = previous as AgentsList | undefined;
        if (!list) return previous;
        return {
          ...list,
          items: list.items.map((agent) => {
            if (vars.isProjectOwner) {
              if (agent.id !== vars.id) return { ...agent, isProjectOwner: false };
            }
            if (agent.id !== vars.id) return agent;
            return {
              ...agent,
              name: vars.name,
              profileId: vars.profileId,
              providerConfigId: vars.providerConfigId,
              modelOverride: vars.modelOverride,
              effortOverride: vars.effortOverride,
              description: vars.description,
              isProjectOwner: vars.isProjectOwner,
            } satisfies AgentOrGuestItem;
          }),
        };
      },
    },
    invalidateKeys: [agentsProjectKey],
    toast: {
      success: () => ({ title: 'Agent updated', description: 'Agent updated successfully.' }),
      error: (error) => ({
        title: 'Update failed',
        description: getErrorMessage(error, 'Failed to update agent'),
      }),
    },
    onSuccessSideEffects: () => {
      setEditAgent(null);
      setUpdatingAgentId(null);
    },
    onErrorSideEffects: () => {
      queryClient.invalidateQueries({ queryKey: agentsProjectKey });
      setUpdatingAgentId(null);
    },
  });

  // ---- Form submit handlers ----
  const handleCreateSubmit = (data: AgentFormSubmitData) => {
    if (!selectedProjectId) return;
    createMutation.mutate({
      projectId: selectedProjectId,
      name: data.name,
      profileId: data.profileId,
      providerConfigId: data.providerConfigId,
      modelOverride: data.modelOverride,
      effortOverride: data.effortOverride,
      description: data.description,
    });
  };

  const handleEditSubmit = (data: AgentFormSubmitData) => {
    if (!editAgent) return;
    setUpdatingAgentId(editAgent.id);
    updateMutation.mutate({
      id: editAgent.id,
      name: data.name,
      profileId: data.profileId,
      providerConfigId: data.providerConfigId,
      modelOverride: data.modelOverride,
      effortOverride: data.effortOverride,
      isProjectOwner: data.isProjectOwner === true,
      description: data.description,
    });
  };

  // ---- Delete handlers ----
  const handleDelete = (agent: AgentOrGuestItem) => {
    deleteDialog.open(agent);
  };

  const confirmDelete = () => {
    if (deleteConfirm) {
      deleteMutation.mutate(deleteConfirm.id);
    }
  };

  // ---- Edit dialog computed values ----
  const editInitialValues = editAgent
    ? {
        name: editAgent.name,
        profileId: editAgent.profileId ?? '',
        providerConfigId: editAgent.providerConfigId ?? '',
        modelOverride: editAgent.modelOverride ?? null,
        effortOverride: editAgent.effortOverride ?? null,
        isProjectOwner: editAgent.isProjectOwner === true,
        description: editAgent.description ?? '',
      }
    : undefined;

  const editInitialProfile = editAgent?.profileId
    ? profilesById.get(editAgent.profileId)
    : undefined;

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold mb-2">Project Agents</h1>
          {selectedProjectId ? (
            <p className="text-muted-foreground">
              Manage agents for{' '}
              <span className="font-semibold text-foreground">
                {activeProject?.name ?? 'the selected project'}
              </span>
              .
            </p>
          ) : (
            <p className="text-muted-foreground">
              Select a project from the header to view and manage its agents.
            </p>
          )}
        </div>
        {selectedProjectId && (
          <div className="flex items-center gap-3">
            <PresetSelector
              projectId={selectedProjectId}
              agents={agentsData?.items ?? []}
              agentPresence={agentPresence}
              onAgentsRefresh={() =>
                queryClient.invalidateQueries({
                  queryKey: agentQueryKeys.project(selectedProjectId),
                })
              }
              onEditPreset={handleEditPreset}
              onDeletePreset={handleDeletePreset}
            />
            <Button variant="outline" onClick={() => setPresetDialogOpen(true)}>
              <Save className="h-4 w-4 mr-2" />
              Save as Preset
            </Button>
            <Button onClick={() => setShowDialog(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Create Agent
            </Button>
          </div>
        )}
      </div>

      {!selectedProjectId && (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <AlertCircle className="h-12 w-12 text-muted-foreground mb-4" />
          <p className="text-lg font-medium mb-2">No Project Selected</p>
          <p className="text-muted-foreground">
            Use the project selector in the header to choose a project and manage its agents here.
          </p>
        </div>
      )}

      {selectedProjectId && (
        <>
          {isLoading && <p className="text-muted-foreground">Loading agents...</p>}

          {agentsData && (
            <div className="space-y-4" data-testid="agents-list">
              {agentsData.items.length === 0 && (
                <div className="flex flex-col items-center justify-center py-12 text-center border rounded-lg">
                  <Bot className="h-12 w-12 text-muted-foreground mb-4" />
                  <p className="text-lg font-medium mb-2">No Agents Yet</p>
                  <p className="text-muted-foreground mb-4">
                    Create your first agent for {activeProject?.name ?? 'this project'}
                  </p>
                  <Button onClick={() => setShowDialog(true)}>
                    <Plus className="h-4 w-4 mr-2" />
                    Create Agent
                  </Button>
                </div>
              )}

              {agentsData.items.map((agent) => {
                const profile = agent.profileId ? profilesById.get(agent.profileId) : undefined;
                const providerName =
                  (agent.providerConfig
                    ? providersById.get(agent.providerConfig.providerId)?.name
                    : null) || profile?.provider?.name;

                return (
                  <AgentCard
                    key={agent.id}
                    agent={agent}
                    profile={profile}
                    providerName={providerName}
                    providersById={providersById}
                    isUpdating={updatingAgentId === agent.id && updateMutation.isPending}
                    isDeleting={deleteMutation.isPending && deleteConfirm?.id === agent.id}
                    onEdit={setEditAgent}
                    onDelete={handleDelete}
                  />
                );
              })}
            </div>
          )}
        </>
      )}

      {/* Create Agent Dialog */}
      <AgentFormDialog
        mode="create"
        open={showDialog}
        onOpenChange={setShowDialog}
        onSubmit={handleCreateSubmit}
        isSubmitting={createMutation.isPending}
        projectName={activeProject?.name}
        profiles={availableProfiles}
        providers={providersById}
        existingAgents={agentsData?.items ?? []}
      />

      {/* Edit Agent Dialog */}
      <AgentFormDialog
        mode="edit"
        open={!!editAgent}
        onOpenChange={(open) => {
          if (!open) setEditAgent(null);
        }}
        initialValues={editInitialValues}
        initialProfile={editInitialProfile}
        onSubmit={handleEditSubmit}
        isSubmitting={updateMutation.isPending}
        projectName={activeProject?.name}
        profiles={availableProfiles}
        providers={providersById}
        existingAgents={agentsData?.items ?? []}
        editAgentId={editAgent?.id}
      />

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialog.isOpen} onOpenChange={deleteDialog.onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Agent</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete <strong>{deleteConfirm?.name}</strong>? This action
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => deleteDialog.close()}>
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

      <PresetDialog
        open={presetDialogOpen}
        onOpenChange={handlePresetDialogOpenChange}
        projectId={selectedProjectId ?? ''}
        agents={agentsData?.items ?? []}
        existingPresetNames={existingPresetNames}
        presetToEdit={presetToEdit}
      />

      <DeletePresetDialog
        open={deletePresetDialogOpen}
        onOpenChange={setDeletePresetDialogOpen}
        projectId={selectedProjectId ?? ''}
        presetToDelete={presetToDelete}
      />
    </div>
  );
}
