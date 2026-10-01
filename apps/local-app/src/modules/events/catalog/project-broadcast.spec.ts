import { projectBroadcast } from './project-broadcast';
import type { BroadcastTopicEntry } from './broadcast-metadata';

describe('projectBroadcast', () => {
  it('resolves static topic/type and passes payload through when no projection', () => {
    const entry: BroadcastTopicEntry<Record<string, unknown>> = {
      topic: 'templates',
      type: 'changed',
    };

    expect(projectBroadcast(entry, { templateId: 't-1' })).toEqual({
      topic: 'templates',
      type: 'changed',
      payload: { templateId: 't-1' },
    });
  });

  it('evaluates function topic/type and applies the payload projection', () => {
    const entry: BroadcastTopicEntry<Record<string, unknown>> = {
      topic: (p) => `session/${p.sessionId}/transcript`,
      type: 'updated',
      payloadProjection: (p) => ({ sessionId: p.sessionId, newMessageCount: p.newMessageCount }),
    };

    expect(
      projectBroadcast(entry, { sessionId: 's1', newMessageCount: 3, transcriptPath: '/secret' }),
    ).toEqual({
      topic: 'session/s1/transcript',
      type: 'updated',
      payload: { sessionId: 's1', newMessageCount: 3 },
    });
  });

  it('supports a dynamic type function', () => {
    const entry: BroadcastTopicEntry<Record<string, unknown>> = {
      topic: (p) => `project/${p.projectId}/epics`,
      type: (p) => p.type as string,
      payloadProjection: (p) => p.data,
    };

    expect(
      projectBroadcast(entry, { projectId: 'p1', type: 'deleted', data: { epicId: 'e1' } }),
    ).toEqual({ topic: 'project/p1/epics', type: 'deleted', payload: { epicId: 'e1' } });
  });
});
