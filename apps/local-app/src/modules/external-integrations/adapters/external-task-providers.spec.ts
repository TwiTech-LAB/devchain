import type {
  ClickUpIntegrationCredentials,
  JiraIntegrationCredentials,
} from '../../storage/models/domain.models';
import { ClickUpProviderError, JiraProviderError } from '../errors/external-provider.errors';
import { ExternalTaskProviderRegistry } from '../external-task-provider.registry';
import { SafeVendorHttpClient, SafeVendorHttpError } from '../transport/safe-vendor-http-client';
import { ClickUpExternalTaskProvider } from './clickup-external-task.provider';
import { JiraExternalTaskProvider } from './jira-external-task.provider';

describe('external task providers', () => {
  const clickupCredentials: ClickUpIntegrationCredentials = {
    provider: 'clickup',
    token: 'clickup-secret-token',
  };
  const jiraCredentials: JiraIntegrationCredentials = {
    provider: 'jira',
    siteUrl: 'https://acme.atlassian.net',
    email: 'private@example.com',
    token: 'jira-secret-token',
  };

  it('normalizes ClickUp identity without exposing the vendor DTO', async () => {
    const requestJson = jest.fn(async () => ({
      user: {
        id: 42,
        username: 'Ada',
        email: 'private@example.com',
        color: '#fff',
        profilePicture: 'https://example.com/private.png',
      },
    }));
    const provider = new ClickUpExternalTaskProvider({
      requestJson,
    } as unknown as SafeVendorHttpClient);

    await expect(provider.verifyCredentials(clickupCredentials)).resolves.toEqual({
      provider: 'clickup',
      remoteId: '42',
      displayName: 'Ada',
    });
    expect(requestJson).toHaveBeenCalledWith({
      url: 'https://api.clickup.com/api/v2/user',
      allowedOrigins: ['https://api.clickup.com'],
      headers: {
        accept: 'application/json',
        authorization: 'clickup-secret-token',
      },
    });
  });

  it('normalizes Jira identity and constrains requests to the validated tenant origin', async () => {
    const requestJson = jest.fn(async () => ({
      accountId: 'jira-account-1',
      displayName: 'Grace',
      emailAddress: 'private@example.com',
      avatarUrls: { '48x48': 'https://example.com/private.png' },
    }));
    const provider = new JiraExternalTaskProvider({
      requestJson,
    } as unknown as SafeVendorHttpClient);

    await expect(provider.verifyCredentials(jiraCredentials)).resolves.toEqual({
      provider: 'jira',
      remoteId: 'jira-account-1',
      displayName: 'Grace',
    });
    expect(requestJson).toHaveBeenCalledWith({
      url: 'https://acme.atlassian.net/rest/api/3/myself',
      allowedOrigins: ['https://acme.atlassian.net'],
      headers: {
        accept: 'application/json',
        authorization: `Basic ${Buffer.from('private@example.com:jira-secret-token').toString(
          'base64',
        )}`,
      },
    });
  });

  it('rejects non-Atlassian Jira origins before transport', async () => {
    const requestJson = jest.fn();
    const provider = new JiraExternalTaskProvider({
      requestJson,
    } as unknown as SafeVendorHttpClient);

    await expect(
      provider.verifyCredentials({ ...jiraCredentials, siteUrl: 'https://127.0.0.1' }),
    ).rejects.toMatchObject<JiraProviderError>({
      code: 'jira_request_rejected',
      details: expect.objectContaining({ provider: 'jira', reason: 'request_rejected' }),
    });
    expect(requestJson).not.toHaveBeenCalled();
  });

  it.each([
    ['clickup', ClickUpExternalTaskProvider, ClickUpProviderError, clickupCredentials],
    ['jira', JiraExternalTaskProvider, JiraProviderError, jiraCredentials],
  ] as const)(
    'maps %s transport failures to provider-specific sanitized errors',
    async (_name, ProviderClass, ErrorClass, credentials) => {
      const requestJson = jest.fn(async () => {
        throw new SafeVendorHttpError('http_error', 401);
      });
      const provider = new ProviderClass({ requestJson } as unknown as SafeVendorHttpClient);

      let caught: unknown;
      try {
        await provider.verifyCredentials(credentials);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ErrorClass);
      expect(JSON.stringify(caught)).not.toContain(credentials.token);
      expect((caught as Error).message).not.toContain(credentials.token);
    },
  );

  it('registers exactly the ClickUp and Jira provider implementations', () => {
    const clickup = new ClickUpExternalTaskProvider({} as SafeVendorHttpClient);
    const jira = new JiraExternalTaskProvider({} as SafeVendorHttpClient);
    const registry = new ExternalTaskProviderRegistry([clickup, jira]);

    expect(registry.getSupportedProviders()).toEqual(['clickup', 'jira']);
    expect(registry.get('clickup')).toBe(clickup);
    expect(registry.get('jira')).toBe(jira);
    expect(registry.getDescriptors()).toEqual([
      {
        provider: 'clickup',
        displayName: 'ClickUp',
        capabilities: { myWork: true },
      },
      {
        provider: 'jira',
        displayName: 'Jira',
        capabilities: { myWork: true },
      },
    ]);
  });

  it('surfaces ClickUp rate-limit reset guidance without upstream response content', async () => {
    const requestJson = jest.fn(async () => {
      throw new SafeVendorHttpError('http_error', 429, '2033-05-18T03:33:20.000Z');
    });
    const provider = new ClickUpExternalTaskProvider({
      requestJson,
    } as unknown as SafeVendorHttpClient);

    await expect(provider.verifyCredentials(clickupCredentials)).rejects.toMatchObject({
      code: 'clickup_rate_limited',
      details: expect.objectContaining({
        provider: 'clickup',
        retryable: true,
        retryAt: '2033-05-18T03:33:20.000Z',
      }),
    });
  });
});
