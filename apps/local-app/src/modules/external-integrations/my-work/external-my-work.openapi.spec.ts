import {
  TASK_DETAIL_RESPONSE_SCHEMA,
  TASK_TIME_ENTRIES_RESPONSE_SCHEMA,
  TIME_ENTRY_CREATE_RESPONSE_SCHEMA,
} from './external-my-work.openapi';

/** The history contract must stay strictly provider-neutral: no author,
 * email, avatar, self URL, billable, tag, approval, visibility, or raw
 * provider fields may enter the documented wire shape. */
describe('external My Work OpenAPI time-entry schemas', () => {
  it('documents the created result with a nullable remote entry id', () => {
    const created = TIME_ENTRY_CREATE_RESPONSE_SCHEMA.oneOf![0] as {
      required: string[];
      properties: Record<string, unknown>;
    };

    expect(created.required).toEqual(['outcome', 'remoteEntryId', 'refresh', 'receipt']);
    expect(created.properties.remoteEntryId).toMatchObject({ type: 'string', nullable: true });
  });
  it('documents the strict 30-day history envelope', () => {
    expect(TASK_TIME_ENTRIES_RESPONSE_SCHEMA.required).toEqual([
      'windowDays',
      'entries',
      'truncated',
      'hasRunningTimer',
    ]);
    expect(TASK_TIME_ENTRIES_RESPONSE_SCHEMA.properties).toMatchObject({
      windowDays: { type: 'integer', enum: [30] },
      truncated: { type: 'boolean' },
      hasRunningTimer: { type: 'boolean' },
    });
    expect(TASK_TIME_ENTRIES_RESPONSE_SCHEMA.properties).not.toHaveProperty('nextCursor');
    expect(JSON.stringify(TASK_TIME_ENTRIES_RESPONSE_SCHEMA)).not.toMatch(
      /author|email|avatar|self|billable|tags|approval|visibility|updateAuthor|raw/i,
    );
  });

  it('documents at most 100 neutral entries', () => {
    const entries = TASK_TIME_ENTRIES_RESPONSE_SCHEMA.properties!.entries as Record<
      string,
      unknown
    >;
    expect(entries.maxItems).toBe(100);
    expect(entries.items).toMatchObject({
      required: ['remoteId', 'durationMs', 'startedAt', 'note', 'noteTruncated', 'canDelete'],
    });
  });

  it('keeps taskTotalDurationMs on task detail only', () => {
    expect(TASK_DETAIL_RESPONSE_SCHEMA.required).toContain('taskTotalDurationMs');
    expect(TASK_DETAIL_RESPONSE_SCHEMA.properties).toMatchObject({
      taskTotalDurationMs: { type: 'integer', nullable: true, minimum: 0 },
    });
    expect(
      (TASK_TIME_ENTRIES_RESPONSE_SCHEMA.properties!.entries as Record<string, unknown>).items,
    ).not.toHaveProperty('taskTotalDurationMs');
  });
});
