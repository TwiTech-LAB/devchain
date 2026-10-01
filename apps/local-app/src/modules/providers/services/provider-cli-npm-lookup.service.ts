import { Injectable, Inject } from '@nestjs/common';
import { compareSemVer, isExactStableSemver } from '@devchain/shared';

/** Injection token so tests can point the lookup at a fake registry. */
export const NPM_REGISTRY_BASE_URL = 'NPM_REGISTRY_BASE_URL';

const REQUEST_TIMEOUT_MS = 10_000;

/** Newest stable releases offered in the pin list. */
export const PIN_LIST_LIMIT = 15;

interface RegistryLatestResponse {
  version?: unknown;
}

interface AbbreviatedPackument {
  versions?: Record<string, unknown>;
}

/**
 * Read-only npm registry client for provider CLI version lookups. Always hits
 * the public registry; never installs anything.
 */
@Injectable()
export class ProviderCliNpmLookupService {
  constructor(@Inject(NPM_REGISTRY_BASE_URL) private readonly registryBaseUrl: string) {}

  /**
   * The `latest` dist-tag. Never the highest published version: npm packages
   * publish previews that outrank `latest` numerically.
   */
  async fetchLatestVersion(npmPackage: string): Promise<string> {
    const data = await this.fetchJson<RegistryLatestResponse>(`/${npmPackage}/latest`);
    const version = data.version;
    if (typeof version !== 'string' || version.length === 0) {
      throw new Error(`Registry returned no version for ${npmPackage} latest dist-tag`);
    }
    return version;
  }

  /** Newest stable (`x.y.z`) published versions, descending, capped at `limit`. */
  async fetchStableVersions(npmPackage: string, limit: number = PIN_LIST_LIMIT): Promise<string[]> {
    const packument = await this.fetchJson<AbbreviatedPackument>(`/${npmPackage}`, {
      accept: 'application/vnd.npm.install-v1+json',
    });
    const versions = packument.versions;
    if (!versions || typeof versions !== 'object') {
      throw new Error(`Registry returned no version list for ${npmPackage}`);
    }
    return Object.keys(versions)
      .filter(isExactStableSemver)
      .sort((a, b) => compareSemVer(b, a))
      .slice(0, limit);
  }

  private async fetchJson<T>(path: string, headers?: { accept: string }): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timeout.unref?.();
    try {
      const response = await fetch(`${this.registryBaseUrl}${path}`, {
        signal: controller.signal,
        headers,
      });
      if (!response.ok) {
        throw new Error(`Unexpected status ${response.status} from npm registry ${path}`);
      }
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`npm registry request timed out after ${REQUEST_TIMEOUT_MS}ms: ${path}`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
