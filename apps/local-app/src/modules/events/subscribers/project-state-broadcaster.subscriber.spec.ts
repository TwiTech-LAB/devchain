import { ProjectStateBroadcasterSubscriber } from './project-state-broadcaster.subscriber';
import type { TerminalGateway } from '../../terminal/gateways/terminal.gateway';

describe('ProjectStateBroadcasterSubscriber', () => {
  let gateway: { broadcastEvent: jest.Mock };
  let subscriber: ProjectStateBroadcasterSubscriber;

  beforeEach(() => {
    gateway = { broadcastEvent: jest.fn() };
    subscriber = new ProjectStateBroadcasterSubscriber(gateway as unknown as TerminalGateway);
  });

  it('handleAgentCreated broadcasts agent.created with agentId and agentName', () => {
    subscriber.handleAgentCreated({
      agentId: 'a1',
      agentName: 'Coder',
      projectId: 'p1',
      profileId: 'prof-1',
      providerConfigId: 'cfg-1',
      actor: null,
    });

    expect(gateway.broadcastEvent).toHaveBeenCalledWith('project/p1/state', 'agent.created', {
      agentId: 'a1',
      agentName: 'Coder',
    });
  });

  it('handleTeamMemberAdded broadcasts with teamId, teamName, addedAgentId, addedAgentName', () => {
    subscriber.handleTeamMemberAdded({
      teamId: 't1',
      projectId: 'p1',
      teamLeadAgentId: 'lead-1',
      teamName: 'Backend',
      addedAgentId: 'a2',
      addedAgentName: 'Worker',
    });

    expect(gateway.broadcastEvent).toHaveBeenCalledWith('project/p1/state', 'team.member.added', {
      teamId: 't1',
      teamName: 'Backend',
      addedAgentId: 'a2',
      addedAgentName: 'Worker',
    });
  });

  it('handleTeamMemberRemoved broadcasts with teamId, teamName, removedAgentId, removedAgentName', () => {
    subscriber.handleTeamMemberRemoved({
      teamId: 't1',
      projectId: 'p1',
      teamLeadAgentId: 'lead-1',
      teamName: 'Backend',
      removedAgentId: 'a2',
      removedAgentName: 'Worker',
    });

    expect(gateway.broadcastEvent).toHaveBeenCalledWith('project/p1/state', 'team.member.removed', {
      teamId: 't1',
      teamName: 'Backend',
      removedAgentId: 'a2',
      removedAgentName: 'Worker',
    });
  });

  it('handleAgentDeleted broadcasts with agentId, agentName, teamId, teamName', () => {
    subscriber.handleAgentDeleted({
      agentId: 'a1',
      agentName: 'Coder',
      projectId: 'p1',
      actor: { type: 'agent', id: 'lead-1' },
      teamId: 't1',
      teamName: 'Backend',
    });

    expect(gateway.broadcastEvent).toHaveBeenCalledWith('project/p1/state', 'agent.deleted', {
      agentId: 'a1',
      agentName: 'Coder',
      teamId: 't1',
      teamName: 'Backend',
    });
  });

  it('handleAgentDeleted broadcasts null team fields when omitted', () => {
    subscriber.handleAgentDeleted({
      agentId: 'a1',
      agentName: 'Coder',
      projectId: 'p1',
      actor: null,
    });

    expect(gateway.broadcastEvent).toHaveBeenCalledWith('project/p1/state', 'agent.deleted', {
      agentId: 'a1',
      agentName: 'Coder',
      teamId: null,
      teamName: null,
    });
  });

  it('handleTeamConfigUpdated broadcasts with teamId, teamName, previous, current', () => {
    const previous = { maxMembers: 5, maxConcurrentTasks: 2, allowTeamLeadCreateAgents: false };
    const current = { maxMembers: 10, maxConcurrentTasks: 3, allowTeamLeadCreateAgents: true };

    subscriber.handleTeamConfigUpdated({
      teamId: 't1',
      projectId: 'p1',
      teamLeadAgentId: 'lead-1',
      teamName: 'Backend',
      previous,
      current,
    });

    expect(gateway.broadcastEvent).toHaveBeenCalledWith('project/p1/state', 'team.config.updated', {
      teamId: 't1',
      teamName: 'Backend',
      previous,
      current,
    });
  });
});
