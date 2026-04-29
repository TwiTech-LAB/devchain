import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { TerminalGateway } from '../../terminal/gateways/terminal.gateway';
import type { AgentCreatedEventPayload } from '../catalog/agent.created';
import type { TeamMemberAddedEventPayload } from '../catalog/team.member.added';
import type { TeamMemberRemovedEventPayload } from '../catalog/team.member.removed';
import type { TeamConfigUpdatedEventPayload } from '../catalog/team.config.updated';
import type { AgentDeletedEventPayload } from '../catalog/agent.deleted';

@Injectable()
export class ProjectStateBroadcasterSubscriber {
  constructor(
    @Inject(forwardRef(() => TerminalGateway))
    private readonly gateway: TerminalGateway,
  ) {}

  @OnEvent('agent.created', { async: true })
  handleAgentCreated(payload: AgentCreatedEventPayload): void {
    this.broadcast(payload.projectId, 'agent.created', {
      agentId: payload.agentId,
      agentName: payload.agentName,
    });
  }

  @OnEvent('team.member.added', { async: true })
  handleTeamMemberAdded(payload: TeamMemberAddedEventPayload): void {
    this.broadcast(payload.projectId, 'team.member.added', {
      teamId: payload.teamId,
      teamName: payload.teamName,
      addedAgentId: payload.addedAgentId,
      addedAgentName: payload.addedAgentName,
    });
  }

  @OnEvent('team.member.removed', { async: true })
  handleTeamMemberRemoved(payload: TeamMemberRemovedEventPayload): void {
    this.broadcast(payload.projectId, 'team.member.removed', {
      teamId: payload.teamId,
      teamName: payload.teamName,
      removedAgentId: payload.removedAgentId,
      removedAgentName: payload.removedAgentName,
    });
  }

  @OnEvent('agent.deleted', { async: true })
  handleAgentDeleted(payload: AgentDeletedEventPayload): void {
    this.broadcast(payload.projectId, 'agent.deleted', {
      agentId: payload.agentId,
      agentName: payload.agentName,
      teamId: payload.teamId ?? null,
      teamName: payload.teamName ?? null,
    });
  }

  @OnEvent('team.config.updated', { async: true })
  handleTeamConfigUpdated(payload: TeamConfigUpdatedEventPayload): void {
    this.broadcast(payload.projectId, 'team.config.updated', {
      teamId: payload.teamId,
      teamName: payload.teamName,
      previous: payload.previous,
      current: payload.current,
    });
  }

  private broadcast(projectId: string, type: string, payload: unknown): void {
    this.gateway.broadcastEvent(`project/${projectId}/state`, type, payload);
  }
}
