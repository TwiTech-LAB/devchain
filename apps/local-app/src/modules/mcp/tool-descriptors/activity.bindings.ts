import type { ToolBindingEntry } from './types';
import { handleActivityStart, handleActivityFinish } from '../services/handlers/activity-tools';

export const activityBindings: ToolBindingEntry[] = [
  ['devchain_activity_start', handleActivityStart as unknown as ToolBindingEntry[1]],
  ['devchain_activity_finish', handleActivityFinish as unknown as ToolBindingEntry[1]],
];
