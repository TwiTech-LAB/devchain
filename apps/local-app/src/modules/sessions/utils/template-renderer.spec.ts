import { buildInitialPromptContext, renderInitialPromptTemplate } from './template-renderer';
import type { Team } from '@/modules/storage/models/domain.models';

function makeTeam(overrides: Partial<Team> & { name: string }): Team {
  return {
    id: overrides.id ?? 'team-1',
    projectId: 'proj-1',
    name: overrides.name,
    description: null,
    teamLeadAgentId: overrides.teamLeadAgentId ?? null,
    maxMembers: 10,
    maxConcurrentTasks: 3,
    allowTeamLeadCreateAgents: false,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };
}

describe('renderInitialPromptTemplate', () => {
  const context = {
    agent: { name: 'Claude' },
    project: { name: 'Devchain' },
    epic: { title: 'Implement Prompt Renderer' },
    provider: { name: 'claude' },
    profile: { name: 'Claude Default' },
    sessionId: 'session-123',
  };

  it('replaces supported variables with context values', () => {
    const template =
      'Agent {agent_name} for project {project_name} using provider {provider_name} profile {profile_name} session {session_id} epic {epic_title}';
    const rendered = renderInitialPromptTemplate(template, buildInitialPromptContext(context));

    expect(rendered).toBe(
      'Agent Claude for project Devchain using provider claude profile Claude Default session session-123 epic Implement Prompt Renderer',
    );
  });

  it('leaves unknown variables untouched', () => {
    const template = 'Hello {unknown_var}';
    const rendered = renderInitialPromptTemplate(template, buildInitialPromptContext(context));

    expect(rendered).toBe('Hello {unknown_var}');
  });

  it('returns empty strings when values are missing', () => {
    const template = 'Epic: {epic_title}';
    const rendered = renderInitialPromptTemplate(
      template,
      buildInitialPromptContext({
        ...context,
        epic: null,
      }),
    );

    expect(rendered).toBe('Epic: ');
  });

  it('treats optional epic token with question mark as empty when missing', () => {
    const template = 'Epic optional: {epic_title?}';
    const rendered = renderInitialPromptTemplate(
      template,
      buildInitialPromptContext({
        ...context,
        epic: null,
      }),
    );

    expect(rendered).toBe('Epic optional: ');
  });

  it('is case-insensitive for token names', () => {
    const template = 'Agent {AGENT_NAME} - Project {Project_Name}';
    const rendered = renderInitialPromptTemplate(template, buildInitialPromptContext(context));

    expect(rendered).toBe('Agent Claude - Project Devchain');
  });

  it('returns empty string for blank templates', () => {
    const rendered = renderInitialPromptTemplate('   ', buildInitialPromptContext(context));
    expect(rendered).toBe('');
  });

  it('builds template context with available values', () => {
    const ctx = buildInitialPromptContext(context);
    expect(ctx.agentName).toBe('Claude');
    expect(ctx.projectName).toBe('Devchain');
    expect(ctx.epicTitle).toBe('Implement Prompt Renderer');
    expect(ctx.providerName).toBe('claude');
    expect(ctx.profileName).toBe('Claude Default');
    expect(ctx.sessionId).toBe('session-123');
  });

  it('renders session_id_short as first 8 characters of session ID', () => {
    const template = 'Short ID: {session_id_short}';
    const uuidContext = {
      ...context,
      sessionId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    };
    const rendered = renderInitialPromptTemplate(template, buildInitialPromptContext(uuidContext));

    expect(rendered).toBe('Short ID: a1b2c3d4');
  });

  it('renders both session_id and session_id_short correctly', () => {
    const template = 'Full: {session_id}, Short: {session_id_short}';
    const uuidContext = {
      ...context,
      sessionId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    };
    const rendered = renderInitialPromptTemplate(template, buildInitialPromptContext(uuidContext));

    expect(rendered).toBe('Full: a1b2c3d4-e5f6-7890-abcd-ef1234567890, Short: a1b2c3d4');
  });

  it('renders session_id_short as empty when sessionId is missing', () => {
    const template = 'Short: {session_id_short}';
    const noSessionContext = {
      ...context,
      sessionId: '',
    };
    const rendered = renderInitialPromptTemplate(
      template,
      buildInitialPromptContext(noSessionContext),
    );

    expect(rendered).toBe('Short: ');
  });

  describe('team variables', () => {
    const AGENT_ID = 'agent-aaa';
    const teamContext = {
      ...context,
      agent: { name: 'Claude', id: AGENT_ID },
    };

    it('{team_name} legacy syntax works after preprocessor', () => {
      const ctx = buildInitialPromptContext({
        ...teamContext,
        teams: [makeTeam({ name: 'Backend', teamLeadAgentId: AGENT_ID })],
      });
      expect(renderInitialPromptTemplate('Team: {team_name}', ctx)).toBe('Team: Backend');
    });

    it('{{team_name}} native syntax works', () => {
      const ctx = buildInitialPromptContext({
        ...teamContext,
        teams: [makeTeam({ name: 'Backend', teamLeadAgentId: AGENT_ID })],
      });
      expect(renderInitialPromptTemplate('Team: {{team_name}}', ctx)).toBe('Team: Backend');
    });

    it('{{#if team_name}} renders when team present, omits when absent', () => {
      const tpl = '{{#if team_name}}Team: {{team_name}}{{/if}}';

      const withTeam = buildInitialPromptContext({
        ...teamContext,
        teams: [makeTeam({ name: 'Backend' })],
      });
      expect(renderInitialPromptTemplate(tpl, withTeam)).toBe('Team: Backend');

      const noTeam = buildInitialPromptContext({ ...teamContext, teams: [] });
      expect(renderInitialPromptTemplate(tpl, noTeam)).toBe('');
    });

    it('{{#if is_team_lead}} works for both true and false', () => {
      const tpl = '{{#if is_team_lead}}LEAD{{else}}MEMBER{{/if}}';

      const asLead = buildInitialPromptContext({
        ...teamContext,
        teams: [makeTeam({ name: 'Backend', teamLeadAgentId: AGENT_ID })],
      });
      expect(renderInitialPromptTemplate(tpl, asLead)).toBe('LEAD');

      const asMember = buildInitialPromptContext({
        ...teamContext,
        teams: [makeTeam({ name: 'Backend', teamLeadAgentId: 'other' })],
      });
      expect(renderInitialPromptTemplate(tpl, asMember)).toBe('MEMBER');
    });

    it('multi-team: team_name empty, team_names comma-joined sorted', () => {
      const ctx = buildInitialPromptContext({
        ...teamContext,
        teams: [makeTeam({ id: 't2', name: 'Zebra' }), makeTeam({ id: 't1', name: 'Alpha' })],
      });
      expect(renderInitialPromptTemplate('{{team_name}}', ctx)).toBe('');
      expect(renderInitialPromptTemplate('{{team_names}}', ctx)).toBe('Alpha, Zebra');
    });
  });
});
