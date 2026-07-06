/**
 * ProviderSettings codec — owns the global `providerSettings` section. These are
 * PROVIDER-LEVEL rows (auto-compact thresholds, 1M-context probe, env merge), NOT a
 * project entity — they mutate the shared provider catalog keyed by provider name.
 *
 * Apply = the legacy `importProviderSettings`, moved VERBATIM. The acceptance matrix is
 * frozen (docs/template-roundtrip-compatibility-matrix.md row 19 + Architect round-2 note):
 *  - `autoCompactThreshold` imports ONLY when the local provider's threshold is null;
 *  - `autoCompactThreshold1m` MAY overwrite the local value when the template carries one;
 *  - `oneMillionContextEnabled` is probed ONLY with a local `binPath` AND an injected probe
 *    callback — success → enabled + threshold 50 (legacy-promoted when no 1m field);
 *    failure / no-binPath / no-probe → disabled + standard threshold 95;
 *  - `env` merges NON-destructively (local wins), with redacted `***` values stripped first.
 *
 * Env semantics here are DISTINCT from config-level env (config env is preserved verbatim
 * via `preserveImportedEnv`; provider env is a local-wins merge) — the two rules must never
 * be unified.
 *
 * Fatal in both modes (matrix row 19). Reads/writes nothing in the ImportContext —
 * provider settings are resolved against live storage, not context maps.
 */
import { createLogger } from '../../../../common/logging/logger';
import { preserveImportedEnv } from '../../helpers/profile-mapping.helpers';
import type { ImportContext } from '../import-context';
import type {
  CodecApplyResult,
  CodecApplyRuntime,
  ParsedTemplatePayload,
  PipelineMode,
  TemplateSectionCodec,
} from '../template-section-codec';

const logger = createLogger('ProviderSettingsCodec');

type ProviderSettingsSection = ParsedTemplatePayload['providerSettings'];

/** Provider row shape the export builder reads (a slice of `listProvidersByIds` output). */
export interface ProviderExportRow {
  id: string;
  name: string;
  binPath: string | null;
  autoCompactThreshold: number | null;
  autoCompactThreshold1m?: number | null;
  oneMillionContextEnabled?: boolean;
  env?: Record<string, string> | null;
}

/**
 * Env helpers the export builder needs. Injected (not imported from project-export.ts) to
 * keep the dependency one-way (project-export -> codec) and avoid an import cycle — the
 * same pattern the profiles codec uses for `sanitizeEnv`.
 */
export interface ProviderEnvFns {
  filterEnvByScope: (
    env: Record<string, string>,
    scopes: Record<string, string[]> | undefined,
    sourceProjectId: string,
  ) => Record<string, string> | null;
  sanitizeEnvMap: (env: Record<string, string> | null | undefined) => Record<string, string> | null;
}

// --- Export build (moved from project-export.ts `buildProviderSettings`). ------------
export function buildProviderSettings(
  providersMap: Map<string, ProviderExportRow>,
  sourceProjectId: string,
  scopeMap: Map<string, Record<string, string[]>>,
  envFns: ProviderEnvFns,
) {
  const providerSettings: Array<{
    name: string;
    autoCompactThreshold: number | null;
    autoCompactThreshold1m?: number | null;
    oneMillionContextEnabled?: boolean;
    env?: Record<string, string> | null;
  }> = [];

  for (const [providerId, provider] of providersMap.entries()) {
    const filteredEnv =
      provider.env && Object.keys(provider.env).length > 0
        ? envFns.filterEnvByScope(provider.env, scopeMap.get(providerId), sourceProjectId)
        : null;
    const hasEnv = filteredEnv !== null;
    if (
      provider.autoCompactThreshold != null ||
      provider.autoCompactThreshold1m != null ||
      provider.oneMillionContextEnabled ||
      hasEnv
    ) {
      providerSettings.push({
        name: provider.name,
        autoCompactThreshold: provider.autoCompactThreshold ?? null,
        ...(provider.autoCompactThreshold1m != null && {
          autoCompactThreshold1m: provider.autoCompactThreshold1m,
        }),
        ...(provider.oneMillionContextEnabled && { oneMillionContextEnabled: true }),
        ...(hasEnv && { env: envFns.sanitizeEnvMap(filteredEnv) }),
      });
    }
  }

  return providerSettings;
}

class ProviderSettingsCodec implements TemplateSectionCodec<ProviderSettingsSection> {
  readonly declaration = {
    section: 'providerSettings',
    reads: [],
    writes: [],
    modes: ['replace', 'create'],
  } as const;

  pick(payload: ParsedTemplatePayload): ProviderSettingsSection {
    return payload.providerSettings;
  }

  build() {
    // Export build is invoked directly by project-export via `buildProviderSettings`
    // (needs the loaded provider rows + env-scope map + the env filter/sanitize fns).
    return [];
  }

  async apply(
    importedProviderSettings: ProviderSettingsSection,
    _ctx: ImportContext,
    _mode: PipelineMode,
    rt: CodecApplyRuntime,
  ): Promise<CodecApplyResult> {
    const storage = rt.storage;

    if (!importedProviderSettings || importedProviderSettings.length === 0) {
      return { section: 'providerSettings' };
    }

    const allProviders = await storage.listProviders();
    const providersByName = new Map(
      allProviders.items.map((provider) => [provider.name.trim().toLowerCase(), provider]),
    );

    let updated = 0;

    for (const setting of importedProviderSettings) {
      const localProvider = providersByName.get(setting.name.trim().toLowerCase());
      if (!localProvider) {
        continue;
      }

      const updates: Record<string, unknown> = {};

      if (localProvider.autoCompactThreshold == null && setting.autoCompactThreshold != null) {
        updates.autoCompactThreshold = setting.autoCompactThreshold;
        logger.info(
          { providerName: setting.name, threshold: setting.autoCompactThreshold },
          'Applied autoCompactThreshold from template import',
        );
      } else if (localProvider.autoCompactThreshold != null) {
        logger.debug(
          { providerName: setting.name, existing: localProvider.autoCompactThreshold },
          'Skipping providerSettings import: local threshold already set',
        );
      }

      // Import autoCompactThreshold1m if present in template
      if (setting.autoCompactThreshold1m != null) {
        updates.autoCompactThreshold1m = setting.autoCompactThreshold1m;
      }

      // Import oneMillionContextEnabled: auto-probe when callback is available,
      // otherwise disable and set a safe threshold (95) to avoid degraded sessions.
      if (setting.oneMillionContextEnabled) {
        // Legacy compat: if template has 1M enabled but no autoCompactThreshold1m,
        // treat the old autoCompactThreshold as the 1M value
        const isLegacyTemplate = setting.autoCompactThreshold1m == null;

        if (localProvider.binPath && rt.probe1m) {
          const outcome = await rt.probe1m(localProvider.binPath);
          if (outcome.supported) {
            updates.oneMillionContextEnabled = true;
            updates.autoCompactThreshold1m = isLegacyTemplate
              ? (setting.autoCompactThreshold ?? 50)
              : (setting.autoCompactThreshold1m ?? 50);
            // Only set standard threshold when local provider doesn't have one
            if (localProvider.autoCompactThreshold == null) {
              updates.autoCompactThreshold = isLegacyTemplate
                ? 95
                : (setting.autoCompactThreshold ?? 95);
            }
            logger.info(
              { providerName: setting.name },
              'Template had 1M context enabled — auto-probe confirmed support',
            );
          } else {
            updates.oneMillionContextEnabled = false;
            if (localProvider.autoCompactThreshold == null) {
              updates.autoCompactThreshold = 95;
            }
            updates.autoCompactThreshold1m = null;
            logger.info(
              { providerName: setting.name, status: outcome.status },
              'Template had 1M context enabled — auto-probe did not confirm support',
            );
          }
        } else {
          updates.oneMillionContextEnabled = false;
          if (localProvider.autoCompactThreshold == null) {
            updates.autoCompactThreshold = 95;
          }
          updates.autoCompactThreshold1m = null;
          logger.info(
            { providerName: setting.name },
            'Template had 1M context enabled — disabled during import (no binPath or probe unavailable)',
          );
        }
      }

      const importedEnv = preserveImportedEnv(setting.env);
      if (importedEnv) {
        if (localProvider.env == null) {
          updates.env = importedEnv;
          logger.info(
            { providerName: setting.name, keyCount: Object.keys(importedEnv).length },
            'Applied provider env from template import (no local env existed)',
          );
        } else {
          const merged = { ...localProvider.env };
          let addedCount = 0;
          for (const [key, value] of Object.entries(importedEnv)) {
            if (!(key in merged)) {
              merged[key] = value;
              addedCount++;
            }
          }
          if (addedCount > 0) {
            updates.env = merged;
            logger.info(
              { providerName: setting.name, addedCount },
              'Merged provider env from template import (local wins on conflicts)',
            );
          } else {
            logger.debug(
              { providerName: setting.name },
              'Skipping provider env import: all template keys already exist locally',
            );
          }
        }
      }

      if (Object.keys(updates).length > 0) {
        await storage.updateProvider(localProvider.id, updates);
        updated++;
      }
    }

    return { section: 'providerSettings', log: { providersUpdated: updated } };
  }
}

export const providerSettingsCodec = new ProviderSettingsCodec();
