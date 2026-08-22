import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { JiraIntegrationCredentials } from '../../storage/models/domain.models';
import { JiraProviderError } from '../errors/external-provider.errors';
import { ExternalTaskProviderRegistry } from '../external-task-provider.registry';
import type { ExternalProviderConnectionContext } from '../models/external-provider.models';
import { ExternalMyWorkService } from '../my-work/external-my-work.service';
import {
  SafeVendorHttpClient,
  SafeVendorHttpError,
  type SafeVendorJsonRequest,
} from '../transport/safe-vendor-http-client';
import { JiraExternalTaskProvider } from './jira-external-task.provider';

const credentials: JiraIntegrationCredentials = {
  provider: 'jira',
  siteUrl: 'https://acme.atlassian.net',
  email: 'private@example.com',
  token: 'jira-secret-token',
};
const context: ExternalProviderConnectionContext = {
  connectionId: 'connection-jira',
  connectionGeneration: 4,
};

function adf(text: string): Record<string, unknown> {
  return {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

function issueDetail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '10001',
    key: 'ENG-1',
    fields: {
      summary: 'Ship Jira actions',
      description: adf('Plain Jira description'),
      status: {
        id: 'status-progress',
        name: 'In Progress',
        statusCategory: { key: 'indeterminate' },
      },
      duedate: '2026-08-22',
      priority: { id: '3', name: 'Medium', iconUrl: 'https://private.example/icon.svg' },
      project: { id: 'project-1', key: 'ENG', name: 'Engineering' },
      timetracking: { timeSpentSeconds: 3_600, timeSpent: '1h' },
    },
    ...overrides,
  };
}

function transitions(): Record<string, unknown> {
  return {
    transitions: [
      {
        id: '31',
        name: 'Finish',
        isAvailable: true,
        to: { id: 'status-done', name: 'Done', statusCategory: { key: 'done' } },
        fields: {},
      },
      {
        id: '41',
        name: 'Resolve with fields',
        isAvailable: true,
        to: { id: 'status-blocked', name: 'Blocked', statusCategory: { key: 'indeterminate' } },
        fields: { resolution: { required: true, name: 'Resolution' } },
      },
      {
        id: '51',
        name: 'Unavailable',
        isAvailable: false,
        to: { id: 'status-review', name: 'Review', statusCategory: { key: 'indeterminate' } },
        fields: {},
      },
    ],
  };
}

function providerWith(requestJson: jest.Mock): JiraExternalTaskProvider {
  return new JiraExternalTaskProvider({
    requestJson,
    requestNoContent: requestJson,
  } as unknown as SafeVendorHttpClient);
}

describe('Jira task detail and workflow actions', () => {
  it('combines normalized issue detail with only executable transition and time capabilities', async () => {
    const oversized = 'x'.repeat(70_000);
    const requestJson = jest.fn(async (request: SafeVendorJsonRequest) => {
      const url = new URL(request.url);
      if (url.pathname === '/rest/api/3/issue/ENG-1') {
        expect(url.searchParams.get('fields')).toBe(
          'summary,description,status,duedate,priority,project,timetracking',
        );
        return issueDetail({
          fields: {
            ...(issueDetail().fields as Record<string, unknown>),
            description: adf(oversized),
          },
        });
      }
      if (url.pathname === '/rest/api/3/issue/ENG-1/transitions') {
        expect(url.searchParams.get('expand')).toBe('transitions.fields');
        return transitions();
      }
      if (url.pathname === '/rest/api/3/configuration') {
        return { timeTrackingEnabled: true };
      }
      throw new Error(`unexpected Jira request: ${url.toString()}`);
    });

    const result = await providerWith(requestJson).myWork!.getTaskDetail!(
      credentials,
      context,
      'ENG-1',
    );

    expect(result).toEqual({
      remoteId: 'ENG-1',
      remoteKey: 'ENG-1',
      title: 'Ship Jira actions',
      description: 'x'.repeat(65_536),
      descriptionTruncated: true,
      status: {
        remoteId: 'status-progress',
        remoteStatusIds: ['status-progress'],
        name: 'In Progress',
        color: '#6b778c',
        category: 'active',
        position: 0,
      },
      dueAt: '2026-08-22T00:00:00.000Z',
      priority: { name: 'Medium', color: '#6b778c' },
      taskTotalDurationMs: 3_600_000,
      webUrl: 'https://acme.atlassian.net/browse/ENG-1',
      location: {
        scopeKey: 'acme.atlassian.net',
        workAreaId: 'project-1',
        workAreaName: 'Engineering',
      },
      allowedStatuses: [
        {
          actionValue: '31',
          actionLabel: 'Finish',
          remoteId: 'status-done',
          remoteStatusIds: ['status-done'],
          name: 'Done',
          color: '#36b37e',
          category: 'completed',
          position: 0,
        },
      ],
      actions: [
        { action: 'change_status', supported: true },
        { action: 'add_comment', supported: true },
        { action: 'log_time', supported: true },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(
      /iconUrl|private\.example|statusCategory|transitions|fields|authorization|ADF/i,
    );
  });

  it('keeps two transitions into one destination status distinct', async () => {
    const requestJson = jest.fn(async (request: SafeVendorJsonRequest) => {
      const url = new URL(request.url);
      if (url.pathname === '/rest/api/3/issue/ENG-1') return issueDetail();
      if (url.pathname === '/rest/api/3/issue/ENG-1/transitions') {
        return {
          transitions: [
            {
              id: '31',
              name: 'Finish',
              isAvailable: true,
              to: { id: 'status-done', name: 'Done', statusCategory: { key: 'done' } },
              fields: {},
            },
            {
              id: '61',
              name: 'Fast-track',
              isAvailable: true,
              to: { id: 'status-done', name: 'Done', statusCategory: { key: 'done' } },
              fields: {},
            },
          ],
        };
      }
      if (url.pathname === '/rest/api/3/configuration') return { timeTrackingEnabled: true };
      throw new Error(`unexpected Jira request: ${url.toString()}`);
    });

    const result = await providerWith(requestJson).myWork!.getTaskDetail!(
      credentials,
      context,
      'ENG-1',
    );

    expect(result.allowedStatuses).toEqual([
      {
        actionValue: '31',
        actionLabel: 'Finish',
        remoteId: 'status-done',
        remoteStatusIds: ['status-done'],
        name: 'Done',
        color: '#36b37e',
        category: 'completed',
        position: 0,
      },
      {
        actionValue: '61',
        actionLabel: 'Fast-track',
        remoteId: 'status-done',
        remoteStatusIds: ['status-done'],
        name: 'Done',
        color: '#36b37e',
        category: 'completed',
        position: 1,
      },
    ]);
  });

  it('preserves readable detail and marks status changes unavailable when transition fetch fails', async () => {
    const requestJson = jest.fn(async (request: SafeVendorJsonRequest) => {
      const path = new URL(request.url).pathname;
      if (path === '/rest/api/3/issue/ENG-1') return issueDetail();
      if (path.endsWith('/transitions')) throw new SafeVendorHttpError('timeout');
      if (path === '/rest/api/3/configuration') return { timeTrackingEnabled: false };
      throw new Error(`unexpected Jira path: ${path}`);
    });

    const result = await providerWith(requestJson).myWork!.getTaskDetail!(
      credentials,
      context,
      'ENG-1',
    );

    expect(result).toEqual(
      expect.objectContaining({
        remoteId: 'ENG-1',
        title: 'Ship Jira actions',
        allowedStatuses: [],
        actions: [
          { action: 'change_status', supported: false },
          { action: 'add_comment', supported: true },
          { action: 'log_time', supported: false },
        ],
      }),
    );
  });

  it('executes only a transition with no required fields and routes unsupported transitions to Jira', async () => {
    const requests: SafeVendorJsonRequest[] = [];
    const requestJson = jest.fn(async (request: SafeVendorJsonRequest) => {
      requests.push(request);
      if (request.method === undefined) return transitions();
      return {};
    });
    const provider = providerWith(requestJson);

    await provider.myWork!.changeStatus!(credentials, context, 'ENG-1', { status: '31' });
    await expect(
      provider.myWork!.changeStatus!(credentials, context, 'ENG-1', { status: '41' }),
    ).rejects.toMatchObject<JiraProviderError>({
      code: 'jira_unsupported_transition',
      details: expect.objectContaining({
        reason: 'unsupported_transition',
        guidance: 'complete_in_jira',
        completeInJiraUrl: 'https://acme.atlassian.net/browse/ENG-1',
      }),
    });

    expect(requests.filter(({ method }) => method === 'POST')).toEqual([
      expect.objectContaining({
        url: 'https://acme.atlassian.net/rest/api/3/issue/ENG-1/transitions',
        method: 'POST',
        body: JSON.stringify({ transition: { id: '31' } }),
      }),
    ]);
  });

  it('accepts a real Jira transition 204 once through the explicit no-content contract', async () => {
    let transitionWrites = 0;
    const fetchImpl = jest.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        transitionWrites += 1;
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify(transitions()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const provider = new JiraExternalTaskProvider(new SafeVendorHttpClient({ fetchImpl }));

    await expect(
      provider.myWork!.changeStatus!(credentials, context, 'ENG-1', { status: '31' }),
    ).resolves.toBeUndefined();
    expect(transitionWrites).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][1]).toEqual(
      expect.objectContaining({ method: 'POST', redirect: 'manual' }),
    );
  });

  it('writes minimal ADF comments and receipt-provable manual worklogs without retrying writes', async () => {
    const requests: SafeVendorJsonRequest[] = [];
    const requestJson = jest.fn(async (request: SafeVendorJsonRequest) => {
      requests.push(request);
      if (new URL(request.url).pathname === '/rest/api/3/configuration') {
        return { timeTrackingEnabled: true };
      }
      if (request.method === 'POST') {
        return { id: 10001, self: 'https://acme.atlassian.net/worklog/10001' };
      }
      return {};
    });
    const provider = providerWith(requestJson);

    await provider.myWork!.addComment!(credentials, context, 'ENG-1', {
      text: 'Ready for review',
      notifyAll: false,
    });
    await expect(
      provider.timeEntryMutations!.createTimeEntry!(credentials, context, 'ENG-1', {
        startedAt: '2026-08-19T10:00:00.000Z',
        durationMs: 3_600_000,
        note: 'Implementation',
      }),
    ).resolves.toEqual({ remoteEntryId: '10001' });
    await expect(
      provider.timeEntryMutations!.createTimeEntry!(credentials, context, 'ENG-1', {
        startedAt: '2026-08-19T11:00:00.000Z',
        durationMs: 60_000,
        note: null,
      }),
    ).resolves.toEqual({ remoteEntryId: '10001' });

    expect(requests).toEqual([
      expect.objectContaining({
        url: 'https://acme.atlassian.net/rest/api/3/issue/ENG-1/comment',
        method: 'POST',
        body: JSON.stringify({ body: adf('Ready for review') }),
      }),
      expect.objectContaining({ url: 'https://acme.atlassian.net/rest/api/3/configuration' }),
      expect.objectContaining({
        url: 'https://acme.atlassian.net/rest/api/3/issue/ENG-1/worklog?adjustEstimate=leave',
        method: 'POST',
        body: JSON.stringify({
          started: '2026-08-19T10:00:00.000+0000',
          timeSpentSeconds: 3600,
          comment: adf('Implementation'),
        }),
      }),
      expect.objectContaining({ url: 'https://acme.atlassian.net/rest/api/3/configuration' }),
      expect.objectContaining({
        url: 'https://acme.atlassian.net/rest/api/3/issue/ENG-1/worklog?adjustEstimate=leave',
        method: 'POST',
        body: JSON.stringify({
          started: '2026-08-19T11:00:00.000+0000',
          timeSpentSeconds: 60,
        }),
      }),
    ]);
  });

  it('treats a confirmed create whose response is not the documented worklog JSON as unknown', async () => {
    const requestJson = jest.fn(async (request: SafeVendorJsonRequest) => {
      if (new URL(request.url).pathname === '/rest/api/3/configuration') {
        return { timeTrackingEnabled: true };
      }
      return { somethingElse: true };
    });

    await expect(
      providerWith(requestJson).timeEntryMutations!.createTimeEntry!(
        credentials,
        context,
        'ENG-1',
        {
          startedAt: '2026-08-19T10:00:00.000Z',
          durationMs: 60_000,
          note: null,
        },
      ),
    ).rejects.toMatchObject({
      code: 'jira_invalid_response',
      details: expect.objectContaining({ dispatched: true }),
    });
  });

  it('prevents worklog submission with clear guidance when Jira time tracking is disabled', async () => {
    const requestJson = jest.fn(async () => ({ timeTrackingEnabled: false }));

    await expect(
      providerWith(requestJson).timeEntryMutations!.createTimeEntry!(
        credentials,
        context,
        'ENG-1',
        {
          startedAt: '2026-08-19T10:00:00.000Z',
          durationMs: 60_000,
          note: null,
        },
      ),
    ).rejects.toMatchObject<JiraProviderError>({
      code: 'jira_time_tracking_disabled',
      details: expect.objectContaining({
        reason: 'time_tracking_disabled',
        guidance: 'enable_time_tracking_in_jira',
      }),
    });
    expect(requestJson).toHaveBeenCalledTimes(1);
    expect(requestJson.mock.calls[0][0].method).toBeUndefined();
  });

  it('surfaces Jira retry guidance and never retries a rate-limited remote write', async () => {
    let writeAttempts = 0;
    const requestJson = jest.fn(async (request: SafeVendorJsonRequest) => {
      if (request.method === undefined) return transitions();
      writeAttempts += 1;
      throw new SafeVendorHttpError('http_error', 429, '2026-08-19T12:00:05.000Z');
    });

    await expect(
      providerWith(requestJson).myWork!.changeStatus!(credentials, context, 'ENG-1', {
        status: '31',
      }),
    ).rejects.toMatchObject({
      code: 'jira_rate_limited',
      details: expect.objectContaining({
        retryable: true,
        retryAt: '2026-08-19T12:00:05.000Z',
      }),
    });
    expect(writeAttempts).toBe(1);
    expect(requestJson).toHaveBeenCalledTimes(2);
  });

  it('dispatches Jira detail and action capabilities through the generic My Work service', async () => {
    const requestJson = jest.fn(async (request: SafeVendorJsonRequest) => {
      const path = new URL(request.url).pathname;
      if (path === '/rest/api/3/issue/ENG-1') return issueDetail();
      if (path.endsWith('/transitions') && request.method === undefined) return transitions();
      if (path === '/rest/api/3/configuration') return { timeTrackingEnabled: true };
      return {};
    });
    const provider = providerWith(requestJson);
    const connection = {
      id: 'connection-jira',
      provider: 'jira' as const,
      generation: 4,
      createdAt: '2026-08-19T10:00:00.000Z',
      updatedAt: '2026-08-19T11:00:00.000Z',
    };
    const storage = {
      getIntegrationConnection: jest.fn(async () => connection),
      getIntegrationConnectionCredentials: jest.fn(async () => credentials),
      findExternalTaskLink: jest.fn(async () => null),
    };
    const service = new ExternalMyWorkService(
      storage as unknown as StorageService,
      new ExternalTaskProviderRegistry([provider]),
    );

    await expect(service.getTaskDetail('jira', 'ENG-1')).resolves.toEqual(
      expect.objectContaining({
        remoteId: 'ENG-1',
        allowedStatuses: [expect.objectContaining({ actionValue: '31', name: 'Done' })],
        linkState: { linked: false, epicId: null },
      }),
    );
    await expect(
      service.addTaskComment('jira', 'ENG-1', { text: 'Generic route', notifyAll: false }),
    ).resolves.toEqual({
      remoteTaskId: 'ENG-1',
      action: 'add_comment',
      succeeded: true,
      refresh: ['my_work', 'task_detail'],
    });
    expect(
      requestJson.mock.calls.filter(
        ([request]) =>
          request.method === 'POST' && new URL(request.url).pathname.endsWith('/comment'),
      ),
    ).toHaveLength(1);
  });
});

function jiraComment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '10000',
    author: {
      accountId: '5b10a2844c20165700ede21g',
      displayName: 'Mia Krystof',
      active: true,
      self: 'https://acme.atlassian.net/rest/api/3/user?accountId=5b10a2844c20165700ede21g',
    },
    body: adf('Plain Jira comment'),
    created: '2026-08-19T12:34:00.000+0000',
    updated: '2026-08-19T13:45:00.000+0000',
    self: 'https://acme.atlassian.net/rest/api/3/issue/10010/comment/10000',
    updateAuthor: {
      accountId: '5b10a2844c20165700ede21g',
      displayName: 'Mia Krystof',
    },
    visibility: { type: 'role', value: 'Administrators', identifier: 'Administrators' },
    ...overrides,
  };
}

function commentsPage(
  comments: Record<string, unknown>[],
  total: number,
  startAt: number,
): Record<string, unknown> {
  return { comments, startAt, maxResults: 10, total };
}

describe('Jira task comments', () => {
  it('requests ten newest-first comments and advances the decimal cursor until total', async () => {
    const requests: SafeVendorJsonRequest[] = [];
    const requestJson = jest.fn(async (request: SafeVendorJsonRequest) => {
      requests.push(request);
      const url = new URL(request.url);
      if (url.pathname !== '/rest/api/3/issue/ENG-1/comment') {
        throw new Error(`unexpected Jira request: ${url.toString()}`);
      }
      expect(url.searchParams.get('maxResults')).toBe('10');
      expect(url.searchParams.get('orderBy')).toBe('-created');
      const startAt = url.searchParams.get('startAt');
      if (startAt === '0') {
        return commentsPage(
          Array.from({ length: 10 }, (_, index) => jiraComment({ id: String(10_000 + index) })),
          25,
          0,
        );
      }
      if (startAt === '10') {
        return commentsPage(
          Array.from({ length: 10 }, (_, index) => jiraComment({ id: String(10_010 + index) })),
          25,
          10,
        );
      }
      return commentsPage(
        Array.from({ length: 5 }, (_, index) => jiraComment({ id: String(10_020 + index) })),
        25,
        20,
      );
    });
    const provider = providerWith(requestJson);

    const first = await provider.myWork!.listComments!(credentials, context, 'ENG-1', null);

    expect(requestJson).toHaveBeenCalledTimes(1);
    expect(new URL(requests[0]!.url).searchParams.get('startAt')).toBe('0');
    expect(first.comments).toHaveLength(10);
    expect(first.comments[0]).toEqual({
      remoteId: '10000',
      author: { remoteId: '5b10a2844c20165700ede21g', displayName: 'Mia Krystof' },
      body: 'Plain Jira comment',
      bodyTruncated: false,
      rich: { document: expect.anything(), supported: true },
      lookupToken: null,
      owned: false,
      createdAt: '2026-08-19T12:34:00.000Z',
      updatedAt: '2026-08-19T13:45:00.000Z',
    });
    expect(first.nextCursor).toBe('10');

    const second = await provider.myWork!.listComments!(
      credentials,
      context,
      'ENG-1',
      first.nextCursor!,
    );
    expect(new URL(requests[1]!.url).searchParams.get('startAt')).toBe('10');
    expect(second.nextCursor).toBe('20');

    const third = await provider.myWork!.listComments!(
      credentials,
      context,
      'ENG-1',
      second.nextCursor!,
    );
    expect(third.comments).toHaveLength(5);
    expect(third.nextCursor).toBeNull();
    expect(JSON.stringify(first)).not.toMatch(
      /self|visibility|updateAuthor|active|atlassian\.net\/rest/i,
    );
  });

  it('emits no cursor for an empty page at any position', async () => {
    const requestJson = jest.fn(async (request: SafeVendorJsonRequest) => {
      const startAt = new URL(request.url).searchParams.get('startAt');
      if (startAt === '0') return commentsPage([], 0, 0);
      if (startAt === '20') return commentsPage([], 20, 20);
      return commentsPage([], 3, 1_000_000);
    });
    const provider = providerWith(requestJson);

    await expect(
      provider.myWork!.listComments!(credentials, context, 'ENG-1', null),
    ).resolves.toEqual({ comments: [], nextCursor: null });
    await expect(
      provider.myWork!.listComments!(credentials, context, 'ENG-1', '20'),
    ).resolves.toEqual({ comments: [], nextCursor: null });
    await expect(
      provider.myWork!.listComments!(credentials, context, 'ENG-1', '1000000'),
    ).resolves.toEqual({ comments: [], nextCursor: null });
  });

  it('emits no cursor for a non-empty page whose position did not advance past the request', async () => {
    const requestJson = jest.fn(async () =>
      commentsPage(
        Array.from({ length: 10 }, (_, index) => jiraComment({ id: String(10_010 + index) })),
        45,
        10,
      ),
    );
    const provider = providerWith(requestJson);

    const page = await provider.myWork!.listComments!(credentials, context, 'ENG-1', '20');

    expect(page.comments).toHaveLength(10);
    expect(page.nextCursor).toBeNull();
  });

  it('stops paging at the startAt cap instead of emitting an unusable cursor', async () => {
    const requestJson = jest.fn(async () =>
      commentsPage(
        Array.from({ length: 10 }, (_, index) => jiraComment({ id: String(index) })),
        2_000_000,
        1_000_000,
      ),
    );
    const provider = providerWith(requestJson);

    const page = await provider.myWork!.listComments!(credentials, context, 'ENG-1', '999995');

    expect(page.comments).toHaveLength(10);
    expect(page.nextCursor).toBeNull();
  });

  it.each([
    ['non-decimal cursor', 'abc'],
    ['negative cursor', '-1'],
    ['fractional cursor', '1.5'],
    ['cursor above the cap', '1000001'],
    ['oversized cursor', '9'.repeat(1_025)],
  ])('rejects a %s before transport', async (_case, cursor) => {
    const requestJson = jest.fn();
    const provider = providerWith(requestJson);

    await expect(
      provider.myWork!.listComments!(credentials, context, 'ENG-1', cursor),
    ).rejects.toMatchObject({ code: 'jira_request_rejected' });
    expect(requestJson).not.toHaveBeenCalled();
  });

  it('preserves ADF inline fallbacks in task descriptions and comment bodies', async () => {
    const inlineAdf = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Ping ' },
            { type: 'mention', attrs: { id: '1', text: '@Ada Lovelace' } },
            { type: 'text', text: ' shipped ' },
            { type: 'emoji', attrs: { shortName: ':tada:' } },
            { type: 'text', text: ' status ' },
            { type: 'status', attrs: { text: 'IN REVIEW', style: 'bold', localId: '1' } },
            { type: 'text', text: ' due ' },
            { type: 'date', attrs: { timestamp: String(Date.parse('2026-08-19T00:00:00.000Z')) } },
            { type: 'text', text: ' spec ' },
            { type: 'inlineCard', attrs: { url: 'https://example.com/spec' } },
          ],
        },
      ],
    };
    const requestJson = jest.fn(async (request: SafeVendorJsonRequest) => {
      const url = new URL(request.url);
      if (url.pathname === '/rest/api/3/issue/ENG-1') {
        return issueDetail({
          fields: {
            ...(issueDetail().fields as Record<string, unknown>),
            description: inlineAdf,
          },
        });
      }
      if (url.pathname === '/rest/api/3/issue/ENG-1/transitions') return transitions();
      if (url.pathname === '/rest/api/3/configuration') return { timeTrackingEnabled: true };
      if (url.pathname === '/rest/api/3/issue/ENG-1/comment') {
        return commentsPage([jiraComment({ body: inlineAdf })], 1, 0);
      }
      throw new Error(`unexpected Jira request: ${url.toString()}`);
    });
    const provider = providerWith(requestJson);

    const detail = await provider.myWork!.getTaskDetail!(credentials, context, 'ENG-1');
    const page = await provider.myWork!.listComments!(credentials, context, 'ENG-1', null);

    const expected =
      'Ping @Ada Lovelace shipped :tada: status IN REVIEW due 2026-08-19 spec https://example.com/spec';
    expect(detail.description).toBe(expected);
    expect(detail.descriptionTruncated).toBe(false);
    expect(page.comments[0]).toEqual(
      expect.objectContaining({ body: expected, bodyTruncated: false }),
    );
  });

  it('skips optional ADF inline fallbacks that have no visible label', async () => {
    const inlineAdf = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Before' },
            { type: 'mention', attrs: { id: 'acc-9' } },
            { type: 'text', text: ' middle' },
            { type: 'inlineCard', attrs: { data: { url: 'https://example.com/spec' } } },
            { type: 'text', text: ' after' },
          ],
        },
      ],
    };
    const requestJson = jest.fn(async (request: SafeVendorJsonRequest) => {
      const url = new URL(request.url);
      if (url.pathname === '/rest/api/3/issue/ENG-1') {
        return issueDetail({
          fields: {
            ...(issueDetail().fields as Record<string, unknown>),
            description: inlineAdf,
          },
        });
      }
      if (url.pathname === '/rest/api/3/issue/ENG-1/transitions') return transitions();
      if (url.pathname === '/rest/api/3/configuration') return { timeTrackingEnabled: true };
      if (url.pathname === '/rest/api/3/issue/ENG-1/comment') {
        return commentsPage([jiraComment({ body: inlineAdf })], 1, 0);
      }
      throw new Error(`unexpected Jira request: ${url.toString()}`);
    });
    const provider = providerWith(requestJson);

    const detail = await provider.myWork!.getTaskDetail!(credentials, context, 'ENG-1');
    const page = await provider.myWork!.listComments!(credentials, context, 'ENG-1', null);

    expect(detail.description).toBe('Before middle after');
    expect(detail.descriptionTruncated).toBe(false);
    expect(page.comments[0]).toEqual(
      expect.objectContaining({ body: 'Before middle after', bodyTruncated: false }),
    );
  });

  it('truncates long flattened comment bodies at the comment bound', async () => {
    const requestJson = jest.fn(async () =>
      commentsPage([jiraComment({ body: adf('x'.repeat(9_000)) })], 1, 0),
    );

    const page = await providerWith(requestJson).myWork!.listComments!(
      credentials,
      context,
      'ENG-1',
      null,
    );

    expect(page.comments[0]).toEqual(
      expect.objectContaining({ body: 'x'.repeat(8_000), bodyTruncated: true }),
    );
  });

  it('uses Unknown user when the Jira author lacks a usable name', async () => {
    const requestJson = jest.fn(async () =>
      commentsPage(
        [jiraComment({ author: null }), jiraComment({ author: { accountId: '5b10' } })],
        2,
        0,
      ),
    );

    const page = await providerWith(requestJson).myWork!.listComments!(
      credentials,
      context,
      'ENG-1',
      null,
    );

    expect(page.comments.map((comment) => comment.author)).toEqual([
      { remoteId: null, displayName: 'Unknown user' },
      { remoteId: '5b10', displayName: 'Unknown user' },
    ]);
  });

  it.each([
    ['non-array comments', { comments: {}, startAt: 0, total: 1 }],
    ['missing total', { comments: [], startAt: 0 }],
    ['non-integer total', { comments: [], startAt: 0, total: '25' }],
    ['missing startAt', { comments: [], total: 1 }],
    ['non-integer startAt', { comments: [], startAt: 1.5, total: 1 }],
    ['negative startAt', { comments: [], startAt: -1, total: 1 }],
    [
      'oversized page',
      { comments: Array.from({ length: 11 }, () => jiraComment()), startAt: 0, total: 11 },
    ],
    ['non-record comment', { comments: ['nope'], startAt: 0, total: 1 }],
  ])('classifies a malformed %s page safely', async (_case, payload) => {
    const requestJson = jest.fn(async () => payload);

    await expect(
      providerWith(requestJson).myWork!.listComments!(credentials, context, 'ENG-1', null),
    ).rejects.toMatchObject({ code: 'jira_invalid_response' });
  });
});
