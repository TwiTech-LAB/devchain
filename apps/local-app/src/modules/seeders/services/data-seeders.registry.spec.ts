import { REGISTERED_DATA_SEEDERS } from './data-seeder.service';
import {
  seedReplacePermissionModePlanSeeder,
  runSeedReplacePermissionModePlan,
} from '../seeders/0002_seed_replace_permission_mode_plan';
import {
  seedPreseedJeffallanClaudeSkillsSeeder,
  runSeedPreseedJeffallanClaudeSkills,
} from '../seeders/0003_seed_preseed_jeffallan_claude_skills';
import {
  seedDisableMicrosoftSourceDefaultSeeder,
  runSeedDisableMicrosoftSourceDefault,
} from '../seeders/0004_seed_disable_microsoft_source_default';
import {
  seedRemoveGeminiProviderSeeder,
  runSeedRemoveGeminiProvider,
} from '../seeders/0009_seed_remove_gemini_provider';
import {
  seedProviderEffortDefaultsSeeder,
  runSeedProviderEffortDefaults,
} from '../seeders/0010_seed_provider_effort_defaults';
import {
  seedClaudeLaunchSettingsSeeder,
  runSeedClaudeLaunchSettings,
} from '../seeders/0012_seed_claude_launch_settings';
import {
  seedPromptTypeTagsSeeder,
  runSeedPromptTypeTags,
} from '../seeders/0013_seed_prompt_type_tags';
import {
  seedPreserveProjectEgressDefaultsSeeder,
  runSeedPreserveProjectEgressDefaults,
} from '../seeders/0014_seed_preserve_project_egress_defaults';

describe('registered data seeder journal identities', () => {
  it.each([
    {
      index: 1,
      name: '0002_seed_replace_permission_mode_plan',
      version: 1,
      seeder: seedReplacePermissionModePlanSeeder,
      run: runSeedReplacePermissionModePlan,
    },
    {
      index: 2,
      name: '0003_seed_preseed_jeffallan_claude_skills',
      version: 1,
      seeder: seedPreseedJeffallanClaudeSkillsSeeder,
      run: runSeedPreseedJeffallanClaudeSkills,
    },
    {
      index: 3,
      name: '0004_seed_disable_microsoft_source_default',
      version: 1,
      seeder: seedDisableMicrosoftSourceDefaultSeeder,
      run: runSeedDisableMicrosoftSourceDefault,
    },
    {
      index: 8,
      name: '0009_seed_remove_gemini_provider',
      version: 1,
      seeder: seedRemoveGeminiProviderSeeder,
      run: runSeedRemoveGeminiProvider,
    },
    {
      index: 9,
      name: '0010_seed_provider_effort_defaults',
      version: 1,
      seeder: seedProviderEffortDefaultsSeeder,
      run: runSeedProviderEffortDefaults,
    },
    {
      index: 11,
      name: '0012_seed_claude_launch_settings',
      version: 1,
      seeder: seedClaudeLaunchSettingsSeeder,
      run: runSeedClaudeLaunchSettings,
    },
    {
      index: 12,
      name: '0013_seed_prompt_type_tags',
      version: 1,
      seeder: seedPromptTypeTagsSeeder,
      run: runSeedPromptTypeTags,
    },
    {
      index: 13,
      name: '0014_seed_preserve_project_egress_defaults',
      version: 1,
      seeder: seedPreserveProjectEgressDefaultsSeeder,
      run: runSeedPreserveProjectEgressDefaults,
    },
  ])('pins $name and its run binding', ({ index, name, version, seeder, run }) => {
    expect(REGISTERED_DATA_SEEDERS[index]).toBe(seeder);
    expect(seeder).toMatchObject({ name, version, run });
  });
});
