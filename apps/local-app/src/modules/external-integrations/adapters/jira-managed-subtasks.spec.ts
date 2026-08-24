import type { JiraIntegrationCredentials } from '../../storage/models/domain.models';
import {
  EXTERNAL_SUBTASK_MANAGEMENT_NOTE,
  type ExternalProviderConnectionContext,
} from '../models/external-provider.models';
import { SafeVendorHttpClient, SafeVendorHttpError } from '../transport/safe-vendor-http-client';
import { JiraExternalTaskProvider } from './jira-external-task.provider';

const credentials: JiraIntegrationCredentials = {
  provider: 'jira',
  siteUrl: 'https://test.atlassian.net',
  email: 'user@example.com',
  token: 'secret',
};
const context: ExternalProviderConnectionContext = {
  connectionId: 'connection-jira',
  connectionGeneration: 2,
};
const ownershipToken = '9f025d13-01ef-4b53-a532-b2a0db008b7e';
const property = { version: 1, ownershipToken };
const description = {
  type: 'doc',
  version: 1,
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Original description' }] },
    { type: 'paragraph', content: [{ type: 'text', text: EXTERNAL_SUBTASK_MANAGEMENT_NOTE }] },
  ],
};

function providerWith(
  requestJson: jest.Mock,
  requestNoContent: jest.Mock = jest.fn(),
): JiraExternalTaskProvider {
  return new JiraExternalTaskProvider({
    requestJson,
    requestNoContent,
  } as unknown as SafeVendorHttpClient);
}

function issue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '10001',
    key: 'KAN-2',
    fields: {
      summary: 'Managed child',
      description,
      parent: { id: '10000', key: 'KAN-1' },
      project: { id: '20000', key: 'KAN' },
    },
    properties: { 'devchain.managed-subtask': property },
    ...overrides,
  };
}

describe('Jira managed subtasks', () => {
  it('discovers one compatible project sub-task type, creates with ADF and property, and caches it', async () => {
    const requestJson = jest
      .fn()
      .mockResolvedValueOnce(
        issue({
          id: '10000',
          key: 'KAN-1',
          fields: { project: { id: '20000', key: 'KAN' } },
          properties: {},
        }),
      )
      .mockResolvedValueOnce([
        { id: '100', name: 'Task', subtask: false, hierarchyLevel: 0 },
        { id: '101', name: 'Subtask', subtask: true, hierarchyLevel: -1 },
      ])
      .mockResolvedValueOnce({ accountId: 'account-1', displayName: 'Connected user' })
      .mockResolvedValueOnce({ id: '10001', key: 'KAN-2' })
      .mockResolvedValueOnce(
        issue({
          id: '10000',
          key: 'KAN-1',
          fields: { project: { id: '20000', key: 'KAN' } },
          properties: {},
        }),
      )
      .mockResolvedValueOnce({ accountId: 'account-1', displayName: 'Connected user' })
      .mockResolvedValueOnce({ id: '10002', key: 'KAN-3' });
    const provider = providerWith(requestJson);

    const input = {
      parentRemoteTaskId: 'KAN-1',
      ownershipToken,
      title: 'Managed child',
      description: 'Original description',
    };
    await expect(provider.subtaskSync!.create(credentials, context, input)).resolves.toEqual({
      remoteTaskId: 'KAN-2',
      remoteKey: 'KAN-2',
      parentRemoteTaskId: 'KAN-1',
      workAreaRemoteId: '20000',
      ownershipToken,
      title: 'Managed child',
      description: 'Original description',
    });
    await provider.subtaskSync!.create(credentials, context, input);

    expect(
      requestJson.mock.calls.filter(([request]) => request.url.includes('/issuetype/project')),
    ).toHaveLength(1);
    const create = requestJson.mock.calls[3]![0];
    expect(JSON.parse(create.body)).toEqual({
      fields: {
        project: { id: '20000' },
        issuetype: { id: '101' },
        parent: { key: 'KAN-1' },
        summary: 'Managed child',
        description,
        assignee: { id: 'account-1' },
      },
      properties: [{ key: 'devchain.managed-subtask', value: property }],
    });
  });

  it('blocks truthfully when the linked project has no compatible sub-task issue type', async () => {
    const requestJson = jest
      .fn()
      .mockResolvedValueOnce(
        issue({
          id: '10000',
          key: 'KAN-1',
          fields: { project: { id: '20000', key: 'KAN' } },
          properties: {},
        }),
      )
      .mockResolvedValueOnce([{ id: '100', name: 'Task', subtask: false, hierarchyLevel: 0 }]);
    await expect(
      providerWith(requestJson).subtaskSync!.create(credentials, context, {
        parentRemoteTaskId: 'KAN-1',
        ownershipToken,
        title: 'Child',
        description: null,
      }),
    ).rejects.toMatchObject({ details: { reason: 'unsupported_subtask_type' } });
    expect(requestJson).toHaveBeenCalledTimes(2);
  });

  it('classifies an exact Jira issue 404 as confirmed absence', async () => {
    const requestJson = jest.fn().mockRejectedValue(new SafeVendorHttpError('http_error', 404));
    await expect(
      providerWith(requestJson).subtaskSync!.readExact(credentials, context, 'KAN-404'),
    ).resolves.toBeNull();
  });

  it('preflights property ownership and parent before editing the exact issue', async () => {
    const requestJson = jest.fn().mockResolvedValue(issue());
    const requestNoContent = jest.fn().mockResolvedValue(undefined);
    await providerWith(requestJson, requestNoContent).subtaskSync!.update(credentials, context, {
      remoteTaskId: 'KAN-2',
      expectedParentRemoteTaskId: 'KAN-1',
      ownershipToken,
      title: 'Renamed',
      description: 'Replacement',
    });
    expect(requestNoContent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'PUT',
        url: 'https://test.atlassian.net/rest/api/3/issue/KAN-2',
        body: expect.stringContaining(EXTERNAL_SUBTASK_MANAGEMENT_NOTE),
      }),
    );
  });

  it.each([
    ['property', issue({ properties: {} }), 'ownership_mismatch'],
    [
      'parent',
      issue({
        fields: {
          summary: 'Managed child',
          description,
          parent: { key: 'OTHER-1' },
          project: { id: '20000' },
        },
      }),
      'parent_mismatch',
    ],
  ])('refuses mutation when the %s proof fails', async (_label, current, reason) => {
    const requestJson = jest.fn().mockResolvedValue(current);
    const requestNoContent = jest.fn();
    await expect(
      providerWith(requestJson, requestNoContent).subtaskSync!.update(credentials, context, {
        remoteTaskId: 'KAN-2',
        expectedParentRemoteTaskId: 'KAN-1',
        ownershipToken,
        title: 'No write',
      }),
    ).rejects.toMatchObject({ details: { reason } });
    expect(requestNoContent).not.toHaveBeenCalled();
  });

  it('deletes only the exact proven issue and reports exact absence separately', async () => {
    const requestJson = jest.fn().mockResolvedValue(issue());
    const requestNoContent = jest.fn().mockResolvedValue(undefined);
    const provider = providerWith(requestJson, requestNoContent);
    await expect(
      provider.subtaskSync!.delete(credentials, context, {
        remoteTaskId: 'KAN-2',
        expectedParentRemoteTaskId: 'KAN-1',
        ownershipToken,
      }),
    ).resolves.toEqual({ outcome: 'deleted' });
    expect(requestNoContent).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://test.atlassian.net/rest/api/3/issue/KAN-2',
        method: 'DELETE',
      }),
    );

    const absent = providerWith(
      jest.fn().mockRejectedValue(new SafeVendorHttpError('http_error', 404)),
      jest.fn(),
    );
    await expect(
      absent.subtaskSync!.delete(credentials, context, {
        remoteTaskId: 'KAN-404',
        expectedParentRemoteTaskId: 'KAN-1',
        ownershipToken,
      }),
    ).resolves.toEqual({ outcome: 'already_absent' });
  });

  it('preserves dispatched delete ambiguity', async () => {
    const requestJson = jest.fn().mockResolvedValue(issue());
    const requestNoContent = jest
      .fn()
      .mockRejectedValue(new SafeVendorHttpError('timeout', undefined, undefined, true));
    await expect(
      providerWith(requestJson, requestNoContent).subtaskSync!.delete(credentials, context, {
        remoteTaskId: 'KAN-2',
        expectedParentRemoteTaskId: 'KAN-1',
        ownershipToken,
      }),
    ).rejects.toMatchObject({ details: { reason: 'timeout', dispatched: true } });
  });

  it('treats an exact delete 404 after successful preflight as already absent', async () => {
    const requestJson = jest.fn().mockResolvedValue(issue());
    const requestNoContent = jest
      .fn()
      .mockRejectedValue(new SafeVendorHttpError('http_error', 404));
    await expect(
      providerWith(requestJson, requestNoContent).subtaskSync!.delete(credentials, context, {
        remoteTaskId: 'KAN-2',
        expectedParentRemoteTaskId: 'KAN-1',
        ownershipToken,
      }),
    ).resolves.toEqual({ outcome: 'already_absent' });
  });

  it('enumerates matching direct children and reports terminal coverage complete', async () => {
    const requestJson = jest
      .fn()
      .mockResolvedValueOnce({
        id: '10000',
        key: 'KAN-1',
        fields: { subtasks: [{ id: '10001', key: 'KAN-2' }] },
      })
      .mockResolvedValueOnce(issue());
    const result = await providerWith(requestJson).subtaskSync!.listOwnedDirectChildren(
      credentials,
      context,
      'KAN-1',
      ownershipToken,
    );
    expect(result).toEqual({
      items: [expect.objectContaining({ remoteTaskId: 'KAN-2' })],
      complete: true,
    });
    expect(requestJson.mock.calls[0]![0].url).toContain('fields=subtasks');
    expect(requestJson.mock.calls[1]![0].url).toContain('properties=devchain.managed-subtask');
  });

  it('reports a capped Jira child walk incomplete', async () => {
    const requestJson = jest.fn().mockResolvedValueOnce({
      id: '10000',
      key: 'KAN-1',
      fields: {
        subtasks: Array.from({ length: 101 }, (_, index) => ({
          id: String(10_000 + index),
          key: `KAN-${index + 2}`,
        })),
      },
    });
    requestJson.mockImplementation((request: { url: string }) => {
      const key = decodeURIComponent(new URL(request.url).pathname.split('/').pop()!);
      return Promise.resolve(issue({ id: String(10_000 + Number(key.slice(4)) - 2), key }));
    });
    const result = await providerWith(requestJson).subtaskSync!.listOwnedDirectChildren(
      credentials,
      context,
      'KAN-1',
      ownershipToken,
    );
    expect(result.complete).toBe(false);
    expect(requestJson).toHaveBeenCalledTimes(101);
  });

  it('marks malformed post-create proof as dispatched unknown', async () => {
    const requestJson = jest
      .fn()
      .mockResolvedValueOnce(
        issue({
          id: '10000',
          key: 'KAN-1',
          fields: { project: { id: '20000', key: 'KAN' } },
          properties: {},
        }),
      )
      .mockResolvedValueOnce([{ id: '101', name: 'Subtask', subtask: true, hierarchyLevel: -1 }])
      .mockResolvedValueOnce({ accountId: 'account-1', displayName: 'Connected user' })
      .mockResolvedValueOnce({ id: '10001' });
    await expect(
      providerWith(requestJson).subtaskSync!.create(credentials, context, {
        parentRemoteTaskId: 'KAN-1',
        ownershipToken,
        title: 'Child',
        description: null,
      }),
    ).rejects.toMatchObject({ details: { reason: 'invalid_response', dispatched: true } });
  });
});
