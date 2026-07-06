/**
 * Presets codec — owns the `presets` IMPORT direction (set-or-clear semantics).
 *
 * Apply replicates the legacy `replaceProjectPresets`: a template WITH presets replaces the
 * stored presets; a template WITHOUT presets CLEARS the stored presets (logged). This asymmetry
 * is intentional and preserved exactly.
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

    const templatePresets = extractTemplatePresets({ presets });

    if (templatePresets.length > 0) {
      await rt.settings.setProjectPresets(rt.projectId, templatePresets);
      return { section: 'presets', log: { presets: templatePresets.length, action: 'set' } };
    }

    await rt.settings.clearProjectPresets(rt.projectId);
    return { section: 'presets', log: { presets: 0, action: 'cleared' } };
  }
}

export const presetsCodec = new PresetsCodec();
