import {
  ESTIMATE_LEGACY_ASSIGN_INPUT_BODY_SCHEMA,
  ESTIMATE_LOG_STATE_RESPONSE_SCHEMA,
  ESTIMATE_TIME_ENTRY_CREATE_INPUT_BODY_SCHEMA,
  ESTIMATE_TIME_OPERATION_RESOLVE_INPUT_BODY_SCHEMA,
  TASK_TIME_ENTRIES_RESPONSE_SCHEMA,
} from './external-my-work.openapi';

/** The history contract must stay strictly provider-neutral: no author,
 * email, avatar, self URL, billable, tag, approval, visibility, or raw
 * provider fields may enter the documented wire shape. */
describe('external My Work OpenAPI time-entry schemas', () => {
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
});

/** The estimate checkpoint contract must stay credential-free: no connection
 * identity, receipt tuple internals, or raw provider fields may enter the
 * documented wire shape. */
describe('external My Work OpenAPI estimate-log schemas', () => {
  it('keeps receipt tuple identity and credentials out of every estimate schema', () => {
    for (const schema of [
      ESTIMATE_LEGACY_ASSIGN_INPUT_BODY_SCHEMA,
      ESTIMATE_LOG_STATE_RESPONSE_SCHEMA,
      ESTIMATE_TIME_ENTRY_CREATE_INPUT_BODY_SCHEMA,
      ESTIMATE_TIME_OPERATION_RESOLVE_INPUT_BODY_SCHEMA,
    ]) {
      expect(JSON.stringify(schema)).not.toMatch(
        /connectionId|connectionGeneration|pendingConnection|noteFingerprint|remoteEntryId|token|credential/i,
      );
    }
  });
});
