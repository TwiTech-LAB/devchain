import { Test, TestingModule } from '@nestjs/testing';
import { ValidationError, NotFoundError, ConflictError } from '../../../common/errors/error-types';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import type { Agent, AgentProfile, Team, TeamMember } from '../../storage/models/domain.models';
import { TeamsStore } from '../storage/teams.store';
import { TeamsService } from './teams.service';
import { EventsService } from '../../events/services/events.service';
import { SessionsService } from '../../sessions/services/sessions.service';

const PROJECT_ID = 'project-1';
const AGENT_A = 'agent-a';
const AGENT_B = 'agent-b';
const AGENT_C = 'agent-c';
const AGENT_OTHER_PROJECT = 'agent-other';
const PROFILE_A = 'profile-a';
const PROFILE_B = 'profile-b';
const PROFILE_OTHER_PROJECT = 'profile-other';

function makeAgent(id: string, projectId: string = PROJECT_ID): Agent {
  return {
    id,
    projectId,
    profileId: 'profile-1',
    providerConfigId: 'config-1',
    modelOverride: null,
    name: `Agent-${id}`,
    description: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeProfile(id: string, projectId: string = PROJECT_ID): AgentProfile {
  return {
    id,
    projectId,
    name: `Profile-${id}`,
    familySlug: null,
    systemPrompt: null,
    instructions: null,
    temperature: null,
    maxTokens: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

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

function makeTeamWithMembers(
  overrides: Partial<Team> = {},
  members: TeamMember[] = [],
  profileIds: string[] = [],
): Team & { members: TeamMember[]; profileIds: string[] } {
  return {
    ...makeTeam(overrides),
    members,
    profileIds,
  };
}

function makeMember(teamId: string, agentId: string): TeamMember {
  return { teamId, agentId, createdAt: '2026-01-01T00:00:00.000Z' };
}

describe('TeamsService', () => {
  let service: TeamsService;
  let teamsStore: jest.Mocked<TeamsStore>;
  let storageService: {
    getAgent: jest.Mock;
    listAgents: jest.Mock;
    getAgentProfile: jest.Mock;
    createAgent: jest.Mock;
    deleteAgent: jest.Mock;
    getProfileProviderConfig: jest.Mock;
  };
  let eventsService: {
    publish: jest.Mock;
  };
  let sessionsService: {
    listActiveSessions: jest.Mock;
    terminateSession: jest.Mock;
  };

  beforeEach(async () => {
    teamsStore = {
      createTeam: jest.fn(),
      getTeam: jest.fn(),
      listTeams: jest.fn(),
      findTeamByExactName: jest.fn(),
      updateTeam: jest.fn(),
      deleteTeam: jest.fn(),
      listTeamsByAgent: jest.fn(),
      getTeamLeadTeams: jest.fn(),
      listConfigsForTeam: jest.fn(),
      listProfilesForTeam: jest.fn(),
      createTeamAgentAtomicCapped: jest.fn(),
    } as unknown as jest.Mocked<TeamsStore>;

    storageService = {
      getAgent: jest.fn(),
      listAgents: jest.fn(),
      getAgentProfile: jest.fn(),
      createAgent: jest.fn(),
      deleteAgent: jest.fn().mockResolvedValue(undefined),
      getProfileProviderConfig: jest.fn().mockImplementation((id: string) => {
        // Default: config belongs to PROFILE_A
        return Promise.resolve({ id, profileId: PROFILE_A, name: `config-${id}` });
      }),
    };

    // Default: all agents belong to PROJECT_ID
    storageService.getAgent.mockImplementation((id: string) => {
      if (id === AGENT_OTHER_PROJECT) {
        return Promise.resolve(makeAgent(id, 'other-project'));
      }
      return Promise.resolve(makeAgent(id));
    });

    // Default: all profiles belong to PROJECT_ID
    storageService.getAgentProfile.mockImplementation((id: string) => {
      if (id === PROFILE_OTHER_PROJECT) {
        return Promise.resolve(makeProfile(id, 'other-project'));
      }
      return Promise.resolve(makeProfile(id));
    });

    // Default: listAgents returns common test agents
    storageService.listAgents.mockResolvedValue({
      items: [makeAgent(AGENT_A), makeAgent(AGENT_B), makeAgent(AGENT_C)],
      total: 3,
      limit: 1000,
      offset: 0,
    });

    eventsService = {
      publish: jest.fn().mockResolvedValue('event-id-1'),
    };

    sessionsService = {
      listActiveSessions: jest.fn().mockResolvedValue([]),
      terminateSession: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TeamsService,
        { provide: TeamsStore, useValue: teamsStore },
        { provide: STORAGE_SERVICE, useValue: storageService },
        { provide: EventsService, useValue: eventsService },
        { provide: SessionsService, useValue: sessionsService },
      ],
    }).compile();

    service = module.get<TeamsService>(TeamsService);
  });

  describe('createTeam', () => {
    it('creates a team when all validations pass', async () => {
      const expected = makeTeam();
      teamsStore.createTeam.mockResolvedValue(expected);

      const result = await service.createTeam({
        projectId: PROJECT_ID,
        name: 'Test Team',
        teamLeadAgentId: AGENT_A,
        memberAgentIds: [AGENT_A, AGENT_B],
      });

      expect(result).toEqual(expected);
      expect(teamsStore.createTeam).toHaveBeenCalledTimes(1);
      expect(storageService.getAgent).toHaveBeenCalledTimes(2);
    });

    it('rejects when members list is empty', async () => {
      await expect(
        service.createTeam({
          projectId: PROJECT_ID,
          name: 'Empty Team',
          teamLeadAgentId: AGENT_A,
          memberAgentIds: [],
        }),
      ).rejects.toThrow(ValidationError);

      await expect(
        service.createTeam({
          projectId: PROJECT_ID,
          name: 'Empty Team',
          teamLeadAgentId: AGENT_A,
          memberAgentIds: [],
        }),
      ).rejects.toThrow('at least 1 member');

      expect(teamsStore.createTeam).not.toHaveBeenCalled();
    });

    it('rejects when team lead is not in members', async () => {
      await expect(
        service.createTeam({
          projectId: PROJECT_ID,
          name: 'Bad Lead',
          teamLeadAgentId: AGENT_C,
          memberAgentIds: [AGENT_A, AGENT_B],
        }),
      ).rejects.toThrow(ValidationError);

      await expect(
        service.createTeam({
          projectId: PROJECT_ID,
          name: 'Bad Lead',
          teamLeadAgentId: AGENT_C,
          memberAgentIds: [AGENT_A, AGENT_B],
        }),
      ).rejects.toThrow('Team lead must be included');

      expect(teamsStore.createTeam).not.toHaveBeenCalled();
    });

    it('allows creating a team without a lead', async () => {
      const expected = makeTeam({ teamLeadAgentId: null });
      teamsStore.createTeam.mockResolvedValue(expected);

      const result = await service.createTeam({
        projectId: PROJECT_ID,
        name: 'Leadless Team',
        memberAgentIds: [AGENT_A, AGENT_B],
      });

      expect(result).toEqual(expected);
      expect(teamsStore.createTeam).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: PROJECT_ID,
          name: 'Leadless Team',
          teamLeadAgentId: null,
          memberAgentIds: [AGENT_A, AGENT_B],
        }),
      );
      expect(storageService.getAgent).toHaveBeenCalledTimes(2);
    });

    it('rejects when agent belongs to different project', async () => {
      await expect(
        service.createTeam({
          projectId: PROJECT_ID,
          name: 'Cross Project',
          teamLeadAgentId: AGENT_A,
          memberAgentIds: [AGENT_A, AGENT_OTHER_PROJECT],
        }),
      ).rejects.toThrow(ValidationError);

      await expect(
        service.createTeam({
          projectId: PROJECT_ID,
          name: 'Cross Project',
          teamLeadAgentId: AGENT_A,
          memberAgentIds: [AGENT_A, AGENT_OTHER_PROJECT],
        }),
      ).rejects.toThrow('different project');

      expect(teamsStore.createTeam).not.toHaveBeenCalled();
    });

    it('silently de-duplicates memberAgentIds before passing to store', async () => {
      const expected = makeTeam();
      teamsStore.createTeam.mockResolvedValue(expected);

      await service.createTeam({
        projectId: PROJECT_ID,
        name: 'Dedup Team',
        teamLeadAgentId: AGENT_A,
        memberAgentIds: [AGENT_A, AGENT_B, AGENT_A, AGENT_B],
      });

      expect(teamsStore.createTeam).toHaveBeenCalledWith(
        expect.objectContaining({
          memberAgentIds: [AGENT_A, AGENT_B],
        }),
      );
      // Only 2 unique agents validated
      expect(storageService.getAgent).toHaveBeenCalledTimes(2);
    });

    it('silently de-duplicates profileIds before passing to store', async () => {
      const expected = makeTeam();
      teamsStore.createTeam.mockResolvedValue(expected);

      await service.createTeam({
        projectId: PROJECT_ID,
        name: 'Dedup Profiles',
        teamLeadAgentId: AGENT_A,
        memberAgentIds: [AGENT_A],
        profileIds: [PROFILE_A, PROFILE_A, PROFILE_B],
      });

      expect(teamsStore.createTeam).toHaveBeenCalledWith(
        expect.objectContaining({
          profileIds: [PROFILE_A, PROFILE_B],
        }),
      );
    });

    it('passes empty profileIds through without error', async () => {
      const expected = makeTeam();
      teamsStore.createTeam.mockResolvedValue(expected);

      await service.createTeam({
        projectId: PROJECT_ID,
        name: 'Empty Profiles',
        teamLeadAgentId: AGENT_A,
        memberAgentIds: [AGENT_A],
        profileIds: [],
      });

      expect(teamsStore.createTeam).toHaveBeenCalledWith(
        expect.objectContaining({ profileIds: [] }),
      );
    });

    it('rejects when agent does not exist', async () => {
      storageService.getAgent.mockRejectedValueOnce(new NotFoundError('Agent', 'missing'));

      await expect(
        service.createTeam({
          projectId: PROJECT_ID,
          name: 'Missing Agent',
          teamLeadAgentId: AGENT_A,
          memberAgentIds: [AGENT_A],
        }),
      ).rejects.toThrow(NotFoundError);
    });

    it('creates team with profileIds when they belong to same project', async () => {
      const expected = makeTeam();
      teamsStore.createTeam.mockResolvedValue(expected);

      await service.createTeam({
        projectId: PROJECT_ID,
        name: 'With Profiles',
        teamLeadAgentId: AGENT_A,
        memberAgentIds: [AGENT_A],
        profileIds: [PROFILE_A, PROFILE_B],
      });

      expect(teamsStore.createTeam).toHaveBeenCalledWith(
        expect.objectContaining({
          profileIds: [PROFILE_A, PROFILE_B],
        }),
      );
      expect(storageService.getAgentProfile).toHaveBeenCalledTimes(2);
    });

    it('rejects when profileId belongs to different project', async () => {
      await expect(
        service.createTeam({
          projectId: PROJECT_ID,
          name: 'Cross Project Profiles',
          teamLeadAgentId: AGENT_A,
          memberAgentIds: [AGENT_A],
          profileIds: [PROFILE_A, PROFILE_OTHER_PROJECT],
        }),
      ).rejects.toThrow(ValidationError);

      await expect(
        service.createTeam({
          projectId: PROJECT_ID,
          name: 'Cross Project Profiles',
          teamLeadAgentId: AGENT_A,
          memberAgentIds: [AGENT_A],
          profileIds: [PROFILE_OTHER_PROJECT],
        }),
      ).rejects.toThrow('different project');

      expect(teamsStore.createTeam).not.toHaveBeenCalled();
    });

    it('passes profileIds through to store on create', async () => {
      teamsStore.createTeam.mockResolvedValue(makeTeam());

      await service.createTeam({
        projectId: PROJECT_ID,
        name: 'Profile Passthrough',
        memberAgentIds: [AGENT_A],
        profileIds: [PROFILE_A],
      });

      expect(teamsStore.createTeam).toHaveBeenCalledWith(
        expect.objectContaining({
          profileIds: [PROFILE_A],
        }),
      );
    });
  });

  describe('createTeam capacity validation', () => {
    beforeEach(() => {
      storageService.getAgent.mockImplementation(async (id: string) => ({
        ...makeAgent(id),
        projectId: PROJECT_ID,
      }));
      teamsStore.createTeam.mockImplementation(async (data) => ({
        ...makeTeam(),
        ...data,
        id: 'team-new',
        maxMembers: data.maxMembers ?? 5,
        maxConcurrentTasks: data.maxConcurrentTasks ?? data.maxMembers ?? 5,
      }));
    });

    it('defaults both capacity fields to 5 when omitted', async () => {
      await service.createTeam({
        projectId: PROJECT_ID,
        name: 'Cap Team',
        memberAgentIds: [AGENT_A],
        teamLeadAgentId: AGENT_A,
      });

      expect(teamsStore.createTeam).toHaveBeenCalledWith(
        expect.objectContaining({ maxMembers: 5, maxConcurrentTasks: 5 }),
      );
    });

    it('defaults maxConcurrentTasks to maxMembers when only maxMembers is set', async () => {
      await service.createTeam({
        projectId: PROJECT_ID,
        name: 'Cap Team',
        memberAgentIds: [AGENT_A],
        teamLeadAgentId: AGENT_A,
        maxMembers: 3,
      });

      expect(teamsStore.createTeam).toHaveBeenCalledWith(
        expect.objectContaining({ maxMembers: 3, maxConcurrentTasks: 3 }),
      );
    });

    it('rejects when maxConcurrentTasks exceeds maxMembers', async () => {
      await expect(
        service.createTeam({
          projectId: PROJECT_ID,
          name: 'Cap Team',
          memberAgentIds: [AGENT_A],
          teamLeadAgentId: AGENT_A,
          maxMembers: 3,
          maxConcurrentTasks: 5,
        }),
      ).rejects.toThrow('maxConcurrentTasks cannot exceed maxMembers');
    });

    it('rejects when initial non-lead members exceed maxMembers', async () => {
      const agents = Array.from({ length: 7 }, (_, i) => `agent-${i}`);
      storageService.getAgent.mockImplementation(async (id: string) => ({
        ...makeAgent(id),
        projectId: PROJECT_ID,
      }));

      await expect(
        service.createTeam({
          projectId: PROJECT_ID,
          name: 'Big Team',
          memberAgentIds: [AGENT_A, ...agents],
          teamLeadAgentId: AGENT_A,
          maxMembers: 5,
        }),
      ).rejects.toThrow('Initial team exceeds maxMembers');
    });
  });

  describe('updateTeam capacity validation', () => {
    beforeEach(() => {
      teamsStore.getTeam.mockResolvedValue(
        makeTeamWithMembers({ maxMembers: 5, maxConcurrentTasks: 5 }, [
          makeMember('team-1', AGENT_A),
          makeMember('team-1', AGENT_B),
        ]),
      );
      teamsStore.updateTeam.mockImplementation(async (_id, data) => ({
        ...makeTeam(),
        ...data,
        maxMembers: data.maxMembers ?? 5,
        maxConcurrentTasks: data.maxConcurrentTasks ?? 5,
      }));
    });

    it('rejects lowering maxMembers below existing maxConcurrentTasks', async () => {
      teamsStore.getTeam.mockResolvedValue(
        makeTeamWithMembers({ maxMembers: 5, maxConcurrentTasks: 4 }, [
          makeMember('team-1', AGENT_A),
          makeMember('team-1', AGENT_B),
        ]),
      );

      await expect(service.updateTeam('team-1', { maxMembers: 3 })).rejects.toThrow(
        'maxConcurrentTasks cannot exceed maxMembers',
      );
    });

    it('rejects expanding members past cap', async () => {
      teamsStore.getTeam.mockResolvedValue(
        makeTeamWithMembers({ maxMembers: 2, maxConcurrentTasks: 2 }, [
          makeMember('team-1', AGENT_A),
        ]),
      );
      storageService.getAgent.mockImplementation(async (id: string) => ({
        ...makeAgent(id),
        projectId: PROJECT_ID,
      }));

      await expect(
        service.updateTeam('team-1', {
          memberAgentIds: [AGENT_A, AGENT_B, 'agent-c', 'agent-d'],
        }),
      ).rejects.toThrow('Team member count exceeds maxMembers');
    });

    it('publishes team.config.updated when capacity changes', async () => {
      teamsStore.updateTeam.mockResolvedValue({
        ...makeTeam(),
        maxMembers: 8,
        maxConcurrentTasks: 5,
      });

      await service.updateTeam('team-1', { maxMembers: 8 });

      expect(eventsService.publish).toHaveBeenCalledWith(
        'team.config.updated',
        expect.objectContaining({
          teamId: 'team-1',
          previous: { maxMembers: 5, maxConcurrentTasks: 5, allowTeamLeadCreateAgents: true },
          current: { maxMembers: 8, maxConcurrentTasks: 5, allowTeamLeadCreateAgents: true },
        }),
      );
    });

    it('publishes team.config.updated when only allowTeamLeadCreateAgents changes', async () => {
      teamsStore.updateTeam.mockResolvedValue({
        ...makeTeam(),
        allowTeamLeadCreateAgents: false,
      });

      await service.updateTeam('team-1', { allowTeamLeadCreateAgents: false });

      expect(eventsService.publish).toHaveBeenCalledWith(
        'team.config.updated',
        expect.objectContaining({
          teamId: 'team-1',
          previous: { maxMembers: 5, maxConcurrentTasks: 5, allowTeamLeadCreateAgents: true },
          current: { maxMembers: 5, maxConcurrentTasks: 5, allowTeamLeadCreateAgents: false },
        }),
      );
    });

    it('publishes single team.config.updated event when capacity and flag both change', async () => {
      teamsStore.updateTeam.mockResolvedValue({
        ...makeTeam(),
        maxMembers: 8,
        allowTeamLeadCreateAgents: false,
      });

      await service.updateTeam('team-1', { maxMembers: 8, allowTeamLeadCreateAgents: false });

      expect(eventsService.publish).toHaveBeenCalledTimes(1);
      expect(eventsService.publish).toHaveBeenCalledWith(
        'team.config.updated',
        expect.objectContaining({
          teamId: 'team-1',
          previous: { maxMembers: 5, maxConcurrentTasks: 5, allowTeamLeadCreateAgents: true },
          current: { maxMembers: 8, maxConcurrentTasks: 5, allowTeamLeadCreateAgents: false },
        }),
      );
    });

    it('does not publish event when capacity unchanged', async () => {
      teamsStore.updateTeam.mockResolvedValue(makeTeam());

      await service.updateTeam('team-1', { name: 'Renamed' });

      expect(eventsService.publish).not.toHaveBeenCalledWith(
        'team.config.updated',
        expect.anything(),
      );
    });

    it('publishes team.member.added when new member is added', async () => {
      teamsStore.updateTeam.mockResolvedValue(makeTeam());

      await service.updateTeam('team-1', {
        memberAgentIds: [AGENT_A, AGENT_B, AGENT_C],
      });

      expect(eventsService.publish).toHaveBeenCalledWith(
        'team.member.added',
        expect.objectContaining({
          teamId: 'team-1',
          addedAgentId: AGENT_C,
        }),
      );
    });

    it('publishes team.member.removed when member is removed', async () => {
      teamsStore.updateTeam.mockResolvedValue(makeTeam());

      await service.updateTeam('team-1', {
        memberAgentIds: [AGENT_A],
      });

      expect(eventsService.publish).toHaveBeenCalledWith(
        'team.member.removed',
        expect.objectContaining({
          teamId: 'team-1',
          removedAgentId: AGENT_B,
        }),
      );
    });

    it('does not publish member events when memberAgentIds is undefined', async () => {
      teamsStore.updateTeam.mockResolvedValue(makeTeam());

      await service.updateTeam('team-1', { name: 'Renamed' });

      expect(eventsService.publish).not.toHaveBeenCalledWith(
        'team.member.added',
        expect.anything(),
      );
      expect(eventsService.publish).not.toHaveBeenCalledWith(
        'team.member.removed',
        expect.anything(),
      );
    });

    it('does not publish member events when members unchanged', async () => {
      teamsStore.updateTeam.mockResolvedValue(makeTeam());

      await service.updateTeam('team-1', {
        memberAgentIds: [AGENT_A, AGENT_B],
      });

      expect(eventsService.publish).not.toHaveBeenCalledWith(
        'team.member.added',
        expect.anything(),
      );
      expect(eventsService.publish).not.toHaveBeenCalledWith(
        'team.member.removed',
        expect.anything(),
      );
    });
  });

  describe('getTeam', () => {
    it('returns team with members from store', async () => {
      const expected = makeTeamWithMembers({}, [
        makeMember('team-1', AGENT_A),
        makeMember('team-1', AGENT_B),
      ]);
      teamsStore.getTeam.mockResolvedValue(expected);

      const result = await service.getTeam('team-1');

      expect(result).toEqual(expected);
      expect(teamsStore.getTeam).toHaveBeenCalledWith('team-1');
    });

    it('returns null for non-existent team', async () => {
      teamsStore.getTeam.mockResolvedValue(null);

      const result = await service.getTeam('missing');
      expect(result).toBeNull();
    });
  });

  describe('listTeams', () => {
    it('returns teams with lead agent names resolved via single batch query', async () => {
      teamsStore.listTeams.mockResolvedValue({
        items: [
          { ...makeTeam({ id: 't1', teamLeadAgentId: AGENT_A }), memberCount: 2 },
          { ...makeTeam({ id: 't2', teamLeadAgentId: AGENT_B }), memberCount: 1 },
        ],
        total: 2,
        limit: 100,
        offset: 0,
      });

      const result = await service.listTeams(PROJECT_ID);

      expect(result.items).toHaveLength(2);
      expect(result.items[0].teamLeadAgentName).toBe(`Agent-${AGENT_A}`);
      expect(result.items[1].teamLeadAgentName).toBe(`Agent-${AGENT_B}`);
      // Single listAgents call instead of per-lead getAgent calls
      expect(storageService.listAgents).toHaveBeenCalledTimes(1);
      expect(storageService.listAgents).toHaveBeenCalledWith(PROJECT_ID, { limit: 1000 });
      expect(storageService.getAgent).not.toHaveBeenCalled();
    });

    it('handles deleted lead agent gracefully (returns null name)', async () => {
      teamsStore.listTeams.mockResolvedValue({
        items: [{ ...makeTeam({ teamLeadAgentId: 'deleted-agent' }), memberCount: 0 }],
        total: 1,
        limit: 100,
        offset: 0,
      });
      // listAgents returns agents that don't include 'deleted-agent'
      storageService.listAgents.mockResolvedValueOnce({
        items: [makeAgent(AGENT_A), makeAgent(AGENT_B)],
        total: 2,
        limit: 1000,
        offset: 0,
      });

      const result = await service.listTeams(PROJECT_ID);

      expect(result.items[0].teamLeadAgentName).toBeNull();
    });

    it('returns null lead name when a team has no lead', async () => {
      teamsStore.listTeams.mockResolvedValue({
        items: [{ ...makeTeam({ teamLeadAgentId: null }), memberCount: 2 }],
        total: 1,
        limit: 100,
        offset: 0,
      });

      const result = await service.listTeams(PROJECT_ID);

      expect(result.items[0].teamLeadAgentName).toBeNull();
      expect(storageService.listAgents).toHaveBeenCalledTimes(1);
    });

    it('resolves multiple teams with same lead using single query', async () => {
      teamsStore.listTeams.mockResolvedValue({
        items: [
          { ...makeTeam({ id: 't1', teamLeadAgentId: AGENT_A }), memberCount: 1 },
          { ...makeTeam({ id: 't2', teamLeadAgentId: AGENT_A }), memberCount: 2 },
        ],
        total: 2,
        limit: 100,
        offset: 0,
      });

      const result = await service.listTeams(PROJECT_ID);

      expect(result.items[0].teamLeadAgentName).toBe(`Agent-${AGENT_A}`);
      expect(result.items[1].teamLeadAgentName).toBe(`Agent-${AGENT_A}`);
      // Still just one listAgents call
      expect(storageService.listAgents).toHaveBeenCalledTimes(1);
    });
  });

  describe('findTeamByExactName', () => {
    it('trims the lookup name and delegates to the store', async () => {
      const expected = makeTeam({ name: 'Platform' });
      teamsStore.findTeamByExactName.mockResolvedValue(expected);

      const result = await service.findTeamByExactName(PROJECT_ID, '  Platform  ');

      expect(result).toEqual(expected);
      expect(teamsStore.findTeamByExactName).toHaveBeenCalledWith(PROJECT_ID, 'Platform');
    });
  });

  describe('updateTeam', () => {
    beforeEach(() => {
      // Default: team exists with AGENT_A as lead and [AGENT_A, AGENT_B] as members
      teamsStore.getTeam.mockResolvedValue(
        makeTeamWithMembers({}, [makeMember('team-1', AGENT_A), makeMember('team-1', AGENT_B)]),
      );
      teamsStore.updateTeam.mockResolvedValue(makeTeam());
    });

    it('updates when all validations pass', async () => {
      const result = await service.updateTeam('team-1', {
        name: 'Updated',
        teamLeadAgentId: AGENT_B,
        memberAgentIds: [AGENT_A, AGENT_B],
      });

      expect(result).toBeDefined();
      expect(teamsStore.updateTeam).toHaveBeenCalledWith(
        'team-1',
        expect.objectContaining({
          name: 'Updated',
          teamLeadAgentId: AGENT_B,
          memberAgentIds: [AGENT_A, AGENT_B],
        }),
      );
    });

    it('rejects when new lead is not in new members', async () => {
      await expect(
        service.updateTeam('team-1', {
          teamLeadAgentId: AGENT_C,
          memberAgentIds: [AGENT_A, AGENT_B],
        }),
      ).rejects.toThrow('Team lead must be included');
    });

    it('rejects when new lead is not in existing members (members unchanged)', async () => {
      await expect(
        service.updateTeam('team-1', {
          teamLeadAgentId: AGENT_C,
        }),
      ).rejects.toThrow('Team lead must be included');
    });

    it('rejects when existing lead is removed from new members', async () => {
      await expect(
        service.updateTeam('team-1', {
          memberAgentIds: [AGENT_B], // AGENT_A (current lead) not included
        }),
      ).rejects.toThrow('Team lead must be included');
    });

    it('allows clearing the lead with explicit null', async () => {
      teamsStore.updateTeam.mockResolvedValue(makeTeam({ teamLeadAgentId: null }));

      const result = await service.updateTeam('team-1', {
        teamLeadAgentId: null,
      });

      expect(result.teamLeadAgentId).toBeNull();
      expect(teamsStore.updateTeam).toHaveBeenCalledWith(
        'team-1',
        expect.objectContaining({ teamLeadAgentId: null }),
      );
      expect(storageService.getAgent).not.toHaveBeenCalled();
    });

    it('allows clearing the lead while replacing members', async () => {
      teamsStore.updateTeam.mockResolvedValue(makeTeam({ teamLeadAgentId: null }));

      const result = await service.updateTeam('team-1', {
        teamLeadAgentId: null,
        memberAgentIds: [AGENT_B],
      });

      expect(result.teamLeadAgentId).toBeNull();
      expect(teamsStore.updateTeam).toHaveBeenCalledWith(
        'team-1',
        expect.objectContaining({
          teamLeadAgentId: null,
          memberAgentIds: [AGENT_B],
        }),
      );
      expect(storageService.getAgent).toHaveBeenCalledWith(AGENT_B);
    });

    it('rejects when new members list is empty', async () => {
      await expect(
        service.updateTeam('team-1', {
          memberAgentIds: [],
        }),
      ).rejects.toThrow('at least 1 member');
    });

    it('rejects when agent belongs to different project', async () => {
      await expect(
        service.updateTeam('team-1', {
          memberAgentIds: [AGENT_A, AGENT_OTHER_PROJECT],
        }),
      ).rejects.toThrow('different project');
    });

    it('throws NotFoundError for non-existent team', async () => {
      teamsStore.getTeam.mockResolvedValue(null);

      await expect(service.updateTeam('missing', { name: 'X' })).rejects.toThrow(NotFoundError);
    });

    it('silently de-duplicates memberAgentIds on update', async () => {
      await service.updateTeam('team-1', {
        memberAgentIds: [AGENT_A, AGENT_B, AGENT_A],
      });

      expect(teamsStore.updateTeam).toHaveBeenCalledWith(
        'team-1',
        expect.objectContaining({
          memberAgentIds: [AGENT_A, AGENT_B],
        }),
      );
    });

    it('silently de-duplicates profileIds on update', async () => {
      await service.updateTeam('team-1', {
        profileIds: [PROFILE_A, PROFILE_A],
      });

      expect(teamsStore.updateTeam).toHaveBeenCalledWith(
        'team-1',
        expect.objectContaining({
          profileIds: [PROFILE_A],
        }),
      );
    });

    it('leaves existing profiles untouched when profileIds is not provided on update', async () => {
      await service.updateTeam('team-1', { name: 'Renamed' });

      expect(teamsStore.updateTeam).toHaveBeenCalledWith(
        'team-1',
        expect.objectContaining({ profileIds: undefined }),
      );
    });

    it('allows updating only name without member/lead changes', async () => {
      await service.updateTeam('team-1', { name: 'Renamed' });

      expect(teamsStore.updateTeam).toHaveBeenCalledWith(
        'team-1',
        expect.objectContaining({ name: 'Renamed' }),
      );
    });

    it('allows updating only description', async () => {
      await service.updateTeam('team-1', { description: 'New desc' });

      expect(teamsStore.updateTeam).toHaveBeenCalledWith(
        'team-1',
        expect.objectContaining({ description: 'New desc' }),
      );
    });

    it('validates profileIds belong to same project on update', async () => {
      await expect(
        service.updateTeam('team-1', {
          profileIds: [PROFILE_A, PROFILE_OTHER_PROJECT],
        }),
      ).rejects.toThrow(ValidationError);

      await expect(
        service.updateTeam('team-1', {
          profileIds: [PROFILE_OTHER_PROJECT],
        }),
      ).rejects.toThrow('different project');
    });

    it('passes profileIds through to store on update', async () => {
      await service.updateTeam('team-1', {
        profileIds: [PROFILE_A, PROFILE_B],
      });

      expect(teamsStore.updateTeam).toHaveBeenCalledWith(
        'team-1',
        expect.objectContaining({
          profileIds: [PROFILE_A, PROFILE_B],
        }),
      );
      expect(storageService.getAgentProfile).toHaveBeenCalledTimes(2);
    });
  });

  describe('disbandTeam', () => {
    it('delegates to store deleteTeam', async () => {
      teamsStore.deleteTeam.mockResolvedValue(undefined);

      await service.disbandTeam('team-1');

      expect(teamsStore.deleteTeam).toHaveBeenCalledWith('team-1');
    });
  });

  describe('listConfigsVisibleToLead', () => {
    it('returns configs for teams led by the agent in the given project', async () => {
      teamsStore.getTeamLeadTeams.mockResolvedValue([
        makeTeam({ id: 'team-1', name: 'Backend Team' }),
      ]);
      teamsStore.listConfigsForTeam.mockResolvedValue([
        {
          id: 'config-1',
          profileId: PROFILE_A,
          providerId: 'provider-1',
          name: 'claude-sonnet',
          description: 'Sonnet config',
          options: null,
          env: null,
          position: 0,
        },
      ]);
      storageService.getAgentProfile.mockResolvedValue(makeProfile(PROFILE_A));

      const result = await service.listConfigsVisibleToLead(AGENT_A, PROJECT_ID);

      expect(Array.isArray(result)).toBe(true);
      const configs = result as Array<{
        configName: string;
        profileName: string;
        teamName: string;
      }>;
      expect(configs).toHaveLength(1);
      expect(configs[0].configName).toBe('claude-sonnet');
      expect(configs[0].profileName).toBe(`Profile-${PROFILE_A}`);
      expect(configs[0].teamName).toBe('Backend Team');
    });

    it('returns FORBIDDEN_NOT_TEAM_LEAD when agent leads no teams in the project', async () => {
      teamsStore.getTeamLeadTeams.mockResolvedValue([]);

      const result = await service.listConfigsVisibleToLead(AGENT_A, PROJECT_ID);

      expect('error' in result).toBe(true);
      const errResult = result as { error: { code: string } };
      expect(errResult.error.code).toBe('FORBIDDEN_NOT_TEAM_LEAD');
    });

    it('filters out teams from other projects', async () => {
      teamsStore.getTeamLeadTeams.mockResolvedValue([
        makeTeam({ id: 'team-other', name: 'Other', projectId: 'other-project' }),
      ]);

      const result = await service.listConfigsVisibleToLead(AGENT_A, PROJECT_ID);

      expect('error' in result).toBe(true);
      const errResult = result as { error: { code: string } };
      expect(errResult.error.code).toBe('FORBIDDEN_NOT_TEAM_LEAD');
    });

    it('deduplicates configs with same key', async () => {
      teamsStore.getTeamLeadTeams.mockResolvedValue([
        makeTeam({ id: 'team-1', name: 'Backend Team' }),
      ]);
      teamsStore.listConfigsForTeam.mockResolvedValue([
        {
          id: 'c1',
          profileId: PROFILE_A,
          providerId: 'p1',
          name: 'claude-sonnet',
          description: 'desc',
          options: null,
          env: null,
          position: 0,
        },
        {
          id: 'c2',
          profileId: PROFILE_A,
          providerId: 'p1',
          name: 'claude-sonnet',
          description: 'desc',
          options: null,
          env: null,
          position: 1,
        },
      ]);
      storageService.getAgentProfile.mockResolvedValue(makeProfile(PROFILE_A));

      const result = await service.listConfigsVisibleToLead(AGENT_A, PROJECT_ID);

      expect(Array.isArray(result)).toBe(true);
      expect((result as unknown[]).length).toBe(1);
    });
  });

  describe('createTeamAgent', () => {
    const baseInput = {
      leadAgentId: AGENT_A,
      projectId: PROJECT_ID,
      name: 'New Agent',
      description: 'Does stuff',
      configName: 'claude-sonnet',
    };

    beforeEach(() => {
      teamsStore.getTeamLeadTeams.mockResolvedValue([
        makeTeam({ id: 'team-1', name: 'Backend Team' }),
      ]);
      teamsStore.listConfigsForTeam.mockResolvedValue([
        {
          id: 'config-1',
          profileId: PROFILE_A,
          providerId: 'provider-1',
          name: 'claude-sonnet',
          description: 'Sonnet',
          options: null,
          env: null,
          position: 0,
        },
      ]);
      storageService.getAgentProfile.mockResolvedValue(makeProfile(PROFILE_A));
      storageService.listAgents.mockResolvedValue({
        items: [makeAgent(AGENT_A), makeAgent(AGENT_B)],
        total: 2,
        limit: 10000,
        offset: 0,
      });
      const createdAgent = {
        ...makeAgent('new-agent-id'),
        name: 'New Agent',
        description: 'Does stuff',
      };
      teamsStore.createTeamAgentAtomicCapped.mockImplementation(async () => {
        return createdAgent;
      });
    });

    it('creates agent successfully with single team', async () => {
      const result = await service.createTeamAgent(baseInput);

      expect('agent' in result).toBe(true);
      const success = result as {
        agent: { id: string; name: string; configName: string };
        teamName: string;
      };
      expect(success.agent.name).toBe('New Agent');
      expect(success.agent.configName).toBe('claude-sonnet');
      expect(success.teamName).toBe('Backend Team');
      expect(teamsStore.createTeamAgentAtomicCapped).toHaveBeenCalledWith(
        expect.objectContaining({ teamId: 'team-1' }),
      );
    });

    it('returns FORBIDDEN_NOT_TEAM_LEAD when agent leads no teams', async () => {
      teamsStore.getTeamLeadTeams.mockResolvedValue([]);

      const result = await service.createTeamAgent(baseInput);

      expect('error' in result).toBe(true);
      expect((result as { error: { code: string } }).error.code).toBe('FORBIDDEN_NOT_TEAM_LEAD');
    });

    it('returns AMBIGUOUS_TEAM_LEAD when leading multiple teams without teamName', async () => {
      teamsStore.getTeamLeadTeams.mockResolvedValue([
        makeTeam({ id: 'team-1', name: 'Team A' }),
        makeTeam({ id: 'team-2', name: 'Team B' }),
      ]);

      const result = await service.createTeamAgent(baseInput);

      expect('error' in result).toBe(true);
      expect((result as { error: { code: string } }).error.code).toBe('AMBIGUOUS_TEAM_LEAD');
    });

    it('resolves correct team when teamName is provided', async () => {
      teamsStore.getTeamLeadTeams.mockResolvedValue([
        makeTeam({ id: 'team-1', name: 'Team A' }),
        makeTeam({ id: 'team-2', name: 'Team B' }),
      ]);
      teamsStore.listConfigsForTeam.mockResolvedValue([
        {
          id: 'config-1',
          profileId: PROFILE_A,
          providerId: 'p1',
          name: 'claude-sonnet',
          description: null,
          options: null,
          env: null,
          position: 0,
        },
      ]);

      const result = await service.createTeamAgent({ ...baseInput, teamName: 'Team B' });

      expect('agent' in result).toBe(true);
      expect(teamsStore.createTeamAgentAtomicCapped).toHaveBeenCalledWith(
        expect.objectContaining({ teamId: 'team-2' }),
      );
    });

    it('returns TEAM_NOT_FOUND_OR_NOT_LED for wrong teamName', async () => {
      const result = await service.createTeamAgent({ ...baseInput, teamName: 'Non-existent' });

      expect('error' in result).toBe(true);
      expect((result as { error: { code: string } }).error.code).toBe('TEAM_NOT_FOUND_OR_NOT_LED');
    });

    it('returns CONFIG_NOT_FOUND when no matching config', async () => {
      teamsStore.listConfigsForTeam.mockResolvedValue([]);

      const result = await service.createTeamAgent({ ...baseInput, configName: 'missing' });

      expect('error' in result).toBe(true);
      expect((result as { error: { code: string } }).error.code).toBe('CONFIG_NOT_FOUND');
    });

    it('returns AMBIGUOUS_CONFIG_NAME when multiple configs match without profileName', async () => {
      teamsStore.listConfigsForTeam.mockResolvedValue([
        {
          id: 'c1',
          profileId: PROFILE_A,
          providerId: 'p1',
          name: 'claude-sonnet',
          description: null,
          options: null,
          env: null,
          position: 0,
        },
        {
          id: 'c2',
          profileId: PROFILE_B,
          providerId: 'p2',
          name: 'claude-sonnet',
          description: null,
          options: null,
          env: null,
          position: 0,
        },
      ]);
      storageService.getAgentProfile.mockImplementation((id: string) =>
        Promise.resolve(makeProfile(id)),
      );

      const result = await service.createTeamAgent(baseInput);

      expect('error' in result).toBe(true);
      expect((result as { error: { code: string } }).error.code).toBe('AMBIGUOUS_CONFIG_NAME');
    });

    it('resolves config with profileName disambiguator', async () => {
      teamsStore.listConfigsForTeam.mockResolvedValue([
        {
          id: 'c1',
          profileId: PROFILE_A,
          providerId: 'p1',
          name: 'claude-sonnet',
          description: null,
          options: null,
          env: null,
          position: 0,
        },
        {
          id: 'c2',
          profileId: PROFILE_B,
          providerId: 'p2',
          name: 'claude-sonnet',
          description: null,
          options: null,
          env: null,
          position: 0,
        },
      ]);
      storageService.getAgentProfile.mockImplementation((id: string) =>
        Promise.resolve(makeProfile(id)),
      );

      const result = await service.createTeamAgent({
        ...baseInput,
        profileName: `Profile-${PROFILE_B}`,
      });

      expect('agent' in result).toBe(true);
    });

    it('returns AGENT_NAME_EXISTS for duplicate name', async () => {
      storageService.listAgents.mockResolvedValue({
        items: [{ ...makeAgent(AGENT_A), name: 'New Agent' }],
        total: 1,
        limit: 10000,
        offset: 0,
      });

      const result = await service.createTeamAgent(baseInput);

      expect('error' in result).toBe(true);
      expect((result as { error: { code: string } }).error.code).toBe('AGENT_NAME_EXISTS');
    });

    it('publishes agent.created with actor after createTeamAgent succeeds', async () => {
      const result = await service.createTeamAgent(baseInput);

      expect('agent' in result).toBe(true);
      expect(eventsService.publish).toHaveBeenCalledWith('agent.created', {
        agentId: expect.any(String),
        agentName: 'New Agent',
        projectId: PROJECT_ID,
        profileId: PROFILE_A,
        providerConfigId: 'config-1',
        actor: { type: 'agent', id: AGENT_A },
      });
    });

    it('swallows publish failure in createTeamAgent', async () => {
      eventsService.publish.mockRejectedValueOnce(new Error('publish failed'));

      const result = await service.createTeamAgent(baseInput);

      expect('agent' in result).toBe(true);
      const success = result as { agent: { id: string; name: string }; teamName: string };
      expect(success.agent.name).toBe('New Agent');
      expect(eventsService.publish).toHaveBeenCalled();
    });

    it('returns TEAM_LEAD_CREATION_DISABLED when allowTeamLeadCreateAgents is false', async () => {
      teamsStore.getTeamLeadTeams.mockResolvedValue([
        makeTeam({ allowTeamLeadCreateAgents: false }),
      ]);

      const result = await service.createTeamAgent(baseInput);

      expect('error' in result).toBe(true);
      const err = result as { error: { code: string } };
      expect(err.error.code).toBe('TEAM_LEAD_CREATION_DISABLED');
    });

    it('returns TEAM_LEAD_CREATION_DISABLED before cap-reached when both apply', async () => {
      teamsStore.getTeamLeadTeams.mockResolvedValue([
        makeTeam({ allowTeamLeadCreateAgents: false, maxMembers: 2 }),
      ]);

      const result = await service.createTeamAgent(baseInput);

      expect('error' in result).toBe(true);
      const err = result as { error: { code: string } };
      expect(err.error.code).toBe('TEAM_LEAD_CREATION_DISABLED');
    });

    it('returns TEAM_NOT_FOUND when teamName invalid even if flag is false', async () => {
      teamsStore.getTeamLeadTeams.mockResolvedValue([
        makeTeam({ allowTeamLeadCreateAgents: false }),
      ]);

      const result = await service.createTeamAgent({
        ...baseInput,
        teamName: 'nonexistent',
      });

      expect('error' in result).toBe(true);
      const err = result as { error: { code: string } };
      expect(err.error.code).toBe('TEAM_NOT_FOUND_OR_NOT_LED');
    });

    it('publishes team.member.added with correct payload on MCP path', async () => {
      await service.createTeamAgent(baseInput);

      expect(eventsService.publish).toHaveBeenCalledWith('team.member.added', {
        teamId: 'team-1',
        projectId: PROJECT_ID,
        teamLeadAgentId: AGENT_A,
        teamName: 'Backend Team',
        addedAgentId: expect.any(String),
        addedAgentName: 'New Agent',
      });
    });

    it('publishes agent.created before team.member.added (ordering)', async () => {
      const callOrder: string[] = [];
      eventsService.publish.mockImplementation(async (event: string) => {
        callOrder.push(event);
      });

      await service.createTeamAgent(baseInput);

      expect(callOrder).toEqual(['agent.created', 'team.member.added']);
    });

    it('best-effort: team.member.added failure does not prevent successful return', async () => {
      eventsService.publish
        .mockResolvedValueOnce('event-id-1')
        .mockRejectedValueOnce(new Error('team.member.added publish failed'));

      const result = await service.createTeamAgent(baseInput);

      expect('agent' in result).toBe(true);
      const success = result as { agent: { id: string; name: string }; teamName: string };
      expect(success.agent.name).toBe('New Agent');
      expect(eventsService.publish).toHaveBeenCalledTimes(2);
    });

    it('does not publish any events when validation rejects early', async () => {
      teamsStore.getTeamLeadTeams.mockResolvedValue([]);

      await service.createTeamAgent(baseInput);

      expect(eventsService.publish).not.toHaveBeenCalled();
    });
  });

  describe('canDeleteAgent', () => {
    it('returns canDelete=true when agent leads no teams', async () => {
      teamsStore.getTeamLeadTeams.mockResolvedValue([]);

      const result = await service.canDeleteAgent(AGENT_A);

      expect(result).toEqual({ canDelete: true, blockingTeams: [] });
    });

    it('returns canDelete=true with blocking team names for informational warnings', async () => {
      teamsStore.getTeamLeadTeams.mockResolvedValue([
        makeTeam({ name: 'Backend Team' }),
        makeTeam({ name: 'Frontend Team' }),
      ]);

      const result = await service.canDeleteAgent(AGENT_A);

      expect(result).toEqual({
        canDelete: true,
        blockingTeams: ['Backend Team', 'Frontend Team'],
      });
    });
  });

  describe('profileConfigSelections validation', () => {
    const CONFIG_A1 = 'config-a1';
    const CONFIG_A2 = 'config-a2';
    const CONFIG_B1 = 'config-b1';

    beforeEach(() => {
      // Setup: config-a1 and config-a2 belong to PROFILE_A, config-b1 belongs to PROFILE_B
      storageService.getProfileProviderConfig.mockImplementation((id: string) => {
        if (id === CONFIG_B1) {
          return Promise.resolve({ id, profileId: PROFILE_B, name: `config-${id}` });
        }
        return Promise.resolve({ id, profileId: PROFILE_A, name: `config-${id}` });
      });
    });

    describe('createTeam', () => {
      beforeEach(() => {
        teamsStore.createTeam.mockResolvedValue(makeTeam());
      });

      it('passes deduped profileConfigSelections to store', async () => {
        await service.createTeam({
          projectId: PROJECT_ID,
          name: 'Team',
          memberAgentIds: [AGENT_A],
          profileIds: [PROFILE_A],
          profileConfigSelections: [{ profileId: PROFILE_A, configIds: [CONFIG_A1, CONFIG_A2] }],
        });

        expect(teamsStore.createTeam).toHaveBeenCalledWith(
          expect.objectContaining({
            profileConfigSelections: [{ profileId: PROFILE_A, configIds: [CONFIG_A1, CONFIG_A2] }],
          }),
        );
      });

      it('drops empty configIds entries (auto-revert)', async () => {
        await service.createTeam({
          projectId: PROJECT_ID,
          name: 'Team',
          memberAgentIds: [AGENT_A],
          profileIds: [PROFILE_A],
          profileConfigSelections: [{ profileId: PROFILE_A, configIds: [] }],
        });

        expect(teamsStore.createTeam).toHaveBeenCalledWith(
          expect.objectContaining({
            profileConfigSelections: [],
          }),
        );
      });

      it('rejects selection referencing profile not in profileIds', async () => {
        await expect(
          service.createTeam({
            projectId: PROJECT_ID,
            name: 'Team',
            memberAgentIds: [AGENT_A],
            profileIds: [PROFILE_A],
            profileConfigSelections: [{ profileId: PROFILE_B, configIds: [CONFIG_B1] }],
          }),
        ).rejects.toThrow(ValidationError);

        await expect(
          service.createTeam({
            projectId: PROJECT_ID,
            name: 'Team',
            memberAgentIds: [AGENT_A],
            profileIds: [PROFILE_A],
            profileConfigSelections: [{ profileId: PROFILE_B, configIds: [CONFIG_B1] }],
          }),
        ).rejects.toThrow('not linked to this team');
      });

      it('rejects config that belongs to wrong profile', async () => {
        await expect(
          service.createTeam({
            projectId: PROJECT_ID,
            name: 'Team',
            memberAgentIds: [AGENT_A],
            profileIds: [PROFILE_A, PROFILE_B],
            profileConfigSelections: [
              { profileId: PROFILE_B, configIds: [CONFIG_A1] }, // CONFIG_A1 belongs to PROFILE_A
            ],
          }),
        ).rejects.toThrow(ValidationError);

        await expect(
          service.createTeam({
            projectId: PROJECT_ID,
            name: 'Team',
            memberAgentIds: [AGENT_A],
            profileIds: [PROFILE_A, PROFILE_B],
            profileConfigSelections: [{ profileId: PROFILE_B, configIds: [CONFIG_A1] }],
          }),
        ).rejects.toThrow(`belongs to profile`);
      });

      it('dedupes duplicate profileIds in selections', async () => {
        await service.createTeam({
          projectId: PROJECT_ID,
          name: 'Team',
          memberAgentIds: [AGENT_A],
          profileIds: [PROFILE_A],
          profileConfigSelections: [
            { profileId: PROFILE_A, configIds: [CONFIG_A1] },
            { profileId: PROFILE_A, configIds: [CONFIG_A2] }, // duplicate profileId
          ],
        });

        expect(teamsStore.createTeam).toHaveBeenCalledWith(
          expect.objectContaining({
            profileConfigSelections: [{ profileId: PROFILE_A, configIds: [CONFIG_A1] }],
          }),
        );
      });

      it('dedupes duplicate configIds within a selection', async () => {
        await service.createTeam({
          projectId: PROJECT_ID,
          name: 'Team',
          memberAgentIds: [AGENT_A],
          profileIds: [PROFILE_A],
          profileConfigSelections: [
            { profileId: PROFILE_A, configIds: [CONFIG_A1, CONFIG_A1, CONFIG_A2] },
          ],
        });

        expect(teamsStore.createTeam).toHaveBeenCalledWith(
          expect.objectContaining({
            profileConfigSelections: [{ profileId: PROFILE_A, configIds: [CONFIG_A1, CONFIG_A2] }],
          }),
        );
      });
    });

    describe('updateTeam', () => {
      beforeEach(() => {
        teamsStore.getTeam.mockResolvedValue(
          makeTeamWithMembers(
            {},
            [makeMember('team-1', AGENT_A), makeMember('team-1', AGENT_B)],
            [PROFILE_A, PROFILE_B],
          ),
        );
        teamsStore.updateTeam.mockResolvedValue(makeTeam());
      });

      it('uses effectiveProfileIds from current team when profileIds not provided', async () => {
        // Current team has PROFILE_A and PROFILE_B; we only send selections
        await service.updateTeam('team-1', {
          profileConfigSelections: [{ profileId: PROFILE_B, configIds: [CONFIG_B1] }],
        });

        expect(teamsStore.updateTeam).toHaveBeenCalledWith(
          'team-1',
          expect.objectContaining({
            profileConfigSelections: [{ profileId: PROFILE_B, configIds: [CONFIG_B1] }],
          }),
        );
      });

      it('passes filtered selections to store', async () => {
        await service.updateTeam('team-1', {
          profileConfigSelections: [
            { profileId: PROFILE_A, configIds: [CONFIG_A1] },
            { profileId: PROFILE_B, configIds: [] }, // empty -> filtered out
          ],
        });

        expect(teamsStore.updateTeam).toHaveBeenCalledWith(
          'team-1',
          expect.objectContaining({
            profileConfigSelections: [{ profileId: PROFILE_A, configIds: [CONFIG_A1] }],
          }),
        );
      });

      it('passes profileConfigSelections as undefined when caller omits selections', async () => {
        await service.updateTeam('team-1', {
          profileIds: [PROFILE_A, PROFILE_B],
        });

        const storeCall = teamsStore.updateTeam.mock.calls[0];
        expect(storeCall[1].profileConfigSelections).toBeUndefined();
      });

      it('rejects selection referencing profile not in effectiveProfileIds', async () => {
        // Update with new profileIds that don't include PROFILE_B
        await expect(
          service.updateTeam('team-1', {
            profileIds: [PROFILE_A],
            profileConfigSelections: [{ profileId: PROFILE_B, configIds: [CONFIG_B1] }],
          }),
        ).rejects.toThrow(ValidationError);

        await expect(
          service.updateTeam('team-1', {
            profileIds: [PROFILE_A],
            profileConfigSelections: [{ profileId: PROFILE_B, configIds: [CONFIG_B1] }],
          }),
        ).rejects.toThrow('not linked to this team');
      });
    });
  });

  describe('createTeamAgentForRest', () => {
    const CONFIG_ID = 'config-rest-1';
    const baseInput = {
      actorLeadAgentId: AGENT_A,
      projectId: PROJECT_ID,
      teamId: 'team-1',
      providerConfigId: CONFIG_ID,
      name: 'New Agent',
    };

    beforeEach(() => {
      teamsStore.getTeam.mockResolvedValue(
        makeTeamWithMembers({}, [makeMember('team-1', AGENT_A)], [PROFILE_A]),
      );
      storageService.getProfileProviderConfig.mockResolvedValue({
        id: CONFIG_ID,
        profileId: PROFILE_A,
        name: 'default-config',
        description: 'Config desc',
      });
      storageService.getAgentProfile.mockResolvedValue(makeProfile(PROFILE_A));
      teamsStore.listProfilesForTeam.mockResolvedValue([PROFILE_A]);
      storageService.listAgents.mockResolvedValue({ items: [] });
      teamsStore.createTeamAgentAtomicCapped.mockImplementation(async (opts) => {
        const agent = await opts.createAgentFn();
        return agent;
      });
      storageService.createAgent.mockImplementation(async (data) => ({
        id: 'created-1',
        ...data,
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
        modelOverride: null,
      }));
    });

    it('creates agent successfully (happy path)', async () => {
      const result = await service.createTeamAgentForRest(baseInput);
      expect(result.id).toBe('created-1');
      expect(result.name).toBe('New Agent');
    });

    it('throws NotFoundError when team does not exist', async () => {
      teamsStore.getTeam.mockResolvedValue(null);
      await expect(service.createTeamAgentForRest(baseInput)).rejects.toThrow(NotFoundError);
    });

    it('throws ValidationError when team has no lead', async () => {
      teamsStore.getTeam.mockResolvedValue(
        makeTeamWithMembers(
          { teamLeadAgentId: null },
          [makeMember('team-1', AGENT_A)],
          [PROFILE_A],
        ),
      );
      await expect(service.createTeamAgentForRest(baseInput)).rejects.toThrow('Team has no lead');
    });

    it('throws ValidationError when actor is not team lead', async () => {
      await expect(
        service.createTeamAgentForRest({ ...baseInput, actorLeadAgentId: AGENT_B }),
      ).rejects.toThrow('Not team lead');
    });

    it('throws ValidationError when profile is not linked to team', async () => {
      teamsStore.listProfilesForTeam.mockResolvedValue([]);
      await expect(service.createTeamAgentForRest(baseInput)).rejects.toThrow(
        'Profile not linked to team',
      );
    });

    it('throws NotFoundError when config profile belongs to different project', async () => {
      storageService.getAgentProfile.mockResolvedValue(makeProfile(PROFILE_A, 'other-project'));
      await expect(service.createTeamAgentForRest(baseInput)).rejects.toThrow(NotFoundError);
    });

    it('throws ConflictError on duplicate agent name', async () => {
      storageService.listAgents.mockResolvedValue({
        items: [{ name: 'New Agent' }],
      });
      await expect(service.createTeamAgentForRest(baseInput)).rejects.toThrow(ConflictError);
    });

    it('propagates NotFoundError when config does not exist', async () => {
      storageService.getProfileProviderConfig.mockRejectedValue(
        new NotFoundError('ProfileProviderConfig'),
      );
      await expect(service.createTeamAgentForRest(baseInput)).rejects.toThrow(NotFoundError);
    });

    it('propagates NotFoundError when profile does not exist', async () => {
      storageService.getAgentProfile.mockRejectedValue(new NotFoundError('AgentProfile'));
      await expect(service.createTeamAgentForRest(baseInput)).rejects.toThrow(NotFoundError);
    });

    it('description fallback: input > config > empty', async () => {
      await service.createTeamAgentForRest({ ...baseInput, description: 'Explicit' });
      expect(storageService.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({ description: 'Explicit' }),
      );

      storageService.createAgent.mockClear();
      await service.createTeamAgentForRest({ ...baseInput });
      expect(storageService.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({ description: 'Config desc' }),
      );

      storageService.createAgent.mockClear();
      storageService.getProfileProviderConfig.mockResolvedValue({
        id: CONFIG_ID,
        profileId: PROFILE_A,
        name: 'default-config',
        description: null,
      });
      await service.createTeamAgentForRest({ ...baseInput });
      expect(storageService.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({ description: '' }),
      );
    });

    it('succeeds when allowTeamLeadCreateAgents is false (flag is MCP-only)', async () => {
      teamsStore.getTeam.mockResolvedValue(
        makeTeamWithMembers(
          { allowTeamLeadCreateAgents: false },
          [makeMember('team-1', AGENT_A)],
          [PROFILE_A],
        ),
      );

      const result = await service.createTeamAgentForRest(baseInput);
      expect(result.id).toBe('created-1');
      expect(result.name).toBe('New Agent');
    });

    it('throws capacity-reached when flag is false AND at cap', async () => {
      teamsStore.getTeam.mockResolvedValue(
        makeTeamWithMembers(
          { allowTeamLeadCreateAgents: false, maxMembers: 1 },
          [makeMember('team-1', AGENT_A)],
          [PROFILE_A],
        ),
      );
      teamsStore.createTeamAgentAtomicCapped.mockRejectedValue(
        new (await import('../../../common/errors/error-types')).TeamMemberCapReachedError(
          'team-1',
          1,
        ),
      );

      await expect(service.createTeamAgentForRest(baseInput)).rejects.toThrow(ConflictError);
    });

    it('publishes team.member.added after successful agent creation', async () => {
      await service.createTeamAgentForRest(baseInput);

      expect(eventsService.publish).toHaveBeenCalledWith(
        'team.member.added',
        expect.objectContaining({
          teamId: 'team-1',
          projectId: PROJECT_ID,
          teamLeadAgentId: AGENT_A,
          teamName: 'Test Team',
          addedAgentId: 'created-1',
          addedAgentName: 'New Agent',
        }),
      );
    });
  });

  describe('deleteTeamAgent', () => {
    const team1 = makeTeam({ id: 'team-1', teamLeadAgentId: AGENT_A });
    const team2 = makeTeam({ id: 'team-2', name: 'Second Team', teamLeadAgentId: AGENT_C });

    function setupHappyPath() {
      teamsStore.getTeamLeadTeams.mockResolvedValue([team1]);
      teamsStore.getTeam.mockResolvedValue(
        makeTeamWithMembers(
          { id: 'team-1', teamLeadAgentId: AGENT_A },
          [makeMember('team-1', AGENT_A), makeMember('team-1', AGENT_B)],
          [],
        ),
      );
      teamsStore.listTeamsByAgent.mockResolvedValue([team1]);
    }

    it('deletes a non-lead team member successfully', async () => {
      setupHappyPath();

      const result = await service.deleteTeamAgent({
        leadAgentId: AGENT_A,
        projectId: PROJECT_ID,
        name: 'Agent-agent-b',
      });

      expect(result).toEqual({
        result: {
          deletedAgentId: AGENT_B,
          deletedAgentName: `Agent-${AGENT_B}`,
          teamName: 'Test Team',
        },
      });
      expect(storageService.deleteAgent).toHaveBeenCalledWith(AGENT_B);
    });

    it('publishes both team.member.removed and agent.deleted events', async () => {
      setupHappyPath();

      await service.deleteTeamAgent({
        leadAgentId: AGENT_A,
        projectId: PROJECT_ID,
        name: 'Agent-agent-b',
      });

      expect(eventsService.publish).toHaveBeenCalledWith(
        'team.member.removed',
        expect.objectContaining({
          teamId: 'team-1',
          projectId: PROJECT_ID,
          removedAgentId: AGENT_B,
        }),
      );
      expect(eventsService.publish).toHaveBeenCalledWith(
        'agent.deleted',
        expect.objectContaining({
          agentId: AGENT_B,
          projectId: PROJECT_ID,
          actor: { type: 'agent', id: AGENT_A },
          teamId: 'team-1',
          teamName: 'Test Team',
        }),
      );
    });

    it('returns FORBIDDEN_NOT_TEAM_LEAD when caller leads no teams', async () => {
      teamsStore.getTeamLeadTeams.mockResolvedValue([]);

      const result = await service.deleteTeamAgent({
        leadAgentId: AGENT_B,
        projectId: PROJECT_ID,
        name: 'Agent-agent-a',
      });

      expect(result).toEqual({
        error: expect.objectContaining({ code: 'FORBIDDEN_NOT_TEAM_LEAD' }),
      });
    });

    it('returns AMBIGUOUS_TEAM_LEAD when caller leads multiple teams without teamName', async () => {
      teamsStore.getTeamLeadTeams.mockResolvedValue([
        makeTeam({ id: 'team-1', teamLeadAgentId: AGENT_A }),
        makeTeam({ id: 'team-x', name: 'Other Team', teamLeadAgentId: AGENT_A }),
      ]);

      const result = await service.deleteTeamAgent({
        leadAgentId: AGENT_A,
        projectId: PROJECT_ID,
        name: 'Agent-agent-b',
      });

      expect(result).toEqual({
        error: expect.objectContaining({ code: 'AMBIGUOUS_TEAM_LEAD' }),
      });
    });

    it('returns TEAM_NOT_FOUND_OR_NOT_LED for explicit teamName not led', async () => {
      teamsStore.getTeamLeadTeams.mockResolvedValue([team1]);

      const result = await service.deleteTeamAgent({
        leadAgentId: AGENT_A,
        projectId: PROJECT_ID,
        name: 'Agent-agent-b',
        teamName: 'Nonexistent Team',
      });

      expect(result).toEqual({
        error: expect.objectContaining({ code: 'TEAM_NOT_FOUND_OR_NOT_LED' }),
      });
    });

    it('returns AGENT_NOT_FOUND_IN_TEAM when name does not match', async () => {
      teamsStore.getTeamLeadTeams.mockResolvedValue([team1]);
      teamsStore.getTeam.mockResolvedValue(
        makeTeamWithMembers(
          { id: 'team-1', teamLeadAgentId: AGENT_A },
          [makeMember('team-1', AGENT_A)],
          [],
        ),
      );

      const result = await service.deleteTeamAgent({
        leadAgentId: AGENT_A,
        projectId: PROJECT_ID,
        name: 'No Such Agent',
      });

      expect(result).toEqual({
        error: expect.objectContaining({ code: 'AGENT_NOT_FOUND_IN_TEAM' }),
      });
    });

    it('returns AMBIGUOUS_AGENT_NAME when multiple members match case-insensitively', async () => {
      const agentAlpha = { ...makeAgent('agent-alpha'), name: 'alpha' };
      const agentAlphaUpper = { ...makeAgent('agent-alpha-upper'), name: 'ALPHA' };

      teamsStore.getTeamLeadTeams.mockResolvedValue([team1]);
      teamsStore.getTeam.mockResolvedValue(
        makeTeamWithMembers(
          { id: 'team-1', teamLeadAgentId: AGENT_A },
          [
            makeMember('team-1', AGENT_A),
            makeMember('team-1', 'agent-alpha'),
            makeMember('team-1', 'agent-alpha-upper'),
          ],
          [],
        ),
      );
      storageService.listAgents.mockResolvedValue({
        items: [makeAgent(AGENT_A), agentAlpha, agentAlphaUpper],
        total: 3,
        limit: 10000,
        offset: 0,
      });

      const result = await service.deleteTeamAgent({
        leadAgentId: AGENT_A,
        projectId: PROJECT_ID,
        name: 'alpha',
      });

      expect(result).toEqual({
        error: expect.objectContaining({ code: 'AMBIGUOUS_AGENT_NAME' }),
      });
    });

    it('returns CANNOT_DELETE_TEAM_LEAD when target is the team lead', async () => {
      teamsStore.getTeamLeadTeams.mockResolvedValue([team1]);
      teamsStore.getTeam.mockResolvedValue(
        makeTeamWithMembers(
          { id: 'team-1', teamLeadAgentId: AGENT_A },
          [makeMember('team-1', AGENT_A), makeMember('team-1', AGENT_B)],
          [],
        ),
      );

      const result = await service.deleteTeamAgent({
        leadAgentId: AGENT_A,
        projectId: PROJECT_ID,
        name: `Agent-${AGENT_A}`,
      });

      expect(result).toEqual({
        error: expect.objectContaining({ code: 'CANNOT_DELETE_TEAM_LEAD' }),
      });
    });

    it('returns TARGET_LEADS_OTHER_TEAM when target leads another team', async () => {
      setupHappyPath();
      teamsStore.listTeamsByAgent.mockResolvedValue([
        team1,
        makeTeam({ id: 'team-x', teamLeadAgentId: AGENT_B }),
      ]);

      const result = await service.deleteTeamAgent({
        leadAgentId: AGENT_A,
        projectId: PROJECT_ID,
        name: `Agent-${AGENT_B}`,
      });

      expect(result).toEqual({
        error: expect.objectContaining({ code: 'TARGET_LEADS_OTHER_TEAM' }),
      });
    });

    it('returns TARGET_BELONGS_TO_OTHER_TEAM when target is in another team', async () => {
      setupHappyPath();
      teamsStore.listTeamsByAgent.mockResolvedValue([team1, team2]);

      const result = await service.deleteTeamAgent({
        leadAgentId: AGENT_A,
        projectId: PROJECT_ID,
        name: `Agent-${AGENT_B}`,
      });

      expect(result).toEqual({
        error: expect.objectContaining({ code: 'TARGET_BELONGS_TO_OTHER_TEAM' }),
      });
    });

    it('auto-terminates running sessions before deletion', async () => {
      setupHappyPath();
      sessionsService.listActiveSessions.mockResolvedValue([{ id: 'sess-1' }, { id: 'sess-2' }]);

      await service.deleteTeamAgent({
        leadAgentId: AGENT_A,
        projectId: PROJECT_ID,
        name: `Agent-${AGENT_B}`,
      });

      expect(sessionsService.listActiveSessions).toHaveBeenCalledWith(
        PROJECT_ID,
        new Set([AGENT_B]),
      );
      expect(sessionsService.terminateSession).toHaveBeenCalledWith('sess-1');
      expect(sessionsService.terminateSession).toHaveBeenCalledWith('sess-2');
      expect(storageService.deleteAgent).toHaveBeenCalledWith(AGENT_B);
    });

    it('proceeds to delete even when session termination fails', async () => {
      setupHappyPath();
      sessionsService.listActiveSessions.mockResolvedValue([{ id: 'sess-1' }]);
      sessionsService.terminateSession.mockRejectedValue(new Error('tmux gone'));

      const result = await service.deleteTeamAgent({
        leadAgentId: AGENT_A,
        projectId: PROJECT_ID,
        name: `Agent-${AGENT_B}`,
      });

      expect(storageService.deleteAgent).toHaveBeenCalledWith(AGENT_B);
      expect(result).toHaveProperty('result');
    });

    it('returns AGENT_HAS_RUNNING_SESSIONS on ConflictError from storage', async () => {
      setupHappyPath();
      storageService.deleteAgent.mockRejectedValue(
        new ConflictError('Cannot delete agent: 1 active session(s)'),
      );

      const result = await service.deleteTeamAgent({
        leadAgentId: AGENT_A,
        projectId: PROJECT_ID,
        name: `Agent-${AGENT_B}`,
      });

      expect(result).toEqual({
        error: expect.objectContaining({ code: 'AGENT_HAS_RUNNING_SESSIONS' }),
      });
    });

    it('re-throws unexpected errors from storage.deleteAgent', async () => {
      setupHappyPath();
      storageService.deleteAgent.mockRejectedValue(new Error('Unexpected DB failure'));

      await expect(
        service.deleteTeamAgent({
          leadAgentId: AGENT_A,
          projectId: PROJECT_ID,
          name: `Agent-${AGENT_B}`,
        }),
      ).rejects.toThrow('Unexpected DB failure');
    });

    it('resolves team by explicit teamName', async () => {
      teamsStore.getTeamLeadTeams.mockResolvedValue([
        team1,
        makeTeam({ id: 'team-x', name: 'Other Team', teamLeadAgentId: AGENT_A }),
      ]);
      teamsStore.getTeam.mockResolvedValue(
        makeTeamWithMembers(
          { id: 'team-1', teamLeadAgentId: AGENT_A },
          [makeMember('team-1', AGENT_A), makeMember('team-1', AGENT_B)],
          [],
        ),
      );
      teamsStore.listTeamsByAgent.mockResolvedValue([team1]);

      const result = await service.deleteTeamAgent({
        leadAgentId: AGENT_A,
        projectId: PROJECT_ID,
        name: `Agent-${AGENT_B}`,
        teamName: 'Test Team',
      });

      expect(result).toHaveProperty('result');
    });
  });
});
