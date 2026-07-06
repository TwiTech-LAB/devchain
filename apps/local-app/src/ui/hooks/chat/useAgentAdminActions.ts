import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getErrorMessage, useToastHelpers } from '@/ui/lib/toast-helpers';
import { chatQueryKeys, type AgentOrGuest } from '@/ui/hooks/useChatQueries';
import { teamsQueryKeys } from '@/ui/lib/teams';
import { terminateSession } from '@/ui/lib/sessions';
import type { ActiveSession } from '@/ui/lib/sessions';
import type { QuickAddPayload } from '@/ui/components/chat/TeamQuickAddButton';

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface CloneAgentRequest {
  agent: AgentOrGuest;
  teamId?: string;
  teamName?: string;
  isTeamLead?: boolean;
}

export interface UseAgentAdminActionsOptions {
  apiFetch: FetchFn;
  projectId: string | null;
  agents: AgentOrGuest[];
  activeSessions: ActiveSession[];
}

export interface UseAgentAdminActionsResult {
  // Clone
  pendingCloneAgent: CloneAgentRequest | null;
  setPendingCloneAgent: (payload: CloneAgentRequest | null) => void;
  pendingCloneName: string;
  cloneTargetTeam: { teamId: string; teamName: string } | null;
  handleConfirmClone: () => void;
  cloningAgent: boolean;
  // Delete
  pendingDeleteAgent: AgentOrGuest | null;
  setPendingDeleteAgent: (agent: AgentOrGuest | null) => void;
  pendingDeleteAgentId: string | null;
  pendingDeleteHasSession: boolean;
  handleConfirmDelete: () => void;
  deletingAgent: boolean;
  // Quick-add
  handleAddTeamAgent: (payload: QuickAddPayload) => void;
}

/**
 * Agent admin mutations (clone / delete / team quick-add), extracted from ChatPage.
 * Owns the two confirmation-dialog targets and their pending state; ChatPage renders
 * the dialogs from this state. Toast copy, the shared invalidation fan-out
 * (agents + presence + active-sessions + teams list + `['teams','detail']`), the 409
 * delete-conflict message, and the terminate-then-delete ordering are preserved
 * verbatim.
 */
export function useAgentAdminActions({
  apiFetch,
  projectId,
  agents,
  activeSessions,
}: UseAgentAdminActionsOptions): UseAgentAdminActionsResult {
  const queryClient = useQueryClient();
  const { toast, showError } = useToastHelpers();

  const invalidateAgentAndTeamCaches = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: chatQueryKeys.agents(projectId) });
    queryClient.invalidateQueries({ queryKey: chatQueryKeys.agentPresence(projectId) });
    queryClient.invalidateQueries({ queryKey: chatQueryKeys.activeSessions(projectId) });
    if (projectId) {
      queryClient.invalidateQueries({ queryKey: teamsQueryKeys.teams(projectId) });
    }
    queryClient.invalidateQueries({ queryKey: ['teams', 'detail'] });
  }, [queryClient, projectId]);

  // ── Clone agent ──
  const [pendingCloneAgent, setPendingCloneAgent] = useState<CloneAgentRequest | null>(null);

  const computeCloneName = useCallback(
    (baseName: string): string => {
      const existingNames = new Set(agents.map((a) => a.name.toLowerCase()));
      for (let n = 1; ; n++) {
        const candidate = `${baseName} (${n})`;
        if (!existingNames.has(candidate.toLowerCase())) return candidate;
      }
    },
    [agents],
  );

  const pendingCloneName = pendingCloneAgent ? computeCloneName(pendingCloneAgent.agent.name) : '';
  const cloneTargetTeam =
    pendingCloneAgent?.teamId && !pendingCloneAgent?.isTeamLead
      ? { teamId: pendingCloneAgent.teamId, teamName: pendingCloneAgent.teamName ?? '' }
      : null;

  const cloneAgentMutation = useMutation({
    mutationFn: async (payload: {
      projectId: string;
      profileId: string;
      name: string;
      description?: string | null;
      providerConfigId: string;
      modelOverride?: string | null;
      targetTeamId?: string | null;
    }) => {
      const res = await apiFetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: payload.projectId,
          profileId: payload.profileId,
          name: payload.name,
          description: payload.description,
          providerConfigId: payload.providerConfigId,
          modelOverride: payload.modelOverride,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? 'Failed to clone agent');
      }
      const created = await res.json();

      if (payload.targetTeamId) {
        try {
          const teamDetailRes = await apiFetch(`/api/teams/${payload.targetTeamId}`);
          if (!teamDetailRes.ok) {
            return { ...created, teamAddFailed: true };
          }
          const teamDetail = await teamDetailRes.json();
          const currentMemberIds = (teamDetail.members ?? []).map(
            (m: { agentId: string }) => m.agentId,
          );
          const putRes = await apiFetch(`/api/teams/${payload.targetTeamId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              memberAgentIds: [...currentMemberIds, created.id],
            }),
          });
          if (!putRes.ok) {
            return { ...created, teamAddFailed: true };
          }
        } catch {
          return { ...created, teamAddFailed: true };
        }
      }

      return created;
    },
    onSuccess: (result) => {
      const targetTeamName = cloneTargetTeam?.teamName;
      const sourceAgentName = pendingCloneAgent?.agent.name ?? '';
      setPendingCloneAgent(null);
      if (result?.teamAddFailed && targetTeamName) {
        toast({
          title: `Cloned ${pendingCloneName}`,
          description: `Couldn't add it to ${targetTeamName}. Add it manually via Teams page.`,
          variant: 'destructive',
        });
      } else if (targetTeamName) {
        toast({ title: `Cloned ${sourceAgentName} into ${targetTeamName}` });
      } else {
        toast({ title: 'Cloned agent' });
      }
      invalidateAgentAndTeamCaches();
    },
    onError: (error) => {
      showError({
        title: 'Failed to clone agent',
        description: getErrorMessage(error, 'Unknown error'),
      });
    },
  });

  const handleConfirmClone = useCallback(() => {
    if (!pendingCloneAgent || !projectId) return;
    const src = pendingCloneAgent.agent;
    cloneAgentMutation.mutate({
      projectId,
      profileId: src.profileId ?? '',
      name: pendingCloneName,
      description: src.description ?? null,
      providerConfigId: src.providerConfigId ?? '',
      modelOverride: src.modelOverride ?? null,
      targetTeamId: cloneTargetTeam?.teamId ?? null,
    });
  }, [pendingCloneAgent, projectId, pendingCloneName, cloneTargetTeam, cloneAgentMutation]);

  // ── Delete agent ──
  const [pendingDeleteAgent, setPendingDeleteAgent] = useState<AgentOrGuest | null>(null);
  const [pendingDeleteAgentId, setPendingDeleteAgentId] = useState<string | null>(null);

  const pendingDeleteHasSession = useMemo(() => {
    if (!pendingDeleteAgent) return false;
    return activeSessions.some(
      (s) => s.agentId === pendingDeleteAgent.id && s.status === 'running',
    );
  }, [pendingDeleteAgent, activeSessions]);

  const deleteAgentMutation = useMutation({
    mutationFn: async (agentId: string) => {
      const agentSessions = activeSessions.filter(
        (s) => s.agentId === agentId && s.status === 'running',
      );
      if (agentSessions.length > 0) {
        await Promise.all(agentSessions.map((s) => terminateSession(s.id, '', apiFetch)));
      }
      const res = await apiFetch(`/api/agents/${agentId}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (res.status === 409) {
          throw new Error("Can't delete — agent is currently running. Try again in a moment.");
        }
        throw new Error(body.message ?? 'Failed to delete agent');
      }
    },
    onMutate: (agentId) => {
      setPendingDeleteAgentId(agentId);
    },
    onSuccess: () => {
      setPendingDeleteAgent(null);
      toast({ title: 'Agent deleted' });
      invalidateAgentAndTeamCaches();
    },
    onError: (error) => {
      showError({
        title: 'Failed to delete agent',
        description: getErrorMessage(error, 'Unknown error'),
      });
    },
    onSettled: () => {
      setPendingDeleteAgentId(null);
    },
  });

  const handleConfirmDelete = useCallback(() => {
    if (!pendingDeleteAgent) return;
    deleteAgentMutation.mutate(pendingDeleteAgent.id);
  }, [pendingDeleteAgent, deleteAgentMutation]);

  // ── Quick-add team agent ──
  const createTeamAgentMutation = useMutation({
    mutationFn: async (payload: {
      teamId: string;
      teamName: string;
      providerConfigId: string;
      name: string;
    }) => {
      const res = await apiFetch(`/api/teams/${payload.teamId}/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerConfigId: payload.providerConfigId,
          name: payload.name,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? 'Failed to add agent');
      }
      return { agent: await res.json(), teamName: payload.teamName };
    },
    onSuccess: ({ agent, teamName }) => {
      toast({ title: `Added ${agent.name} to ${teamName}` });
      invalidateAgentAndTeamCaches();
    },
    onError: (error) => {
      showError({
        title: 'Failed to add agent',
        description: getErrorMessage(error, 'Unknown error'),
      });
    },
  });

  const handleAddTeamAgent = useCallback(
    (payload: QuickAddPayload) => {
      createTeamAgentMutation.mutate({
        teamId: payload.teamId,
        teamName: payload.teamName,
        providerConfigId: payload.providerConfigId,
        name: payload.computedName,
      });
    },
    [createTeamAgentMutation],
  );

  return {
    pendingCloneAgent,
    setPendingCloneAgent,
    pendingCloneName,
    cloneTargetTeam,
    handleConfirmClone,
    cloningAgent: cloneAgentMutation.isPending,
    pendingDeleteAgent,
    setPendingDeleteAgent,
    pendingDeleteAgentId,
    pendingDeleteHasSession,
    handleConfirmDelete,
    deletingAgent: deleteAgentMutation.isPending,
    handleAddTeamAgent,
  };
}
