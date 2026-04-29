import { useMemo } from 'react';
import { Checkbox } from '@/ui/components/ui/checkbox';
import { deriveSelectionMode, type ConfigItem, type ProfileSelection } from './selector-types';

interface ProviderConfigGranularSelectorProps<
  TProfileKey extends string,
  TConfigKey extends string,
> {
  focusedProfileKey: TProfileKey | null;
  configsByProfile: Record<TProfileKey, ConfigItem<TConfigKey>[]>;
  selections: ProfileSelection<TProfileKey, TConfigKey>[];
  onChange: (selections: ProfileSelection<TProfileKey, TConfigKey>[]) => void;
}

export function ProviderConfigGranularSelector<
  TProfileKey extends string,
  TConfigKey extends string,
>({
  focusedProfileKey,
  configsByProfile,
  selections,
  onChange,
}: ProviderConfigGranularSelectorProps<TProfileKey, TConfigKey>) {
  const configs = focusedProfileKey ? (configsByProfile[focusedProfileKey] ?? []) : [];

  const providers = useMemo(() => {
    const map = new Map<string, ConfigItem<TConfigKey>[]>();
    for (const config of configs) {
      const group = map.get(config.providerName) ?? [];
      group.push(config);
      map.set(config.providerName, group);
    }
    return [...map.entries()].map(([name, items]) => ({ name, configs: items }));
  }, [configs]);

  const currentSelection = useMemo(() => {
    if (!focusedProfileKey) return null;
    return selections.find((s) => s.profileKey === focusedProfileKey) ?? null;
  }, [selections, focusedProfileKey]);

  const isAllowAll = !currentSelection || currentSelection.mode === 'allow-all';
  const selectedConfigKeys = new Set<TConfigKey>(
    isAllowAll
      ? configs.map((c) => c.key)
      : currentSelection?.mode === 'subset'
        ? (currentSelection.configKeys ?? [])
        : [],
  );

  function emitChange(nextKeys: TConfigKey[]) {
    if (!focusedProfileKey) return;
    const allKeys = configs.map((c) => c.key);
    const mode = deriveSelectionMode(nextKeys, allKeys);
    const rest = selections.filter((s) => s.profileKey !== focusedProfileKey);

    if (mode === 'allow-all') {
      onChange([...rest, { profileKey: focusedProfileKey, mode: 'allow-all' }]);
    } else if (mode === 'remove') {
      onChange([...rest, { profileKey: focusedProfileKey, mode: 'remove' }]);
    } else {
      onChange([...rest, { profileKey: focusedProfileKey, mode: 'subset', configKeys: nextKeys }]);
    }
  }

  function handleProviderToggle(providerName: string, checked: boolean) {
    const providerConfigKeys = configs
      .filter((c) => c.providerName === providerName)
      .map((c) => c.key);

    const current = new Set(selectedConfigKeys);
    if (checked) {
      providerConfigKeys.forEach((k) => current.add(k));
    } else {
      providerConfigKeys.forEach((k) => current.delete(k));
    }
    emitChange([...current]);
  }

  function handleConfigToggle(configKey: TConfigKey, checked: boolean) {
    const current = new Set(selectedConfigKeys);
    if (checked) {
      current.add(configKey);
    } else {
      current.delete(configKey);
    }
    emitChange([...current]);
  }

  function getProviderCheckedState(providerName: string): boolean | 'indeterminate' {
    const providerConfigKeys = configs
      .filter((c) => c.providerName === providerName)
      .map((c) => c.key);

    const checkedCount = providerConfigKeys.filter((k) => selectedConfigKeys.has(k)).length;
    if (checkedCount === 0) return false;
    if (checkedCount === providerConfigKeys.length) return true;
    return 'indeterminate';
  }

  if (!focusedProfileKey) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Select a profile
      </div>
    );
  }

  if (configs.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        No provider configs
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {providers.map((provider) => {
        const state = getProviderCheckedState(provider.name);
        return (
          <div
            key={provider.name}
            data-testid={`provider-group-${provider.name}`}
            className="rounded border p-2"
          >
            <label className="flex cursor-pointer items-center gap-2 px-1 py-1">
              <Checkbox
                checked={state}
                onCheckedChange={(checked) => handleProviderToggle(provider.name, checked === true)}
                aria-label={`Select all ${provider.name} configs`}
              />
              <span className="text-sm font-medium capitalize">{provider.name}</span>
              <span className="text-xs text-muted-foreground">
                ({provider.configs.length} config{provider.configs.length !== 1 ? 's' : ''})
              </span>
            </label>
            <div className="ml-6 mt-1 flex flex-col gap-0.5">
              {provider.configs.map((config) => (
                <label key={config.key} className="flex cursor-pointer items-center gap-2 py-0.5">
                  <Checkbox
                    checked={selectedConfigKeys.has(config.key)}
                    onCheckedChange={(checked) => handleConfigToggle(config.key, checked === true)}
                    aria-label={config.label}
                  />
                  <span className="text-xs text-muted-foreground">{config.label}</span>
                </label>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
