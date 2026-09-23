import type { ApiResponseSchemaHost } from '@nestjs/swagger';
import { INTEGRATION_PROVIDER_IDS } from '../../storage/models/domain.models';
import {
  MAX_COMMENT_LENGTH,
  MAX_STATUS_LENGTH,
  MAX_TASK_COMMENT_AUTHOR_LENGTH,
  MAX_TASK_COMMENT_BODY_LENGTH,
  MAX_TASK_COMMENT_CURSOR_LENGTH,
  MAX_TASK_COMMENT_ID_LENGTH,
  MAX_TASK_DETAIL_SUBTASKS,
  MAX_TIME_ENTRY_DURATION_MS,
  MAX_TIME_ENTRY_HISTORY_ENTRIES,
  MAX_TIME_ENTRY_NOTE_LENGTH,
  TIME_ENTRY_HISTORY_WINDOW_DAYS,
  type ExternalTaskAction,
} from '../models/external-provider.models';

type SchemaObject = ApiResponseSchemaHost['schema'];

export {
  INTEGRATION_PROVIDER_IDS,
  MAX_COMMENT_LENGTH,
  MAX_STATUS_LENGTH,
  MAX_TASK_COMMENT_AUTHOR_LENGTH,
  MAX_TASK_COMMENT_BODY_LENGTH,
  MAX_TASK_COMMENT_CURSOR_LENGTH,
  MAX_TASK_COMMENT_ID_LENGTH,
  MAX_TIME_ENTRY_DURATION_MS,
  MAX_TIME_ENTRY_NOTE_LENGTH,
};
export { MAX_REMOTE_TASK_ID_LENGTH } from '../models/external-provider.models';

const STATUS_CATEGORIES = ['active', 'completed', 'unknown'];
const TASK_ACTIONS = ['change_status', 'add_comment', 'log_time'];
const REFRESH_TARGETS = ['my_work', 'task_detail'];

const providerDescriptorSchema: SchemaObject = {
  type: 'object',
  required: ['provider', 'displayName', 'capabilities'],
  properties: {
    provider: { type: 'string', enum: [...INTEGRATION_PROVIDER_IDS] },
    displayName: { type: 'string' },
    capabilities: {
      type: 'object',
      required: ['myWork'],
      properties: { myWork: { type: 'boolean' } },
    },
  },
};

const workAreaColumnSchema: SchemaObject = {
  type: 'object',
  required: ['remoteId', 'name', 'color', 'category', 'position'],
  properties: {
    remoteId: { type: 'string', nullable: true },
    remoteStatusIds: { type: 'array', items: { type: 'string' } },
    name: { type: 'string' },
    color: { type: 'string' },
    category: { type: 'string', enum: STATUS_CATEGORIES },
    position: { type: 'number' },
  },
};

// A status option is a work-area column plus its write identity; the column
// shape is spread so both documents can never drift apart.
const taskStatusOptionSchema: SchemaObject = {
  type: 'object',
  required: ['actionValue', ...(workAreaColumnSchema.required ?? [])],
  properties: {
    actionValue: { type: 'string', minLength: 1, maxLength: MAX_STATUS_LENGTH },
    actionLabel: { type: 'string' },
    ...workAreaColumnSchema.properties,
  },
};

const workAreaSchema: SchemaObject = {
  type: 'object',
  required: [
    'remoteId',
    'scopeKey',
    'name',
    'kind',
    'description',
    'assignedTaskCount',
    'hierarchy',
    'workflow',
    'refresh',
  ],
  properties: {
    remoteId: { type: 'string' },
    scopeKey: { type: 'string' },
    name: { type: 'string' },
    kind: { type: 'string', enum: ['list', 'board', 'project'] },
    description: { type: 'string', nullable: true },
    assignedTaskCount: { type: 'integer', minimum: 0 },
    hierarchy: {
      type: 'array',
      items: {
        type: 'object',
        required: ['kind', 'remoteId', 'name'],
        properties: {
          kind: {
            type: 'string',
            enum: ['workspace', 'space', 'folder', 'project', 'board'],
          },
          remoteId: { type: 'string' },
          name: { type: 'string' },
        },
      },
    },
    workflow: {
      type: 'object',
      required: ['isOverridden', 'columns'],
      properties: {
        isOverridden: { type: 'boolean' },
        columns: { type: 'array', items: workAreaColumnSchema },
      },
    },
    refresh: {
      type: 'object',
      required: ['state', 'refreshedAt', 'retryable', 'retryAt'],
      properties: {
        state: { type: 'string', enum: ['fresh', 'stale', 'error'] },
        refreshedAt: { type: 'string', format: 'date-time', nullable: true },
        retryable: { type: 'boolean' },
        retryAt: { type: 'string', format: 'date-time', nullable: true },
      },
    },
  },
};

const taskSummarySchema: SchemaObject = {
  type: 'object',
  required: [
    'remoteId',
    'parentRemoteTaskId',
    'title',
    'status',
    'updatedAt',
    'dueAt',
    'completedAt',
    'webUrl',
  ],
  properties: {
    remoteId: { type: 'string' },
    parentRemoteTaskId: { type: 'string', nullable: true },
    title: { type: 'string' },
    status: {
      type: 'object',
      required: ['name', 'category'],
      properties: {
        remoteId: { type: 'string', nullable: true },
        name: { type: 'string' },
        category: { type: 'string', enum: STATUS_CATEGORIES },
      },
    },
    updatedAt: { type: 'string', format: 'date-time' },
    dueAt: { type: 'string', format: 'date-time', nullable: true },
    completedAt: { type: 'string', format: 'date-time', nullable: true },
    webUrl: { type: 'string', format: 'uri', nullable: true },
  },
};

const exampleWorkArea = {
  remoteId: '901',
  scopeKey: '123',
  name: 'Sprint',
  kind: 'list',
  description: 'Current sprint delivery work.',
  assignedTaskCount: 1,
  hierarchy: [
    { kind: 'workspace', remoteId: '123', name: 'Engineering' },
    { kind: 'space', remoteId: '456', name: 'Product' },
    { kind: 'folder', remoteId: '789', name: 'Delivery' },
  ],
  workflow: {
    isOverridden: true,
    columns: [
      {
        remoteId: 'progress',
        name: 'In Progress',
        color: '#7c4dff',
        category: 'active',
        position: 0,
      },
    ],
  },
  refresh: {
    state: 'fresh',
    refreshedAt: '2026-08-19T12:00:00.000Z',
    retryable: false,
    retryAt: null,
  },
};

export const MY_WORK_RESPONSE_SCHEMA: SchemaObject = {
  oneOf: [
    {
      type: 'object',
      required: ['provider', 'descriptor', 'supported', 'reason'],
      properties: {
        provider: { type: 'string', enum: [...INTEGRATION_PROVIDER_IDS] },
        descriptor: providerDescriptorSchema,
        supported: { type: 'boolean', enum: [false] },
        reason: { type: 'string', enum: ['unsupported'] },
      },
      example: {
        provider: 'jira',
        descriptor: {
          provider: 'jira',
          displayName: 'Jira',
          capabilities: { myWork: false },
        },
        supported: false,
        reason: 'unsupported',
      },
    },
    {
      type: 'object',
      required: [
        'provider',
        'descriptor',
        'supported',
        'capabilities',
        'workAreas',
        'tasks',
        'refreshedAt',
      ],
      properties: {
        provider: { type: 'string', enum: [...INTEGRATION_PROVIDER_IDS] },
        descriptor: providerDescriptorSchema,
        supported: { type: 'boolean', enum: [true] },
        capabilities: {
          type: 'object',
          required: ['timeTrackingEnabled'],
          properties: { timeTrackingEnabled: { type: 'boolean' } },
        },
        workAreas: { type: 'array', items: workAreaSchema },
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            required: ['workArea', 'task'],
            properties: {
              workArea: workAreaSchema,
              task: taskSummarySchema,
            },
          },
        },
        refreshedAt: { type: 'string', format: 'date-time' },
      },
      example: {
        provider: 'clickup',
        descriptor: {
          provider: 'clickup',
          displayName: 'ClickUp',
          capabilities: { myWork: true },
        },
        supported: true,
        capabilities: { timeTrackingEnabled: true },
        workAreas: [exampleWorkArea],
        tasks: [
          {
            workArea: exampleWorkArea,
            task: {
              remoteId: 'abc123',
              parentRemoteTaskId: null,
              title: 'Ship provider-neutral work',
              status: { name: 'in progress', category: 'active' },
              updatedAt: '2026-08-19T12:00:00.000Z',
              dueAt: null,
              completedAt: null,
              webUrl: 'https://app.clickup.com/t/abc123',
            },
          },
        ],
        refreshedAt: '2026-08-19T12:00:00.000Z',
      },
    },
  ],
};

export const TASK_DETAIL_RESPONSE_SCHEMA: SchemaObject = {
  type: 'object',
  required: [
    'remoteId',
    'remoteKey',
    'title',
    'description',
    'descriptionTruncated',
    'status',
    'dueAt',
    'priority',
    'subtasks',
    'subtasksTruncated',
    'taskTotalDurationMs',
    'webUrl',
    'location',
    'allowedStatuses',
    'actions',
    'linkState',
  ],
  properties: {
    remoteId: { type: 'string' },
    remoteKey: { type: 'string' },
    title: { type: 'string' },
    description: { type: 'string', nullable: true, maxLength: 65_536 },
    descriptionTruncated: { type: 'boolean' },
    status: workAreaColumnSchema,
    dueAt: { type: 'string', format: 'date-time', nullable: true },
    priority: {
      type: 'object',
      nullable: true,
      required: ['name', 'color'],
      properties: { name: { type: 'string' }, color: { type: 'string' } },
    },
    subtasks: {
      type: 'array',
      maxItems: MAX_TASK_DETAIL_SUBTASKS,
      items: {
        type: 'object',
        required: ['remoteId', 'remoteKey', 'title', 'status', 'webUrl'],
        properties: {
          remoteId: { type: 'string' },
          remoteKey: { type: 'string' },
          title: { type: 'string' },
          status: {
            type: 'object',
            required: ['name', 'category'],
            properties: {
              remoteId: { type: 'string', nullable: true },
              name: { type: 'string' },
              category: { type: 'string', enum: STATUS_CATEGORIES },
            },
          },
          webUrl: { type: 'string', format: 'uri', nullable: true },
        },
      },
    },
    subtasksTruncated: {
      type: 'boolean',
      description: 'True when the provider-neutral direct-child list may be incomplete.',
    },
    taskTotalDurationMs: {
      type: 'integer',
      nullable: true,
      minimum: 0,
      description: 'Total logged time on the task in ms; null when the provider reports none.',
    },
    webUrl: { type: 'string', format: 'uri' },
    location: {
      type: 'object',
      required: ['scopeKey', 'workAreaId', 'workAreaName'],
      properties: {
        scopeKey: { type: 'string' },
        workAreaId: { type: 'string' },
        workAreaName: { type: 'string' },
      },
    },
    allowedStatuses: { type: 'array', items: taskStatusOptionSchema },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['action', 'supported'],
        properties: {
          action: { type: 'string', enum: TASK_ACTIONS },
          supported: { type: 'boolean' },
        },
      },
    },
    linkState: {
      type: 'object',
      required: ['linked', 'epicId'],
      properties: {
        linked: { type: 'boolean' },
        epicId: { type: 'string', nullable: true },
      },
    },
  },
};

export const TASK_COMMENT_SCHEMA: SchemaObject = {
  type: 'object',
  required: [
    'remoteId',
    'author',
    'body',
    'bodyTruncated',
    'rich',
    'lookupToken',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    remoteId: { type: 'string', maxLength: MAX_TASK_COMMENT_ID_LENGTH },
    author: {
      type: 'object',
      required: ['remoteId', 'displayName'],
      properties: {
        remoteId: { type: 'string', nullable: true },
        displayName: { type: 'string', maxLength: MAX_TASK_COMMENT_AUTHOR_LENGTH },
      },
    },
    body: { type: 'string', maxLength: MAX_TASK_COMMENT_BODY_LENGTH },
    bodyTruncated: { type: 'boolean' },
    rich: {
      oneOf: [
        {
          type: 'object',
          required: ['document', 'supported'],
          description: 'Bounded canonical rich body inside the closed V1 set',
          properties: {
            document: { type: 'object' },
            supported: { type: 'boolean', enum: [true] },
          },
        },
        {
          type: 'object',
          required: ['supported', 'readOnlyReason'],
          description: 'Unsupported provider body; the comment stays read-only',
          properties: {
            supported: { type: 'boolean', enum: [false] },
            readOnlyReason: { type: 'string' },
          },
        },
        { type: 'null', description: 'No provider rich payload present' },
      ],
    },
    lookupToken: {
      type: 'string',
      nullable: true,
      description:
        'Server-issued ClickUp lookup token binding connection generation, task, comment, and page proof; null on Jira.',
    },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
  },
};

export const TASK_COMMENTS_RESPONSE_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['comments', 'nextCursor'],
  properties: {
    comments: { type: 'array', items: TASK_COMMENT_SCHEMA },
    nextCursor: { type: 'string', nullable: true, maxLength: MAX_TASK_COMMENT_CURSOR_LENGTH },
  },
  example: {
    comments: [
      {
        remoteId: 'comment-1',
        author: { remoteId: '183', displayName: 'John Doe' },
        body: 'Plain text only',
        bodyTruncated: false,
        createdAt: '2026-08-19T12:00:00.000Z',
        updatedAt: null,
      },
    ],
    nextCursor: null,
  },
};

export const STATUS_INPUT_BODY_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['status'],
  additionalProperties: false,
  properties: {
    status: { type: 'string', minLength: 1, maxLength: MAX_STATUS_LENGTH },
  },
};

export const COMMENT_INPUT_BODY_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['text'],
  additionalProperties: false,
  properties: {
    text: { type: 'string', minLength: 1, maxLength: MAX_COMMENT_LENGTH },
    notifyAll: { type: 'boolean', default: false },
  },
};

export const TIME_ENTRY_INPUT_BODY_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['startedAt', 'durationMs'],
  additionalProperties: false,
  properties: {
    startedAt: { type: 'string', format: 'date-time' },
    durationMs: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_TIME_ENTRY_DURATION_MS,
    },
    note: { type: 'string', nullable: true, maxLength: MAX_TIME_ENTRY_NOTE_LENGTH },
  },
};

export const TASK_TIME_ENTRY_SCHEMA: SchemaObject = {
  type: 'object',
  required: [
    'remoteId',
    'durationMs',
    'startedAt',
    'note',
    'noteTruncated',
    'canEdit',
    'canDelete',
  ],
  properties: {
    remoteId: { type: 'string', maxLength: 256 },
    durationMs: { type: 'integer', minimum: 1, maximum: MAX_TIME_ENTRY_DURATION_MS },
    startedAt: { type: 'string', format: 'date-time' },
    note: { type: 'string', nullable: true, maxLength: MAX_TIME_ENTRY_NOTE_LENGTH },
    noteTruncated: { type: 'boolean' },
    canEdit: {
      type: 'boolean',
      description: 'True only for the current owner with a confirmed provider edit permission.',
    },
    canDelete: {
      type: 'boolean',
      description: 'True only for the current owner with a confirmed provider permission.',
    },
  },
};

export const TASK_TIME_ENTRIES_RESPONSE_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['windowDays', 'entries', 'truncated', 'hasRunningTimer'],
  properties: {
    windowDays: {
      type: 'integer',
      enum: [TIME_ENTRY_HISTORY_WINDOW_DAYS],
      description: 'Fixed provider-neutral history window in days.',
    },
    entries: {
      type: 'array',
      maxItems: MAX_TIME_ENTRY_HISTORY_ENTRIES,
      items: TASK_TIME_ENTRY_SCHEMA,
    },
    truncated: {
      type: 'boolean',
      description: 'True when coverage of the 30-day own-entry set is incomplete.',
    },
    hasRunningTimer: {
      type: 'boolean',
      description:
        'True when the provider reports a running timer; running timers never appear in entries.',
    },
  },
  example: {
    windowDays: 30,
    entries: [
      {
        remoteId: '10001',
        durationMs: 3_600_000,
        startedAt: '2026-08-19T10:00:00.000Z',
        note: 'Implementation',
        noteTruncated: false,
        canEdit: true,
        canDelete: true,
      },
    ],
    truncated: false,
    hasRunningTimer: false,
  },
};

export function taskActionResponseSchema(action: ExternalTaskAction): SchemaObject {
  return {
    type: 'object',
    required: ['remoteTaskId', 'action', 'succeeded', 'refresh'],
    properties: {
      remoteTaskId: { type: 'string' },
      action: { type: 'string', enum: [action] },
      succeeded: { type: 'boolean', enum: [true] },
      refresh: {
        type: 'array',
        items: { type: 'string', enum: REFRESH_TARGETS },
      },
    },
  };
}

const TIME_MUTATION_PHASES = [
  'pending',
  'dispatched',
  'outcome_unknown',
  'succeeded',
  'failed',
  'already_deleted',
  'not_applied',
  'abandoned_unknown',
  'superseded',
];

/** Bounded in-memory operation receipt; process-restart loss is documented
 * and never triggers an automatic re-dispatch. */
export const TIME_OPERATION_RECEIPT_SCHEMA: SchemaObject = {
  type: 'object',
  required: [
    'operationId',
    'kind',
    'provider',
    'remoteTaskId',
    'remoteEntryId',
    'phase',
    'canVerify',
    'createdAt',
    'updatedAt',
    'expiresAt',
  ],
  properties: {
    operationId: { type: 'string', maxLength: 128 },
    kind: { type: 'string', enum: ['create', 'update', 'delete'] },
    provider: { type: 'string', enum: [...INTEGRATION_PROVIDER_IDS] },
    remoteTaskId: { type: 'string' },
    remoteEntryId: { type: 'string', nullable: true },
    phase: { type: 'string', enum: TIME_MUTATION_PHASES },
    canVerify: {
      type: 'boolean',
      description:
        'Authoritative Verify availability, derived from the receipt proof: true only while the operation is outcome_unknown and its stored evidence can settle it — an exact-read update/delete, or a create whose pre-dispatch baseline was complete. Busy, terminal, and unprovable receipts report false.',
    },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    expiresAt: {
      type: 'string',
      format: 'date-time',
      description: 'End of the unknown guarantee; the receipt expires after this time.',
    },
  },
};

export const TIME_ENTRY_CREATE_RESPONSE_SCHEMA: SchemaObject = {
  oneOf: [
    {
      type: 'object',
      description: 'Provider-confirmed create; refresh task detail only.',
      required: ['outcome', 'remoteEntryId', 'refresh', 'receipt'],
      properties: {
        outcome: { type: 'string', enum: ['created'] },
        remoteEntryId: {
          type: 'string',
          nullable: true,
          description:
            'Null when the provider documented create response confirms the write without naming the created entry.',
        },
        refresh: {
          type: 'array',
          items: { type: 'string', enum: ['task_detail'] },
          minItems: 1,
          maxItems: 1,
        },
        receipt: TIME_OPERATION_RECEIPT_SCHEMA,
      },
    },
    {
      type: 'object',
      description:
        'Dispatched with unknown vendor outcome. Never retried automatically; resolve through the operation verify route or acknowledge the duplicate risk.',
      required: ['outcome', 'receipt'],
      properties: {
        outcome: { type: 'string', enum: ['outcome_unknown'] },
        receipt: TIME_OPERATION_RECEIPT_SCHEMA,
      },
    },
  ],
};

export const TIME_ENTRY_DELETE_RESPONSE_SCHEMA: SchemaObject = {
  oneOf: [
    {
      type: 'object',
      required: ['outcome', 'receipt'],
      properties: {
        outcome: { type: 'string', enum: ['deleted', 'already_deleted', 'not_applied'] },
        receipt: TIME_OPERATION_RECEIPT_SCHEMA,
      },
    },
    {
      type: 'object',
      description:
        'Dispatched with unknown vendor outcome; resolution requires the exact-resource read through the verify route.',
      required: ['outcome', 'receipt'],
      properties: {
        outcome: { type: 'string', enum: ['outcome_unknown'] },
        receipt: TIME_OPERATION_RECEIPT_SCHEMA,
      },
    },
  ],
};

export const TIME_ENTRY_UPDATE_RESPONSE_SCHEMA: SchemaObject = {
  oneOf: [
    {
      type: 'object',
      required: ['outcome', 'receipt'],
      properties: {
        outcome: { type: 'string', enum: ['updated', 'not_applied'] },
        receipt: TIME_OPERATION_RECEIPT_SCHEMA,
      },
    },
    {
      type: 'object',
      description:
        'Dispatched with unknown vendor outcome; resolution compares the exact entry with the desired and pre-dispatch states.',
      required: ['outcome', 'receipt'],
      properties: {
        outcome: { type: 'string', enum: ['outcome_unknown'] },
        receipt: TIME_OPERATION_RECEIPT_SCHEMA,
      },
    },
  ],
};

export const TIME_OPERATION_VERIFY_RESPONSE_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['receipt', 'resolved', 'resolution'],
  properties: {
    receipt: TIME_OPERATION_RECEIPT_SCHEMA,
    resolved: { type: 'boolean' },
    resolution: {
      type: 'string',
      enum: [
        'created',
        'updated',
        'deleted',
        'already_deleted',
        'not_applied',
        'completeness_not_provable',
        'unresolved',
        'connection_superseded',
        'verify_failed',
        'already_terminal',
      ],
    },
  },
};

export const TIME_OPERATION_ACK_RESPONSE_SCHEMA: SchemaObject = {
  type: 'object',
  description:
    'Ambiguity acknowledgement: the caller accepts duplicate risk for creates or version uncertainty for updates/deletes, and the receipt becomes terminal abandoned_unknown.',
  required: ['receipt'],
  properties: {
    receipt: TIME_OPERATION_RECEIPT_SCHEMA,
  },
};

const EDIT_SESSION_STATES = [
  'editable',
  'saved_unverified',
  'outcome_unknown',
  'diverged',
  'invalidated',
  'expired',
] as const;

export const EDIT_SESSION_RESPONSE_SCHEMA: SchemaObject = {
  type: 'object',
  required: [
    'sessionId',
    'kind',
    'provider',
    'remoteTaskId',
    'remoteCommentId',
    'state',
    'revision',
    'baselineFingerprint',
    'createdAt',
    'lastActivityAt',
    'idleExpiresAt',
    'absoluteExpiresAt',
  ],
  properties: {
    sessionId: { type: 'string', format: 'uuid' },
    kind: { type: 'string', enum: ['description_edit', 'comment_delete'] },
    provider: { type: 'string', enum: [...INTEGRATION_PROVIDER_IDS] },
    remoteTaskId: { type: 'string' },
    remoteCommentId: { type: 'string', nullable: true },
    state: { type: 'string', enum: [...EDIT_SESSION_STATES] },
    revision: { type: 'integer', minimum: 0 },
    baselineFingerprint: { type: 'string', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
    lastActivityAt: { type: 'string', format: 'date-time' },
    idleExpiresAt: { type: 'string', format: 'date-time' },
    absoluteExpiresAt: { type: 'string', format: 'date-time' },
  },
  example: {
    sessionId: '3f2a1b8e-0000-4000-8000-000000000000',
    kind: 'description_edit',
    provider: 'jira',
    remoteTaskId: 'KAN-1',
    remoteCommentId: null,
    state: 'editable',
    revision: 0,
    baselineFingerprint: '{"version":1,"blocks":[]}',
    createdAt: '2026-08-22T00:00:00.000Z',
    lastActivityAt: '2026-08-22T00:00:00.000Z',
    idleExpiresAt: '2026-08-22T00:15:00.000Z',
    absoluteExpiresAt: '2026-08-22T02:00:00.000Z',
  },
};

export const EDIT_SESSION_VERIFY_RESPONSE_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['session', 'remoteState', 'reason'],
  properties: {
    session: { ...EDIT_SESSION_RESPONSE_SCHEMA, nullable: true },
    remoteState: {
      type: 'string',
      nullable: true,
      enum: ['new_payload', 'old_baseline', 'diverged', 'gone'],
    },
    reason: {
      type: 'string',
      nullable: true,
      enum: ['session_not_found', 'session_expired'],
    },
  },
};

export const EDIT_SESSION_WRITE_RESPONSE_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['outcome'],
  properties: {
    outcome: {
      type: 'string',
      enum: ['saved', 'saved_unverified', 'outcome_unknown', 'pre_dispatch_rejected'],
      description:
        'saved: the post-write verification read confirmed the payload and the baseline advanced exactly once.',
    },
    revision: {
      type: 'integer',
      minimum: 1,
      description: 'Present only for outcome saved: the new writable revision.',
    },
    reason: {
      type: 'string',
      enum: [
        'session_not_found',
        'session_expired',
        'session_not_editable',
        'revision_conflict',
        'operation_busy',
        'connection_superseded',
        'unsupported_content',
        'diverged',
        'target_gone',
      ],
    },
    session: { ...EDIT_SESSION_RESPONSE_SCHEMA, nullable: true },
  },
};

export const COMMENT_DELETE_RESPONSE_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['outcome'],
  properties: {
    outcome: {
      type: 'string',
      enum: ['deleted', 'already_deleted', 'outcome_unknown', 'rejected'],
    },
    reason: {
      type: 'string',
      enum: [
        'session_not_found',
        'session_expired',
        'session_not_editable',
        'operation_busy',
        'not_owned',
        'connection_superseded',
        'delete_rejected',
      ],
    },
    session: { ...EDIT_SESSION_RESPONSE_SCHEMA, nullable: true },
  },
};

export const EDIT_SESSION_RELOAD_RESPONSE_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['status', 'session'],
  properties: {
    status: { type: 'string', enum: ['reloaded', 'gone', 'unsupported'] },
    session: { ...EDIT_SESSION_RESPONSE_SCHEMA, nullable: true },
  },
};

export const RICH_DESCRIPTION_RESPONSE_SCHEMA: SchemaObject = {
  type: 'object',
  required: [
    'document',
    'fingerprint',
    'supported',
    'readOnlyReason',
    'canEdit',
    'canDeleteOwnedComments',
  ],
  properties: {
    document: {
      type: 'object',
      nullable: true,
      description: 'Bounded canonical ExternalRichDocumentV1; null when unsupported.',
    },
    fingerprint: { type: 'string', nullable: true },
    supported: { type: 'boolean' },
    readOnlyReason: {
      type: 'string',
      nullable: true,
      enum: ['unsupported_content'],
    },
    canEdit: {
      type: 'boolean',
      description: 'False when the rich-edit capability gate is NO_GO or content is unsupported.',
    },
    canDeleteOwnedComments: {
      type: 'boolean',
      description: 'False when the owned-delete capability gate is NO_GO.',
    },
  },
};

export const COMMENT_EDIT_SESSION_INPUT_BODY_SCHEMA: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  properties: {
    lookupToken: {
      type: 'string',
      nullable: true,
      maxLength: 1_024,
      description:
        'ClickUp server-issued lookup token from the comment page; Jira omits it and uses its exact-comment endpoint.',
    },
  },
};

export const DELETE_SESSION_INPUT_BODY_SCHEMA: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  properties: {
    pageProof: {
      type: 'string',
      nullable: true,
      maxLength: MAX_TASK_COMMENT_CURSOR_LENGTH,
      description:
        'ClickUp page cursor that produced the comment; bounds deletion lookup to that page plus one adjacent page.',
    },
  },
};

const ESTIMATE_PENDING_DISPOSITIONS = [
  'none',
  'busy',
  'outcome_unknown',
  'manual_review',
  'finishing',
];

/** Durable checkpoint pending-operation projection. The receipt tuple identity
 * (connection id and generation) and provider credentials never enter this
 * shape; it carries only what the client needs to render and recover. */
const ESTIMATE_PENDING_OPERATION_SCHEMA: SchemaObject = {
  type: 'object',
  required: [
    'operationId',
    'deltaMinutes',
    'estimateTotalMinutes',
    'startedAt',
    'phase',
    'resolution',
    'activityDate',
  ],
  properties: {
    operationId: { type: 'string', maxLength: 128 },
    deltaMinutes: { type: 'integer', minimum: 1 },
    estimateTotalMinutes: { type: 'integer', minimum: 0 },
    startedAt: { type: 'string', format: 'date-time' },
    phase: { type: 'string', enum: ['prepared', 'outcome_unknown'] },
    resolution: { type: 'string', nullable: true, enum: ['logged', 'not_logged'] },
    activityDate: {
      type: 'string',
      nullable: true,
      pattern: '^\\d{4}-\\d{2}-\\d{2}$',
      description:
        'Target activity date of the pending dated delta; null on migrated legacy pending rows.',
    },
  },
};

/** One persisted dated-ledger row: minutes settled for one local activity date. */
const ESTIMATE_LOGGED_DAY_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['activityDate', 'loggedMinutes'],
  properties: {
    activityDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    loggedMinutes: { type: 'integer', minimum: 0 },
  },
};

export const ESTIMATE_LOG_STATE_RESPONSE_SCHEMA: SchemaObject = {
  type: 'object',
  required: [
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
  ],
  properties: {
    initialized: {
      type: 'boolean',
      description:
        'False until the first Set logged estimate or confirmed estimate create; absence of the durable row means uninitialized.',
    },
    revision: { type: 'integer', minimum: 0 },
    loggedMinutes: { type: 'integer', minimum: 0 },
    aggregationTimeZone: {
      type: 'string',
      nullable: true,
      maxLength: 128,
      description:
        'Canonical IANA zone the dated ledger groups under; null until the first dated baseline binds one.',
    },
    days: {
      type: 'array',
      maxItems: 3_660,
      description:
        'The dated ledger, sorted ascending by activityDate. Never truncated: a ledger above the bound fails closed instead.',
      items: ESTIMATE_LOGGED_DAY_SCHEMA,
    },
    unallocatedLoggedMinutes: {
      type: 'integer',
      minimum: 0,
      description:
        'Derived on every read as loggedMinutes minus the dated sum; legacy scalar credit waiting for oldest-first materialization.',
    },
    pendingDisposition: {
      type: 'string',
      enum: ESTIMATE_PENDING_DISPOSITIONS,
      description:
        'finishing is derived when a stored logged/not_logged resolution is still being applied; manual_review marks an ambiguous pending operation that needs an explicit choice.',
    },
    canVerify: {
      type: 'boolean',
      description:
        'True only while provider Verify is available for the pending operation on the matching current connection epoch.',
    },
    verifyExpiresAt: {
      type: 'string',
      format: 'date-time',
      nullable: true,
      description:
        'Receipt-absolute deadline of the current Verify availability; null whenever canVerify is false. Clients may schedule exactly one deadline transition from it — the receipt, not a client TTL, owns the timing.',
    },
    pending: {
      oneOf: [ESTIMATE_PENDING_OPERATION_SCHEMA, { type: 'null' }],
    },
    legacyCheckpoint: {
      nullable: true,
      oneOf: [
        {
          type: 'object',
          required: ['revision', 'loggedMinutes', 'hasPendingOperation'],
          properties: {
            revision: { type: 'integer', minimum: 1 },
            loggedMinutes: { type: 'integer', minimum: 0 },
            hasPendingOperation: { type: 'boolean' },
          },
        },
        { type: 'null' },
      ],
      description:
        'Previous logged-time history of this remote task still awaiting ownership attribution. Never the selected project\u2019s own amount: while present, estimate export, reconciliation, and Set logged stay closed until the one-time legacy assignment resolves ownership; null once resolved.',
    },
  },
  example: {
    initialized: true,
    revision: 2,
    loggedMinutes: 90,
    aggregationTimeZone: 'Europe/Madrid',
    days: [{ activityDate: '2026-08-29', loggedMinutes: 30 }],
    unallocatedLoggedMinutes: 60,
    pendingDisposition: 'none',
    canVerify: false,
    verifyExpiresAt: null,
    pending: null,
    legacyCheckpoint: null,
  },
};

/** Dedicated strict request for the one-time legacy ownership assignment. */
export const ESTIMATE_LEGACY_ASSIGN_INPUT_BODY_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['scopeKey', 'expectedLegacyRevision'],
  properties: {
    scopeKey: { type: 'string', minLength: 1, maxLength: 256 },
    expectedLegacyRevision: {
      type: 'integer',
      minimum: 0,
      description:
        'Legacy checkpoint revision the caller saw; the assignment fails closed against a concurrent claim or stale view.',
    },
  },
  additionalProperties: false,
  example: { scopeKey: 'acme.atlassian.net', expectedLegacyRevision: 4 },
};

export const ESTIMATE_TIME_ENTRY_CREATE_INPUT_BODY_SCHEMA: SchemaObject = {
  type: 'object',
  required: [
    'scopeKey',
    'requestKey',
    'timeZone',
    'estimateTotalMinutes',
    'expectedRevision',
    'dailySnapshot',
  ],
  additionalProperties: false,
  properties: {
    scopeKey: { type: 'string', minLength: 1, maxLength: 256 },
    requestKey: {
      type: 'string',
      format: 'uuid',
      description:
        'One fresh browser crypto.randomUUID per click; never a stable Epic or task id. The server derives per-entry operation ids from it and never reuses a key across provider tuples.',
    },
    timeZone: {
      type: 'string',
      minLength: 1,
      maxLength: 128,
      description: 'IANA time zone used for both client display and server recomputation.',
    },
    estimateTotalMinutes: {
      type: 'integer',
      minimum: 0,
      description:
        'Snapshot of the current DevChain estimate total; must equal the dailySnapshot sum and stay at or below the same-timezone live totals per date.',
    },
    expectedRevision: { type: 'integer', minimum: 0 },
    dailySnapshot: {
      type: 'array',
      uniqueItems: true,
      maxItems: 3_660,
      description:
        'Captured daily projection: unique canonical activity dates in ascending order summing exactly to estimateTotalMinutes. The 3,660-entry bound keeps the JSON body comfortably inside the configured Fastify body limit.',
      items: {
        type: 'object',
        required: ['activityDate', 'minutes'],
        additionalProperties: false,
        properties: {
          activityDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          minutes: { type: 'integer', minimum: 0 },
        },
      },
    },
  },
};

/** One create outcome variant sharing the settlement-count contract. */
const estimateCreateOutcome = (
  outcome: 'logged' | 'partially_logged' | 'outcome_unknown',
  description: string,
): SchemaObject => ({
  type: 'object',
  description,
  required: ['outcome', 'entriesLogged', 'minutesLogged', 'hasMore', 'stoppedReason', 'state'],
  properties: {
    outcome: { type: 'string', enum: [outcome] },
    entriesLogged: {
      type: 'integer',
      minimum: 0,
      maximum: 10,
      description: 'Provider entries this request settled durably.',
    },
    minutesLogged: { type: 'integer', minimum: 0 },
    hasMore: {
      type: 'boolean',
      description: 'True when unlogged dated time remains for a later fresh click.',
    },
    stoppedReason: {
      type: 'string',
      enum: ['completed', 'entry_cap', 'provider_error', 'concurrent_write', 'outcome_unknown'],
      description:
        'Fixed safe stop reason; never carries provider detail. entry_cap means the 10-entry bound stopped a clean prefix.',
    },
    state: ESTIMATE_LOG_STATE_RESPONSE_SCHEMA,
  },
});

export const ESTIMATE_TIME_ENTRY_CREATE_RESPONSE_SCHEMA: SchemaObject = {
  oneOf: [
    estimateCreateOutcome(
      'logged',
      'Every dispatched entry settled durably; live growth beyond the capture stays unlogged for a later click.',
    ),
    estimateCreateOutcome(
      'partially_logged',
      'A confirmed prefix settled durably before a known provider failure or a competing write; the safe stop reason explains the boundary.',
    ),
    estimateCreateOutcome(
      'outcome_unknown',
      'Dispatched with unknown vendor outcome. Never retried automatically; the pending date settles only through the estimate resolve route.',
    ),
  ],
};

export const ESTIMATE_LOG_STATE_SET_INPUT_BODY_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['scopeKey', 'loggedMinutes', 'expectedRevision', 'timeZone'],
  additionalProperties: false,
  properties: {
    scopeKey: { type: 'string', minLength: 1, maxLength: 256 },
    loggedMinutes: {
      type: 'integer',
      minimum: 0,
      description:
        'Records DevChain submissions and explicit user assumptions; the correction path for bootstrap and drift. Rebuilds the dated baseline oldest-first from the live projection in timeZone and never writes to a provider.',
    },
    expectedRevision: { type: 'integer', minimum: 0 },
    timeZone: {
      type: 'string',
      minLength: 1,
      maxLength: 128,
      description: 'Canonical IANA zone to bind the rebuilt dated baseline to.',
    },
  },
};

export const ESTIMATE_TIME_OPERATION_RESOLVE_INPUT_BODY_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['scopeKey', 'action', 'expectedRevision'],
  additionalProperties: false,
  properties: {
    scopeKey: { type: 'string', minLength: 1, maxLength: 256 },
    action: {
      type: 'string',
      enum: ['verify', 'logged', 'not_logged'],
      description:
        'Verify resolves from exact provider proof and requires the pending connection epoch; logged/not_logged are the explicit manual resolutions and stay available after receipt loss or connection replacement.',
    },
    expectedRevision: { type: 'integer', minimum: 0 },
  },
};

export const ESTIMATE_TIME_OPERATION_RESOLVE_RESPONSE_SCHEMA: SchemaObject = {
  oneOf: [
    {
      type: 'object',
      required: ['outcome', 'state'],
      properties: {
        outcome: { type: 'string', enum: ['logged', 'not_logged'] },
        state: ESTIMATE_LOG_STATE_RESPONSE_SCHEMA,
      },
    },
    {
      type: 'object',
      description:
        'The pending operation could not be resolved yet; the returned state explains the current disposition.',
      required: ['outcome', 'state'],
      properties: {
        outcome: { type: 'string', enum: ['unresolved'] },
        state: ESTIMATE_LOG_STATE_RESPONSE_SCHEMA,
      },
    },
  ],
};
