import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/ui/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/ui/components/ui/dialog';
import { useToast } from '@/ui/hooks/use-toast';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';
import { Plus, Bot, AlertCircle, Save } from 'lucide-react';
import { PresetSelector, PresetDialog, DeletePresetDialog } from '@/ui/components/agents';
import type { Preset } from '@/ui/lib/preset-validation';
import { McpConfigurationModal } from '@/ui/components/shared/McpConfigurationModal';
import { fetchPreflightChecks } from '@/ui/lib/preflight';
import { useAgentSessionControls } from '@/ui/hooks/useAgentSessionControls';
import { AgentFormDialog } from '@/ui/components/agent/AgentFormDialog';
import type { AgentFormSubmitData } from '@/ui/components/agent/AgentFormDialog';
import { AgentCard } from '@/ui/components/agent/AgentCard';

// ============================================
// Types
// ============================================

interface Agent {
  id: string;
  projectId: string;
  profileId: string;
  providerConfigId?: string | null;
  modelOverride?: string | null;
  name: string;
  description?: string | null;
  profile?: AgentProfile;
  providerConfig?: ProviderConfig;
  createdAt: string;
  updatedAt: string;
}

interface ProviderConfig {
  id: string;
  profileId: string;
  providerId: string;
  name: string;
  options: string | null;
  env: Record<string, string> | null;
}

interface AgentProfile {
  id: string;
  name: string;
  providerId: string;
  provider?: {
    id: string;
    name: string;
  };
  promptCount?: number;
}

interface Provider {
  id: string;
  name: string;
  binPath?: string | null;
}

interface AgentsQueryData {
  items: Agent[];
  total?: number;
  limit?: number;
  offset?: number;
}

// ============================================
// Fetch functions
// ============================================

async function fetchProfiles(projectId: string) {
  const res = await fetch(`/api/profiles?projectId=${encodeURIComponent(projectId)}`);
  if (!res.ok) throw new Error('Failed to fetch profiles');
  return res.json();
}

async function fetchProviders() {
  const res = await fetch('/api/providers');
  if (!res.ok) throw new Error('Failed to fetch providers');
  return res.json();
}

async function fetchAgents(projectId: string) {
  const res = await fetch(`/api/agents?projectId=${projectId}&includeGuests=true`);
  if (!res.ok) throw new Error('Failed to fetch agents');
  return res.json();
}

async function createAgent(data: {
  projectId: string;
  profileId: string;
  providerConfigId?: string | null;
  modelOverride?: string | null;
  name: string;
  description?: string | null;
}) {
  const res = await fetch('/api/agents', {
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

async function deleteAgent(id: string) {
  const res = await fetch(`/api/agents/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to delete agent' }));
    throw new Error(error.message || 'Failed to delete agent');
  }
}

async function updateAgentRequest(
  id: string,
  data: {
    name?: string;
    profileId?: string;
    providerConfigId?: string | null;
    modelOverride?: string | null;
    description?: string | null;
  },
): Promise<Agent> {
  const res = await fetch(`/api/agents/${id}`, {
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
// Query key factory
// ============================================

export const agentsPageQueryKeys = {
  agents: (projectId: string) => ['agents', projectId] as const,
  profiles: (projectId: string) => ['profiles', projectId] as const,
  providers: () => ['providers'] as const,
  presets: (projectId: string) => ['project-presets', projectId] as const,
  preflight: (rootPath?: string) => ['preflight', 'agents-page', rootPath ?? 'global'] as const,
};

// ============================================
// Component
// ============================================

export function AgentsPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { selectedProjectId, selectedProject: activeProject } = useSelectedProject();

  // ---- Data queries ----
  const { data: profilesData } = useQuery({
    queryKey: agentsPageQueryKeys.profiles(selectedProjectId as string),
    queryFn: () => fetchProfiles(selectedProjectId as string),
    enabled: !!selectedProjectId,
  });
  const { data: providersData } = useQuery({
    queryKey: agentsPageQueryKeys.providers(),
    queryFn: fetchProviders,
  });
  const { data: agentsData, isLoading } = useQuery({
    queryKey: agentsPageQueryKeys.agents(selectedProjectId as string),
    queryFn: () => fetchAgents(selectedProjectId as string),
    enabled: !!selectedProjectId,
  });

  const { data: presetsData } = useQuery<{ presets: { name: string }[] }>({
    queryKey: agentsPageQueryKeys.presets(selectedProjectId as string),
    queryFn: async () => {
      const res = await fetch(`/api/projects/${selectedProjectId}/presets`);
      if (!res.ok) throw new Error('Failed to fetch presets');
      return res.json();
    },
    enabled: !!selectedProjectId,
  });
  const existingPresetNames = (presetsData?.presets ?? []).map((p) => p.name);

  const { refetch: refetchPreflight } = useQuery({
    queryKey: agentsPageQueryKeys.preflight(activeProject?.rootPath),
    queryFn: () => fetchPreflightChecks(activeProject?.rootPath),
    staleTime: 30000,
    refetchInterval: 60000,
  });

  // ---- Session controls (extracted hook) ----
  const sessionControls = useAgentSessionControls({
    projectId: selectedProjectId ?? null,
    refetchPreflight,
  });

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
    const map = new Map<string, AgentProfile>();
    if (profilesData?.items) {
      profilesData.items.forEach((profile: AgentProfile) => {
        map.set(profile.id, {
          ...profile,
          provider: profile.provider,
        });
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
  const [editAgent, setEditAgent] = useState<Agent | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<Agent | null>(null);
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
  const createMutation = useMutation({
    mutationFn: createAgent,
    onMutate: async (newAgent) => {
      await queryClient.cancelQueries({
        queryKey: agentsPageQueryKeys.agents(selectedProjectId as string),
      });
      const previousData = queryClient.getQueryData(
        agentsPageQueryKeys.agents(selectedProjectId as string),
      );

      const profile =
        profilesById.get(newAgent.profileId) ||
        profilesData?.items.find((p: AgentProfile) => p.id === newAgent.profileId);

      queryClient.setQueryData(
        agentsPageQueryKeys.agents(selectedProjectId as string),
        (old: AgentsQueryData | undefined) => ({
          ...old,
          items: [
            {
              id: 'temp-' + Date.now(),
              ...newAgent,
              profile,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            ...(old?.items || []),
          ],
        }),
      );

      return { previousData };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: agentsPageQueryKeys.agents(selectedProjectId as string),
      });
      setShowDialog(false);
      toast({
        title: 'Success',
        description: 'Agent created successfully',
      });
    },
    onError: (error, _variables, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(
          agentsPageQueryKeys.agents(selectedProjectId as string),
          context.previousData,
        );
      }
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to create agent',
        variant: 'destructive',
      });
    },
  });

  // ---- Delete mutation ----
  const deleteMutation = useMutation({
    mutationFn: deleteAgent,
    onMutate: async (id) => {
      await queryClient.cancelQueries({
        queryKey: agentsPageQueryKeys.agents(selectedProjectId as string),
      });
      const previousData = queryClient.getQueryData(
        agentsPageQueryKeys.agents(selectedProjectId as string),
      );

      queryClient.setQueryData(
        agentsPageQueryKeys.agents(selectedProjectId as string),
        (old: AgentsQueryData | undefined) => ({
          ...old,
          items: old?.items.filter((a: Agent) => a.id !== id),
        }),
      );

      return { previousData };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: agentsPageQueryKeys.agents(selectedProjectId as string),
      });
      setDeleteConfirm(null);
      toast({
        title: 'Success',
        description: 'Agent deleted successfully',
      });
    },
    onError: (error, _variables, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(
          agentsPageQueryKeys.agents(selectedProjectId as string),
          context.previousData,
        );
      }
      setDeleteConfirm(null);
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to delete agent',
        variant: 'destructive',
      });
    },
  });

  // ---- Update mutation ----
  const updateMutation = useMutation({
    mutationFn: ({
      id,
      name,
      profileId,
      providerConfigId,
      modelOverride,
      description,
    }: {
      id: string;
      name: string;
      profileId: string;
      providerConfigId: string | null;
      modelOverride: string | null;
      description: string | null;
    }) => updateAgentRequest(id, { name, profileId, providerConfigId, modelOverride, description }),
    onMutate: async (variables) => {
      setUpdatingAgentId(variables.id);
      await queryClient.cancelQueries({
        queryKey: agentsPageQueryKeys.agents(selectedProjectId as string),
      });
      const previousData = queryClient.getQueryData(
        agentsPageQueryKeys.agents(selectedProjectId as string),
      );

      queryClient.setQueryData(
        agentsPageQueryKeys.agents(selectedProjectId as string),
        (old: AgentsQueryData | undefined) => {
          if (!old) return old;
          return {
            ...old,
            items: old.items.map((agent) =>
              agent.id === variables.id
                ? {
                    ...agent,
                    name: variables.name,
                    profileId: variables.profileId,
                    providerConfigId: variables.providerConfigId,
                    modelOverride: variables.modelOverride,
                    description: variables.description,
                    profile:
                      profilesById.get(variables.profileId) ||
                      profilesData?.items.find((p: AgentProfile) => p.id === variables.profileId) ||
                      agent.profile,
                    updatedAt: new Date().toISOString(),
                  }
                : agent,
            ),
          };
        },
      );

      return { previousData };
    },
    onSuccess: (updatedAgent) => {
      queryClient.setQueryData(
        agentsPageQueryKeys.agents(selectedProjectId as string),
        (old: AgentsQueryData | undefined) => {
          if (!old) return old;
          return {
            ...old,
            items: old.items.map((agent) => (agent.id === updatedAgent.id ? updatedAgent : agent)),
          };
        },
      );
      toast({
        title: 'Agent updated',
        description: 'Agent updated successfully.',
      });
      setEditAgent(null);
    },
    onError: (error, _variables, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(
          agentsPageQueryKeys.agents(selectedProjectId as string),
          context.previousData,
        );
      }
      toast({
        title: 'Update failed',
        description: error instanceof Error ? error.message : 'Failed to update agent',
        variant: 'destructive',
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: agentsPageQueryKeys.agents(selectedProjectId as string),
      });
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
      description: data.description,
    });
  };

  const handleEditSubmit = (data: AgentFormSubmitData) => {
    if (!editAgent) return;
    updateMutation.mutate({
      id: editAgent.id,
      name: data.name,
      profileId: data.profileId,
      providerConfigId: data.providerConfigId,
      modelOverride: data.modelOverride,
      description: data.description,
    });
  };

  // ---- Delete handlers ----
  const handleDelete = (agent: Agent) => {
    setDeleteConfirm(agent);
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
        profileId: editAgent.profileId,
        providerConfigId: editAgent.providerConfigId ?? '',
        modelOverride: editAgent.modelOverride ?? null,
        description: editAgent.description ?? '',
      }
    : undefined;

  const editInitialProfile = editAgent
    ? editAgent.profile || profilesById.get(editAgent.profileId)
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
              agentPresence={sessionControls.agentPresence}
              onAgentsRefresh={() =>
                queryClient.invalidateQueries({
                  queryKey: agentsPageQueryKeys.agents(selectedProjectId),
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

              {agentsData.items.map((agent: Agent) => {
                const profile = agent.profile || profilesById.get(agent.profileId);
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
                    presence={sessionControls.agentPresence[agent.id]}
                    isLastUsed={sessionControls.lastUsedAgentId === agent.id}
                    isLaunching={sessionControls.launchingAgentId === agent.id}
                    isUpdating={updatingAgentId === agent.id && updateMutation.isPending}
                    isDeleting={deleteMutation.isPending && deleteConfirm?.id === agent.id}
                    controlsDisabled={!selectedProjectId}
                    isTerminating={sessionControls.terminatingAgentId === agent.id}
                    isRestarting={sessionControls.restartingAgentId === agent.id}
                    onLaunch={sessionControls.handleLaunch}
                    onRestart={sessionControls.handleRestart}
                    onTerminate={sessionControls.handleTerminate}
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
      <Dialog open={!!deleteConfirm} onOpenChange={(open) => !open && setDeleteConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Agent</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete <strong>{deleteConfirm?.name}</strong>? This action
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

      {/* MCP Configuration Modal */}
      {sessionControls.pendingMcpLaunch && (
        <McpConfigurationModal
          open={sessionControls.mcpModalOpen}
          onOpenChange={(open) => {
            sessionControls.setMcpModalOpen(open);
            if (!open) {
              sessionControls.setPendingMcpLaunch(null);
            }
          }}
          providerId={sessionControls.pendingMcpLaunch.providerId}
          providerName={sessionControls.pendingMcpLaunch.providerName}
          projectPath={activeProject?.rootPath}
          onConfigured={sessionControls.handleMcpConfigured}
          onVerify={sessionControls.handleVerifyMcp}
        />
      )}

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
