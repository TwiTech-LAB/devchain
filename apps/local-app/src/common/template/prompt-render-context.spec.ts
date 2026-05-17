import { buildPromptRenderContext, RECIPIENT_CONTEXT_KEYS } from './prompt-render-context';
import type { TeamsLookup } from './agent-recipient-context';
import { ServiceUnavailableError } from '../errors/service-unavailable.error';

function makeTeamsLookup(teams: Array<{ name: string; teamLeadAgentId?: string }>): TeamsLookup {
  return {
    listTeamsByAgent: jest
      .fn()
      .mockResolvedValue(
        teams.map((t) => ({ name: t.name, teamLeadAgentId: t.teamLeadAgentId ?? 'other-agent' })),
      ),
  };
}

describe('buildPromptRenderContext', () => {
  describe('Recipient context shape', () => {
    it('no recipientAgentId → empty recipient vars, no IO', async () => {
      const teams = makeTeamsLookup([]);
      const result = await buildPromptRenderContext({ teams });

      expect(result.vars).toEqual(
        expect.objectContaining({
          team_name: '',
          team_names: '',
          is_team_lead: false,
        }),
      );
      expect(teams.listTeamsByAgent).not.toHaveBeenCalled();
    });

    it('recipient with no team membership → empty team vars', async () => {
      const teams = makeTeamsLookup([]);
      const result = await buildPromptRenderContext({
        recipientAgentId: 'agent-1',
        teams,
      });

      expect(result.vars.team_name).toBe('');
      expect(result.vars.team_names).toBe('');
      expect(result.vars.is_team_lead).toBe(false);
    });

    it('recipient leads single team "Backend"', async () => {
      const teams = makeTeamsLookup([{ name: 'Backend', teamLeadAgentId: 'agent-1' }]);
      const result = await buildPromptRenderContext({
        recipientAgentId: 'agent-1',
        teams,
      });

      expect(result.vars.team_name).toBe('Backend');
      expect(result.vars.team_names).toBe('Backend');
      expect(result.vars.is_team_lead).toBe(true);
    });

    it('recipient is member-only of single team "Backend"', async () => {
      const teams = makeTeamsLookup([{ name: 'Backend', teamLeadAgentId: 'other-agent' }]);
      const result = await buildPromptRenderContext({
        recipientAgentId: 'agent-1',
        teams,
      });

      expect(result.vars.team_name).toBe('Backend');
      expect(result.vars.team_names).toBe('Backend');
      expect(result.vars.is_team_lead).toBe(false);
    });

    it('recipient on two teams "Zebra" + "Alpha" → sorted, multi-team empty team_name', async () => {
      const teams = makeTeamsLookup([
        { name: 'Zebra', teamLeadAgentId: 'agent-1' },
        { name: 'Alpha', teamLeadAgentId: 'other-agent' },
      ]);
      const result = await buildPromptRenderContext({
        recipientAgentId: 'agent-1',
        teams,
      });

      expect(result.vars.team_name).toBe('');
      expect(result.vars.team_names).toBe('Alpha, Zebra');
      expect(result.vars.is_team_lead).toBe(true);
    });
  });

  describe('Extras passthrough', () => {
    it('extras merged into vars alongside recipient context', async () => {
      const teams = makeTeamsLookup([{ name: 'Backend', teamLeadAgentId: 'agent-1' }]);
      const result = await buildPromptRenderContext({
        recipientAgentId: 'agent-1',
        teams,
        extras: { agent_name: 'Claude', project_name: 'Devchain' },
      });

      expect(result.vars.agent_name).toBe('Claude');
      expect(result.vars.project_name).toBe('Devchain');
      expect(result.vars.team_name).toBe('Backend');
    });

    it('undefined extras → only recipient vars present', async () => {
      const teams = makeTeamsLookup([]);
      const result = await buildPromptRenderContext({
        recipientAgentId: 'agent-1',
        teams,
        extras: undefined,
      });

      expect(Object.keys(result.vars)).toEqual(['team_name', 'team_names', 'is_team_lead']);
    });
  });

  describe('Collision rejection', () => {
    it('extras with "team_name" throws collision error', async () => {
      const teams = makeTeamsLookup([]);
      await expect(
        buildPromptRenderContext({ teams, extras: { team_name: 'override' } }),
      ).rejects.toThrow(/team_name.*collides/);
    });

    it('extras with "team_names" throws collision error', async () => {
      const teams = makeTeamsLookup([]);
      await expect(
        buildPromptRenderContext({ teams, extras: { team_names: 'override' } }),
      ).rejects.toThrow(/team_names.*collides/);
    });

    it('extras with "is_team_lead" throws collision error', async () => {
      const teams = makeTeamsLookup([]);
      await expect(
        buildPromptRenderContext({ teams, extras: { is_team_lead: true } }),
      ).rejects.toThrow(/is_team_lead.*collides/);
    });

    it('inherited keys on extras prototype do NOT throw', async () => {
      const teams = makeTeamsLookup([]);
      const extras = Object.create({ team_name: 'inherited' });
      extras.safe_key = 'value';

      const result = await buildPromptRenderContext({ teams, extras });
      expect(result.vars.safe_key).toBe('value');
    });
  });

  describe('Failure semantics', () => {
    it('ServiceUnavailableError → resolves to empty recipient vars', async () => {
      const teams: TeamsLookup = {
        listTeamsByAgent: jest.fn().mockRejectedValue(new ServiceUnavailableError('TeamsService')),
      };

      const result = await buildPromptRenderContext({
        recipientAgentId: 'agent-1',
        teams,
      });

      expect(result.vars.team_name).toBe('');
      expect(result.vars.team_names).toBe('');
      expect(result.vars.is_team_lead).toBe(false);
    });

    it('other errors re-throw', async () => {
      const teams: TeamsLookup = {
        listTeamsByAgent: jest.fn().mockRejectedValue(new Error('DB connection lost')),
      };

      await expect(
        buildPromptRenderContext({ recipientAgentId: 'agent-1', teams }),
      ).rejects.toThrow('DB connection lost');
    });
  });

  describe('Cross-site invariant', () => {
    it('same agentId + same teams mock + different extras → identical recipient vars', async () => {
      const teams = makeTeamsLookup([{ name: 'Backend', teamLeadAgentId: 'agent-1' }]);

      const resultA = await buildPromptRenderContext({
        recipientAgentId: 'agent-1',
        teams,
        extras: { agent_name: 'Claude' },
      });

      const resultB = await buildPromptRenderContext({
        recipientAgentId: 'agent-1',
        teams,
        extras: { project_name: 'Devchain', session_id: '123' },
      });

      expect(resultA.vars.team_name).toBe(resultB.vars.team_name);
      expect(resultA.vars.team_names).toBe(resultB.vars.team_names);
      expect(resultA.vars.is_team_lead).toBe(resultB.vars.is_team_lead);
    });
  });

  describe('recipientLegacyVariables constant', () => {
    it('returns exact RECIPIENT_CONTEXT_KEYS contents', async () => {
      const teams = makeTeamsLookup([]);
      const result = await buildPromptRenderContext({ teams });

      expect(result.recipientLegacyVariables).toEqual(['team_name', 'team_names', 'is_team_lead']);
      expect(result.recipientLegacyVariables).toBe(RECIPIENT_CONTEXT_KEYS);
    });
  });
});
