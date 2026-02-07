import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/ui/components/ui/button';
import { Input } from '@/ui/components/ui/input';
import { Textarea } from '@/ui/components/ui/textarea';
import { Label } from '@/ui/components/ui/label';
import { Badge } from '@/ui/components/ui/badge';
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
import {
  Plus,
  Bot,
  AlertCircle,
  Loader2,
  Play,
  Pencil,
  RotateCcw,
  Power,
  Save,
} from 'lucide-react';
import { PresetSelector, PresetDialog, DeletePresetDialog } from '@/ui/components/agents';
import type { Preset } from '@/ui/lib/preset-validation';
import { McpConfigurationModal } from '@/ui/components/shared/McpConfigurationModal';
import { fetchPreflightChecks } from '@/ui/lib/preflight';
import { useTerminalWindowManager } from '@/ui/terminal-windows';
import { useAppSocket } from '@/ui/hooks/useAppSocket';
import type { WsEnvelope } from '@/ui/lib/socket';
import {
  TERMINAL_SESSIONS_QUERY_KEY,
  OPEN_TERMINAL_DOCK_EVENT,
} from '@/ui/components/terminal-dock';
import {
  fetchAgentPresence,
  terminateSession,
  launchSession,
  restartSession,
  SessionApiError,
  type ActiveSession,
  type AgentPresenceMap,
} from '@/ui/lib/sessions';
import { Avatar, AvatarFallback, AvatarImage } from '@/ui/components/ui/avatar';
import {
  TooltipProvider,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/ui/components/ui/tooltip';
import {
  getAgentAvatarAltText,
  getAgentAvatarDataUri,
  getAgentInitials,
} from '@/ui/lib/multiavatar';

function useDebouncedValue<T>(value: T, delay = 250): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timeoutId = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timeoutId);
  }, [value, delay]);

  return debouncedValue;
}

function useAvatarPreview(name: string | null | undefined) {
  const debouncedName = useDebouncedValue(name ?? '', 250);

  return useMemo(() => {
    const normalized = debouncedName?.trim() ?? '';
    const previewSrc = getAgentAvatarDataUri(normalized);
    const altText = getAgentAvatarAltText(normalized);
    const fallback = getAgentInitials(normalized);
    const displayName = normalized || 'Avatar preview';

    return {
      src: previewSrc,
      alt: altText,
      fallback,
      displayName,
    };
  }, [debouncedName]);
}

interface Agent {
  id: string;
  projectId: string;
  profileId: string;
  providerConfigId?: string | null;
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

async function fetchProviderConfigs(profileId: string): Promise<ProviderConfig[]> {
  const res = await fetch(`/api/profiles/${profileId}/provider-configs`);
  if (!res.ok) throw new Error('Failed to fetch provider configs');
  return res.json();
}

async function createAgent(data: {
  projectId: string;
  profileId: string;
  providerConfigId?: string | null;
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

// Launch handled via centralized helper in ui/lib/sessions

const LAST_AGENT_STORAGE_KEY = 'devchain:lastAgentByProject';

function readLastAgentId(projectId: string | null): string | null {
  if (!projectId || typeof window === 'undefined') {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(LAST_AGENT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed[projectId] === 'string') {
      return parsed[projectId] as string;
    }
  } catch {
    // ignore malformed payloads
  }
  return null;
}

function writeLastAgentId(projectId: string, agentId: string) {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    const raw = window.localStorage.getItem(LAST_AGENT_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('invalid storage payload');
    }
    parsed[projectId] = agentId;
    window.localStorage.setItem(LAST_AGENT_STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    window.localStorage.setItem(LAST_AGENT_STORAGE_KEY, JSON.stringify({ [projectId]: agentId }));
  }
}

export function AgentsPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { selectedProjectId, selectedProject: activeProject } = useSelectedProject();
  const terminalSessionsQueryKey = [
    ...TERMINAL_SESSIONS_QUERY_KEY,
    selectedProjectId ?? 'all',
  ] as const;
  const [showDialog, setShowDialog] = useState(false);
  const [presetDialogOpen, setPresetDialogOpen] = useState(false);
  const [presetToEdit, setPresetToEdit] = useState<Preset | null>(null);
  const [deletePresetDialogOpen, setDeletePresetDialogOpen] = useState(false);
  const [presetToDelete, setPresetToDelete] = useState<Preset | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<Agent | null>(null);
  const [formData, setFormData] = useState({
    name: '',
    profileId: '',
    providerConfigId: '',
    description: '',
  });
  const [editAgent, setEditAgent] = useState<Agent | null>(null);
  const [editFormData, setEditFormData] = useState({
    name: '',
    profileId: '',
    providerConfigId: '',
    description: '',
  });
  const [launchingAgentId, setLaunchingAgentId] = useState<string | null>(null);
  const [updatingAgentId, setUpdatingAgentId] = useState<string | null>(null);
  const [lastUsedAgentId, setLastUsedAgentId] = useState<string | null>(null);
  const openTerminalWindow = useTerminalWindowManager();
  const createPreview = useAvatarPreview(formData.name);
  const editPreview = useAvatarPreview(editFormData.name);

  // MCP configuration modal state
  const [mcpModalOpen, setMcpModalOpen] = useState(false);
  const [pendingLaunchAgent, setPendingLaunchAgent] = useState<{
    agentId: string;
    providerId: string;
    providerName: string;
    action: 'launch' | 'restart';
    sessionId?: string; // For restart action
  } | null>(null);

  const { data: profilesData } = useQuery({
    queryKey: ['profiles', selectedProjectId],
    queryFn: () => fetchProfiles(selectedProjectId as string),
    enabled: !!selectedProjectId,
  });
  const { data: providersData } = useQuery({ queryKey: ['providers'], queryFn: fetchProviders });
  const { data: agentsData, isLoading } = useQuery({
    queryKey: ['agents', selectedProjectId],
    queryFn: () => fetchAgents(selectedProjectId as string),
    enabled: !!selectedProjectId,
  });

  // Fetch existing presets for duplicate name validation
  const { data: presetsData } = useQuery<{ presets: { name: string }[] }>({
    queryKey: ['project-presets', selectedProjectId],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${selectedProjectId}/presets`);
      if (!res.ok) throw new Error('Failed to fetch presets');
      return res.json();
    },
    enabled: !!selectedProjectId,
  });
  const existingPresetNames = (presetsData?.presets ?? []).map((p) => p.name);

  // Preset management handlers
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

  const { refetch: refetchPreflight } = useQuery({
    queryKey: ['preflight', 'agents-page', activeProject?.rootPath ?? 'global'],
    queryFn: () => fetchPreflightChecks(activeProject?.rootPath),
    staleTime: 30000,
    refetchInterval: 60000,
  });

  // Fetch provider configs for create form's selected profile
  const { data: createFormConfigs } = useQuery({
    queryKey: ['provider-configs', formData.profileId],
    queryFn: () => fetchProviderConfigs(formData.profileId),
    enabled: !!formData.profileId,
  });

  // Fetch provider configs for edit form's selected profile
  const { data: editFormConfigs } = useQuery({
    queryKey: ['provider-configs', editFormData.profileId],
    queryFn: () => fetchProviderConfigs(editFormData.profileId),
    enabled: !!editFormData.profileId,
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

  const profilesById = useMemo(() => {
    const map = new Map<string, AgentProfile>();
    if (profilesData?.items) {
      profilesData.items.forEach((profile: AgentProfile) => {
        // Use profile.provider from enriched API response
        map.set(profile.id, {
          ...profile,
          provider: profile.provider,
        });
      });
    }
    return map;
  }, [profilesData]);

  // Check for duplicate agent names (case-insensitive)
  const isDuplicateCreateName = useMemo(() => {
    const trimmedName = formData.name.trim().toLowerCase();
    if (!trimmedName || !agentsData?.items) return false;
    return agentsData.items.some((agent: Agent) => agent.name.trim().toLowerCase() === trimmedName);
  }, [formData.name, agentsData?.items]);

  const isDuplicateEditName = useMemo(() => {
    const trimmedName = editFormData.name.trim().toLowerCase();
    if (!trimmedName || !agentsData?.items || !editAgent) return false;
    return agentsData.items.some(
      (agent: Agent) =>
        agent.name.trim().toLowerCase() === trimmedName && agent.id !== editAgent.id,
    );
  }, [editFormData.name, agentsData?.items, editAgent]);

  const createMutation = useMutation({
    mutationFn: createAgent,
    onMutate: async (newAgent) => {
      await queryClient.cancelQueries({ queryKey: ['agents', selectedProjectId] });
      const previousData = queryClient.getQueryData(['agents', selectedProjectId]);

      const profile =
        profilesById.get(newAgent.profileId) ||
        profilesData?.items.find((p: AgentProfile) => p.id === newAgent.profileId);

      queryClient.setQueryData(
        ['agents', selectedProjectId],
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
      queryClient.invalidateQueries({ queryKey: ['agents', selectedProjectId] });
      setShowDialog(false);
      setFormData({ name: '', profileId: '', providerConfigId: '', description: '' });
      toast({
        title: 'Success',
        description: 'Agent created successfully',
      });
    },
    onError: (error, variables, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(['agents', selectedProjectId], context.previousData);
      }
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to create agent',
        variant: 'destructive',
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteAgent,
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ['agents', selectedProjectId] });
      const previousData = queryClient.getQueryData(['agents', selectedProjectId]);

      queryClient.setQueryData(
        ['agents', selectedProjectId],
        (old: AgentsQueryData | undefined) => ({
          ...old,
          items: old?.items.filter((a: Agent) => a.id !== id),
        }),
      );

      return { previousData };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents', selectedProjectId] });
      setDeleteConfirm(null);
      toast({
        title: 'Success',
        description: 'Agent deleted successfully',
      });
    },
    onError: (error, variables, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(['agents', selectedProjectId], context.previousData);
      }
      setDeleteConfirm(null);
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to delete agent',
        variant: 'destructive',
      });
    },
  });

  useEffect(() => {
    setLastUsedAgentId(readLastAgentId(selectedProjectId ?? null));
  }, [selectedProjectId]);

  // Auto-select config when profile changes in create form
  useEffect(() => {
    // Skip while configs are loading
    if (createFormConfigs === undefined) {
      return;
    }

    if (createFormConfigs.length === 1) {
      // Auto-select if only one config
      setFormData((prev) => ({ ...prev, providerConfigId: createFormConfigs[0].id }));
    } else if (createFormConfigs.length === 0) {
      // Reset if no configs available (profile has no provider configs)
      setFormData((prev) => ({ ...prev, providerConfigId: '' }));
    } else if (formData.providerConfigId) {
      // Multiple configs - check if current selection is still valid
      const stillValid = createFormConfigs.some((c) => c.id === formData.providerConfigId);
      if (!stillValid) {
        setFormData((prev) => ({ ...prev, providerConfigId: '' }));
      }
    }
  }, [createFormConfigs, formData.profileId]);

  // Auto-select config when profile changes in edit form
  useEffect(() => {
    // Skip while configs are loading - don't reset the providerConfigId
    // that was correctly set by the editAgent effect
    if (editFormConfigs === undefined) {
      return;
    }

    if (editFormConfigs.length === 1) {
      // Auto-select if only one config
      setEditFormData((prev) => ({ ...prev, providerConfigId: editFormConfigs[0].id }));
    } else if (editFormConfigs.length === 0) {
      // Reset if no configs available (profile has no provider configs)
      setEditFormData((prev) => ({ ...prev, providerConfigId: '' }));
    } else if (editFormData.providerConfigId) {
      // Multiple configs - check if current selection is still valid
      const stillValid = editFormConfigs.some((c) => c.id === editFormData.providerConfigId);
      if (!stillValid) {
        setEditFormData((prev) => ({ ...prev, providerConfigId: '' }));
      }
    }
  }, [editFormConfigs, editFormData.profileId]);

  useEffect(() => {
    if (editAgent) {
      setEditFormData({
        name: editAgent.name,
        profileId: editAgent.profileId,
        providerConfigId: editAgent.providerConfigId ?? '',
        description: editAgent.description ?? '',
      });
    } else {
      setEditFormData({ name: '', profileId: '', providerConfigId: '', description: '' });
    }
  }, [editAgent]);

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
    createMutation.mutate({
      projectId: selectedProjectId,
      profileId: formData.profileId,
      providerConfigId: formData.providerConfigId || null,
      name: formData.name,
      description: formData.description.trim() || null,
    });
  };

  const handleDelete = (agent: Agent) => {
    setDeleteConfirm(agent);
  };

  const confirmDelete = () => {
    if (deleteConfirm) {
      deleteMutation.mutate(deleteConfirm.id);
    }
  };

  const handleEditSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editAgent) {
      return;
    }
    const trimmedName = editFormData.name.trim();
    if (!trimmedName) {
      toast({
        title: 'Name required',
        description: 'Please enter a name for the agent.',
        variant: 'destructive',
      });
      return;
    }
    updateMutation.mutate({
      id: editAgent.id,
      name: trimmedName,
      profileId: editFormData.profileId,
      providerConfigId: editFormData.providerConfigId || null,
      description: editFormData.description.trim() || null,
    });
  };

  const updateMutation = useMutation({
    mutationFn: ({
      id,
      name,
      profileId,
      providerConfigId,
      description,
    }: {
      id: string;
      name: string;
      profileId: string;
      providerConfigId: string | null;
      description: string | null;
    }) => updateAgentRequest(id, { name, profileId, providerConfigId, description }),
    onMutate: async (variables) => {
      setUpdatingAgentId(variables.id);
      await queryClient.cancelQueries({ queryKey: ['agents', selectedProjectId] });
      const previousData = queryClient.getQueryData(['agents', selectedProjectId]);

      queryClient.setQueryData(
        ['agents', selectedProjectId],
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
        ['agents', selectedProjectId],
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
        queryClient.setQueryData(['agents', selectedProjectId], context.previousData);
      }
      toast({
        title: 'Update failed',
        description: error instanceof Error ? error.message : 'Failed to update agent',
        variant: 'destructive',
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['agents', selectedProjectId] });
      setUpdatingAgentId(null);
    },
  });

  // Presence query to detect running sessions per agent
  const { data: agentPresence = {} as AgentPresenceMap, refetch: refetchPresence } = useQuery({
    queryKey: ['agent-presence', selectedProjectId],
    queryFn: () => fetchAgentPresence(selectedProjectId as string),
    enabled: !!selectedProjectId,
    // Keep presence fresh; socket invalidation will also force refetch
    refetchInterval: 2000,
  });

  // Realtime presence updates via socket envelopes
  useAppSocket(
    {
      message: (envelope: WsEnvelope) => {
        const { topic, type } = envelope;
        if (
          (topic.startsWith('agent/') && type === 'presence') ||
          (topic.startsWith('session/') && type === 'activity')
        ) {
          queryClient.invalidateQueries({ queryKey: ['agent-presence'] });
          if (selectedProjectId) {
            queryClient.invalidateQueries({ queryKey: ['agent-presence', selectedProjectId] });
          }
          // opportunistically refetch in-place for snappier UX
          if (selectedProjectId) void refetchPresence();
        }
      },
    },
    [queryClient, selectedProjectId, refetchPresence],
  );

  // Terminate session mutation
  const [terminatingAgentId, setTerminatingAgentId] = useState<string | null>(null);
  const terminateMutation = useMutation({
    mutationFn: (sessionId: string) => terminateSession(sessionId),
    onMutate: async () => {
      // no-op; handled via local state per agent
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['active-sessions', selectedProjectId] });
      queryClient.invalidateQueries({ queryKey: ['agent-presence', selectedProjectId] });
      toast({
        title: 'Session terminated',
        description: 'The agent session was terminated successfully.',
      });
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : 'Failed to terminate session';
      toast({ title: 'Terminate failed', description: message, variant: 'destructive' });
    },
    onSettled: () => {
      setTerminatingAgentId(null);
    },
  });

  // Restart state (separate from launching to keep UI clear)
  const [restartingAgentId, setRestartingAgentId] = useState<string | null>(null);

  const launchMutation = useMutation({
    mutationFn: ({ agentId, projectId }: { agentId: string; projectId: string }) =>
      launchSession(agentId, projectId),
    onMutate: ({ agentId }) => {
      setLaunchingAgentId(agentId);
    },
    onSuccess: (data, variables) => {
      const launchedSession: ActiveSession = {
        id: data.id,
        epicId: data.epicId ?? null,
        agentId: data.agentId ?? variables.agentId,
        tmuxSessionId: data.tmuxSessionId ?? null,
        status: data.status,
        startedAt: data.startedAt,
        endedAt: data.endedAt ?? null,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
      };
      toast({
        title: 'Session launched',
        description: `Session ${launchedSession.id.slice(0, 8)} created for ${variables.agentId}.`,
      });
      openTerminalWindow(launchedSession);
      queryClient.setQueryData(
        terminalSessionsQueryKey,
        (existing: ActiveSession[] | undefined) => {
          if (!existing || existing.length === 0) {
            return [launchedSession];
          }
          const already = existing.findIndex((session) => session.id === launchedSession.id);
          if (already >= 0) {
            const copy = existing.slice();
            copy[already] = launchedSession;
            return copy;
          }
          return [launchedSession, ...existing];
        },
      );
      queryClient.invalidateQueries({ queryKey: terminalSessionsQueryKey });
      if (selectedProjectId) {
        writeLastAgentId(selectedProjectId, variables.agentId);
        setLastUsedAgentId(variables.agentId);
      }
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(OPEN_TERMINAL_DOCK_EVENT));
      }
    },
    onError: (error: unknown, variables) => {
      if (error instanceof SessionApiError && error.hasCode('CLAUDE_AUTO_COMPACT_ENABLED')) {
        toast({
          title: 'Session launch blocked',
          description: 'Claude auto-compact is enabled - see the notification to resolve.',
        });
        return;
      }

      // Check if this is an MCP_NOT_CONFIGURED error from the backend
      if (error instanceof SessionApiError && error.hasCode('MCP_NOT_CONFIGURED')) {
        const details = error.payload?.details;
        // Show MCP configuration modal with provider info from error
        setPendingLaunchAgent({
          agentId: variables.agentId,
          providerId: details?.providerId ?? '',
          providerName: details?.providerName ?? 'Unknown',
          action: 'launch',
        });
        setMcpModalOpen(true);
        // Invalidate preflight cache so user sees updated status
        queryClient.invalidateQueries({ queryKey: ['preflight'] });
        return;
      }

      // Generic error handling
      const message =
        error instanceof Error ? error.message : 'Unable to launch session for the agent.';
      toast({
        title: 'Launch failed',
        description: message,
        variant: 'destructive',
      });
    },
    onSettled: () => {
      setLaunchingAgentId(null);
    },
  });

  /**
   * Launch a session for an agent. Backend handles MCP auto-configuration.
   * If MCP auto-config fails, an MCP_NOT_CONFIGURED error triggers the modal.
   */
  const handleLaunchClick = (agent: Agent) => {
    if (!selectedProjectId) return;
    launchMutation.mutate({ agentId: agent.id, projectId: selectedProjectId });
  };

  /**
   * Restart a session for an agent. Backend handles MCP auto-configuration.
   * If MCP auto-config fails, an MCP_NOT_CONFIGURED error triggers the modal.
   */
  const handleRestartClick = async (agent: Agent, sessionId: string) => {
    if (!selectedProjectId) return;
    await performRestart(agent.id, sessionId);
  };

  /**
   * Perform the actual restart operation (extracted for reuse).
   */
  const performRestart = async (agentId: string, sessionId: string) => {
    setRestartingAgentId(agentId);
    try {
      const result = await restartSession(agentId, selectedProjectId as string, sessionId);
      const newSession = result.session;
      // Open terminal window and update cache similar to launch flow
      openTerminalWindow(newSession);
      queryClient.setQueryData(
        terminalSessionsQueryKey,
        (existing: ActiveSession[] | undefined) => {
          if (!existing || existing.length === 0) {
            return [newSession];
          }
          const idx = existing.findIndex((s) => s.id === newSession.id);
          if (idx >= 0) {
            const copy = existing.slice();
            copy[idx] = newSession;
            return copy;
          }
          return [newSession, ...existing];
        },
      );
      queryClient.invalidateQueries({ queryKey: terminalSessionsQueryKey });
      queryClient.invalidateQueries({ queryKey: ['agent-presence', selectedProjectId] });
      if (selectedProjectId) {
        writeLastAgentId(selectedProjectId, agentId);
        setLastUsedAgentId(agentId);
      }
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(OPEN_TERMINAL_DOCK_EVENT));
      }
      // Show warning or success toast
      if (result.terminateWarning) {
        toast({
          title: 'Session restarted with warning',
          description: result.terminateWarning,
          variant: 'destructive',
        });
      } else {
        toast({
          title: 'Session restarted',
          description: `Session ${newSession.id.slice(0, 8)} started successfully.`,
        });
      }
    } catch (e) {
      if (e instanceof SessionApiError && e.hasCode('CLAUDE_AUTO_COMPACT_ENABLED')) {
        toast({
          title: 'Session launch blocked',
          description: 'Claude auto-compact is enabled - see the notification to resolve.',
        });
        return;
      }

      // Check if this is an MCP_NOT_CONFIGURED error from the backend
      if (e instanceof SessionApiError && e.hasCode('MCP_NOT_CONFIGURED')) {
        const details = e.payload?.details;
        // Show MCP configuration modal with provider info from error
        setPendingLaunchAgent({
          agentId,
          providerId: details?.providerId ?? '',
          providerName: details?.providerName ?? 'Unknown',
          action: 'restart',
          sessionId,
        });
        setMcpModalOpen(true);
        // Invalidate preflight cache so user sees updated status
        queryClient.invalidateQueries({ queryKey: ['preflight'] });
        return;
      }

      // Generic error handling
      const msg = e instanceof Error ? e.message : 'Failed to restart session';
      toast({
        title: 'Restart failed',
        description: msg,
        variant: 'destructive',
      });
    } finally {
      setRestartingAgentId(null);
    }
  };

  /**
   * Called when MCP is successfully configured via the modal.
   * Refetch preflight and proceed with launch or restart.
   */
  const handleMcpConfigured = async () => {
    // Invalidate ALL preflight queries so Layout badge updates too
    queryClient.invalidateQueries({ queryKey: ['preflight'] });
    // Refetch this page's preflight to update MCP status
    await refetchPreflight();

    // Proceed with launch or restart if we have a pending agent
    if (pendingLaunchAgent && selectedProjectId) {
      if (pendingLaunchAgent.action === 'restart' && pendingLaunchAgent.sessionId) {
        performRestart(pendingLaunchAgent.agentId, pendingLaunchAgent.sessionId);
      } else {
        launchMutation.mutate({
          agentId: pendingLaunchAgent.agentId,
          projectId: selectedProjectId,
        });
      }
    }

    // Clean up modal state
    setPendingLaunchAgent(null);
  };

  /**
   * Verify MCP configuration by checking preflight.
   */
  const handleVerifyMcp = async (): Promise<boolean> => {
    // Invalidate ALL preflight queries so Layout badge updates too
    queryClient.invalidateQueries({ queryKey: ['preflight'] });
    const result = await refetchPreflight();
    if (!pendingLaunchAgent || !result.data) return false;

    const providerCheck = result.data.providers.find((p) => p.id === pendingLaunchAgent.providerId);
    return providerCheck?.mcpStatus === 'pass';
  };

  const availableProfiles = useMemo(() => {
    if (profilesById.size > 0) {
      return Array.from(profilesById.values());
    }
    return profilesData?.items || [];
  }, [profilesById, profilesData]);

  const selectedEditProfile = editAgent
    ? editAgent.profile || profilesById.get(editAgent.profileId)
    : undefined;
  const hasSelectedProfileOption = editFormData.profileId
    ? availableProfiles.some((profile: AgentProfile) => profile.id === editFormData.profileId)
    : false;

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
                queryClient.invalidateQueries({ queryKey: ['agents', selectedProjectId] })
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
                // Use agent.providerConfig first, then fallback to profile.provider
                const providerName =
                  (agent.providerConfig
                    ? providersById.get(agent.providerConfig.providerId)?.name
                    : null) || profile?.provider?.name;
                const isLaunching = launchingAgentId === agent.id && launchMutation.isPending;
                const isLastUsed = lastUsedAgentId === agent.id;
                const isUpdating = updatingAgentId === agent.id && updateMutation.isPending;
                const avatarSrc = getAgentAvatarDataUri(agent.name);
                const avatarAlt = getAgentAvatarAltText(agent.name);
                const avatarFallback = getAgentInitials(agent.name);

                return (
                  <div
                    key={agent.id}
                    className="border rounded-lg p-4 bg-card"
                    data-testid={`agent-card-${agent.id}`}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex flex-1 items-start gap-3">
                        <Avatar
                          className="h-12 w-12 border border-border"
                          aria-label={avatarAlt}
                          title={avatarAlt}
                        >
                          {avatarSrc ? <AvatarImage src={avatarSrc} alt={avatarAlt} /> : null}
                          <AvatarFallback className="uppercase tracking-wide">
                            {avatarFallback}
                          </AvatarFallback>
                        </Avatar>
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-2">
                            <h3 className="text-lg font-semibold">
                              {agent.name || 'Unnamed agent'}
                            </h3>
                            {isLastUsed && (
                              <Badge variant="secondary" className="uppercase">
                                Last launched
                              </Badge>
                            )}
                          </div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm text-muted-foreground">Profile:</span>
                            <span className="text-sm font-medium">
                              {profile?.name || 'Unknown Profile'}
                            </span>
                            {providerName && (
                              <Badge variant="secondary">{providerName.toUpperCase()}</Badge>
                            )}
                            {agent.providerConfig && (
                              <Badge
                                variant="outline"
                                title={[
                                  agent.providerConfig.name,
                                  providersById.get(agent.providerConfig.providerId)?.name !==
                                  agent.providerConfig.name
                                    ? `(${providersById.get(agent.providerConfig.providerId)?.name})`
                                    : null,
                                  agent.providerConfig.options,
                                ]
                                  .filter(Boolean)
                                  .join(' ')}
                              >
                                {agent.providerConfig.name}
                                {agent.providerConfig.env &&
                                  Object.keys(agent.providerConfig.env).length > 0 &&
                                  ' [env]'}
                              </Badge>
                            )}
                            {profile?.promptCount !== undefined && (
                              <Badge variant="outline">
                                {profile.promptCount} prompt
                                {profile.promptCount !== 1 ? 's' : ''}
                              </Badge>
                            )}
                          </div>
                          {agent.description && (
                            <p className="text-sm text-muted-foreground mt-2 line-clamp-2">
                              {agent.description}
                            </p>
                          )}
                          <p className="text-xs text-muted-foreground mt-2">
                            Created {new Date(agent.createdAt).toLocaleDateString()}
                          </p>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        {(() => {
                          const presence = agentPresence[agent.id];
                          const sessionId = presence?.sessionId ?? null;
                          const hasSession = Boolean(presence?.online && sessionId);
                          const isTerminating = terminatingAgentId === agent.id;
                          const isRestarting = restartingAgentId === agent.id;
                          const anyBusy = isLaunching || isTerminating || isRestarting;

                          if (hasSession && sessionId) {
                            return (
                              <>
                                <TooltipProvider>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Button
                                        size="sm"
                                        variant="default"
                                        aria-label="Restart session"
                                        title="Terminate the current session and start a new one"
                                        disabled={!selectedProjectId || anyBusy}
                                        onClick={() => handleRestartClick(agent, sessionId)}
                                      >
                                        {anyBusy ? (
                                          <>
                                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                            Restarting…
                                          </>
                                        ) : (
                                          <>
                                            <RotateCcw className="mr-2 h-4 w-4" />
                                            Restart
                                          </>
                                        )}
                                      </Button>
                                    </TooltipTrigger>
                                    <TooltipContent>Restart session</TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>

                                <TooltipProvider>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Button
                                        size="sm"
                                        variant="destructive"
                                        aria-label="Terminate session"
                                        title="Terminate the current session"
                                        disabled={
                                          !selectedProjectId || isTerminating || isRestarting
                                        }
                                        onClick={() => {
                                          setTerminatingAgentId(agent.id);
                                          terminateMutation.mutate(sessionId);
                                        }}
                                      >
                                        {isTerminating ? (
                                          <>
                                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                            Terminating…
                                          </>
                                        ) : (
                                          <>
                                            <Power className="mr-2 h-4 w-4" />
                                            Terminate
                                          </>
                                        )}
                                      </Button>
                                    </TooltipTrigger>
                                    <TooltipContent>Terminate session</TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>
                              </>
                            );
                          }

                          return (
                            <Button
                              size="sm"
                              onClick={() => handleLaunchClick(agent)}
                              disabled={!selectedProjectId || isLaunching}
                              aria-label="Launch session"
                              title="Launch a new session for this agent"
                            >
                              {isLaunching ? (
                                <>
                                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                  Launching…
                                </>
                              ) : (
                                <>
                                  <Play className="mr-2 h-4 w-4" />
                                  Launch Session
                                </>
                              )}
                            </Button>
                          );
                        })()}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setEditAgent(agent)}
                          disabled={isUpdating}
                        >
                          <Pencil className="mr-2 h-4 w-4" />
                          Edit
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => handleDelete(agent)}
                          disabled={deleteMutation.isPending && deleteConfirm?.id === agent.id}
                        >
                          Delete
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* Create Agent Dialog */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Agent</DialogTitle>
            <DialogDescription>
              Create a new agent for {activeProject?.name ?? 'this project'}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label htmlFor="agent-name">Name *</Label>
              <Input
                id="agent-name"
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                required
                placeholder="Enter agent name"
                aria-invalid={isDuplicateCreateName}
              />
              {isDuplicateCreateName && (
                <p className="text-sm text-destructive mt-1">
                  An agent with this name already exists in this project.
                </p>
              )}
            </div>
            <div className="flex items-center gap-3 rounded-md border border-dashed border-muted p-3">
              <Avatar
                data-testid="agent-preview-create-avatar"
                className="h-12 w-12 border border-border"
                aria-label={createPreview.alt}
                title={createPreview.alt}
              >
                {createPreview.src ? (
                  <AvatarImage
                    src={createPreview.src}
                    alt={createPreview.alt}
                    data-testid="agent-preview-create-image"
                  />
                ) : null}
                <AvatarFallback className="uppercase tracking-wide">
                  {createPreview.fallback}
                </AvatarFallback>
              </Avatar>
              <div className="space-y-1">
                <p className="text-sm font-medium" data-testid="agent-preview-create-label">
                  {createPreview.displayName}
                </p>
                <p className="text-xs text-muted-foreground">
                  Deterministic avatar updates after a short pause.
                </p>
              </div>
            </div>

            <div>
              <Label htmlFor="agent-profile">Profile *</Label>
              <select
                id="agent-profile"
                value={formData.profileId}
                onChange={(e) =>
                  setFormData({ ...formData, profileId: e.target.value, providerConfigId: '' })
                }
                required
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">-- Select a profile --</option>
                {availableProfiles.map((profile: AgentProfile) => {
                  // Use profile.provider.name from enriched response
                  const providerName = profile.provider?.name || '';

                  return (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                      {providerName ? ` (${providerName.toUpperCase()})` : ''}
                    </option>
                  );
                })}
              </select>
              {availableProfiles.length === 0 && (
                <p className="text-sm text-muted-foreground mt-1">
                  No profiles available. Create a profile first.
                </p>
              )}
            </div>

            {/* Provider Config Selector - shows when profile is selected */}
            {formData.profileId && (
              <div>
                <Label htmlFor="agent-config">
                  Provider Configuration{' '}
                  {createFormConfigs && createFormConfigs.length > 0 ? '*' : ''}
                </Label>
                <select
                  id="agent-config"
                  value={formData.providerConfigId}
                  onChange={(e) => setFormData({ ...formData, providerConfigId: e.target.value })}
                  required={createFormConfigs && createFormConfigs.length > 0}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">-- Select a configuration --</option>
                  {createFormConfigs?.map((config) => {
                    const provider = providersById.get(config.providerId);
                    const hasEnv = config.env && Object.keys(config.env).length > 0;
                    // Show provider name in parentheses if different from config name
                    const providerSuffix =
                      provider?.name && provider.name !== config.name ? ` (${provider.name})` : '';
                    return (
                      <option key={config.id} value={config.id}>
                        {config.name}
                        {providerSuffix}
                        {hasEnv ? ' [env]' : ''}
                      </option>
                    );
                  })}
                </select>
                {createFormConfigs && createFormConfigs.length === 0 && (
                  <div className="mt-2 flex items-start gap-2 p-3 rounded-md bg-destructive/10 border border-destructive/20">
                    <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                    <div className="text-sm">
                      <p className="font-medium text-destructive">No provider configurations</p>
                      <p className="text-muted-foreground">
                        This profile has no provider configurations. Go to{' '}
                        <span className="font-medium">Profiles → Edit</span> to add one before
                        creating an agent.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div>
              <Label htmlFor="agent-description">Description (optional)</Label>
              <Textarea
                id="agent-description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="Enter agent description"
                rows={3}
              />
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setShowDialog(false);
                  setFormData({ name: '', profileId: '', providerConfigId: '', description: '' });
                }}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  createMutation.isPending ||
                  isDuplicateCreateName ||
                  (formData.profileId && createFormConfigs && createFormConfigs.length === 0)
                }
              >
                Create
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit Agent Dialog */}
      <Dialog
        open={!!editAgent}
        onOpenChange={(open) => {
          if (!open) {
            setEditAgent(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Agent</DialogTitle>
            <DialogDescription>
              Update the agent details for {activeProject?.name ?? 'this project'}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleEditSubmit} className="space-y-4">
            <div>
              <Label htmlFor="edit-agent-name">Name *</Label>
              <Input
                id="edit-agent-name"
                type="text"
                value={editFormData.name}
                onChange={(e) => setEditFormData({ ...editFormData, name: e.target.value })}
                required
                placeholder="Enter agent name"
                aria-invalid={isDuplicateEditName}
              />
              {isDuplicateEditName && (
                <p className="text-sm text-destructive mt-1">
                  An agent with this name already exists in this project.
                </p>
              )}
            </div>
            <div className="flex items-center gap-3 rounded-md border border-dashed border-muted p-3">
              <Avatar
                data-testid="agent-preview-edit-avatar"
                className="h-12 w-12 border border-border"
                aria-label={editPreview.alt}
                title={editPreview.alt}
              >
                {editPreview.src ? (
                  <AvatarImage
                    src={editPreview.src}
                    alt={editPreview.alt}
                    data-testid="agent-preview-edit-image"
                  />
                ) : null}
                <AvatarFallback className="uppercase tracking-wide">
                  {editPreview.fallback}
                </AvatarFallback>
              </Avatar>
              <div className="space-y-1">
                <p className="text-sm font-medium" data-testid="agent-preview-edit-label">
                  {editPreview.displayName}
                </p>
                <p className="text-xs text-muted-foreground">
                  Preview updates after you pause typing.
                </p>
              </div>
            </div>
            <div>
              <Label htmlFor="edit-agent-profile">Profile *</Label>
              <select
                id="edit-agent-profile"
                value={editFormData.profileId}
                onChange={(e) =>
                  setEditFormData({
                    ...editFormData,
                    profileId: e.target.value,
                    providerConfigId: '',
                  })
                }
                required
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">-- Select a profile --</option>
                {!hasSelectedProfileOption && editFormData.profileId && selectedEditProfile && (
                  <option value={editFormData.profileId}>
                    {selectedEditProfile.name}
                    {selectedEditProfile.provider?.name
                      ? ` (${selectedEditProfile.provider.name.toUpperCase()})`
                      : ''}
                  </option>
                )}
                {availableProfiles.map((profile: AgentProfile) => {
                  // Use profile.provider.name from enriched response
                  const providerName = profile.provider?.name || '';

                  return (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                      {providerName ? ` (${providerName.toUpperCase()})` : ''}
                    </option>
                  );
                })}
              </select>
              {availableProfiles.length === 0 && (
                <p className="text-sm text-muted-foreground mt-1">
                  No profiles available. Create a profile first.
                </p>
              )}
            </div>

            {/* Provider Config Selector - shows when profile is selected */}
            {editFormData.profileId && (
              <div>
                <Label htmlFor="edit-agent-config">
                  Provider Configuration {editFormConfigs && editFormConfigs.length > 0 ? '*' : ''}
                </Label>
                <select
                  id="edit-agent-config"
                  value={editFormData.providerConfigId}
                  onChange={(e) =>
                    setEditFormData({ ...editFormData, providerConfigId: e.target.value })
                  }
                  required={editFormConfigs && editFormConfigs.length > 0}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">-- Select a configuration --</option>
                  {editFormConfigs?.map((config) => {
                    const provider = providersById.get(config.providerId);
                    const hasEnv = config.env && Object.keys(config.env).length > 0;
                    // Show provider name in parentheses if different from config name
                    const providerSuffix =
                      provider?.name && provider.name !== config.name ? ` (${provider.name})` : '';
                    return (
                      <option key={config.id} value={config.id}>
                        {config.name}
                        {providerSuffix}
                        {hasEnv ? ' [env]' : ''}
                      </option>
                    );
                  })}
                </select>
                {editFormConfigs && editFormConfigs.length === 0 && (
                  <div className="mt-2 flex items-start gap-2 p-3 rounded-md bg-destructive/10 border border-destructive/20">
                    <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                    <div className="text-sm">
                      <p className="font-medium text-destructive">No provider configurations</p>
                      <p className="text-muted-foreground">
                        This profile has no provider configurations. Go to{' '}
                        <span className="font-medium">Profiles → Edit</span> to add one.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div>
              <Label htmlFor="edit-agent-description">Description (optional)</Label>
              <Textarea
                id="edit-agent-description"
                value={editFormData.description}
                onChange={(e) => setEditFormData({ ...editFormData, description: e.target.value })}
                placeholder="Enter agent description"
                rows={3}
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setEditAgent(null)}
                disabled={updateMutation.isPending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  updateMutation.isPending ||
                  !editAgent ||
                  isDuplicateEditName ||
                  (editFormData.profileId && editFormConfigs && editFormConfigs.length === 0)
                }
              >
                {updateMutation.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Saving…
                  </>
                ) : (
                  'Save changes'
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

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
      {pendingLaunchAgent && (
        <McpConfigurationModal
          open={mcpModalOpen}
          onOpenChange={(open) => {
            setMcpModalOpen(open);
            if (!open) {
              setPendingLaunchAgent(null);
            }
          }}
          providerId={pendingLaunchAgent.providerId}
          providerName={pendingLaunchAgent.providerName}
          projectPath={activeProject?.rootPath}
          onConfigured={handleMcpConfigured}
          onVerify={handleVerifyMcp}
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
