import type { ClickUpIntegrationCredentials } from '../../storage/models/domain.models';
import { ClickUpProviderError } from '../errors/external-provider.errors';
import type { ExternalProviderConnectionContext } from '../models/external-provider.models';
import {
  SafeVendorHttpClient,
  SafeVendorHttpError,
  type SafeVendorJsonRequest,
} from '../transport/safe-vendor-http-client';
import { ClickUpExternalTaskProvider } from './clickup-external-task.provider';

const credentials: ClickUpIntegrationCredentials = {
  provider: 'clickup',
  token: 'clickup-secret-token',
};
const context: ExternalProviderConnectionContext = {
  connectionId: 'connection-clickup',
  connectionGeneration: 3,
};

function taskDetail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'task-1',
    custom_id: 'DEV-1',
    name: 'Ship remote actions',
    text_content: 'Plain task description',
    status: {
      id: 'progress',
      status: 'In Progress',
      color: '#7c4dff',
      orderindex: 1,
      type: 'custom',
    },
    due_date: '1787400000000',
    priority: { priority: 'normal', color: '#f8ae00' },
    time_spent: '3600000',
    url: 'https://app.clickup.com/t/task-1',
    team_id: 'workspace-1',
    list: { id: 'list-1', name: 'Sprint' },
    assignees: [{ id: 42, email: 'private@example.com' }],
    ...overrides,
  };
}

function listDetail(): Record<string, unknown> {
  return {
    id: 'list-1',
    name: 'Sprint',
    override_statuses: true,
    statuses: [
      {
        id: 'complete',
        status: 'Complete',
        color: '#6bc950',
        orderindex: 2,
        type: 'closed',
      },
      {
        id: 'todo',
        status: 'To Do',
        color: '#d3d3d3',
        orderindex: 0,
        type: 'open',
      },
      {
        id: 'progress',
        status: 'In Progress',
        color: '#7c4dff',
        orderindex: 1,
        type: 'custom',
      },
    ],
  };
}

function providerWith(requestJson: jest.Mock): ClickUpExternalTaskProvider {
  return new ClickUpExternalTaskProvider({ requestJson } as unknown as SafeVendorHttpClient);
}

describe('ClickUp task detail and remote actions', () => {
  it('normalizes bounded detail, exact allowed statuses, and safe action capabilities', async () => {
    const oversized = 'x'.repeat(70_000);
    const requestJson = jest.fn(async (request: SafeVendorJsonRequest) => {
      const path = new URL(request.url).pathname;
      if (path === '/api/v2/task/task-1') {
        return taskDetail({ text_content: oversized });
      }
      if (path === '/api/v2/list/list-1') {
        return listDetail();
      }
      throw new Error('unexpected request');
    });
    const provider = providerWith(requestJson);

    const result = await provider.myWork!.getTaskDetail!(credentials, context, 'task-1');

    expect(result).toEqual({
      remoteId: 'task-1',
      remoteKey: 'DEV-1',
      title: 'Ship remote actions',
      description: 'x'.repeat(65_536),
      descriptionTruncated: true,
      status: {
        remoteId: 'progress',
        name: 'In Progress',
        color: '#7c4dff',
        category: 'active',
        position: 1,
      },
      dueAt: '2026-08-22T12:00:00.000Z',
      priority: { name: 'normal', color: '#f8ae00' },
      taskTotalDurationMs: 3_600_000,
      webUrl: 'https://app.clickup.com/t/task-1',
      location: {
        scopeKey: 'workspace-1',
        workAreaId: 'list-1',
        workAreaName: 'Sprint',
      },
      allowedStatuses: [
        {
          actionValue: 'To Do',
          remoteStatusIds: ['todo'],
          remoteId: 'todo',
          name: 'To Do',
          color: '#d3d3d3',
          category: 'active',
          position: 0,
        },
        {
          actionValue: 'In Progress',
          remoteStatusIds: ['progress'],
          remoteId: 'progress',
          name: 'In Progress',
          color: '#7c4dff',
          category: 'active',
          position: 1,
        },
        {
          actionValue: 'Complete',
          remoteStatusIds: ['complete'],
          remoteId: 'complete',
          name: 'Complete',
          color: '#6bc950',
          category: 'completed',
          position: 2,
        },
      ],
      actions: [
        { action: 'change_status', supported: true },
        { action: 'add_comment', supported: true },
        { action: 'log_time', supported: true },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(
      /text_content|team_id|assignees|private@example.com|authorization/i,
    );
  });

  it('keeps status-name write identity and omits remoteStatusIds when a status has no id', async () => {
    const requestJson = jest.fn(async (request: SafeVendorJsonRequest) => {
      const path = new URL(request.url).pathname;
      if (path === '/api/v2/task/task-1') return taskDetail();
      if (path === '/api/v2/list/list-1') {
        return {
          ...listDetail(),
          statuses: [
            {
              status: 'No Id Status',
              color: '#d3d3d3',
              orderindex: 0,
              type: 'open',
            },
          ],
        };
      }
      throw new Error('unexpected request');
    });

    const result = await providerWith(requestJson).myWork!.getTaskDetail!(
      credentials,
      context,
      'task-1',
    );

    expect(result.allowedStatuses).toEqual([
      {
        actionValue: 'No Id Status',
        remoteId: null,
        name: 'No Id Status',
        color: '#d3d3d3',
        category: 'active',
        position: 0,
      },
    ]);
    expect(JSON.stringify(result.allowedStatuses)).not.toContain('actionLabel');
  });

  it('rejects a non-allowlisted task source URL', async () => {
    const requestJson = jest.fn(async () => taskDetail({ url: 'https://evil.example/task-1' }));
    const provider = providerWith(requestJson);

    await expect(
      provider.myWork!.getTaskDetail!(credentials, context, 'task-1'),
    ).rejects.toMatchObject<ClickUpProviderError>({
      code: 'clickup_invalid_response',
    });
    expect(requestJson).toHaveBeenCalledTimes(1);
  });

  it('uses direct status/comment writes and server-derived Workspace time payloads', async () => {
    const requests: SafeVendorJsonRequest[] = [];
    const requestJson = jest.fn(async (request: SafeVendorJsonRequest) => {
      requests.push(request);
      if (request.method === undefined && new URL(request.url).pathname === '/api/v2/task/task-1') {
        return { id: 'task-1', team_id: 'workspace-1' };
      }
      if (request.method === 'POST') {
        return {
          id: 8127,
          start: Date.parse('2026-08-19T10:00:00.000Z'),
          duration: 3_600_000,
          billable: false,
          assignee: 42,
          tags: [],
          description: 'Implementation',
          tid: 'task-1',
        };
      }
      return {};
    });
    const provider = providerWith(requestJson);

    await provider.myWork!.changeStatus!(credentials, context, 'task-1', {
      status: 'Complete',
    });
    await provider.myWork!.addComment!(credentials, context, 'task-1', {
      text: 'Plain text only',
      notifyAll: false,
    });
    await expect(
      provider.timeEntryMutations!.createTimeEntry!(credentials, context, 'task-1', {
        startedAt: '2026-08-19T10:00:00.000Z',
        durationMs: 3_600_000,
        note: 'Implementation',
      }),
    ).resolves.toEqual({ remoteEntryId: '8127' });

    expect(requests).toEqual([
      expect.objectContaining({
        url: 'https://api.clickup.com/api/v2/task/task-1',
        method: 'PUT',
        body: JSON.stringify({ status: 'Complete' }),
      }),
      expect.objectContaining({
        url: 'https://api.clickup.com/api/v2/task/task-1/comment',
        method: 'POST',
        body: JSON.stringify({ comment_text: 'Plain text only', notify_all: false }),
      }),
      expect.objectContaining({
        url: 'https://api.clickup.com/api/v2/task/task-1',
      }),
      expect.objectContaining({
        url: 'https://api.clickup.com/api/v2/team/workspace-1/time_entries',
        method: 'POST',
        body: JSON.stringify({
          start: Date.parse('2026-08-19T10:00:00.000Z'),
          duration: 3_600_000,
          description: 'Implementation',
          tid: 'task-1',
        }),
      }),
    ]);
    for (const request of requests.filter((request) => request.method !== undefined)) {
      expect(request.headers).toEqual({
        accept: 'application/json',
        authorization: 'clickup-secret-token',
        'content-type': 'application/json',
      });
    }
  });

  it.each([
    [new SafeVendorHttpError('http_error', 401), 'clickup_authentication_failed'],
    [new SafeVendorHttpError('http_error', 403), 'clickup_permission_denied'],
    [new SafeVendorHttpError('http_error', 404), 'clickup_not_found'],
    [
      new SafeVendorHttpError('http_error', 429, '2033-05-18T03:33:20.000Z'),
      'clickup_rate_limited',
    ],
    [new SafeVendorHttpError('timeout'), 'clickup_timeout'],
  ])('maps write failure %# safely without retry', async (failure, code) => {
    const requestJson = jest.fn(async () => {
      throw failure;
    });
    const provider = providerWith(requestJson);

    await expect(
      provider.myWork!.changeStatus!(credentials, context, 'task-1', { status: 'Done' }),
    ).rejects.toMatchObject({ code });
    expect(requestJson).toHaveBeenCalledTimes(1);
  });

  it('does not retry a failed manual-time write', async () => {
    let writeAttempts = 0;
    const requestJson = jest.fn(async (request: SafeVendorJsonRequest) => {
      if (request.method === undefined) {
        return { id: 'task-1', team_id: 'workspace-1' };
      }
      writeAttempts += 1;
      throw new SafeVendorHttpError('timeout');
    });
    const provider = providerWith(requestJson);

    await expect(
      provider.timeEntryMutations!.createTimeEntry!(credentials, context, 'task-1', {
        startedAt: '2026-08-19T10:00:00.000Z',
        durationMs: 60_000,
        note: null,
      }),
    ).rejects.toMatchObject({ code: 'clickup_timeout' });
    expect(writeAttempts).toBe(1);
    expect(requestJson).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      'oversized status',
      (provider: ClickUpExternalTaskProvider) =>
        provider.myWork!.changeStatus!(credentials, context, 'task-1', {
          status: 'x'.repeat(257),
        }),
    ],
    [
      'oversized comment',
      (provider: ClickUpExternalTaskProvider) =>
        provider.myWork!.addComment!(credentials, context, 'task-1', {
          text: 'x'.repeat(10_001),
          notifyAll: false,
        }),
    ],
    [
      'unsafe notify value',
      (provider: ClickUpExternalTaskProvider) =>
        provider.myWork!.addComment!(credentials, context, 'task-1', {
          text: 'Comment',
          notifyAll: 'yes' as unknown as boolean,
        }),
    ],
    [
      'oversized duration',
      (provider: ClickUpExternalTaskProvider) =>
        provider.timeEntryMutations!.createTimeEntry!(credentials, context, 'task-1', {
          startedAt: '2026-08-19T10:00:00.000Z',
          durationMs: 7 * 24 * 60 * 60 * 1_000 + 1,
          note: null,
        }),
    ],
  ])('rejects %s at the adapter boundary before transport', async (_case, operation) => {
    const requestJson = jest.fn();
    const provider = providerWith(requestJson);

    await expect(operation(provider)).rejects.toMatchObject({ code: 'clickup_request_rejected' });
    expect(requestJson).not.toHaveBeenCalled();
  });

  it('does not expose an unsafe vendor error body or retry a rejected write', async () => {
    const fetchImpl = jest.fn(
      async () =>
        new Response(JSON.stringify({ error: 'vendor-secret-body' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
    ) as typeof fetch;
    const provider = new ClickUpExternalTaskProvider(new SafeVendorHttpClient({ fetchImpl }));

    const promise = provider.myWork!.addComment!(credentials, context, 'task-1', {
      text: 'Plain text',
      notifyAll: false,
    });

    await expect(promise).rejects.toMatchObject({ code: 'clickup_permission_denied' });
    await expect(promise).rejects.not.toThrow('vendor-secret-body');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

function clickupComment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'comment-1',
    comment: [{ text: 'Plain comment' }],
    comment_text: 'Plain comment',
    user: {
      id: 183,
      username: 'John Doe',
      email: 'johndoe@example.com',
      color: '#827718',
      initials: 'JD',
      profilePicture: 'https://attachments.clickup.com/183.jpg',
    },
    resolved: false,
    assignee: { id: 7, username: 'Someone Else', email: 'other@example.com' },
    assigned_by: null,
    reactions: [':tada:'],
    date: '1787400000000',
    reply_count: '0',
    ...overrides,
  };
}

function cursorFor(date: number, id: string): string {
  return Buffer.from(JSON.stringify({ date, id }), 'utf8').toString('base64url');
}

describe('ClickUp task comments', () => {
  const baseDate = 1_787_400_000_000;

  it('returns newest-first pages and sends start plus start_id together for older pages', async () => {
    const pageOne = Array.from({ length: 25 }, (_, index) =>
      clickupComment({
        id: `comment-${index}`,
        comment_text: `Comment ${index}`,
        date: String(baseDate - index * 60_000),
      }),
    );
    const olderPage = [
      clickupComment({ id: 'comment-25', date: String(baseDate - 25 * 60_000) }),
      clickupComment({ id: 'comment-26', date: String(baseDate - 26 * 60_000) }),
    ];
    const requests: SafeVendorJsonRequest[] = [];
    const requestJson = jest.fn(async (request: SafeVendorJsonRequest) => {
      requests.push(request);
      const url = new URL(request.url);
      if (url.pathname !== '/api/v2/task/task-1/comment') {
        throw new Error('unexpected request');
      }
      return { comments: url.searchParams.has('start') ? olderPage : pageOne };
    });
    const provider = providerWith(requestJson);

    const first = await provider.myWork!.listComments!(credentials, context, 'task-1', null);

    expect(requestJson).toHaveBeenCalledTimes(1);
    expect(new URL(requests[0]!.url).search).toBe('');
    expect(first.comments).toHaveLength(25);
    expect(first.comments[0]).toEqual({
      remoteId: 'comment-0',
      author: { remoteId: '183', displayName: 'John Doe' },
      body: 'Comment 0',
      bodyTruncated: false,
      rich: { document: expect.anything(), supported: true },
      lookupToken: expect.any(String),
      owned: false,
      createdAt: new Date(baseDate).toISOString(),
      updatedAt: null,
    });
    expect(first.nextCursor).toBe(cursorFor(baseDate - 24 * 60_000, 'comment-24'));

    const second = await provider.myWork!.listComments!(
      credentials,
      context,
      'task-1',
      first.nextCursor!,
    );

    expect(requestJson).toHaveBeenCalledTimes(2);
    const olderUrl = new URL(requests[1]!.url);
    expect(olderUrl.searchParams.get('start')).toBe(String(baseDate - 24 * 60_000));
    expect(olderUrl.searchParams.get('start_id')).toBe('comment-24');
    expect(second.comments).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
  });

  it('permits empty and attachment-only comment bodies', async () => {
    const requestJson = jest.fn(async () => ({
      comments: [clickupComment({ comment_text: '' }), clickupComment({ comment_text: undefined })],
    }));

    const result = await providerWith(requestJson).myWork!.listComments!(
      credentials,
      context,
      'task-1',
      null,
    );

    expect(result.comments.map((comment) => [comment.body, comment.bodyTruncated])).toEqual([
      ['', false],
      ['', false],
    ]);
  });

  it('uses Unknown user when the author name is unusable', async () => {
    const requestJson = jest.fn(async () => ({
      comments: [
        clickupComment({ user: null }),
        clickupComment({ user: { id: 5, username: '   ' } }),
        clickupComment({ user: { username: 'Deleted Member' } }),
      ],
    }));

    const result = await providerWith(requestJson).myWork!.listComments!(
      credentials,
      context,
      'task-1',
      null,
    );

    expect(result.comments.map((comment) => comment.author)).toEqual([
      { remoteId: null, displayName: 'Unknown user' },
      { remoteId: '5', displayName: 'Unknown user' },
      { remoteId: null, displayName: 'Deleted Member' },
    ]);
  });

  it('excludes vendor PII, rich segments, and assignee data from the normalized page', async () => {
    const requestJson = jest.fn(async () => ({ comments: [clickupComment()] }));

    const result = await providerWith(requestJson).myWork!.listComments!(
      credentials,
      context,
      'task-1',
      null,
    );

    expect(result.comments[0]!.updatedAt).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(
      /johndoe@example|other@example|profilePicture|#827718|initials|assignee|assigned_by|reaction|resolved|reply_count|comment_text/i,
    );
    expect(JSON.stringify(result)).not.toMatch(/"comment"\s*:/);
  });

  it('truncates oversized comment bodies and marks them', async () => {
    const requestJson = jest.fn(async () => ({
      comments: [clickupComment({ comment_text: 'x'.repeat(9_000) })],
    }));

    const result = await providerWith(requestJson).myWork!.listComments!(
      credentials,
      context,
      'task-1',
      null,
    );

    expect(result.comments[0]).toEqual(
      expect.objectContaining({ body: 'x'.repeat(8_000), bodyTruncated: true }),
    );
  });

  it('returns no cursor for a terminal partial page', async () => {
    const requestJson = jest.fn(async () => ({
      comments: Array.from({ length: 24 }, (_, index) =>
        clickupComment({ id: `comment-${index}` }),
      ),
    }));

    const result = await providerWith(requestJson).myWork!.listComments!(
      credentials,
      context,
      'task-1',
      null,
    );

    expect(result.comments).toHaveLength(24);
    expect(result.nextCursor).toBeNull();
  });

  it.each([
    ['non-base64url charset', 'not+a/cursor!!'],
    ['non-json payload', Buffer.from('not json here', 'utf8').toString('base64url')],
    ['array payload', Buffer.from('[]', 'utf8').toString('base64url')],
    ['missing date', Buffer.from('{"id":"comment-1"}', 'utf8').toString('base64url')],
    [
      'non-numeric date',
      Buffer.from('{"date":"abc","id":"comment-1"}', 'utf8').toString('base64url'),
    ],
    ['negative date', Buffer.from('{"date":-1,"id":"comment-1"}', 'utf8').toString('base64url')],
    [
      'oversized id',
      Buffer.from(`{"date":1,"id":"${'x'.repeat(257)}"}`, 'utf8').toString('base64url'),
    ],
    ['oversized cursor', 'x'.repeat(1_025)],
  ])('rejects a %s cursor before transport', async (_case, cursor) => {
    const requestJson = jest.fn();
    const provider = providerWith(requestJson);

    await expect(
      provider.myWork!.listComments!(credentials, context, 'task-1', cursor),
    ).rejects.toMatchObject({ code: 'clickup_request_rejected' });
    expect(requestJson).not.toHaveBeenCalled();
  });

  it.each([
    ['non-array comments', {}],
    ['oversized page', { comments: Array.from({ length: 26 }, () => clickupComment()) }],
    ['non-record comment', { comments: ['nope'] }],
  ])('classifies a malformed %s page safely', async (_case, payload) => {
    const requestJson = jest.fn(async () => payload);

    await expect(
      providerWith(requestJson).myWork!.listComments!(credentials, context, 'task-1', null),
    ).rejects.toMatchObject({ code: 'clickup_invalid_response' });
  });
});
