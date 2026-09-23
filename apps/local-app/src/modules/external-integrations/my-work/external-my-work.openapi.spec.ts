import {
  ESTIMATE_LEGACY_ASSIGN_INPUT_BODY_SCHEMA,
  ESTIMATE_LOG_STATE_RESPONSE_SCHEMA,
  ESTIMATE_LOG_STATE_SET_INPUT_BODY_SCHEMA,
  ESTIMATE_TIME_ENTRY_CREATE_INPUT_BODY_SCHEMA,
  ESTIMATE_TIME_ENTRY_CREATE_RESPONSE_SCHEMA,
  ESTIMATE_TIME_OPERATION_RESOLVE_INPUT_BODY_SCHEMA,
  MY_WORK_RESPONSE_SCHEMA,
  TASK_DETAIL_RESPONSE_SCHEMA,
  TASK_TIME_ENTRIES_RESPONSE_SCHEMA,
  TIME_ENTRY_CREATE_RESPONSE_SCHEMA,
  TIME_OPERATION_RECEIPT_SCHEMA,
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

  it('requires and describes the receipt canVerify availability flag', () => {
    expect(TIME_OPERATION_RECEIPT_SCHEMA.required).toEqual(
      expect.arrayContaining(['phase', 'canVerify']),
    );
    expect(TIME_OPERATION_RECEIPT_SCHEMA.properties).toMatchObject({
      canVerify: { type: 'boolean' },
    });
    expect(
      (TIME_OPERATION_RECEIPT_SCHEMA.properties!.canVerify as { description?: string }).description
        ?.length,
    ).toBeGreaterThan(0);
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
      required: [
        'remoteId',
        'durationMs',
        'startedAt',
        'note',
        'noteTruncated',
        'canEdit',
        'canDelete',
      ],
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

  it('documents required provider-neutral hierarchy fields', () => {
    const supported = MY_WORK_RESPONSE_SCHEMA.oneOf![1] as {
      properties: {
        tasks: { items: { properties: { task: { required: string[]; properties: object } } } };
      };
    };
    const summary = supported.properties.tasks.items.properties.task;
    expect(summary.required).toContain('parentRemoteTaskId');
    expect(summary.properties).toMatchObject({
      parentRemoteTaskId: { type: 'string', nullable: true },
    });

    expect(TASK_DETAIL_RESPONSE_SCHEMA.required).toEqual(
      expect.arrayContaining(['subtasks', 'subtasksTruncated']),
    );
    expect(TASK_DETAIL_RESPONSE_SCHEMA.properties).toMatchObject({
      subtasks: {
        type: 'array',
        maxItems: 100,
        items: {
          required: ['remoteId', 'remoteKey', 'title', 'status', 'webUrl'],
        },
      },
      subtasksTruncated: { type: 'boolean' },
    });
  });
});

/** The estimate checkpoint contract must stay credential-free: no connection
 * identity, receipt tuple internals, or raw provider fields may enter the
 * documented wire shape. */
describe('external My Work OpenAPI estimate-log schemas', () => {
  it('documents the state envelope with the derived dispositions', () => {
    expect(ESTIMATE_LOG_STATE_RESPONSE_SCHEMA.required).toEqual([
      'initialized',
      'revision',
      'loggedMinutes',
      'aggregationTimeZone',
      'days',
      'unallocatedLoggedMinutes',
      'pendingDisposition',
      'canVerify',
      'verifyExpiresAt',
      'pending',
      'legacyCheckpoint',
    ]);
    expect(ESTIMATE_LOG_STATE_RESPONSE_SCHEMA.properties).toMatchObject({
      aggregationTimeZone: { type: 'string', nullable: true },
      days: {
        type: 'array',
        maxItems: 3_660,
        items: {
          type: 'object',
          required: ['activityDate', 'loggedMinutes'],
        },
      },
      unallocatedLoggedMinutes: { type: 'integer', minimum: 0 },
      pendingDisposition: {
        type: 'string',
        enum: ['none', 'busy', 'outcome_unknown', 'manual_review', 'finishing'],
      },
      canVerify: { type: 'boolean' },
      verifyExpiresAt: {
        type: 'string',
        format: 'date-time',
        nullable: true,
      },
      pending: {
        oneOf: [
          {
            type: 'object',
            required: expect.arrayContaining(['activityDate']),
          },
          { type: 'null' },
        ],
      },
      legacyCheckpoint: {
        nullable: true,
        oneOf: [
          {
            type: 'object',
            required: ['revision', 'loggedMinutes', 'hasPendingOperation'],
          },
          { type: 'null' },
        ],
      },
    });
    expect(ESTIMATE_LOG_STATE_RESPONSE_SCHEMA.example).toMatchObject({ legacyCheckpoint: null });
  });

  it('documents the dedicated legacy ownership assignment request', () => {
    expect(ESTIMATE_LEGACY_ASSIGN_INPUT_BODY_SCHEMA.required).toEqual([
      'scopeKey',
      'expectedLegacyRevision',
    ]);
    expect(ESTIMATE_LEGACY_ASSIGN_INPUT_BODY_SCHEMA.additionalProperties).toBe(false);
    expect(ESTIMATE_LEGACY_ASSIGN_INPUT_BODY_SCHEMA.properties).toMatchObject({
      scopeKey: { type: 'string', minLength: 1, maxLength: 256 },
      expectedLegacyRevision: { type: 'integer', minimum: 0 },
    });
  });

  it('documents the dated create contract with the bounded snapshot and outcome counts', () => {
    expect(ESTIMATE_TIME_ENTRY_CREATE_INPUT_BODY_SCHEMA.required).toEqual([
      'scopeKey',
      'requestKey',
      'timeZone',
      'estimateTotalMinutes',
      'expectedRevision',
      'dailySnapshot',
    ]);
    expect(ESTIMATE_TIME_ENTRY_CREATE_INPUT_BODY_SCHEMA.properties).toMatchObject({
      requestKey: { type: 'string', format: 'uuid' },
      dailySnapshot: { type: 'array', maxItems: 3_660 },
    });

    const outcomes = ESTIMATE_TIME_ENTRY_CREATE_RESPONSE_SCHEMA.oneOf as Array<{
      properties: { outcome: { enum: string[] }; entriesLogged: unknown; stoppedReason: unknown };
      required: string[];
    }>;
    expect(outcomes.map((outcome) => outcome.properties.outcome.enum[0])).toEqual([
      'logged',
      'partially_logged',
      'outcome_unknown',
    ]);
    for (const outcome of outcomes) {
      expect(outcome.required).toEqual(
        expect.arrayContaining([
          'outcome',
          'entriesLogged',
          'minutesLogged',
          'hasMore',
          'stoppedReason',
          'state',
        ]),
      );
      expect(outcome.properties.entriesLogged).toMatchObject({ maximum: 10 });
      expect(outcome.properties.stoppedReason).toMatchObject({
        enum: ['completed', 'entry_cap', 'provider_error', 'concurrent_write', 'outcome_unknown'],
      });
    }

    expect(ESTIMATE_LOG_STATE_SET_INPUT_BODY_SCHEMA.required).toEqual(
      expect.arrayContaining(['timeZone']),
    );
  });

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
