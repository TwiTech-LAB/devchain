import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';

import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import type { Agent, Team, TeamMember } from '../../storage/models/domain.models';
import { TeamsService } from '../services/teams.service';
import { TeamsController } from './teams.controller';

const PROJECT_ID = 'project-1';
const AGENT_A = 'agent-a';
const AGENT_B = 'agent-b';

function makeTeam(overrides: Partial<Team> = {}): Team {
  return {
    id: 'team-1',
    projectId: PROJECT_ID,
    name: 'Test Team',
    description: null,
    teamLeadAgentId: AGENT_A,
    maxMembers: 5,
    maxConcurrentTasks: 5,
    allowTeamLeadCreateAgents: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeMember(teamId: string, agentId: string): TeamMember {
  return { teamId, agentId, createdAt: '2026-01-01T00:00:00.000Z' };
}

function makeAgent(id: string): Agent {
  return {
    id,
    projectId: PROJECT_ID,
    isProjectOwner: false,
    profileId: 'profile-1',
    providerConfigId: 'config-1',
    modelOverride: null,
    effortOverride: null,
    name: `Agent-${id}`,
    description: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('TeamsController', () => {
  let controller: TeamsController;
  let teamsService: jest.Mocked<TeamsService>;
  let storageService: { getAgent: jest.Mock };

  beforeEach(async () => {
    teamsService = {
      createTeam: jest.fn(),
      getTeam: jest.fn(),
      listTeams: jest.fn(),
      updateTeam: jest.fn(),
      disbandTeam: jest.fn(),
      canDeleteAgent: jest.fn(),
      createTeamAgentForRest: jest.fn(),
    } as unknown as jest.Mocked<TeamsService>;

    storageService = {
      getAgent: jest.fn().mockImplementation((id: string) => Promise.resolve(makeAgent(id))),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TeamsController],
      providers: [
        { provide: TeamsService, useValue: teamsService },
        { provide: STORAGE_SERVICE, useValue: storageService },
      ],
    }).compile();

    controller = module.get<TeamsController>(TeamsController);
  });

  describe('GET /api/teams', () => {
    it('passes limit and offset as numbers', async () => {
      teamsService.listTeams.mockResolvedValue({
        items: [],
        total: 0,
        limit: 10,
        offset: 5,
      });

      await controller.listTeams(PROJECT_ID, '10', '5');

      expect(teamsService.listTeams).toHaveBeenCalledWith(PROJECT_ID, {
        limit: 10,
        offset: 5,
      });
    });

    it('throws BadRequestException when projectId is missing', async () => {
      await expect(controller.listTeams(undefined as unknown as string)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('GET /api/teams/:id', () => {
    it('returns team with enriched members', async () => {
      teamsService.getTeam.mockResolvedValue({
        ...makeTeam(),
        members: [makeMember('team-1', AGENT_A), makeMember('team-1', AGENT_B)],
        profileIds: [],
        profileConfigSelections: [],
      });

      const result = await controller.getTeam('team-1');

      expect(result.id).toBe('team-1');
      expect(result.teamLeadAgentName).toBe(`Agent-${AGENT_A}`);
      expect(result.members).toHaveLength(2);

      const leadMember = result.members.find((m) => m.agentId === AGENT_A);
      const regularMember = result.members.find((m) => m.agentId === AGENT_B);
      expect(leadMember!.isLead).toBe(true);
      expect(leadMember!.agentName).toBe(`Agent-${AGENT_A}`);
      expect(regularMember!.isLead).toBe(false);
      expect(regularMember!.agentName).toBe(`Agent-${AGENT_B}`);
    });

    it('throws NotFoundException when team does not exist', async () => {
      teamsService.getTeam.mockResolvedValue(null);

      await expect(controller.getTeam('missing')).rejects.toThrow(NotFoundException);
    });

    it('handles deleted agent gracefully in member enrichment', async () => {
      teamsService.getTeam.mockResolvedValue({
        ...makeTeam({ teamLeadAgentId: AGENT_A }),
        members: [makeMember('team-1', AGENT_A), makeMember('team-1', 'deleted-agent')],
        profileIds: [],
        profileConfigSelections: [],
      });
      storageService.getAgent.mockImplementation((id: string) => {
        if (id === 'deleted-agent') return Promise.reject(new Error('not found'));
        return Promise.resolve(makeAgent(id));
      });

      const result = await controller.getTeam('team-1');

      const deleted = result.members.find((m) => m.agentId === 'deleted-agent');
      expect(deleted!.agentName).toBeNull();
    });

    it('returns null lead name when the team has no lead', async () => {
      teamsService.getTeam.mockResolvedValue({
        ...makeTeam({ teamLeadAgentId: null }),
        members: [makeMember('team-1', AGENT_A), makeMember('team-1', AGENT_B)],
        profileIds: [],
        profileConfigSelections: [],
      });

      const result = await controller.getTeam('team-1');

      expect(result.teamLeadAgentId).toBeNull();
      expect(result.teamLeadAgentName).toBeNull();
      expect(result.members.every((member) => member.isLead === false)).toBe(true);
    });
  });

  describe('POST /api/teams', () => {
    it('creates team with valid body', async () => {
      const expected = makeTeam();
      teamsService.createTeam.mockResolvedValue(expected);

      const result = await controller.createTeam({
        projectId: PROJECT_ID,
        name: 'New Team',
        teamLeadAgentId: AGENT_A,
        memberAgentIds: [AGENT_A, AGENT_B],
      });

      expect(result).toEqual(expected);
      expect(teamsService.createTeam).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
        name: 'New Team',
        teamLeadAgentId: AGENT_A,
        memberAgentIds: [AGENT_A, AGENT_B],
        profileIds: [],
      });
    });
  });

  describe('profileConfigSelections', () => {
    it('GET returns empty array when profileConfigSelections is undefined', async () => {
      teamsService.getTeam.mockResolvedValue({
        ...makeTeam(),
        members: [makeMember('team-1', AGENT_A)],
        profileIds: [],
        profileConfigSelections: undefined as unknown as Array<{
          profileId: string;
          configIds: string[];
        }>,
      });

      const result = await controller.getTeam('team-1');

      expect(result.profileConfigSelections).toEqual([]);
    });
  });

  describe('POST /api/teams/:teamId/agents', () => {
    const VALID_CONFIG_UUID = '11111111-1111-1111-1111-111111111111';
    const teamWithMembers = {
      ...makeTeam(),
      members: [makeMember('team-1', AGENT_A)],
      profileIds: ['profile-1'],
      profileConfigSelections: [],
    };

    it('returns created agent on success', async () => {
      teamsService.getTeam.mockResolvedValue(teamWithMembers);
      teamsService.createTeamAgentForRest.mockResolvedValue(makeAgent('new-1'));

      const result = await controller.createTeamAgent('team-1', {
        providerConfigId: VALID_CONFIG_UUID,
        name: 'New Agent',
      });

      expect(result.id).toBe('new-1');
      expect(teamsService.createTeamAgentForRest).toHaveBeenCalledWith(
        expect.objectContaining({
          teamId: 'team-1',
          providerConfigId: VALID_CONFIG_UUID,
          name: 'New Agent',
        }),
      );
    });

    it('throws NotFoundException when team does not exist', async () => {
      teamsService.getTeam.mockResolvedValue(null);

      await expect(
        controller.createTeamAgent('nonexistent', {
          providerConfigId: VALID_CONFIG_UUID,
          name: 'Agent',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws on team with no lead', async () => {
      teamsService.getTeam.mockResolvedValue({
        ...teamWithMembers,
        teamLeadAgentId: null,
      });

      await expect(
        controller.createTeamAgent('team-1', {
          providerConfigId: VALID_CONFIG_UUID,
          name: 'Agent',
        }),
      ).rejects.toThrow('Team has no lead');
    });
  });
});
