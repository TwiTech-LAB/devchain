import Database from 'better-sqlite3';
import {
  DEVCHAIN_OPENCODE_CREDENTIAL_ID_PREFIX,
  fromOpencodeV2Credential,
  type OpencodeV1Entry,
} from './opencode-credentials';

/**
 * DevChain's OpenCode 2 credentials as the v1 `auth.json` content home writes back,
 * and the newest `time_updated` among them. Null when the DB or its `credential`
 * table is missing, or there are no DevChain credentials.
 */
export function readOpencodeCredentialFamilyV2(
  dbPath: string,
): { content: string; maxTimeUpdated: number } | null {
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
  try {
    const rows = db
      .prepare(
        `SELECT integration_id, value, time_updated FROM credential
         WHERE id LIKE ? ESCAPE '\\' AND integration_id IS NOT NULL
         ORDER BY integration_id`,
      )
      .all(`${DEVCHAIN_OPENCODE_CREDENTIAL_ID_PREFIX.replace(/_/g, '\\_')}%`) as Array<{
      integration_id: string;
      value: string;
      time_updated: number;
    }>;
    if (rows.length === 0) return null;
    const entries: Record<string, OpencodeV1Entry> = {};
    for (const row of rows) {
      entries[row.integration_id] = fromOpencodeV2Credential(
        row.integration_id,
        JSON.parse(row.value) as Record<string, unknown>,
      );
    }
    return {
      content: JSON.stringify(entries),
      maxTimeUpdated: Math.max(...rows.map((row) => row.time_updated)),
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}
