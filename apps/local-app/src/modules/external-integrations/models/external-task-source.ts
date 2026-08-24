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

function parseSafeHttpsUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length > 2_048) return null;
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
    return url;
  } catch {
    return null;
  }
}

export function normalizeExternalTaskSourceUrl(
  provider: IntegrationProvider,
  value: unknown,
): string | null {
  const policy = SOURCE_URL_POLICIES[provider] as ExternalTaskSourceUrlPolicy | undefined;
  const url = parseSafeHttpsUrl(value);
  if (!policy || !url) return null;
  return policy.allowsHost(url) && url.pathname.startsWith(policy.pathPrefix)
    ? url.toString()
    : null;
}

export function normalizeExternalWorkAreaSourceUrl(
  provider: IntegrationProvider,
  value: unknown,
): string | null {
  const url = parseSafeHttpsUrl(value);
  if (!url || url.hash !== '') return null;

  if (provider === 'clickup') {
    const listPath = /^\/[^/]+\/v\/li\/[^/]+\/?$/;
    return url.origin === 'https://app.clickup.com' && listPath.test(url.pathname) && !url.search
      ? url.toString()
      : null;
  }

  const searchKeys = [...url.searchParams.keys()];
  return JIRA_TENANT_HOSTNAME.test(url.hostname.toLowerCase()) &&
    url.pathname === '/secure/RapidBoard.jspa' &&
    searchKeys.length === 1 &&
    searchKeys[0] === 'rapidView' &&
    Boolean(url.searchParams.get('rapidView'))
    ? url.toString()
    : null;
}

export function normalizeExternalProviderSourceUrl(
  provider: IntegrationProvider,
  value: unknown,
): string | null {
  const url = parseSafeHttpsUrl(value);
  if (!url || url.pathname !== '/' || url.search !== '' || url.hash !== '') return null;

  if (provider === 'clickup') {
    return url.origin === 'https://app.clickup.com' ? url.toString() : null;
  }

  return JIRA_TENANT_HOSTNAME.test(url.hostname.toLowerCase()) ? url.toString() : null;
}
