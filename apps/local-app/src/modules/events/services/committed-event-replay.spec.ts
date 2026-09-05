import { ZodError } from 'zod';
import { parseCommittedEventPayloadForReplay } from './committed-event-replay';

describe('parseCommittedEventPayloadForReplay', () => {
  const common = {
    connectionId: 'legacy-connection',
    provider: 'clickup' as const,
    generation: 3,
    subtaskSyncEnabled: true,
    syncSettingRevision: 2,
  };

  it.each([
    {
      name: 'integration.connection.created' as const,
      payload: {
        ...common,
        createdAt: '2026-08-25T00:00:00.000Z',
        updatedAt: '2026-08-25T01:00:00.000Z',
      },
    },
    {
      name: 'integration.connection.updated' as const,
      payload: {
        ...common,
        previousGeneration: 2,
        previousSubtaskSyncEnabled: false,
        previousSyncSettingRevision: 1,
        createdAt: '2026-08-25T00:00:00.000Z',
        updatedAt: '2026-08-25T01:00:00.000Z',
      },
    },
    {
      name: 'integration.connection.deleted' as const,
      payload: {
        ...common,
        deletedAt: '2026-08-25T01:00:00.000Z',
      },
    },
  ])('accepts replay-only legacy $name payloads', ({ name, payload }) => {
    expect(parseCommittedEventPayloadForReplay(name, payload)).toEqual(payload);
  });

  it('prefers and preserves the strict current payload', () => {
    const payload = {
      ...common,
      projectId: 'project-1',
      createdAt: '2026-08-25T00:00:00.000Z',
      updatedAt: '2026-08-25T01:00:00.000Z',
    };

    expect(parseCommittedEventPayloadForReplay('integration.connection.created', payload)).toEqual(
      payload,
    );
  });

  it('does not weaken legacy replay with unknown fields', () => {
    expect(() =>
      parseCommittedEventPayloadForReplay('integration.connection.deleted', {
        ...common,
        deletedAt: '2026-08-25T01:00:00.000Z',
        unexpected: true,
      }),
    ).toThrow(ZodError);
  });
});
