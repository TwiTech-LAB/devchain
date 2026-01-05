import { useState, useMemo, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/ui/components/ui/dialog';
import { Button } from '@/ui/components/ui/button';
import { Badge } from '@/ui/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/ui/components/ui/table';
import { useToast } from '@/ui/hooks/use-toast';
import { Loader2, AlertTriangle, Settings } from 'lucide-react';
import { fetchAgentPresence, type AgentPresenceMap } from '@/ui/lib/sessions';

interface Agent {
  id: string;
  projectId: string;
  profileId: string;
  name: string;
  description?: string | null;
  profile?: AgentProfile;
}

interface AgentProfile {
  id: string;
  name: string;
  providerId: string;
  familySlug?: string | null;
  provider?: {
    id: string;
    name: string;
  };
}

interface Provider {
  id: string;
  name: string;
}

interface ProjectConfigurationModalProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

async function fetchAgents(projectId: string) {
  const res = await fetch(`/api/agents?projectId=${projectId}`);
  if (!res.ok) throw new Error('Failed to fetch agents');
  return res.json();
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

async function updateAgent(id: string, data: { profileId: string }) {
  const res = await fetch(`/api/agents/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('Failed to update agent');
  return res.json();
}

export function ProjectConfigurationModal({
  projectId,
  open,
  onOpenChange,
}: ProjectConfigurationModalProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [changes, setChanges] = useState<Record<string, string>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [presence, setPresence] = useState<AgentPresenceMap>({});

  // Fetch agents
  const { data: agentsData, isLoading: agentsLoading } = useQuery({
    queryKey: ['agents', projectId],
    queryFn: () => fetchAgents(projectId),
    enabled: open && !!projectId,
  });

  // Fetch profiles
  const { data: profilesData, isLoading: profilesLoading } = useQuery({
    queryKey: ['profiles', projectId],
    queryFn: () => fetchProfiles(projectId),
    enabled: open && !!projectId,
  });

  // Fetch providers
  const { data: providersData, isLoading: providersLoading } = useQuery({
    queryKey: ['providers'],
    queryFn: fetchProviders,
    enabled: open,
  });

  // Fetch presence when modal opens
  useEffect(() => {
    if (open && projectId) {
      fetchAgentPresence(projectId).then(setPresence).catch(console.error);
    }
  }, [open, projectId]);

  // Reset changes when modal closes
  useEffect(() => {
    if (!open) {
      setChanges({});
    }
  }, [open]);

  // Build profiles grouped by familySlug
  const profilesByFamily = useMemo(() => {
    const profiles: AgentProfile[] = profilesData?.items || [];
    const map = new Map<string, AgentProfile[]>();

    profiles.forEach((profile) => {
      if (profile.familySlug) {
        const existing = map.get(profile.familySlug) || [];
        existing.push(profile);
        map.set(profile.familySlug, existing);
      }
    });

    return map;
  }, [profilesData]);

  // Build providers map
  const providersById = useMemo(() => {
    const providers: Provider[] = providersData?.items || [];
    return new Map(providers.map((p) => [p.id, p]));
  }, [providersData]);

  // Build profiles map
  const profilesById = useMemo(() => {
    const profiles: AgentProfile[] = profilesData?.items || [];
    return new Map(profiles.map((p) => [p.id, p]));
  }, [profilesData]);

  // Get available providers for an agent's profile family
  const getAvailableProfiles = (agent: Agent): AgentProfile[] => {
    const currentProfileId = changes[agent.id] || agent.profileId;
    const currentProfile = profilesById.get(currentProfileId);

    if (!currentProfile?.familySlug) {
      return [];
    }

    return profilesByFamily.get(currentProfile.familySlug) || [];
  };

  // Check if agent has active session
  const hasActiveSession = (agentId: string): boolean => {
    return !!presence[agentId];
  };

  // Get current profile for an agent (considering pending changes)
  const getCurrentProfile = (agent: Agent): AgentProfile | undefined => {
    const profileId = changes[agent.id] || agent.profileId;
    return profilesById.get(profileId);
  };

  // Handle provider change for an agent
  const handleProfileChange = (agentId: string, newProfileId: string) => {
    const agent = (agentsData?.items || []).find((a: Agent) => a.id === agentId);
    if (!agent) return;

    if (newProfileId === agent.profileId) {
      // Remove from changes if reverting to original
      const newChanges = { ...changes };
      delete newChanges[agentId];
      setChanges(newChanges);
    } else {
      setChanges({ ...changes, [agentId]: newProfileId });
    }
  };

  // Save all changes
  const handleSave = async () => {
    const changeEntries = Object.entries(changes);
    if (changeEntries.length === 0) {
      onOpenChange(false);
      return;
    }

    // Check for active sessions
    const agentsWithActiveSessions = changeEntries.filter(([agentId]) => hasActiveSession(agentId));

    if (agentsWithActiveSessions.length > 0) {
      const confirmed = window.confirm(
        `${agentsWithActiveSessions.length} agent(s) have active sessions. ` +
          'Changing their provider configuration may affect running sessions. Continue?',
      );
      if (!confirmed) return;
    }

    setIsSaving(true);
    try {
      await Promise.all(
        changeEntries.map(([agentId, profileId]) => updateAgent(agentId, { profileId })),
      );

      toast({
        title: 'Configuration saved',
        description: `Updated ${changeEntries.length} agent(s)`,
      });

      queryClient.invalidateQueries({ queryKey: ['agents', projectId] });
      setChanges({});
      onOpenChange(false);
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to save changes',
        variant: 'destructive',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const isLoading = agentsLoading || profilesLoading || providersLoading;
  const agents: Agent[] = agentsData?.items || [];
  const hasChanges = Object.keys(changes).length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5" />
            Project Configuration
          </DialogTitle>
          <DialogDescription>
            Configure agent providers. Agents with the same family slug can be switched between
            different providers.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : agents.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            No agents found in this project.
          </div>
        ) : (
          <div className="max-h-[60vh] overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Agent</TableHead>
                  <TableHead>Family</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead className="w-[50px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {agents.map((agent) => {
                  const currentProfile = getCurrentProfile(agent);
                  const availableProfiles = getAvailableProfiles(agent);
                  const hasFamily = !!currentProfile?.familySlug;
                  const canSwitch = hasFamily && availableProfiles.length > 1;
                  const isChanged = !!changes[agent.id];
                  const isActive = hasActiveSession(agent.id);

                  return (
                    <TableRow key={agent.id} className={isChanged ? 'bg-muted/50' : ''}>
                      <TableCell>
                        <div className="font-medium">{agent.name}</div>
                        {agent.description && (
                          <div className="text-sm text-muted-foreground truncate max-w-[200px]">
                            {agent.description}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        {currentProfile?.familySlug ? (
                          <Badge variant="outline">{currentProfile.familySlug}</Badge>
                        ) : (
                          <span className="text-muted-foreground text-sm">No family</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {canSwitch ? (
                          <Select
                            value={changes[agent.id] || agent.profileId}
                            onValueChange={(value) => handleProfileChange(agent.id, value)}
                          >
                            <SelectTrigger className="w-[180px]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {availableProfiles.map((profile) => {
                                const provider = providersById.get(profile.providerId);
                                return (
                                  <SelectItem key={profile.id} value={profile.id}>
                                    {provider?.name || 'Unknown'}
                                  </SelectItem>
                                );
                              })}
                            </SelectContent>
                          </Select>
                        ) : (
                          <span className="text-sm">
                            {currentProfile?.provider?.name ||
                              providersById.get(currentProfile?.providerId || '')?.name ||
                              'Unknown'}
                            {!hasFamily && (
                              <span className="text-muted-foreground ml-1">(no family)</span>
                            )}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        {isActive && (
                          <Badge variant="secondary" className="gap-1">
                            <AlertTriangle className="h-3 w-3" />
                            Active
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSaving || !hasChanges}>
            {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Save Changes
            {hasChanges && ` (${Object.keys(changes).length})`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
