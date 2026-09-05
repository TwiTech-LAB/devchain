import type { ClickUpIntegrationCredentials } from '../../storage/models/domain.models';
import type { ExternalProviderConnectionContext } from '../models/external-provider.models';
import { SafeVendorHttpClient, SafeVendorHttpError } from '../transport/safe-vendor-http-client';
import { ClickUpExternalTaskProvider } from './clickup-external-task.provider';

const credentials: ClickUpIntegrationCredentials = {
  provider: 'clickup',
  token: 'clickup-secret-token',
};
const context: ExternalProviderConnectionContext = {
  connectionId: 'connection-clickup',
  connectionGeneration: 3,
};
const ownershipToken = '9f025d13';
const otherOwnershipToken = '0a1b2c3d';
const marker = `SourceId: ${ownershipToken}`;
const managedDescription = `Original description\n\n${marker}`;

function providerWith(
  requestJson: jest.Mock,
  requestNoContent: jest.Mock = jest.fn(),
): ClickUpExternalTaskProvider {
  return new ClickUpExternalTaskProvider({
    requestJson,
    requestNoContent,
  } as unknown as SafeVendorHttpClient);
}

function task(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'child-1',
    custom_id: 'DC-1',
    name: 'Managed child',
    parent: 'parent-1',
    list: { id: '42' },
    assignees: [{ id: 123 }],
    markdown_description: managedDescription,
    ...overrides,
  };
}

describe('ClickUp managed subtasks', () => {
  it('creates in the exact parent List appending the terminal source id to the description', async () => {
    const requestJson = jest
      .fn()
      .mockResolvedValueOnce(task({ id: 'parent-1', parent: null, name: 'Parent' }))
      .mockResolvedValueOnce({ user: { id: 123 } })
      .mockResolvedValueOnce(task());
    const provider = providerWith(requestJson);

    await expect(
      provider.subtaskSync!.create(credentials, context, {
        parentRemoteTaskId: 'parent-1',
        ownershipToken,
        title: 'Managed child',
        description: 'Original description',
      }),
    ).resolves.toEqual({
      remoteTaskId: 'child-1',
      remoteKey: 'DC-1',
      parentRemoteTaskId: 'parent-1',
      workAreaRemoteId: '42',
      ownershipToken,
      title: 'Managed child',
      description: 'Original description',
    });

    expect(requestJson.mock.calls[2]![0]).toEqual(
      expect.objectContaining({
        url: 'https://api.clickup.com/api/v2/list/42/task',
        method: 'POST',
        body: JSON.stringify({
          name: 'Managed child',
          markdown_content: managedDescription,
          parent: 'parent-1',
          assignees: [123],
        }),
      }),
    );
  });

  it('creates a marker-only Markdown body when the source description is null', async () => {
    const requestJson = jest
      .fn()
      .mockResolvedValueOnce(task({ id: 'parent-1', parent: null, name: 'Parent' }))
      .mockResolvedValueOnce({ user: { id: 123 } })
      .mockResolvedValueOnce(task({ markdown_description: marker }));
    const provider = providerWith(requestJson);

    await expect(
      provider.subtaskSync!.create(credentials, context, {
        parentRemoteTaskId: 'parent-1',
        ownershipToken,
        title: 'Managed child',
        description: null,
      }),
    ).resolves.toMatchObject({ ownershipToken, description: null });

    expect(JSON.parse(requestJson.mock.calls[2]![0].body)).toMatchObject({
      markdown_content: marker,
    });
  });

  it.each([
    ['uppercase hex', '9F025D13'],
    ['non-hexadecimal', 'zzzzzzz1'],
    ['too short', '9f025d1'],
    ['too long', '9f025d133'],
    ['uuid-shaped', '9f025d13-01ef-4b53-a532-b2a0db008b7e'],
  ])('rejects a %s ownership token at the provider boundary', async (_label, token) => {
    const requestJson = jest.fn();
    await expect(
      providerWith(requestJson).subtaskSync!.create(credentials, context, {
        parentRemoteTaskId: 'parent-1',
        ownershipToken: token,
        title: 'Managed child',
        description: null,
      }),
    ).rejects.toMatchObject({ details: { reason: 'request_rejected' } });
    expect(requestJson).not.toHaveBeenCalled();
  });

  it('reads marker-only and description-plus-marker bodies without changing the description', async () => {
    const markerOnly = providerWith(
      jest.fn().mockResolvedValueOnce(task({ markdown_description: marker })),
    );
    await expect(
      markerOnly.subtaskSync!.readExact(credentials, context, 'child-1'),
    ).resolves.toEqual(expect.objectContaining({ ownershipToken, description: null }));

    const withDescription = providerWith(jest.fn().mockResolvedValueOnce(task()));
    await expect(
      withDescription.subtaskSync!.readExact(credentials, context, 'child-1'),
    ).resolves.toEqual(
      expect.objectContaining({ ownershipToken, description: 'Original description' }),
    );
  });

  it.each([
    ['uppercase marker', `Original description\n\nSourceId: 9F025D13`],
    ['non-hexadecimal marker', `Original description\n\nSourceId: zzzzzzz1`],
    ['short marker', `Original description\n\nSourceId: 9f025d1`],
    ['long marker', `Original description\n\nSourceId: 9f025d133`],
    ['embedded marker', `Original SourceId: ${ownershipToken} description`],
    ['non-terminal marker', `Original description\n\n${marker}\nTrailing line`],
  ])('treats a %s as unowned and keeps the full body as description', async (_label, body) => {
    const requestJson = jest.fn().mockResolvedValue(task({ markdown_description: body }));
    const snapshot = await providerWith(requestJson).subtaskSync!.readExact(
      credentials,
      context,
      'child-1',
    );
    expect(snapshot).toEqual(expect.objectContaining({ ownershipToken: null, description: body }));
  });

  it('refuses to create when the connected ClickUp user has no numeric assignee id', async () => {
    const requestJson = jest
      .fn()
      .mockResolvedValueOnce(task({ id: 'parent-1', parent: null, name: 'Parent' }))
      .mockResolvedValueOnce({ user: { id: 'not-numeric' } });

    await expect(
      providerWith(requestJson).subtaskSync!.create(credentials, context, {
        parentRemoteTaskId: 'parent-1',
        ownershipToken,
        title: 'Managed child',
        description: null,
      }),
    ).rejects.toMatchObject({ details: { reason: 'invalid_response' } });
    expect(requestJson).toHaveBeenCalledTimes(2);
  });

  it('classifies an exact task 404 as confirmed absence', async () => {
    const requestJson = jest.fn().mockRejectedValue(new SafeVendorHttpError('http_error', 404));
    await expect(
      providerWith(requestJson).subtaskSync!.readExact(credentials, context, 'missing'),
    ).resolves.toBeNull();
  });

  it('preflights ownership and parent before updating title and Markdown description', async () => {
    const requestJson = jest.fn().mockResolvedValueOnce(task()).mockResolvedValueOnce(task());
    const provider = providerWith(requestJson);
    await provider.subtaskSync!.update(credentials, context, {
      remoteTaskId: 'child-1',
      expectedParentRemoteTaskId: 'parent-1',
      ownershipToken,
      title: 'Renamed child',
      description: 'Replacement',
    });
    expect(requestJson.mock.calls[1]![0]).toEqual(
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          name: 'Renamed child',
          markdown_content: `Replacement\n\n${marker}`,
        }),
      }),
    );
  });

  it('writes a marker-only body when updating to a null description', async () => {
    const requestJson = jest.fn().mockResolvedValueOnce(task()).mockResolvedValueOnce(task());
    const provider = providerWith(requestJson);
    await provider.subtaskSync!.update(credentials, context, {
      remoteTaskId: 'child-1',
      expectedParentRemoteTaskId: 'parent-1',
      ownershipToken,
      description: null,
    });
    expect(JSON.parse(requestJson.mock.calls[1]![0].body)).toEqual({
      markdown_content: marker,
    });
  });

  it.each([
    [
      'ownership marker',
      task({ markdown_description: 'Remote description' }),
      'ownership_mismatch',
    ],
    ['expected parent', task({ parent: 'other-parent' }), 'parent_mismatch'],
  ])('refuses update when the %s proof fails', async (_label, current, reason) => {
    const requestJson = jest.fn().mockResolvedValue(current);
    await expect(
      providerWith(requestJson).subtaskSync!.update(credentials, context, {
        remoteTaskId: 'child-1',
        expectedParentRemoteTaskId: 'parent-1',
        ownershipToken,
        title: 'Must not write',
      }),
    ).rejects.toMatchObject({ details: { reason } });
    expect(requestJson).toHaveBeenCalledTimes(1);
  });

  it('deletes the exact proven task through the strict 204 path', async () => {
    const requestJson = jest.fn().mockResolvedValue(task());
    const requestNoContent = jest.fn().mockResolvedValue(undefined);
    const provider = providerWith(requestJson, requestNoContent);
    await expect(
      provider.subtaskSync!.delete(credentials, context, {
        remoteTaskId: 'child-1',
        expectedParentRemoteTaskId: 'parent-1',
        ownershipToken,
      }),
    ).resolves.toEqual({ outcome: 'deleted' });
    expect(requestNoContent).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://api.clickup.com/api/v2/task/child-1',
        method: 'DELETE',
      }),
    );
  });

  it('returns already_absent without dispatching delete after an exact 404', async () => {
    const requestJson = jest.fn().mockRejectedValue(new SafeVendorHttpError('http_error', 404));
    const requestNoContent = jest.fn();
    await expect(
      providerWith(requestJson, requestNoContent).subtaskSync!.delete(credentials, context, {
        remoteTaskId: 'missing',
        expectedParentRemoteTaskId: 'parent-1',
        ownershipToken,
      }),
    ).resolves.toEqual({ outcome: 'already_absent' });
    expect(requestNoContent).not.toHaveBeenCalled();
  });

  it('treats an exact delete 404 after successful preflight as already absent', async () => {
    const requestJson = jest.fn().mockResolvedValue(task());
    const requestNoContent = jest
      .fn()
      .mockRejectedValue(new SafeVendorHttpError('http_error', 404));
    await expect(
      providerWith(requestJson, requestNoContent).subtaskSync!.delete(credentials, context, {
        remoteTaskId: 'child-1',
        expectedParentRemoteTaskId: 'parent-1',
        ownershipToken,
      }),
    ).resolves.toEqual({ outcome: 'already_absent' });
  });

  it('preserves dispatched ambiguity from the exact delete', async () => {
    const requestJson = jest.fn().mockResolvedValue(task());
    const requestNoContent = jest
      .fn()
      .mockRejectedValue(new SafeVendorHttpError('timeout', undefined, undefined, true));
    await expect(
      providerWith(requestJson, requestNoContent).subtaskSync!.delete(credentials, context, {
        remoteTaskId: 'child-1',
        expectedParentRemoteTaskId: 'parent-1',
        ownershipToken,
      }),
    ).rejects.toMatchObject({ details: { reason: 'timeout', dispatched: true } });
  });

  it('enumerates only matching owned direct children and proves a short page complete', async () => {
    const requestJson = jest
      .fn()
      .mockResolvedValueOnce(task({ id: 'parent-1', parent: null, name: 'Parent' }))
      .mockResolvedValueOnce({
        tasks: [
          task(),
          task({
            id: 'other-token',
            markdown_description: `Original description\n\nSourceId: ${otherOwnershipToken}`,
          }),
          task({ id: 'grandchild', parent: 'child-1' }),
        ],
      });
    const result = await providerWith(requestJson).subtaskSync!.listOwnedDirectChildren(
      credentials,
      context,
      'parent-1',
      ownershipToken,
    );
    expect(result).toEqual({
      items: [expect.objectContaining({ remoteTaskId: 'child-1' })],
      complete: true,
    });
    expect(requestJson.mock.calls[1]![0].url).toContain('subtasks=true');
    expect(requestJson.mock.calls[1]![0].url).toContain('include_closed=true');
    expect(requestJson.mock.calls[1]![0].url).toContain('include_markdown_description=true');
  });

  it('reports capped enumeration as incomplete', async () => {
    const fullPage = {
      tasks: Array.from({ length: 100 }, (_, index) => task({ id: `child-${index}` })),
    };
    const requestJson = jest
      .fn()
      .mockResolvedValueOnce(task({ id: 'parent-1', parent: null, name: 'Parent' }));
    for (let page = 0; page < 10; page += 1) requestJson.mockResolvedValueOnce(fullPage);
    const result = await providerWith(requestJson).subtaskSync!.listOwnedDirectChildren(
      credentials,
      context,
      'parent-1',
      ownershipToken,
    );
    expect(result.complete).toBe(false);
    expect(requestJson).toHaveBeenCalledTimes(11);
  });

  it('marks a malformed confirmed-create response as dispatched unknown', async () => {
    const requestJson = jest
      .fn()
      .mockResolvedValueOnce(task({ id: 'parent-1', parent: null, name: 'Parent' }))
      .mockResolvedValueOnce({ user: { id: 123 } })
      .mockResolvedValueOnce({ id: 'child-1' });
    await expect(
      providerWith(requestJson).subtaskSync!.create(credentials, context, {
        parentRemoteTaskId: 'parent-1',
        ownershipToken,
        title: 'Child',
        description: null,
      }),
    ).rejects.toMatchObject({ details: { reason: 'invalid_response', dispatched: true } });
  });
});
