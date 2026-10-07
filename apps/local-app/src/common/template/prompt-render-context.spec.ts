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

  describe('recipientLegacyVariables constant', () => {
    it('returns exact RECIPIENT_CONTEXT_KEYS contents', async () => {
      const teams = makeTeamsLookup([]);
      const result = await buildPromptRenderContext({ teams });

      expect(result.recipientLegacyVariables).toEqual(['team_name', 'team_names', 'is_team_lead']);
      expect(result.recipientLegacyVariables).toBe(RECIPIENT_CONTEXT_KEYS);
    });
  });
});
