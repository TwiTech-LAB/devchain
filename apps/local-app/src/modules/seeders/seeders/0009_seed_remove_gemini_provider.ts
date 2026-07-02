import { getRawSqliteClient } from '../../storage/db/sqlite-raw';
import type { DataSeeder, SeederContext } from '../types/seeder.types';

const SEEDER_NAME = '0009_seed_remove_gemini_provider';
const SEEDER_VERSION = 1;

/**
 * Idempotent startup cleanup for stranded `gemini` provider records.
 *
 * The Gemini CLI launch provider was removed from code (gemini-retirement
 * Phase 1). An existing local DB may still carry a persisted `providers` row
 * named `gemini` — plus dependent `profile_provider_configs` and `agents` —
 * which would otherwise trip a preflight failure (the provider name no longer
 * resolves to a supported adapter). D2: we proactively delete those rows so the
 * DB converges cleanly; preflight-fail is not acceptable to the user.
 *
 * ── Removal policy (documented & deliberate) ──────────────────────────────
 * An agent whose provider config points at the removed `gemini` provider is
 * DELETED outright, together with its config — we do NOT silently repoint it to
 * another provider (e.g. agy) and we do NOT invent a replacement config. The
 * end state is: zero `gemini` provider rows, zero configs referencing them, and
 * no agent left pointing at a removed config.
 *
 * ── FK-safe cascade order (foreign_keys = ON) ─────────────────────────────
 * The chain is `providers ← profile_provider_configs.provider_id ←
 * agents.provider_config_id`, all ON DELETE RESTRICT. The ONLY other RESTRICT
 * child in play is `sessions.agent_id`; every remaining relation to the deleted
 * rows is ON DELETE CASCADE (team_members, chat_*, provider_models,
 * provider_env_scopes, provider_probe_proofs, team_profile_configs) or SET NULL
 * (teams.team_lead_agent_id, *.author_agent_id, scheduled_epics.template_agent_id).
 * So we only need to explicitly delete, in order:
 *   1. sessions of the affected agents (RESTRICT — incl. any 'running' rows: the
 *      provider is gone, so the agent cannot legitimately be running),
 *   2. the affected agents (FK cascade/set-null handles their other relations),
 *   3. the gemini configs (cascade handles team_profile_configs),
 *   4. the gemini provider rows (cascade handles models/env_scopes/probe_proofs).
 * The whole cascade runs in a single IMMEDIATE transaction. Matching is
 * case-insensitive (`lower(name) = 'gemini'`).
 *
 * Idempotent: a re-run on a DB with no gemini rows is a no-op.
 */
export async function runSeedRemoveGeminiProvider(ctx: SeederContext): Promise<void> {
  const sqlite = getRawSqliteClient(ctx.db);

  const cascade = sqlite.transaction(() => {
    const geminiProviders = sqlite
      .prepare("SELECT id FROM providers WHERE lower(name) = 'gemini'")
      .all() as Array<{ id: string }>;
    const providersMatched = geminiProviders.length;

    if (providersMatched === 0) {
      return { providersMatched: 0, sessions: 0, agents: 0, configs: 0, providers: 0 };
    }

    const affectedAgents = `
      SELECT a.id FROM agents a
      JOIN profile_provider_configs c ON a.provider_config_id = c.id
      JOIN providers p ON c.provider_id = p.id
      WHERE lower(p.name) = 'gemini'
    `;
    const geminiConfigs = `
      SELECT c.id FROM profile_provider_configs c
      JOIN providers p ON c.provider_id = p.id
      WHERE lower(p.name) = 'gemini'
    `;

    // 1. sessions (the only non-chain RESTRICT child of agents)
    const sessions = sqlite
      .prepare(`DELETE FROM sessions WHERE agent_id IN (${affectedAgents})`)
      .run().changes;
    // 2. agents (FK cascade/set-null handles team_members, chat_*, lead refs)
    const agents = sqlite
      .prepare(`DELETE FROM agents WHERE provider_config_id IN (${geminiConfigs})`)
      .run().changes;
    // 3. configs (cascade handles team_profile_configs)
    const configs = sqlite
      .prepare(
        'DELETE FROM profile_provider_configs WHERE provider_id IN ' +
          "(SELECT id FROM providers WHERE lower(name) = 'gemini')",
      )
      .run().changes;
    // 4. provider rows (cascade handles models/env_scopes/probe_proofs)
    const providers = sqlite
      .prepare("DELETE FROM providers WHERE lower(name) = 'gemini'")
      .run().changes;

    return { providersMatched, sessions, agents, configs, providers };
  });

  const result = cascade.immediate();

  if (result.providersMatched === 0) {
    ctx.logger.debug(
      { seederName: SEEDER_NAME, seederVersion: SEEDER_VERSION },
      'No gemini provider rows; skipping',
    );
    return;
  }

  ctx.logger.info(
    {
      seederName: SEEDER_NAME,
      seederVersion: SEEDER_VERSION,
      providersMatched: result.providersMatched,
      sessionsDeleted: result.sessions,
      agentsDeleted: result.agents,
      configsDeleted: result.configs,
      providersDeleted: result.providers,
    },
    'Removed stranded gemini provider records',
  );
}

export const seedRemoveGeminiProviderSeeder: DataSeeder = {
  name: SEEDER_NAME,
  version: SEEDER_VERSION,
  run: runSeedRemoveGeminiProvider,
};
