import { EventMapperService } from './event-mapper.service';

describe('EventMapperService', () => {
  let service: EventMapperService;

  beforeEach(() => {
    service = new EventMapperService();
  });

  it('maps epic.deleted with projectId for ingest forwarding', () => {
    const payload = {
      epicId: 'epic-1',
      projectId: 'project-1',
      title: 'Deleted epic',
      parentId: null,
      actor: null,
    };

    const result = service.mapToIngestPayload(
      { name: 'epic.deleted', payload },
      'evt-epic-deleted-1',
      'user-1',
    );

    expect(result.source).toBe('workflow');
    expect(result.sourceEventType).toBe('epic.deleted');
    expect(result.sourceEventId).toBe('evt-epic-deleted-1');
    expect(result.forwardingUserId).toBe('user-1');
    expect(result.recipientMode).toBe('self');
    expect(result.projectId).toBe('project-1');
    expect(result.payload).toEqual(payload);
  });

  it('maps a generic AUQ notice without scoped identifiers or content', () => {
    const result = service.mapToGenericAskUserQuestionNotice(
      'auq.pending:internal-source-id',
      'user-1',
    );

    expect(result).toMatchObject({
      sourceEventId: 'auq.pending:internal-source-id',
      sourceEventType: 'claude.hooks.ask_user_question.pending',
      forwardingUserId: 'user-1',
      projectId: null,
      payload: { accountLevel: true },
    });
    expect(JSON.stringify(result.payload)).not.toMatch(
      /project|workspace|agent|session|tool|thread|question|deep.?link/i,
    );
  });

  it('keeps session events projectless for project-gating fallback behavior', () => {
    const payload = { sessionId: 's1', sessionName: 'session-1' };

    const result = service.mapToIngestPayload(
      { name: 'session.crashed', payload },
      'evt-session-1',
      'user-1',
    );

    expect(result.projectId).toBeNull();
    expect(result.sourceEventType).toBe('session.crashed');
  });

  it('projects ask_user_question.pending to identifiers only — strips question content', () => {
    const payload = {
      projectId: 'project-7',
      agentId: 'agent-7',
      sessionId: 'session-7',
      claudeSessionId: 'claude-7',
      toolUseId: 'tool-7',
      questions: [
        {
          question: 'SECRET PROMPT',
          header: 'H',
          multiSelect: false,
          options: [{ label: 'A', description: 'd' }],
        },
      ],
      createdAt: 1,
      expiresAt: 2,
    };

    const result = service.mapToIngestPayload(
      { name: 'claude.hooks.ask_user_question.pending', payload },
      'auq.pending:tool-7',
      'user-1',
      { instanceId: 'inst-9' },
    );

    expect(result.sourceEventType).toBe('claude.hooks.ask_user_question.pending');
    expect(result.projectId).toBe('project-7');
    expect(result.payload).toEqual({
      sessionId: 'session-7',
      agentId: 'agent-7',
      toolUseId: 'tool-7',
      projectId: 'project-7',
      claudeSessionId: 'claude-7',
      instanceId: 'inst-9',
    });
    // The sensitive question content must never be forwarded.
    expect(result.payload.questions).toBeUndefined();
  });

  it('omits instanceId from the AUQ payload when not provided', () => {
    const payload = {
      projectId: 'project-7',
      agentId: null,
      sessionId: 'session-7',
      claudeSessionId: 'claude-7',
      toolUseId: 'tool-7',
      questions: [
        {
          question: 'q',
          header: 'H',
          multiSelect: false,
          options: [{ label: 'A', description: 'd' }],
        },
      ],
      createdAt: 1,
      expiresAt: 2,
    };

    const result = service.mapToIngestPayload(
      { name: 'claude.hooks.ask_user_question.pending', payload },
      'auq.pending:tool-7',
      'user-1',
    );

    expect('instanceId' in result.payload).toBe(false);
    expect(result.payload.agentId).toBeNull();
  });
});
