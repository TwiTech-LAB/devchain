import type { ToolBindingEntry } from './types';
import { handleListSessions, handleRegisterGuest } from '../services/handlers/session-tools';

export const sessionBindings: ToolBindingEntry[] = [
  ['devchain_list_sessions', handleListSessions as unknown as ToolBindingEntry[1]],
  ['devchain_register_guest', handleRegisterGuest as unknown as ToolBindingEntry[1]],
];
