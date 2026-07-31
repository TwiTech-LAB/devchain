export const EVENT_BUS_REDUCE_MOTION_STORAGE_KEY = 'devchain:chatSidebar:eventBusReduceMotion';

export interface AgentEventBusPreferenceStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

function browserStorage(): AgentEventBusPreferenceStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readAgentEventBusReduceMotion(
  storage: AgentEventBusPreferenceStorage | null = browserStorage(),
): boolean {
  if (!storage) return false;
  try {
    const rawValue = storage.getItem(EVENT_BUS_REDUCE_MOTION_STORAGE_KEY);
    if (rawValue === null) return false;
    const parsedValue: unknown = JSON.parse(rawValue);
    return typeof parsedValue === 'boolean' ? parsedValue : false;
  } catch {
    return false;
  }
}

export function writeAgentEventBusReduceMotion(
  enabled: boolean,
  storage: AgentEventBusPreferenceStorage | null = browserStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(EVENT_BUS_REDUCE_MOTION_STORAGE_KEY, JSON.stringify(enabled));
    return true;
  } catch {
    return false;
  }
}
