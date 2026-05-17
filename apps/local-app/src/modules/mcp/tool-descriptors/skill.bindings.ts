import type { ToolBindingEntry } from './types';
import { handleListSkills, handleGetSkill } from '../services/handlers/skill-tools';

export const skillBindings: ToolBindingEntry[] = [
  ['devchain_list_skills', handleListSkills as unknown as ToolBindingEntry[1]],
  ['devchain_get_skill', handleGetSkill as unknown as ToolBindingEntry[1]],
];
