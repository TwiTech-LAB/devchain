import { handleProjectsList } from '../services/handlers/project-tools';
import type { ToolBindingEntry } from './types';

export const projectBindings: ToolBindingEntry[] = [
  ['devchain_projects_list', handleProjectsList as unknown as ToolBindingEntry[1]],
];
