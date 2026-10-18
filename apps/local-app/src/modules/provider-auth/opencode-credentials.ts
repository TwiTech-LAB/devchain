/**
 * Converts between DevChain's stored OpenCode login (an entry of the OpenCode 1
 * `auth.json`, kept unchanged in the vault) and an OpenCode 2 credential `value`.
 * The v1 → v2 rules mirror OpenCode 2's own one-time `auth.json` import.
 */

export type OpencodeV1Entry = Record<string, unknown>;

export type OpencodeV2Credential =
  | { type: 'key'; key: string; metadata?: Record<string, unknown> }
  | {
      type: 'oauth';
      methodID: string;
      refresh: string;
      access: string;
      expires: number;
      metadata?: Record<string, unknown>;
    };

/** One item of `opencode auth export` (2.x). */
export interface OpencodeV2ExportItem {
  id: string;
  integrationID: string;
  label: string;
  active: boolean;
  value: Record<string, unknown>;
}

/** DevChain imports each delivered login under this id prefix; other credentials are the user's. */
export const DEVCHAIN_OPENCODE_CREDENTIAL_ID_PREFIX = 'cred_devchain_';

/** The OAuth method OpenCode 2 assigns to a login imported from `auth.json`. */
export function opencodeOauthMethodId(integrationId: string): string {
  if (integrationId === 'openai') return 'chatgpt-browser';
  if (['github-copilot', 'opencode', 'xai'].includes(integrationId)) return 'device';
  return 'oauth';
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function requireString(
  entry: Record<string, unknown>,
  field: string,
  what: string,
  allowEmpty = false,
): string {
  const value = entry[field];
  if (typeof value !== 'string' || (value === '' && !allowEmpty)) {
    throw new Error(`${what} has no ${field}`);
  }
  return value;
}

/** Throws for an entry type OpenCode 2 cannot hold. */
export function toOpencodeV2Credential(
  integrationId: string,
  entry: OpencodeV1Entry,
): OpencodeV2Credential {
  const what = `OpenCode ${integrationId} login`;
  switch (entry.type) {
    case 'api':
      return {
        type: 'key',
        key: requireString(entry, 'key', what),
        ...(isRecord(entry.metadata) && { metadata: entry.metadata }),
      };
    // v2 has no `wellknown` type; the token becomes the key.
    case 'wellknown':
      return { type: 'key', key: requireString(entry, 'token', what) };
    case 'oauth': {
      if (typeof entry.expires !== 'number') throw new Error(`${what} has no expires`);
      const accountId = typeof entry.accountId === 'string' ? entry.accountId : '';
      const enterpriseUrl = typeof entry.enterpriseUrl === 'string' ? entry.enterpriseUrl : '';
      const metadata = {
        ...(isRecord(entry.metadata) ? entry.metadata : {}),
        ...(accountId ? { accountID: accountId } : {}),
        ...(enterpriseUrl ? { enterpriseUrl } : {}),
      };
      return {
        type: 'oauth',
        methodID:
          typeof entry.methodID === 'string'
            ? entry.methodID
            : opencodeOauthMethodId(integrationId),
        // Some OpenCode 2 methods store an empty refresh token.
        refresh: requireString(entry, 'refresh', what, true),
        access: requireString(entry, 'access', what),
        expires: entry.expires,
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      };
    }
    default:
      throw new Error(`${what} has the unsupported type ${String(entry.type)}`);
  }
}

/**
 * The v1 entry for a v2 credential `value`, with v1's key order so a v1 → v2 → v1
 * round trip is byte-identical. A `key` credential always becomes `api`: a former
 * `wellknown` entry cannot be told apart. An oauth `methodID` other than the import
 * default and any metadata beyond `accountID`/`enterpriseUrl` are kept on the entry,
 * because OpenCode 2 needs them to refresh the token. An unknown type is returned
 * as-is so callers see it as an unsupported login.
 */
export function fromOpencodeV2Credential(
  integrationId: string,
  value: Record<string, unknown>,
): OpencodeV1Entry {
  if (value.type === 'key') {
    return {
      type: 'api',
      key: value.key,
      ...(isRecord(value.metadata) && { metadata: value.metadata }),
    };
  }
  if (value.type === 'oauth') {
    const { accountID, enterpriseUrl, ...metadata } = isRecord(value.metadata)
      ? value.metadata
      : {};
    return {
      type: 'oauth',
      refresh: value.refresh,
      access: value.access,
      expires: value.expires,
      ...(accountID !== undefined && { accountId: accountID }),
      ...(enterpriseUrl !== undefined && { enterpriseUrl }),
      ...(value.methodID !== opencodeOauthMethodId(integrationId) && {
        methodID: value.methodID,
      }),
      ...(Object.keys(metadata).length > 0 && { metadata }),
    };
  }
  return { ...value };
}

/**
 * The active credential of each integration in `opencode auth export` output, as
 * v1 entries keyed by integration id. Throws when the output is not an export.
 */
export function parseOpencodeV2Export(stdout: string): Record<string, OpencodeV1Entry> {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error('auth export did not print a JSON array');
  const entries: Record<string, OpencodeV1Entry> = {};
  for (const item of parsed as unknown[]) {
    if (!isRecord(item) || typeof item.integrationID !== 'string' || !isRecord(item.value)) {
      throw new Error('auth export printed an unexpected credential');
    }
    if (item.active === true) {
      entries[item.integrationID] = fromOpencodeV2Credential(item.integrationID, item.value);
    }
  }
  return entries;
}
