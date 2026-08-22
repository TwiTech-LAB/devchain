import type { ClickUpIntegrationCredentials } from '../../storage/models/domain.models';
import type { ExternalProviderConnectionContext } from '../models/external-provider.models';
import { SafeVendorHttpClient, SafeVendorHttpError } from '../transport/safe-vendor-http-client';
import { ClickUpExternalTaskProvider } from './clickup-external-task.provider';

// Adapter unit layer: provider-native HTTP shapes are faked at the safe
// client boundary, matching the recorded live-probe contracts.

const credentials: ClickUpIntegrationCredentials = {
  provider: 'clickup',
  token: 'clickup-secret-token',
};
const context: ExternalProviderConnectionContext = {
  connectionId: 'connection-clickup',
  connectionGeneration: 3,
};

function providerWith(requestJson: jest.Mock): ClickUpExternalTaskProvider {
  return new ClickUpExternalTaskProvider({ requestJson } as unknown as SafeVendorHttpClient);
}

function commentPage(ids: string[], oldestCursor: { date: number; id: string } | null) {
  const comments = ids.map((id, index) => ({
    id,
    comment_text: `text-${id}`,
    comment: [{ text: `text-${id}` }],
    user: { id: 183, username: 'Probe Owner' },
    date: 1_700_000_000_000 - index * 1_000,
  }));
  return {
    comments,
    nextCursor: oldestCursor
      ? Buffer.from(JSON.stringify(oldestCursor), 'utf8').toString('base64url')
      : null,
  };
}

function cursorOf(date: number, id: string): string {
  return Buffer.from(JSON.stringify({ date, id }), 'utf8').toString('base64url');
}

describe('ClickUp owned mutations and description editing', () => {
  it('getCurrentOwnerRemoteId reads the authorized user id', async () => {
    const requestJson = jest.fn().mockResolvedValue({ user: { id: 183, username: 'owner' } });
    const provider = providerWith(requestJson);
    await expect(provider.ownedMutations!.getCurrentOwnerRemoteId(credentials)).resolves.toBe(
      '183',
    );
    expect(requestJson).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://api.clickup.com/api/v2/user' }),
    );
  });

  describe('bounded findComment', () => {
    it('finds a comment on the producing page replay with one request', async () => {
      const requestJson = jest
        .fn()
        .mockResolvedValueOnce(commentPage(['c2', 'c1'], { date: 1, id: 'c1' }));
      const provider = providerWith(requestJson);
      const snapshot = await provider.ownedMutations!.findComment(
        credentials,
        context,
        'task-1',
        'c2',
        cursorOf(1_700_000_000_000, 'c3'),
      );
      expect(snapshot).toMatchObject({
        remoteId: 'c2',
        authorRemoteId: '183',
        createdAt: new Date(1_700_000_000_000).toISOString(),
        metadata: { assignee: null, resolved: null, groupAssignee: null },
      });
      expect(Array.isArray(snapshot!.raw)).toBe(true);
      expect(requestJson).toHaveBeenCalledTimes(1);
      expect(requestJson.mock.calls[0]![0].url).toContain('start=');
      expect(requestJson.mock.calls[0]![0].url).toContain('start_id=');
    });

    it('chases exactly one provider-issued adjacent page and then stops', async () => {
      const requestJson = jest
        .fn()
        .mockResolvedValueOnce(commentPage(['c9'], { date: 1, id: 'c9' }))
        .mockResolvedValueOnce(commentPage(['c2', 'c1'], null));
      const provider = providerWith(requestJson);
      const snapshot = await provider.ownedMutations!.findComment(
        credentials,
        context,
        'task-1',
        'c2',
        null,
      );
      expect(snapshot?.remoteId).toBe('c2');
      expect(requestJson).toHaveBeenCalledTimes(2);
    });

    it('returns null after the two-page bound instead of paging further', async () => {
      const requestJson = jest
        .fn()
        .mockResolvedValueOnce(commentPage(['c9'], { date: 1, id: 'c9' }))
        .mockResolvedValueOnce(commentPage(['c8'], { date: 2, id: 'c8' }));
      const provider = providerWith(requestJson);
      await expect(
        provider.ownedMutations!.findComment(credentials, context, 'task-1', 'c1', null),
      ).resolves.toBeNull();
      expect(requestJson).toHaveBeenCalledTimes(2);
    });

    it('rejects a malformed page proof cursor', async () => {
      const provider = providerWith(jest.fn());
      await expect(
        provider.ownedMutations!.findComment(credentials, context, 'task-1', 'c1', 'not-a-cursor'),
      ).rejects.toMatchObject({ details: { reason: 'request_rejected' } });
    });
  });

  it('deleteComment issues the documented comment delete', async () => {
    const requestJson = jest.fn().mockResolvedValue({});
    const provider = providerWith(requestJson);
    await provider.ownedMutations!.deleteComment(credentials, context, 'task-1', '555');
    expect(requestJson).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://api.clickup.com/api/v2/comment/555',
        method: 'DELETE',
      }),
    );
  });

  it('preserves dispatched flag through transport mapping on delete', async () => {
    const requestJson = jest.fn().mockImplementation(() => {
      throw new SafeVendorHttpError('timeout', undefined, undefined, true);
    });
    const provider = providerWith(requestJson);
    await expect(
      provider.ownedMutations!.deleteComment(credentials, context, 'task-1', '555'),
    ).rejects.toMatchObject({ details: { reason: 'timeout', dispatched: true } });
  });

  it('updateOwnedComment preserves freshly fetched assignee, resolved, and group_assignee exactly', async () => {
    const requestJson = jest.fn().mockResolvedValue({ id: '555' });
    const provider = providerWith(requestJson);
    const document = {
      version: 1,
      blocks: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'edited ', marks: [] },
            { type: 'text', text: 'body', marks: [{ type: 'bold' }] },
          ],
        },
      ],
    } as never;
    await provider.ownedMutations!.updateOwnedComment(
      credentials,
      context,
      'task-1',
      '555',
      document,
      { assignee: 183, resolved: true, groupAssignee: 'dd01f92f-48ca-446d-88a1-0beb0e8f5f14' },
    );
    expect(requestJson).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://api.clickup.com/api/v2/comment/555',
        method: 'PUT',
        body: JSON.stringify({
          comment: [{ text: 'edited ' }, { text: 'body', attributes: { bold: true } }],
          assignee: 183,
          resolved: true,
          group_assignee: 'dd01f92f-48ca-446d-88a1-0beb0e8f5f14',
        }),
      }),
    );
  });

  it('updateOwnedComment fails closed for markdown-unrepresentable content', async () => {
    const requestJson = jest.fn();
    const provider = providerWith(requestJson);
    const document = {
      version: 1,
      blocks: [{ type: 'paragraph', content: [{ type: 'hardBreak' }] }],
    } as never;
    await expect(
      provider.ownedMutations!.updateOwnedComment(credentials, context, 'task-1', '555', document, {
        assignee: null,
        resolved: null,
        groupAssignee: null,
      }),
    ).rejects.toMatchObject({ details: { reason: 'request_rejected' } });
    expect(requestJson).not.toHaveBeenCalled();
  });

  describe('description edit', () => {
    it('reads the markdown description through the documented flag', async () => {
      const requestJson = jest.fn().mockResolvedValue({
        id: 'task-1',
        markdown_description: '# heading',
      });
      const provider = providerWith(requestJson);
      await expect(
        provider.descriptionEdit!.readDescription(credentials, context, 'task-1'),
      ).resolves.toBe('# heading');
      expect(requestJson.mock.calls[0]![0].url).toContain('include_markdown_description=true');
    });

    it('returns null for an absent markdown description', async () => {
      const requestJson = jest.fn().mockResolvedValue({ id: 'task-1' });
      const provider = providerWith(requestJson);
      await expect(
        provider.descriptionEdit!.readDescription(credentials, context, 'task-1'),
      ).resolves.toBeNull();
    });

    it('writes the markdown description through the task update body', async () => {
      const requestJson = jest.fn().mockResolvedValue({ id: 'task-1' });
      const provider = providerWith(requestJson);
      await provider.descriptionEdit!.writeDescription(
        credentials,
        context,
        'task-1',
        '# new content',
      );
      expect(requestJson).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://api.clickup.com/api/v2/task/task-1',
          method: 'PUT',
          body: JSON.stringify({ markdown_description: '# new content' }),
        }),
      );
    });

    it('rejects a non-string description payload', async () => {
      const provider = providerWith(jest.fn());
      await expect(
        provider.descriptionEdit!.writeDescription(credentials, context, 'task-1', 42),
      ).rejects.toMatchObject({ details: { reason: 'request_rejected' } });
    });
  });
});
