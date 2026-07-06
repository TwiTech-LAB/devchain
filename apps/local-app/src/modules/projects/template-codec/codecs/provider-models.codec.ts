/**
 * Provider models codec — owns the `providerModels` template section.
 *
 * Apply is ADDITIVE and behavior-preserving (was `importProviderModels`): resolve
 * providers by name, skip unknown providers (no fail), and bulk-create with CI-dedupe
 * (`storage.bulkCreateProviderModels`). Reads/writes NOTHING in the ImportContext — its
 * only effect is on provider storage — so it carries no ordering dependencies.
 */
import { createLogger } from '../../../../common/logging/logger';
import type { ImportContext } from '../import-context';
import type {
  CodecApplyResult,
  CodecApplyRuntime,
  ExportBuildContext,
  ParsedTemplatePayload,
  PipelineMode,
  TemplateSectionCodec,
} from '../template-section-codec';

const logger = createLogger('ProviderModelsCodec');

// Accessed via cast (as the legacy `importProviderModels` did): the published
// @devchain/shared type can lag the source schema for newly-added optional sections.
type ProviderModelsSection = Array<{ providerName: string; models: string[] }> | undefined;

/** Export builder (moved verbatim from project-export.ts `buildProviderModels`). */
export async function buildProviderModels(
  providersMap: ExportBuildContext['providersMap'],
  storage: ExportBuildContext['storage'],
) {
  const providerIds = [...providersMap.keys()];
  if (providerIds.length === 0) {
    return [] as Array<{ providerName: string; models: string[] }>;
  }

  const allModels = await storage.listProviderModelsByProviderIds(providerIds);
  const modelsByProviderId = new Map<string, string[]>();
  for (const model of allModels) {
    const models = modelsByProviderId.get(model.providerId) ?? [];
    models.push(model.name);
    modelsByProviderId.set(model.providerId, models);
  }

  const result: Array<{ providerName: string; models: string[] }> = [];
  for (const [providerId, provider] of providersMap.entries()) {
    const models = modelsByProviderId.get(providerId);
    if (models && models.length > 0) {
      result.push({ providerName: provider.name, models });
    }
  }
  return result;
}

class ProviderModelsCodec implements TemplateSectionCodec<ProviderModelsSection> {
  readonly declaration = {
    section: 'providerModels',
    reads: [],
    writes: [],
    modes: ['replace', 'create'],
  } as const;

  pick(payload: ParsedTemplatePayload): ProviderModelsSection {
    return (payload as { providerModels?: Array<{ providerName: string; models: string[] }> })
      .providerModels;
  }

  build() {
    // Export build for this codec is driven directly by project-export via
    // `buildProviderModels` (needs providersMap + storage); no pipeline export path.
    return [];
  }

  async apply(
    providerModels: ProviderModelsSection,
    _ctx: ImportContext,
    _mode: PipelineMode,
    rt: CodecApplyRuntime,
  ): Promise<CodecApplyResult> {
    const { storage } = rt;
    if (!providerModels || providerModels.length === 0) {
      return { section: 'providerModels', log: { added: 0, existing: 0, providersSkipped: 0 } };
    }

    const allProviders = await storage.listProviders();
    const providersByName = new Map(
      allProviders.items.map((provider) => [provider.name.trim().toLowerCase(), provider]),
    );

    let added = 0;
    let existing = 0;
    let providersSkipped = 0;

    for (const entry of providerModels) {
      const localProvider = providersByName.get(entry.providerName.trim().toLowerCase());
      if (!localProvider) {
        providersSkipped++;
        logger.debug(
          { providerName: entry.providerName },
          'Skipping providerModels import: no matching local provider',
        );
        continue;
      }
      if (entry.models.length === 0) continue;

      const result = await storage.bulkCreateProviderModels(localProvider.id, entry.models);
      added += result.added.length;
      existing += result.existing.length;
    }

    const log = { added, existing, providersSkipped };
    logger.info(log, 'Imported provider models from template');
    return { section: 'providerModels', log };
  }
}

export const providerModelsCodec = new ProviderModelsCodec();
