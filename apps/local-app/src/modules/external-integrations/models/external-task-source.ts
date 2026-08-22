import type { IntegrationProvider } from '../../storage/models/domain.models';

const JIRA_TENANT_HOSTNAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.atlassian\.net$/;

interface ExternalTaskSourceUrlPolicy {
  allowsHost(url: URL): boolean;
  pathPrefix: string;
}

const SOURCE_URL_POLICIES: Record<IntegrationProvider, ExternalTaskSourceUrlPolicy> = {
  clickup: {
    allowsHost: (url) => url.origin === 'https://app.clickup.com',
    pathPrefix: '/t/',
  },
  jira: {
    allowsHost: (url) => JIRA_TENANT_HOSTNAME.test(url.hostname.toLowerCase()),
    pathPrefix: '/browse/',
  },
};

export function normalizeExternalTaskSourceUrl(
  provider: IntegrationProvider,
  value: unknown,
): string | null {
  const policy = SOURCE_URL_POLICIES[provider] as ExternalTaskSourceUrlPolicy | undefined;
  if (!policy || typeof value !== 'string' || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.port !== ''
    ) {
      return null;
    }
    return policy.allowsHost(url) && url.pathname.startsWith(policy.pathPrefix)
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}
