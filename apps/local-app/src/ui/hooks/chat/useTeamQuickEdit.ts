import { useCallback, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getErrorMessage, useToastHelpers } from '@/ui/lib/toast-helpers';
import { chatQueryKeys } from '@/ui/hooks/useChatQueries';
import { teamsQueryKeys, updateTeam } from '@/ui/lib/teams';

/**
 * Quick-edit-team domain flow, extracted from ChatPage. Owns the modal target,
 * the three form fields, and the update mutation (invalidation keys + toast copy
 * preserved verbatim). ChatPage renders the modal from this state and calls
 * `submit()` — it holds no team-edit orchestration itself.
 */
export interface QuickEditTeamTarget {
  teamId: string;
  teamName: string;
  maxMembers: number;
  maxConcurrentTasks: number;
  allowTeamLeadCreateAgents: boolean;
}

export interface UseTeamQuickEditResult {
  quickEditTeam: QuickEditTeamTarget | null;
  maxMembers: number;
  setMaxMembers: (value: number) => void;
  maxConcurrentTasks: number;
  setMaxConcurrentTasks: (value: number) => void;
  allowTeamLeadCreateAgents: boolean;
  setAllowTeamLeadCreateAgents: (value: boolean) => void;
  openEditTeam: (payload: QuickEditTeamTarget) => void;
  closeEditTeam: () => void;
  submit: () => void;
  isPending: boolean;
}

export function useTeamQuickEdit({
  projectId,
}: {
  projectId: string | null;
}): UseTeamQuickEditResult {
  const queryClient = useQueryClient();
  const { toast, showError } = useToastHelpers();

  const [quickEditTeam, setQuickEditTeam] = useState<QuickEditTeamTarget | null>(null);
  const [maxMembers, setMaxMembers] = useState(5);
  const [maxConcurrentTasks, setMaxConcurrentTasks] = useState(5);
  const [allowTeamLeadCreateAgents, setAllowTeamLeadCreateAgents] = useState(false);

  const openEditTeam = useCallback((payload: QuickEditTeamTarget) => {
    setQuickEditTeam(payload);
    setMaxMembers(payload.maxMembers);
    setMaxConcurrentTasks(payload.maxConcurrentTasks);
    setAllowTeamLeadCreateAgents(payload.allowTeamLeadCreateAgents);
  }, []);

  const closeEditTeam = useCallback(() => setQuickEditTeam(null), []);

  const mutation = useMutation({
    mutationFn: (payload: {
      teamId: string;
      maxMembers: number;
      maxConcurrentTasks: number;
      allowTeamLeadCreateAgents: boolean;
    }) =>
      updateTeam(payload.teamId, {
        maxMembers: payload.maxMembers,
        maxConcurrentTasks: payload.maxConcurrentTasks,
        allowTeamLeadCreateAgents: payload.allowTeamLeadCreateAgents,
      }),
    onSuccess: () => {
      const teamName = quickEditTeam?.teamName ?? '';
      const teamId = quickEditTeam?.teamId;
      setQuickEditTeam(null);
      toast({ title: `Team '${teamName}' updated` });
      if (projectId) {
        queryClient.invalidateQueries({ queryKey: chatQueryKeys.agents(projectId) });
        queryClient.invalidateQueries({ queryKey: chatQueryKeys.agentPresence(projectId) });
        queryClient.invalidateQueries({ queryKey: chatQueryKeys.activeSessions(projectId) });
        queryClient.invalidateQueries({ queryKey: teamsQueryKeys.teams(projectId) });
      }
      if (teamId) {
        queryClient.invalidateQueries({ queryKey: teamsQueryKeys.detail(teamId) });
      }
    },
    onError: (error) => {
      showError({
        title: 'Failed to update team',
        description: getErrorMessage(error, 'Unknown error'),
      });
    },
  });

  const submit = useCallback(() => {
    if (!quickEditTeam) return;
    mutation.mutate({
      teamId: quickEditTeam.teamId,
      maxMembers,
      maxConcurrentTasks,
      allowTeamLeadCreateAgents,
    });
  }, [quickEditTeam, maxMembers, maxConcurrentTasks, allowTeamLeadCreateAgents, mutation]);

  return {
    quickEditTeam,
    maxMembers,
    setMaxMembers,
    maxConcurrentTasks,
    setMaxConcurrentTasks,
    allowTeamLeadCreateAgents,
    setAllowTeamLeadCreateAgents,
    openEditTeam,
    closeEditTeam,
    submit,
    isPending: mutation.isPending,
  };
}
