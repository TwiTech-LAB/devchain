import { buildInitialPromptContext, renderInitialPromptTemplate } from './template-renderer';

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
});
