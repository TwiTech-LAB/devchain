/**
 * Presets codec merges incoming template presets with user presets against the saved roster.
 *
 * EXPORT is not owned by this codec: presets export is driven by the export options
 * (`presetsOverride` merged with stored presets via `resolveExportPresets` in project-export.ts),
 * which is an options concern rather than a pure project-state projection. It stays in
 * project-export until the export path is migrated. `build()` is therefore a placeholder.
 */
import { extractTemplatePresets } from '../../helpers/profile-mapping.helpers';
import type { ImportContext } from '../import-context';
import type {
  CodecApplyResult,
  CodecApplyRuntime,
  ParsedTemplatePayload,
  PipelineMode,
  TemplateSectionCodec,
} from '../template-section-codec';

type PresetsSection = ParsedTemplatePayload['presets'];

class PresetsCodec implements TemplateSectionCodec<PresetsSection> {
  readonly declaration = {
    section: 'presets',
    reads: [],
    writes: [],
    requiresState: ['agentsPersisted'],
    modes: ['replace', 'create'],
  } as const;

  pick(payload: ParsedTemplatePayload): PresetsSection {
    return payload.presets;
  }

  build() {
    // Presets export is options-driven and remains in project-export (see file header).
    return [];
  }

  async apply(
    presets: PresetsSection,
    _ctx: ImportContext,
    _mode: PipelineMode,
    rt: CodecApplyRuntime,
  ): Promise<CodecApplyResult> {
    if (!rt.settings) {
      return { section: 'presets', log: { skipped: 'no settings service' } };
    }

    const { projectId } = rt;
    const options = { limit: Number.MAX_SAFE_INTEGER };
    const [agents, teams] = await Promise.all([
      rt.storage.listAgents(projectId, options),
      rt.teamsService?.listTeams(projectId, options),
    ]);
    const templatePresets = extractTemplatePresets({ presets });
    await rt.settings.mergeProjectTemplatePresets(
      projectId,
      templatePresets,
      agents.items.map(({ name }) => name),
      teams?.items.map(({ name }) => name),
    );
    return { section: 'presets', log: { presets: templatePresets.length, action: 'merged' } };
  }
}

export const presetsCodec = new PresetsCodec();
