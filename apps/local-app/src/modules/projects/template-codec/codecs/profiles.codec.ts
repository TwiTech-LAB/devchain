/**
 * Profiles codec — owns the `profiles` section INCLUDING its embedded providerConfigs
 * (there is no standalone providerConfigs codec). Apply = the legacy
 * `createImportedProfiles` + `createImportedProviderConfigs`, moved verbatim:
 *  - create each selected profile, recording `profileIdMap`;
 *  - create the provider config for EVERY config backed by an installed provider (env preserved
 *    verbatim via `preserveImportedEnv` — the config-level env rule, DISTINCT from the
 *    providerSettings merge — carrying model/effort/position); genuinely uninstalled providers
 *    are skipped (they cannot satisfy the provider foreign key).
 *
 * Publishes TWO config lookups, both keyed by `buildProviderConfigLookupKey(profileId, configName)`:
 *  - `configLookupMap` — every persisted config, for the teams codec + faithful restoration;
 *  - `selectionEligibleConfigLookupMap` — the subset whose provider is Step-1-selection-eligible,
 *    for initial agent binding. With no allowlist the two are identical.
 *
 * Declares reads `selectedProfilesByFamily` (seeded pre-pipeline) and writes `profileIdMap` +
 * `configLookupMap` + `selectionEligibleConfigLookupMap`; the agents codec reads the eligible map.
 */
import { createLogger } from '../../../../common/logging/logger';
import {
  buildProviderConfigLookupKey,
  preserveImportedEnv,
} from '../../helpers/profile-mapping.helpers';
import type { ImportContext, SelectedProfilesByFamily } from '../import-context';
import type {
  CodecApplyResult,
  CodecApplyRuntime,
  ParsedTemplatePayload,
  PipelineMode,
  TemplateSectionCodec,
} from '../template-section-codec';

const logger = createLogger('ProfilesCodec');

type ProfilesSection = ParsedTemplatePayload['profiles'];
type ProfilesToCreate = SelectedProfilesByFamily['profilesToCreate'];

// --- Export build (moved from project-export.ts `buildExportProfiles`). ------------
// `sanitizeEnv` is injected (rather than imported from project-export.ts) to keep the
// dependency one-way (project-export -> codec) and avoid an import cycle.
interface ExportProfileRow {
  id: string;
  name: string;
  familySlug?: string | null;
  instructions?: string | null;
  temperature?: number | null;
  maxTokens?: number | null;
}
interface ExportConfigRow {
  id: string;
  name: string;
  providerId: string;
  description: string | null;
  options: string | null;
  env: Record<string, string> | null | undefined;
  model: string | null;
  effort: string | null;
  position: number;
}
interface ProfileExportContext {
  allConfigsByProfile: ReadonlyMap<string, ReadonlyArray<ExportConfigRow>>;
  providersMap: ReadonlyMap<string, { id: string; name: string }>;
  configIdToInfo: Map<string, { name: string; profileId: string }>;
}

export function buildExportProfiles(
  profilesRes: { items: ReadonlyArray<ExportProfileRow> },
  context: ProfileExportContext,
  sanitizeEnv: (env: Record<string, string> | null | undefined) => Record<string, string> | null,
) {
  return profilesRes.items.map((profile) => {
    const configs = context.allConfigsByProfile.get(profile.id) || [];

    let primaryProvider: { id: string; name: string } | null = null;
    const providerConfigs = configs.map((config) => {
      const provider = context.providersMap.get(config.providerId);
      if (!primaryProvider && provider) {
        primaryProvider = { id: provider.id, name: provider.name };
      }

      context.configIdToInfo.set(config.id, { name: config.name, profileId: profile.id });

      return {
        name: config.name,
        providerName: provider?.name || 'unknown',
        description: config.description,
        options: config.options,
        env: sanitizeEnv(config.env),
        ...(config.model != null && { model: config.model }),
        ...(config.effort != null && { effort: config.effort }),
        position: config.position,
      };
    });

    return {
      id: profile.id,
      name: profile.name,
      provider: primaryProvider,
      familySlug: profile.familySlug,
      instructions: profile.instructions,
      temperature: profile.temperature,
      maxTokens: profile.maxTokens,
      ...(providerConfigs.length > 0 && { providerConfigs }),
    };
  });
}

class ProfilesCodec implements TemplateSectionCodec<ProfilesSection> {
  readonly declaration = {
    section: 'profiles',
    reads: ['selectedProfilesByFamily'],
    writes: [
      'profileIdMap',
      'profileNameToId',
      'configLookupMap',
      'selectionEligibleConfigLookupMap',
    ],
    requiresState: ['existingDataCleared'],
    producesState: ['profilesPersisted'],
    modes: ['replace', 'create'],
  } as const;

  pick(payload: ParsedTemplatePayload): ProfilesSection {
    return payload.profiles;
  }

  build() {
    // Export build for profiles is invoked directly by project-export via
    // `buildExportProfiles` (needs the loaded profile/config/provider context).
    return [];
  }

  async apply(
    _section: ProfilesSection,
    ctx: ImportContext,
    _mode: PipelineMode,
    rt: CodecApplyRuntime,
  ): Promise<CodecApplyResult> {
    const { projectId, storage } = rt;
    const installed = rt.installedProviders ?? new Map<string, string>();
    // No allowlist → every installed provider is selection-eligible, so eligible ≡ full.
    const selected = rt.selectedProviders ?? installed;
    const profilesToCreate = ctx.get('selectedProfilesByFamily').profilesToCreate;

    const profileIdMap = await this.createProfiles(projectId, profilesToCreate, storage);
    const { configLookupMap, selectionEligibleConfigLookupMap } = await this.createProviderConfigs(
      profilesToCreate,
      profileIdMap,
      installed,
      selected,
      storage,
    );

    // Name(lowercased) -> new id, for downstream name-based resolution (watchers, teams).
    const profileNameToId = new Map<string, string>();
    for (const profile of profilesToCreate) {
      const key = profile.id || `name:${profile.name.trim().toLowerCase()}`;
      const newId = profileIdMap[key];
      if (newId) profileNameToId.set(profile.name.trim().toLowerCase(), newId);
    }

    ctx.set('profileIdMap', profileIdMap);
    ctx.set('profileNameToId', profileNameToId);
    ctx.set('configLookupMap', configLookupMap);
    ctx.set('selectionEligibleConfigLookupMap', selectionEligibleConfigLookupMap);

    return {
      section: 'profiles',
      log: {
        profiles: profilesToCreate.length,
        configs: configLookupMap.size,
        eligibleConfigs: selectionEligibleConfigLookupMap.size,
      },
    };
  }

  private async createProfiles(
    projectId: string,
    profilesToCreate: ProfilesToCreate,
    storage: CodecApplyRuntime['storage'],
  ): Promise<Record<string, string>> {
    const profileIdMap: Record<string, string> = {};

    for (const profile of profilesToCreate) {
      const created = await storage.createAgentProfile({
        projectId,
        name: profile.name,
        familySlug: profile.familySlug ?? null,
        systemPrompt: null,
        instructions: profile.instructions ?? null,
        temperature: profile.temperature ?? null,
        maxTokens: profile.maxTokens ?? null,
      });

      const profileKey = profile.id || `name:${profile.name.trim().toLowerCase()}`;
      profileIdMap[profileKey] = created.id;
    }

    return profileIdMap;
  }

  private async createProviderConfigs(
    profilesToCreate: ProfilesToCreate,
    profileIdMap: Record<string, string>,
    installed: Map<string, string>,
    selected: Map<string, string>,
    storage: CodecApplyRuntime['storage'],
  ): Promise<{
    configLookupMap: Map<string, string>;
    selectionEligibleConfigLookupMap: Map<string, string>;
  }> {
    const configLookupMap = new Map<string, string>();
    const selectionEligibleConfigLookupMap = new Map<string, string>();

    for (const profile of profilesToCreate) {
      const profileKey = profile.id || `name:${profile.name.trim().toLowerCase()}`;
      const newProfileId = profileIdMap[profileKey];
      if (!newProfileId) {
        continue;
      }

      const providerConfigs = (
        profile as {
          providerConfigs?: Array<{
            name: string;
            providerName: string;
            description?: string | null;
            options?: string | null;
            env?: Record<string, string> | null;
            model?: string | null;
            effort?: string | null;
            position?: number;
          }>;
        }
      ).providerConfigs;

      if (providerConfigs && providerConfigs.length > 0) {
        for (const config of providerConfigs) {
          const providerKey = config.providerName.trim().toLowerCase();
          const providerId = installed.get(providerKey);
          if (!providerId) {
            logger.warn(
              { profileName: profile.name, providerName: config.providerName },
              'Provider not found for config, skipping',
            );
            continue;
          }

          const created = await storage.createProfileProviderConfig({
            profileId: newProfileId,
            providerId,
            name: config.name,
            description: config.description ?? null,
            options: config.options ?? null,
            env: preserveImportedEnv(config.env),
            model: config.model ?? null,
            effort: config.effort ?? null,
            // Pass through verbatim; undefined keeps storage's max+1 auto-assign (legacy behavior).
            position: config.position,
          });

          const lookupKey = buildProviderConfigLookupKey(newProfileId, config.name);
          configLookupMap.set(lookupKey, created.id);
          if (selected.has(providerKey)) {
            selectionEligibleConfigLookupMap.set(lookupKey, created.id);
          }
        }
        continue;
      }

      const providerName = profile.provider.name.trim().toLowerCase();
      const providerId = installed.get(providerName);
      if (!providerId) {
        continue;
      }

      const options =
        profile.options != null
          ? typeof profile.options === 'string'
            ? profile.options
            : JSON.stringify(profile.options)
          : null;

      const created = await storage.createProfileProviderConfig({
        profileId: newProfileId,
        providerId,
        name: 'default',
        options,
        env: null,
      });

      const lookupKey = buildProviderConfigLookupKey(newProfileId, 'default');
      configLookupMap.set(lookupKey, created.id);
      if (selected.has(providerName)) {
        selectionEligibleConfigLookupMap.set(lookupKey, created.id);
      }
    }

    return { configLookupMap, selectionEligibleConfigLookupMap };
  }
}

export const profilesCodec = new ProfilesCodec();
