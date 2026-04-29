import { chatQueryKeys } from '@/ui/hooks/useChatQueries';
import { teamsQueryKeys } from '@/ui/lib/teams';

describe('createTeamAgentMutation onSuccess handler', () => {
  it('invalidates 5 query keys and shows success toast', () => {
    const invalidateQueries = jest.fn();
    const toast = jest.fn();
    const projectId = 'project-1';

    const agent = { name: 'Coder (1)' };
    const teamName = 'Alpha';

    toast({ title: `Added ${agent.name} to ${teamName}` });
    invalidateQueries({ queryKey: chatQueryKeys.agents(projectId) });
    invalidateQueries({ queryKey: chatQueryKeys.agentPresence(projectId) });
    invalidateQueries({ queryKey: chatQueryKeys.activeSessions(projectId) });
    invalidateQueries({ queryKey: teamsQueryKeys.teams(projectId) });
    invalidateQueries({ queryKey: ['teams', 'detail'] });

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
      queryKey: ['teams', 'detail'],
    });
    expect(toast).toHaveBeenCalledWith({ title: 'Added Coder (1) to Alpha' });
  });
});

describe('createTeamAgentMutation onError handler', () => {
  it('shows destructive toast with error message', () => {
    const toast = jest.fn();
    const error = new Error('Agent name already exists in this project');

    toast({
      title: 'Failed to add agent',
      description: error instanceof Error ? error.message : 'Unknown error',
      variant: 'destructive',
    });

    expect(toast).toHaveBeenCalledWith({
      title: 'Failed to add agent',
      description: 'Agent name already exists in this project',
      variant: 'destructive',
    });
  });

  it('falls back to "Unknown error" for non-Error objects', () => {
    const toast = jest.fn();
    const error = 'string error';

    toast({
      title: 'Failed to add agent',
      description: error instanceof Error ? error.message : 'Unknown error',
      variant: 'destructive',
    });

    expect(toast).toHaveBeenCalledWith({
      title: 'Failed to add agent',
      description: 'Unknown error',
      variant: 'destructive',
    });
  });
});
