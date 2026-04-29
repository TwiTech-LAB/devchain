import { chatQueryKeys } from '@/ui/hooks/useChatQueries';
import { teamsQueryKeys } from '@/ui/lib/teams';

describe('quickEditTeamMutation payload shape', () => {
  it('includes allowTeamLeadCreateAgents alongside capacity fields', () => {
    const payload = {
      teamId: 'team-1',
      maxMembers: 8,
      maxConcurrentTasks: 4,
      allowTeamLeadCreateAgents: true,
    };

    expect(payload).toEqual({
      teamId: 'team-1',
      maxMembers: 8,
      maxConcurrentTasks: 4,
      allowTeamLeadCreateAgents: true,
    });
    expect(payload).toHaveProperty('allowTeamLeadCreateAgents', true);
  });

  it('sends allowTeamLeadCreateAgents=false when toggled off', () => {
    const payload = {
      teamId: 'team-1',
      maxMembers: 5,
      maxConcurrentTasks: 3,
      allowTeamLeadCreateAgents: false,
    };

    expect(payload).toHaveProperty('allowTeamLeadCreateAgents', false);
  });
});

describe('quickEditTeamMutation onSuccess handler', () => {
  it('invalidates chat and teams query keys', () => {
    const invalidateQueries = jest.fn();
    const toast = jest.fn();
    const projectId = 'project-1';
    const teamId = 'team-1';
    const teamName = 'Alpha';

    toast({ title: `Team '${teamName}' updated` });
    invalidateQueries({ queryKey: chatQueryKeys.agents(projectId) });
    invalidateQueries({ queryKey: chatQueryKeys.agentPresence(projectId) });
    invalidateQueries({ queryKey: chatQueryKeys.activeSessions(projectId) });
    invalidateQueries({ queryKey: teamsQueryKeys.teams(projectId) });
    invalidateQueries({ queryKey: teamsQueryKeys.detail(teamId) });

    expect(invalidateQueries).toHaveBeenCalledTimes(5);
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['agents', projectId],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['agent-presence', projectId],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['active-sessions', projectId],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['teams', projectId],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['teams', 'detail', teamId],
    });
    expect(toast).toHaveBeenCalledWith({ title: "Team 'Alpha' updated" });
  });
});

describe('quickEditTeamMutation onError handler', () => {
  it('shows destructive toast with error message', () => {
    const toast = jest.fn();
    const error = new Error('Team not found');

    toast({
      title: 'Failed to update team',
      description: error instanceof Error ? error.message : 'Unknown error',
      variant: 'destructive',
    });

    expect(toast).toHaveBeenCalledWith({
      title: 'Failed to update team',
      description: 'Team not found',
      variant: 'destructive',
    });
  });

  it('falls back to "Unknown error" for non-Error objects', () => {
    const toast = jest.fn();
    const error = 'string error';

    toast({
      title: 'Failed to update team',
      description: error instanceof Error ? error.message : 'Unknown error',
      variant: 'destructive',
    });

    expect(toast).toHaveBeenCalledWith({
      title: 'Failed to update team',
      description: 'Unknown error',
      variant: 'destructive',
    });
  });
});
