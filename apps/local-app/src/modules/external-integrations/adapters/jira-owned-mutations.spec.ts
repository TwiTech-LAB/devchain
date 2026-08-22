import type { JiraIntegrationCredentials } from '../../storage/models/domain.models';
import type { ExternalProviderConnectionContext } from '../models/external-provider.models';
import {
  SafeVendorHttpClient,
  type SafeVendorJsonRequest,
} from '../transport/safe-vendor-http-client';
import { JiraExternalTaskProvider } from './jira-external-task.provider';

// Adapter unit layer: provider-native HTTP shapes are faked at the safe
// client boundary, matching the recorded live-probe contracts.

const credentials: JiraIntegrationCredentials = {
  provider: 'jira',
  siteUrl: 'https://test.atlassian.net',
  email: 'user@example.com',
  token: 'jira-secret-token',
};
const context: ExternalProviderConnectionContext = {
  connectionId: 'connection-jira',
  connectionGeneration: 2,
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

describe('Jira owned mutations and description editing', () => {
  it('getCurrentOwnerRemoteId reads the myself accountId', async () => {
    const requestJson = jest
      .fn()
      .mockResolvedValue({ accountId: '5b10a2844c20165700ede21g', displayName: 'Owner' });
    const provider = providerWith(requestJson);
    await expect(provider.ownedMutations!.getCurrentOwnerRemoteId(credentials)).resolves.toBe(
      '5b10a2844c20165700ede21g',
    );
  });

  it('findComment performs exactly one exact-comment read', async () => {
    const requestJson = jest.fn().mockResolvedValue({
      id: '10000',
      author: { accountId: '5b10a2844c20165700ede21g', displayName: 'Owner' },
      body: { type: 'doc', version: 1, content: [] },
      created: '2026-08-22T00:00:00.000+0000',
      updated: '2026-08-22T00:00:00.000+0000',
    });
    const provider = providerWith(requestJson);
    const snapshot = await provider.ownedMutations!.findComment(
      credentials,
      context,
      'KAN-1',
      '10000',
    );
    expect(snapshot).toEqual({
      remoteId: '10000',
      authorRemoteId: '5b10a2844c20165700ede21g',
      createdAt: '2026-08-22T00:00:00.000Z',
      raw: { type: 'doc', version: 1, content: [] },
      metadata: { assignee: null, resolved: null, groupAssignee: null },
    });
    expect(requestJson).toHaveBeenCalledTimes(1);
    expect((requestJson.mock.calls[0]![0] as SafeVendorJsonRequest).url).toBe(
      'https://test.atlassian.net/rest/api/3/issue/KAN-1/comment/10000',
    );
  });

  it('deleteComment uses the strict no-content reader for the 204 shape', async () => {
    const requestNoContent = jest.fn().mockResolvedValue(undefined);
    const provider = providerWith(jest.fn(), requestNoContent);
    await provider.ownedMutations!.deleteComment(credentials, context, 'KAN-1', '10000');
    expect(requestNoContent).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://test.atlassian.net/rest/api/3/issue/KAN-1/comment/10000',
        method: 'DELETE',
      }),
    );
  });

  it('updateOwnedComment PUTs the canonical ADF body through the exact-comment endpoint', async () => {
    const requestJson = jest.fn().mockResolvedValue({ id: '10000' });
    const provider = providerWith(requestJson);
    const document = {
      version: 1,
      blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'edited', marks: [] }] }],
    } as never;
    await provider.ownedMutations!.updateOwnedComment(
      credentials,
      context,
      'KAN-1',
      '10000',
      document,
      {
        assignee: null,
        resolved: null,
        groupAssignee: null,
      },
    );
    expect(requestJson).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://test.atlassian.net/rest/api/3/issue/KAN-1/comment/10000',
        method: 'PUT',
        body: JSON.stringify({
          body: {
            type: 'doc',
            version: 1,
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'edited' }] }],
          },
        }),
      }),
    );
  });

  describe('description edit', () => {
    const adf = {
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'desc' }] }],
    };

    it('reads the raw ADF description', async () => {
      const requestJson = jest.fn().mockResolvedValue({ fields: { description: adf } });
      const provider = providerWith(requestJson);
      await expect(
        provider.descriptionEdit!.readDescription(credentials, context, 'KAN-1'),
      ).resolves.toEqual(adf);
      expect((requestJson.mock.calls[0]![0] as SafeVendorJsonRequest).url).toContain(
        'fields=description',
      );
    });

    it('writes the ADF description through the issue edit endpoint', async () => {
      const requestNoContent = jest.fn().mockResolvedValue(undefined);
      const provider = providerWith(jest.fn(), requestNoContent);
      await provider.descriptionEdit!.writeDescription(credentials, context, 'KAN-1', adf);
      expect(requestNoContent).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://test.atlassian.net/rest/api/3/issue/KAN-1',
          method: 'PUT',
          body: JSON.stringify({ fields: { description: adf } }),
        }),
      );
    });

    it('rejects a non-ADF description payload', async () => {
      const provider = providerWith(jest.fn(), jest.fn());
      await expect(
        provider.descriptionEdit!.writeDescription(credentials, context, 'KAN-1', 'markdown'),
      ).rejects.toMatchObject({ details: { reason: 'request_rejected' } });
    });
  });
});
