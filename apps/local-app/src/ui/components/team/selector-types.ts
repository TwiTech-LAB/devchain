export type SelectionMode = 'allow-all' | 'subset' | 'remove';

export interface ProfileSelection<TProfileKey extends string, TConfigKey extends string> {
  profileKey: TProfileKey;
  mode: SelectionMode;
  configKeys?: TConfigKey[];
}

export interface ConfigItem<TConfigKey extends string> {
  key: TConfigKey;
  label: string;
  providerName: string;
}

export function toConfigItem(config: {
  id: string;
  name: string;
  providerName?: string | null;
}): ConfigItem<string> {
  return { key: config.id, label: config.name, providerName: config.providerName ?? 'unknown' };
}

export function deriveSelectionMode(selectedKeys: string[], totalKeys: string[]): SelectionMode {
  if (selectedKeys.length === 0) return 'remove';
  if (selectedKeys.length === totalKeys.length) return 'allow-all';
  return 'subset';
}
