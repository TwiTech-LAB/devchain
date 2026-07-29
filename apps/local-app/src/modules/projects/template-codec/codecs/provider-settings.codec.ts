/**
 * ProviderSettings codec — owns the global `providerSettings` section. These are
 * PROVIDER-LEVEL rows (auto-compact threshold and env merge), NOT a
 * project entity — they mutate the shared provider catalog keyed by provider name.
 *
 * Apply preserves the established provider-settings import contract:
 *  - `autoCompactThreshold` imports ONLY when the local provider's threshold is null;
 *  - `env` merges NON-destructively (local wins), preserving redacted `***` placeholders.
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
  autoCompactThreshold: number | null;
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
    env?: Record<string, string> | null;
  }> = [];

  for (const [providerId, provider] of providersMap.entries()) {
    const filteredEnv =
      provider.env && Object.keys(provider.env).length > 0
        ? envFns.filterEnvByScope(provider.env, scopeMap.get(providerId), sourceProjectId)
        : null;
    const hasEnv = filteredEnv !== null;
    if (provider.autoCompactThreshold != null || hasEnv) {
      providerSettings.push({
        name: provider.name,
        autoCompactThreshold: provider.autoCompactThreshold ?? null,
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

      const importedEnv = preserveImportedEnv(
        sanitizeLegacyClaudeProviderEnv(setting.name, setting.env),
      );
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

function sanitizeLegacyClaudeProviderEnv(
  providerName: string,
  env: Record<string, string> | null | undefined,
): Record<string, string> | null | undefined {
  if (
    providerName.trim().toLowerCase() !== 'claude' ||
    env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW !== '1000000'
  ) {
    return env;
  }

  const { CLAUDE_CODE_AUTO_COMPACT_WINDOW: _retiredWindow, ...sanitized } = env;
  return sanitized;
}
