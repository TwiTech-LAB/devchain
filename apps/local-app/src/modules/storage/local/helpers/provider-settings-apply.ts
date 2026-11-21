import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { validateClaudeLaunchSettingsJson } from '@devchain/shared';
import { createLogger } from '../../../../common/logging/logger';
import type { ReplicaProviderSettingsRow } from '../../interfaces/storage.interface';
import { normalizeEnvForStorage, tryParseProviderEnv } from './storage-helpers';

const logger = createLogger('ProviderSettingsApply');

export function listInstanceProjectIds(db: Database.Database): Set<string> {
  return new Set(
    (db.prepare('SELECT id FROM projects').all() as Array<{ id: string }>).map((row) => row.id),
  );
}

/**
 * Makes one provider's home-owned settings equal to home's `row`: the two
 * scalars, then the env and its scope rows. This is the Connect rule; the
 * health-poll push applies the same rule.
 */
export function applyHomeProviderRow(
  db: Database.Database,
  providerId: string,
  row: ReplicaProviderSettingsRow,
  instanceProjectIds: ReadonlySet<string>,
  now: string,
): void {
  applyProviderSettings(db, providerId, row, now);
  reconcileProviderEnv(db, providerId, row, instanceProjectIds, now);
}

/**
 * Makes the provider's env and scope rows equal to `row`. A key without home
 * scope rows stays global; a scoped key keeps only the projects in
 * `instanceProjectIds` and is dropped when none of them is there. Writes
 * nothing when the instance already matches.
 */
function reconcileProviderEnv(
  db: Database.Database,
  providerId: string,
  row: ReplicaProviderSettingsRow,
  instanceProjectIds: ReadonlySet<string>,
  now: string,
): void {
  const env: Record<string, string> = Object.create(null);
  const retainedScopes = new Map<string, Set<string>>();
  const insertScope = db.prepare(
    'INSERT INTO provider_env_scopes (provider_id, env_key, project_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
  );
  for (const [key, value] of Object.entries(row.env ?? {})) {
    const homeScopes = Object.hasOwn(row.envScopes, key) ? row.envScopes[key] : [];
    const scopes = new Set(homeScopes.filter((id) => instanceProjectIds.has(id)));
    // A scoped key must never become global when its projects are absent.
    if (homeScopes.length > 0 && scopes.size === 0) continue;
    env[key] = value;
    retainedScopes.set(key, scopes);
    for (const projectId of scopes) insertScope.run(providerId, key, projectId, now);
  }

  const deleteScope = db.prepare(
    'DELETE FROM provider_env_scopes WHERE provider_id = ? AND env_key = ? AND project_id = ?',
  );
  const stored = db
    .prepare('SELECT env_key, project_id FROM provider_env_scopes WHERE provider_id = ?')
    .all(providerId) as Array<{ env_key: string; project_id: string }>;
  for (const scope of stored) {
    if (retainedScopes.get(scope.env_key)?.has(scope.project_id)) continue;
    deleteScope.run(providerId, scope.env_key, scope.project_id);
  }

  const envJson = normalizeEnvForStorage(env);
  db.prepare('UPDATE providers SET env = ?, updated_at = ? WHERE id = ? AND env IS NOT ?').run(
    envJson,
    now,
    providerId,
    envJson,
  );
}

/**
 * Both scalars overwrite, an explicit null included. An invalid Claude launch
 * settings JSON keeps the stored value.
 */
function applyProviderSettings(
  db: Database.Database,
  providerId: string,
  row: ReplicaProviderSettingsRow,
  now: string,
): void {
  const current = db
    .prepare(
      'SELECT auto_compact_threshold, claude_launch_settings_json FROM providers WHERE id = ?',
    )
    .get(providerId) as
    | { auto_compact_threshold: number | null; claude_launch_settings_json: string | null }
    | undefined;
  if (!current) throw new Error('provider row is missing');

  const invalidLaunch =
    row.claude_launch_settings_json !== null &&
    !validateClaudeLaunchSettingsJson(row.claude_launch_settings_json).valid;
  if (invalidLaunch) {
    logger.warn({ provider: row.providerName }, 'Skipped invalid Claude launch settings JSON');
  }
  const launchToStore = invalidLaunch
    ? current.claude_launch_settings_json
    : row.claude_launch_settings_json;
  if (
    row.auto_compact_threshold === current.auto_compact_threshold &&
    launchToStore === current.claude_launch_settings_json
  ) {
    return;
  }
  db.prepare(
    'UPDATE providers SET auto_compact_threshold = ?, claude_launch_settings_json = ?, updated_at = ? WHERE id = ?',
  ).run(row.auto_compact_threshold, launchToStore, now, providerId);
}

type CanonicalEnv = Array<[string, string]> | { unparsable: string } | null;

function canonicalEnv(envJson: string | null): CanonicalEnv {
  const env = tryParseProviderEnv(envJson);
  if (env === undefined) return { unparsable: envJson ?? '' };
  const entries = Object.entries(env ?? {});
  // `{}` and NULL both mean "no env".
  return entries.length === 0 ? null : entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * sha256 over the home-owned provider settings, every scope row and every
 * project ID of this instance. Timestamps are not part of it. Call it inside
 * the writer's transaction so a concurrent write cannot slip between the
 * apply and the hash.
 */
export function readProviderSettingsFingerprint(db: Database.Database): string {
  // Each query has a fixed order, so equal state always gives the same hash.
  const providers = (
    db
      .prepare(
        `SELECT name, env, auto_compact_threshold, claude_launch_settings_json
         FROM providers ORDER BY name`,
      )
      .all() as Array<{
      name: string;
      env: string | null;
      auto_compact_threshold: number | null;
      claude_launch_settings_json: string | null;
    }>
  ).map((row) => ({
    name: row.name,
    env: canonicalEnv(row.env),
    autoCompactThreshold: row.auto_compact_threshold,
    claudeLaunchSettingsJson: row.claude_launch_settings_json,
  }));
  const scopes = (
    db
      .prepare(
        `SELECT p.name AS provider, s.env_key AS envKey, s.project_id AS projectId
         FROM provider_env_scopes s JOIN providers p ON p.id = s.provider_id
         ORDER BY p.name, s.env_key, s.project_id`,
      )
      .all() as Array<{ provider: string; envKey: string; projectId: string }>
  ).map((row) => [row.provider, row.envKey, row.projectId]);
  const projectIds = (
    db.prepare('SELECT id FROM projects ORDER BY id').all() as Array<{ id: string }>
  ).map((row) => row.id);

  return createHash('sha256')
    .update(JSON.stringify({ providers, scopes, projectIds }))
    .digest('hex');
}
