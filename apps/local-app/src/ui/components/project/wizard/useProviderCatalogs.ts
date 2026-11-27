import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import {
  launchModelOf,
  providerEffortQueries,
  selectProviderEffortNames,
  type ProviderEffortNamesCatalog,
} from '@/ui/lib/provider-efforts';
import { providerModelQueryKeys } from '@/ui/lib/provider-model-query-keys';
import { useBackendFetch } from '@/ui/hooks/useFetchFactory';
import type { BackendId } from '@/ui/lib/api-transport';
import type { SetupPreviewResponse } from '@/ui/pages/projects/lib/project-contracts';
import type { AgentRow, TemplateAgent, TemplateProviderConfig } from './agentPlan';
import { installedReferencedProviders } from './providerSelection';

interface ProviderModelCatalogOption {
  id: string;
  name: string;
}

const EMPTY_EFFORTS: ProviderEffortNamesCatalog = {
  efforts: [],
  supportsEffort: false,
  requiresModelForEffort: false,
};

/** Normalize the shared provider-model query to one object shape. */
function parseModelOptions(payload: unknown, providerId: string): ProviderModelCatalogOption[] {
  if (!Array.isArray(payload)) return [];
  return payload
    .map((raw, index) => {
      if (typeof raw === 'string') {
        const name = raw.trim();
        return name ? { id: `${providerId}:${name}:${index}`, name } : null;
      }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      const item = raw as { id?: unknown; name?: unknown };
      if (typeof item.name !== 'string' || !item.name.trim()) return null;
      const name = item.name.trim();
      const id =
        typeof item.id === 'string' && item.id.trim() ? item.id : `${providerId}:${name}:${index}`;
      return { id, name };
    })
    .filter((item): item is ProviderModelCatalogOption => item !== null);
}

/** Dedupe while preserving first-seen order (case-insensitive). */
function uniqueNames(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const key = value.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/** Model and effort catalogs per lowercased provider name: local catalogs + template catalogs. */
export interface ProviderCatalogs {
  localModels: Map<string, string[]>;
  localEfforts: Map<string, ProviderEffortNamesCatalog>;
  templateModels: Map<string, string[]>;
  templateEfforts: Map<string, string[]>;
}

/**
 * Load the model and effort catalogs of the referenced installed providers, and index the catalogs
 * the template carries (available even for providers not installed locally). `backend` must be the
 * backend that answered the preview: the provider ids come from its installed providers.
 */
export function useProviderCatalogs(
  preview: SetupPreviewResponse,
  backend: BackendId,
): ProviderCatalogs {
  const fetchFn = useBackendFetch(backend);
  const payload = preview.payload;

  const providerIdByName = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of preview.localAvailability.installedProviders) {
      map.set(p.name.trim().toLowerCase(), p.id);
    }
    return map;
  }, [preview.localAvailability.installedProviders]);

  const catalogProviders = useMemo(() => {
    const out: Array<{ id: string; name: string }> = [];
    for (const name of installedReferencedProviders(preview)) {
      const id = providerIdByName.get(name);
      if (id) out.push({ id, name });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }, [preview, providerIdByName]);

  // The Projects page keeps these entries in the home query client, also for a VM backend. A
  // catalog edit on the VM's Providers page invalidates only that page's client, so each opening
  // of the wizard reads the catalogs again.
  const modelQueries = useQueries({
    queries: catalogProviders.map(({ id }) => ({
      queryKey: providerModelQueryKeys.main(id, backend),
      queryFn: async () => {
        const res = await fetchFn(`/api/providers/${id}/models`);
        if (!res.ok) return [] as ProviderModelCatalogOption[];
        return parseModelOptions((await res.json().catch(() => [])) as unknown, id);
      },
      staleTime: 5 * 60 * 1000,
      refetchOnMount: 'always' as const,
    })),
  });

  const effortQueries = useQueries({
    queries: catalogProviders.map(({ id }) => ({
      ...providerEffortQueries.catalog(fetchFn, id, backend),
      select: selectProviderEffortNames,
      staleTime: 5 * 60 * 1000,
      refetchOnMount: 'always' as const,
    })),
  });

  const localModels = useMemo(() => {
    const map = new Map<string, string[]>();
    catalogProviders.forEach(({ id, name }, index) => {
      map.set(
        name,
        parseModelOptions(modelQueries[index]?.data, id).map((option) => option.name),
      );
    });
    return map;
  }, [catalogProviders, modelQueries]);

  const localEfforts = useMemo(() => {
    const map = new Map<string, ProviderEffortNamesCatalog>();
    catalogProviders.forEach(({ name }, index) => {
      map.set(name, effortQueries[index]?.data ?? EMPTY_EFFORTS);
    });
    return map;
  }, [catalogProviders, effortQueries]);

  const templateModels = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const entry of payload.providerModels ?? []) {
      map.set(entry.providerName.trim().toLowerCase(), entry.models);
    }
    return map;
  }, [payload.providerModels]);

  const templateEfforts = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const entry of payload.providerEfforts ?? []) {
      map.set(entry.providerName.trim().toLowerCase(), entry.efforts);
    }
    return map;
  }, [payload.providerEfforts]);

  return useMemo(
    () => ({ localModels, localEfforts, templateModels, templateEfforts }),
    [localModels, localEfforts, templateModels, templateEfforts],
  );
}

export interface AgentModelChoices {
  modelOptions: string[];
  effortOptions: string[];
  supportsEffort: boolean;
  /** The provider applies an effort only with a model. */
  requiresModelForEffort: boolean;
  /** The provider needs a model before an effort can be chosen and none resolves. */
  effortDisabled: boolean;
}

/**
 * Model and effort options for an agent row on a config: the provider's local catalog ∪ the
 * template catalog ∪ the config default ∪ the template and current overrides.
 */
export function agentModelChoices(
  catalogs: ProviderCatalogs,
  agent: TemplateAgent,
  row: AgentRow,
  config: TemplateProviderConfig | undefined,
): AgentModelChoices {
  const providerKey = config?.providerName.trim().toLowerCase() ?? '';

  const modelOptions = uniqueNames([
    ...(catalogs.localModels.get(providerKey) ?? []),
    ...(catalogs.templateModels.get(providerKey) ?? []),
    config?.model ?? null,
    agent.modelOverride ?? null,
    row.modelOverride,
  ]);

  const localEfforts = catalogs.localEfforts.get(providerKey) ?? EMPTY_EFFORTS;
  const effortOptions = uniqueNames([
    ...localEfforts.efforts,
    ...(catalogs.templateEfforts.get(providerKey) ?? []),
    config?.effort ?? null,
    agent.effortOverride ?? null,
    row.effortOverride,
  ]);
  const { requiresModelForEffort } = localEfforts;

  return {
    modelOptions,
    effortOptions,
    supportsEffort: localEfforts.supportsEffort || effortOptions.length > 0,
    requiresModelForEffort,
    effortDisabled: requiresModelForEffort && !launchModelOf(row.modelOverride, config),
  };
}

/**
 * The row change for a Model pick. A pick that leaves no model also clears the effort: the effort
 * select locks then, so its pick could no longer be changed.
 */
export function modelPickPatch(
  requiresModelForEffort: boolean,
  config: TemplateProviderConfig | undefined,
  modelOverride: string | null,
): Partial<AgentRow> {
  return requiresModelForEffort && !launchModelOf(modelOverride, config)
    ? { modelOverride, effortOverride: null }
    : { modelOverride };
}

/**
 * The row change for a config pick. A pick that leaves no model for a provider that needs one
 * also clears the effort, for the same reason as a Model pick.
 */
export function configPickPatch(
  catalogs: ProviderCatalogs,
  row: AgentRow,
  config: TemplateProviderConfig,
): Partial<AgentRow> {
  const pick = { configName: config.name, pinned: true, userSelectedOption: true };
  const { requiresModelForEffort } =
    catalogs.localEfforts.get(config.providerName.trim().toLowerCase()) ?? EMPTY_EFFORTS;
  return requiresModelForEffort && !launchModelOf(row.modelOverride, config)
    ? { ...pick, effortOverride: null }
    : pick;
}
