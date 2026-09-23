import type { SkillsService } from '../../skills/services/skills.service';
import type { SkillSourceLifecycleService } from '../../skills/services/skill-source-lifecycle.service';
import type { SkillToolContext } from '../services/handlers/skill-context';
import {
  handleListSkills,
  handleGetSkill,
  handleSkillsUsageStats,
  handleSkillsSetEnabled,
  handleSkillsSetSourceEnabled,
  handleSkillsSync,
} from '../services/handlers/skill-tools';
import { createNullAdapter } from '../services/handlers/null-adapter';
import { defineToolGroup, type McpBindingRuntime } from './binding-types';

function createSkillContext(runtime: McpBindingRuntime): SkillToolContext {
  return {
    skillsService: runtime.skillsService ?? createNullAdapter<SkillsService>('SkillsService'),
    skillSourceLifecycleService:
      runtime.skillSourceLifecycleService ??
      createNullAdapter<SkillSourceLifecycleService>('SkillSourceLifecycleService'),
    resolveSessionContext: runtime.resolveSessionContext,
  };
}

export const skillBindings = defineToolGroup<SkillToolContext>(createSkillContext, [
  ['devchain_list_skills', handleListSkills],
  ['devchain_get_skill', handleGetSkill],
  ['devchain_skills_usage_stats', handleSkillsUsageStats],
  ['devchain_skills_set_enabled', handleSkillsSetEnabled],
  ['devchain_skills_set_source_enabled', handleSkillsSetSourceEnabled],
  ['devchain_skills_sync', handleSkillsSync],
]);
