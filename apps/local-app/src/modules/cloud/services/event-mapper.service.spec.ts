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

  it('maps epic.comment.created with projectId for ingest forwarding', () => {
    const payload = {
      commentId: 'comment-1',
      epicId: 'epic-1',
      projectId: 'project-1',
      parentId: 'parent-1',
      authorName: 'Coder',
      content: 'hello',
      actor: null,
    };

    const result = service.mapToIngestPayload(
      { name: 'epic.comment.created', payload },
      'evt-epic-comment-1',
      'user-1',
    );

    expect(result.sourceEventType).toBe('epic.comment.created');
    expect(result.projectId).toBe('project-1');
    expect(result.payload).toEqual(payload);
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
});
