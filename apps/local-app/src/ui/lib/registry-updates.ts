import { isLessThan } from '@devchain/shared';

/**
 * Template info from the unified templates API
 */
export interface CachedTemplateInfo {
  slug: string;
  source: 'bundled' | 'registry';
  latestVersion: string | null;
}

/**
 * Remote registry template info
 */
export interface RemoteTemplateInfo {
  slug: string;
  latestVersion: string | null;
}

/**
 * Update status for a template
 */
export type TemplateUpdateStatus =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'update-available'; remoteVersion: string }
  | { status: 'up-to-date' }
  | { status: 'offline' }
  | { status: 'not-in-registry' };

/**
 * Fetch cached templates from unified API
 */
export async function fetchCachedTemplates(): Promise<CachedTemplateInfo[]> {
  const res = await fetch('/api/templates');
  if (!res.ok) return [];
  const data = await res.json();
  return data.templates || [];
}

/**
 * Fetch remote registry template info to get actual latest version.
 * Returns null if template not found in registry (API returns null/empty).
 * Throws on network errors to distinguish from "not found".
 */
export async function fetchRemoteTemplateInfo(slug: string): Promise<RemoteTemplateInfo | null> {
  const res = await fetch(`/api/registry/templates/${encodeURIComponent(slug)}`);
  if (!res.ok) {
    throw new Error(`Registry request failed: ${res.status}`);
  }
  const data = await res.json();

  // API returns null when template not found in registry
  if (!data) {
    return null;
  }

  const latestVersion =
    data.versions?.find((v: { isLatest: boolean }) => v.isLatest)?.version ?? null;
  return { slug, latestVersion };
}

/**
 * Check update status for a single template by comparing cached vs remote version.
 * Supports both registry and bundled templates.
 *
 * For registry templates (with local version):
 * - Network errors → 'offline'
 * - Template not in registry → 'not-in-registry'
 * - Remote newer → 'update-available'
 * - Same or older → 'up-to-date'
 *
 * For bundled templates (no local version):
 * - Network errors → 'offline'
 * - Template not in registry → 'not-in-registry'
 * - Template in registry → 'update-available' (shows "Available in registry")
 */
export async function checkTemplateUpdateStatus(
  template: CachedTemplateInfo,
): Promise<TemplateUpdateStatus> {
  // Registry templates without a local version - nothing to compare
  if (template.source === 'registry' && !template.latestVersion) {
    return { status: 'idle' };
  }

  let remote: RemoteTemplateInfo | null;
  try {
    remote = await fetchRemoteTemplateInfo(template.slug);
  } catch {
    // Network error or API failure
    return { status: 'offline' };
  }

  // Template not found in registry (API returned null)
  if (!remote) {
    return { status: 'not-in-registry' };
  }

  // Template found but no version info
  if (!remote.latestVersion) {
    return { status: 'not-in-registry' };
  }

  // Bundled templates WITH a version: compare like registry templates
  if (template.source === 'bundled' && template.latestVersion) {
    try {
      if (isLessThan(template.latestVersion, remote.latestVersion)) {
        return { status: 'update-available', remoteVersion: remote.latestVersion };
      }
      return { status: 'up-to-date' };
    } catch {
      // Version comparison error - treat as up-to-date
      return { status: 'up-to-date' };
    }
  }

  // Bundled templates WITHOUT version: show as "available in registry"
  if (template.source === 'bundled') {
    return { status: 'update-available', remoteVersion: remote.latestVersion };
  }

  // Registry templates: compare versions
  try {
    if (isLessThan(template.latestVersion!, remote.latestVersion)) {
      return { status: 'update-available', remoteVersion: remote.latestVersion };
    }
    return { status: 'up-to-date' };
  } catch {
    // Version comparison error - treat as up-to-date rather than offline
    return { status: 'up-to-date' };
  }
}

/**
 * Check if any cached registry template has an update available remotely.
 * Returns true on first update found (short-circuits).
 */
export async function hasAnyTemplateUpdates(templates: CachedTemplateInfo[]): Promise<boolean> {
  // Filter to only registry templates with a cached version
  const registryTemplates = templates.filter((t) => t.source === 'registry' && t.latestVersion);

  if (registryTemplates.length === 0) {
    return false;
  }

  // Fetch remote versions in parallel
  const results = await Promise.allSettled(
    registryTemplates.map(async (template) => {
      const remote = await fetchRemoteTemplateInfo(template.slug);
      return { template, remote };
    }),
  );

  // Check if any template has an update available
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const { template, remote } = result.value;
    if (!remote || !remote.latestVersion || !template.latestVersion) continue;

    try {
      if (isLessThan(template.latestVersion, remote.latestVersion)) {
        return true;
      }
    } catch {
      // Ignore version comparison errors
    }
  }

  return false;
}

/**
 * Check update status for multiple templates in parallel.
 * Includes both registry and bundled templates.
 * Returns a map of slug -> update status.
 */
export async function checkAllTemplateUpdates(
  templates: CachedTemplateInfo[],
): Promise<Record<string, TemplateUpdateStatus>> {
  // Include all templates (registry and bundled)
  // Registry templates without version will return 'idle' from checkTemplateUpdateStatus
  if (templates.length === 0) {
    return {};
  }

  const results = await Promise.allSettled(
    templates.map(async (template) => {
      const status = await checkTemplateUpdateStatus(template);
      return { slug: template.slug, status };
    }),
  );

  const statusMap: Record<string, TemplateUpdateStatus> = {};

  for (const result of results) {
    if (result.status === 'fulfilled') {
      statusMap[result.value.slug] = result.value.status;
    }
  }

  return statusMap;
}
