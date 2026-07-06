/**
 * Provider efforts codec — owns the `providerEfforts` template section. Mirrors the
 * provider models codec exactly (was `importProviderEfforts` / `buildProviderEfforts`):
 * additive, CI-deduped via `storage.bulkCreateProviderEfforts`, skips unknown providers.
 * No ImportContext reads/writes.
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

const logger = createLogger('ProviderEffortsCodec');

// Accessed via cast (as the legacy `importProviderEfforts` did): the published
// @devchain/shared type can lag the source schema for newly-added optional sections.
type ProviderEffortsSection = Array<{ providerName: string; efforts: string[] }> | undefined;

/** Export builder (moved verbatim from project-export.ts `buildProviderEfforts`). */
export async function buildProviderEfforts(
  providersMap: ExportBuildContext['providersMap'],
  storage: ExportBuildContext['storage'],
) {
  const providerIds = [...providersMap.keys()];
  if (providerIds.length === 0) {
    return [] as Array<{ providerName: string; efforts: string[] }>;
  }

  const allEfforts = await storage.listProviderEffortsByProviderIds(providerIds);
  const effortsByProviderId = new Map<string, string[]>();
  for (const effort of allEfforts) {
    const efforts = effortsByProviderId.get(effort.providerId) ?? [];
    efforts.push(effort.name);
    effortsByProviderId.set(effort.providerId, efforts);
  }

  const result: Array<{ providerName: string; efforts: string[] }> = [];
  for (const [providerId, provider] of providersMap.entries()) {
    const efforts = effortsByProviderId.get(providerId);
    if (efforts && efforts.length > 0) {
      result.push({ providerName: provider.name, efforts });
    }
  }
  return result;
}

class ProviderEffortsCodec implements TemplateSectionCodec<ProviderEffortsSection> {
  readonly declaration = {
    section: 'providerEfforts',
    reads: [],
    writes: [],
    modes: ['replace', 'create'],
  } as const;

  pick(payload: ParsedTemplatePayload): ProviderEffortsSection {
    return (payload as { providerEfforts?: Array<{ providerName: string; efforts: string[] }> })
      .providerEfforts;
  }

  build() {
    // Export build driven directly by project-export via `buildProviderEfforts`.
    return [];
  }

  async apply(
    providerEfforts: ProviderEffortsSection,
    _ctx: ImportContext,
    _mode: PipelineMode,
    rt: CodecApplyRuntime,
  ): Promise<CodecApplyResult> {
    const { storage } = rt;
    if (!providerEfforts || providerEfforts.length === 0) {
      return { section: 'providerEfforts', log: { added: 0, existing: 0, providersSkipped: 0 } };
    }

    const allProviders = await storage.listProviders();
    const providersByName = new Map(
      allProviders.items.map((provider) => [provider.name.trim().toLowerCase(), provider]),
    );

    let added = 0;
    let existing = 0;
    let providersSkipped = 0;

    for (const entry of providerEfforts) {
      const localProvider = providersByName.get(entry.providerName.trim().toLowerCase());
      if (!localProvider) {
        providersSkipped++;
        logger.debug(
          { providerName: entry.providerName },
          'Skipping providerEfforts import: no matching local provider',
        );
        continue;
      }
      if (entry.efforts.length === 0) continue;

      const result = await storage.bulkCreateProviderEfforts(localProvider.id, entry.efforts);
      added += result.added.length;
      existing += result.existing.length;
    }

    const log = { added, existing, providersSkipped };
    logger.info(log, 'Imported provider efforts from template');
    return { section: 'providerEfforts', log };
  }
}

export const providerEffortsCodec = new ProviderEffortsCodec();
