import { BUILT_IN_SKILL_SOURCE_NAMES } from '../../../../common/constants/built-in-skill-sources';

/** Every source name an instance registers: the built-ins, then its managed sources. */
export function registeredSourceNames(managedNames: readonly string[]): string[] {
  return [...Object.values(BUILT_IN_SKILL_SOURCE_NAMES), ...managedNames];
}

export function effectiveSourceSwitches(
  storedMap: Record<string, boolean>,
  registeredNames: readonly string[],
): Record<string, boolean> {
  return Object.fromEntries(registeredNames.map((name) => [name, storedMap[name] !== false]));
}

export function mergeSourceSwitches(
  homeEffective: Record<string, boolean>,
  vmStored: Record<string, boolean>,
): Record<string, boolean> {
  return { ...vmStored, ...homeEffective };
}
