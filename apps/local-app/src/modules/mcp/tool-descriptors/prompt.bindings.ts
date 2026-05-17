import type { ToolBindingEntry } from './types';
import { handleListPrompts, handleGetPrompt } from '../services/handlers/prompt-tools';

export const promptBindings: ToolBindingEntry[] = [
  ['devchain_list_prompts', handleListPrompts as unknown as ToolBindingEntry[1]],
  ['devchain_get_prompt', handleGetPrompt as unknown as ToolBindingEntry[1]],
];
