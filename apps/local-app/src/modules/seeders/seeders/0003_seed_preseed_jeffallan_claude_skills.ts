import type { CreateCommunitySkillSource } from '../../storage/models/domain.models';
import type { DataSeeder, SeederContext } from '../services/data-seeder.service';

const SEEDER_NAME = '0003_seed_preseed_jeffallan_claude_skills';
const SEEDER_VERSION = 1;

const DEFAULT_COMMUNITY_SOURCE: CreateCommunitySkillSource = {
  name: 'jeffallan',
  repoOwner: 'Jeffallan',
  repoName: 'claude-skills',
  branch: 'main',
};

export async function runSeedPreseedJeffallanClaudeSkills(ctx: SeederContext): Promise<void> {
  const existing = await ctx.storage.getCommunitySkillSourceByName(DEFAULT_COMMUNITY_SOURCE.name);
  if (existing) {
    ctx.logger.info(
      {
        seederName: SEEDER_NAME,
        seederVersion: SEEDER_VERSION,
        created: 0,
        skipped: 1,
        existingSourceId: existing.id,
        sourceName: existing.name,
      },
      'Pre-seed jeffallan community source seeder completed',
    );
    return;
  }

  const created = await ctx.storage.createCommunitySkillSource(DEFAULT_COMMUNITY_SOURCE);
  ctx.logger.info(
    {
      seederName: SEEDER_NAME,
      seederVersion: SEEDER_VERSION,
      created: 1,
      skipped: 0,
      sourceId: created.id,
      sourceName: created.name,
    },
    'Pre-seed jeffallan community source seeder completed',
  );
}

export const seedPreseedJeffallanClaudeSkillsSeeder: DataSeeder = {
  name: SEEDER_NAME,
  version: SEEDER_VERSION,
  run: runSeedPreseedJeffallanClaudeSkills,
};
