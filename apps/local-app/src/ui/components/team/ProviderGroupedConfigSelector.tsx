import { useMemo } from 'react';
import { Checkbox } from '@/ui/components/ui/checkbox';
import { deriveSelectionMode } from './selector-types';
import type { SelectionMode, ProfileSelection, ConfigItem } from './selector-types';

export type { SelectionMode, ProfileSelection, ConfigItem };

export interface ProviderGroupedConfigSelectorProps<
  TProfileKey extends string,
  TConfigKey extends string,
> {
  focusedProfileKey: TProfileKey | null;
  configsByProfile: Record<TProfileKey, ConfigItem<TConfigKey>[]>;
  selections: ProfileSelection<TProfileKey, TConfigKey>[];
  onChange: (selections: ProfileSelection<TProfileKey, TConfigKey>[]) => void;
  /**
   * Immutable baseline used by the provider checkbox toggle. When set, toggling
   * a provider only adds/removes the configs declared by this baseline for that
   * provider — preserving the original template's per-config subset instead of
   * defaulting to "all configs of this provider".
   */
  templateSelections?: ProfileSelection<TProfileKey, TConfigKey>[];
}

export function ProviderGroupedConfigSelector<
  TProfileKey extends string,
  TConfigKey extends string,
>({
  focusedProfileKey,
  configsByProfile,
  selections,
  onChange,
  templateSelections,
}: ProviderGroupedConfigSelectorProps<TProfileKey, TConfigKey>) {
  const configs = focusedProfileKey ? (configsByProfile[focusedProfileKey] ?? []) : [];

  /**
   * When a `templateSelections` baseline is provided in `subset` mode, hide
   * configs that the template did not pre-select — the dialog should only
   * surface what the template author chose to expose.
   */
  const visibleConfigs = useMemo(() => {
    if (!templateSelections || !focusedProfileKey) return configs;
    const templateSel = templateSelections.find((s) => s.profileKey === focusedProfileKey);
    if (!templateSel || templateSel.mode !== 'subset' || !templateSel.configKeys) return configs;
    const allowed = new Set<TConfigKey>(templateSel.configKeys);
    return configs.filter((c) => allowed.has(c.key));
  }, [configs, templateSelections, focusedProfileKey]);

  const providers = useMemo(() => {
    const map = new Map<string, ConfigItem<TConfigKey>[]>();
    for (const config of visibleConfigs) {
      const group = map.get(config.providerName) ?? [];
      group.push(config);
      map.set(config.providerName, group);
    }
    return [...map.entries()].map(([name, items]) => ({ name, configs: items }));
  }, [visibleConfigs]);

  const currentSelection = useMemo(() => {
    if (!focusedProfileKey) return null;
    return selections.find((s) => s.profileKey === focusedProfileKey) ?? null;
  }, [selections, focusedProfileKey]);

  const isAllowAll = !currentSelection || currentSelection.mode === 'allow-all';
  const selectedConfigKeys = new Set<TConfigKey>(
    isAllowAll
      ? visibleConfigs.map((c) => c.key)
      : currentSelection?.mode === 'subset'
        ? (currentSelection.configKeys ?? [])
        : [],
  );

  const totalConfigCount = configs.length;

  /**
   * Configs that the provider checkbox controls — defaults to every config of
   * the provider, but narrows to the template's subset when one is provided so
   * toggling does not silently expand a "sonnet+opus46"-only template into
   * "all four claude configs".
   */
  function getProviderToggleSet(providerName: string): TConfigKey[] {
    const providerConfigKeys = configs
      .filter((c) => c.providerName === providerName)
      .map((c) => c.key);

    if (!templateSelections || !focusedProfileKey) return providerConfigKeys;
    const templateSel = templateSelections.find((s) => s.profileKey === focusedProfileKey);
    if (!templateSel || templateSel.mode === 'allow-all') return providerConfigKeys;
    if (templateSel.mode === 'subset' && templateSel.configKeys) {
      const templateKeys = new Set<TConfigKey>(templateSel.configKeys);
      return providerConfigKeys.filter((k) => templateKeys.has(k));
    }
    return providerConfigKeys;
  }

  function emitChange(mode: SelectionMode, configKeys?: TConfigKey[]) {
    if (!focusedProfileKey) return;
    const rest = selections.filter((s) => s.profileKey !== focusedProfileKey);

    if (mode === 'allow-all') {
      onChange([...rest, { profileKey: focusedProfileKey, mode: 'allow-all' }]);
    } else if (mode === 'remove') {
      onChange([...rest, { profileKey: focusedProfileKey, mode: 'remove' }]);
    } else {
      onChange([
        ...rest,
        { profileKey: focusedProfileKey, mode: 'subset', configKeys: configKeys ?? [] },
      ]);
    }
  }

  function handleProviderToggle(providerName: string, checked: boolean) {
    const toggleSet = getProviderToggleSet(providerName);
    if (toggleSet.length === 0) return;

    const current = new Set<TConfigKey>(
      isAllowAll ? configs.map((c) => c.key) : selectedConfigKeys,
    );
    if (checked) {
      toggleSet.forEach((k) => current.add(k));
    } else {
      toggleSet.forEach((k) => current.delete(k));
    }
    const nextKeys = [...current];

    if (nextKeys.length === 0) {
      emitChange('remove');
    } else if (nextKeys.length === totalConfigCount) {
      emitChange('allow-all');
    } else {
      emitChange('subset', nextKeys);
    }
  }

  function handleConfigToggle(configKey: TConfigKey, checked: boolean) {
    // selectedConfigKeys already expands 'allow-all' to all visibleConfigs at lines 66-72,
    // so building from it correctly materializes the full set before single-key mutation.
    const next = new Set<TConfigKey>(selectedConfigKeys);
    if (checked) next.add(configKey);
    else next.delete(configKey);
    const nextKeys = [...next];

    // IMPORTANT: derive 'full' against ALL profile configs, NOT visibleConfigs.
    // `allow-all` is the server-side sentinel for "no restrictions". If the pivot were
    // visibleConfigs.length, selecting every visible config in a template-restricted profile
    // would silently collapse back to unrestricted allow-all, defeating the template intent.
    const mode = deriveSelectionMode(
      nextKeys,
      configs.map((c) => c.key),
    );
    emitChange(mode, mode === 'subset' ? nextKeys : undefined);
  }

  function getProviderCheckedState(providerName: string): boolean | 'indeterminate' {
    const toggleSet = getProviderToggleSet(providerName);
    if (toggleSet.length === 0) return false;

    const includedCount = toggleSet.filter((k) => selectedConfigKeys.has(k)).length;
    if (includedCount === 0) return false;
    if (includedCount === toggleSet.length) return true;
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

  if (visibleConfigs.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Template did not pre-select any configs for this profile
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {providers.map((provider) => {
        const state = getProviderCheckedState(provider.name);
        return (
          <div key={provider.name} className="rounded border p-2">
            <label className="flex cursor-pointer items-center gap-2 px-1 py-1">
              <Checkbox
                checked={state}
                onCheckedChange={(checked) => handleProviderToggle(provider.name, checked === true)}
                aria-label={`Provider ${provider.name}`}
              />
              <span className="text-sm font-medium capitalize">{provider.name}</span>
              <span className="text-xs text-muted-foreground">
                ({provider.configs.length} config{provider.configs.length !== 1 ? 's' : ''})
              </span>
            </label>
            <div className="ml-6 mt-1 flex flex-col gap-0.5">
              {provider.configs.map((config) => {
                const selected = selectedConfigKeys.has(config.key);
                return (
                  <label
                    key={config.key}
                    className={`flex cursor-pointer items-center gap-1.5 text-xs ${
                      selected ? 'text-foreground' : 'text-muted-foreground line-through'
                    }`}
                  >
                    <Checkbox
                      checked={selected}
                      onCheckedChange={(checked) =>
                        handleConfigToggle(config.key, checked === true)
                      }
                      aria-label={`Config ${config.key}`}
                    />
                    <span>{config.label}</span>
                  </label>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
