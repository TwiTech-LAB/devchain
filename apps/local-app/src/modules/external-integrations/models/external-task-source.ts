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

export type ExternalTaskUrlReference =
  | { kind: 'task'; provider: IntegrationProvider; hostname: string; taskId: string }
  /** A supported task host whose path is not exactly one segment after the task prefix. */
  | { kind: 'unsupported_path'; provider: IntegrationProvider }
  | { kind: 'unsupported_host' };

/**
 * Reads a pasted task URL through the same host and path policy as stored
 * source URLs. Query and hash are ignored. A ClickUp custom-id URL
 * (`/t/<team>/<CUSTOM>`) has two segments and is reported as `unsupported_path`.
 */
/** A Jira connection's site hostname, the Jira remote scope key; null when the URL does not parse. */
export function jiraSiteHostname(siteUrl: string): string | null {
  try {
    return new URL(siteUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function parseExternalTaskUrl(value: string): ExternalTaskUrlReference {
  const url = parseSafeHttpsUrl(value);
  if (!url) return { kind: 'unsupported_host' };
  for (const provider of Object.keys(SOURCE_URL_POLICIES) as IntegrationProvider[]) {
    const policy = SOURCE_URL_POLICIES[provider];
    if (!policy.allowsHost(url)) continue;
    if (!url.pathname.startsWith(policy.pathPrefix)) {
      return { kind: 'unsupported_path', provider };
    }
    const segments = url.pathname.slice(policy.pathPrefix.length).replace(/\/$/, '').split('/');
    let taskId: string;
    try {
      taskId = decodeURIComponent(segments[0] ?? '').trim();
    } catch {
      return { kind: 'unsupported_path', provider };
    }
    if (segments.length !== 1 || !taskId) {
      return { kind: 'unsupported_path', provider };
    }
    return { kind: 'task', provider, hostname: url.hostname.toLowerCase(), taskId };
  }
  return { kind: 'unsupported_host' };
}
