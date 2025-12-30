import { findUnknownTokens, renderInviteTemplate } from './invite-template.util';

describe('invite-template util', () => {
  const baseContext = {
    threadId: 'thread-123',
    threadTitle: 'Squad Chat',
    inviterName: 'You',
    participantNames: 'Alpha Agent, Beta Agent',
    invitedAgentName: 'Gamma Agent',
    createdAt: '2024-03-01T10:00:00Z',
    messageId: 'message-123',
  };

  it('replaces variables and snippets in a custom template', () => {
    const template =
      'Hello {{ invited_agent_name }} in {{ thread_title }} ({{ thread_id }}). Ack: {{ mcp_ack_hint }}';

    const rendered = renderInviteTemplate(template, baseContext);

    expect(rendered).toContain('Hello Gamma Agent in Squad Chat');
    expect(rendered).toContain('thread_id: "thread-123"');
    expect(rendered).toContain('message_id: "message-123"');
    expect(rendered).toContain('agent_name: "Gamma Agent"');
  });

  it('falls back to default template when provided template is empty', () => {
    const rendered = renderInviteTemplate('', baseContext);

    expect(rendered).toContain('Welcome Gamma Agent to thread "Squad Chat" (thread-123).');
    expect(rendered).toContain('tools/call { name: "devchain_chat_list_members"');
  });

  it('reports unknown tokens for validation', () => {
    const tokens = findUnknownTokens('Hey {{ invited_agent_name }} {{ mystery_token }}');
    expect(tokens).toEqual(['mystery_token']);
  });
});
