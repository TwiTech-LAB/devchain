/**
 * Project-settings codec — owns the `projectSettings` section AND the `initialPrompt`
 * resolution (the codec unifies these two related payload fields).
 *
 * IMPORT apply replicates the legacy `applyImportedProjectSettings` exactly by delegating to
 * `mergeProjectSettingsWithInitialPrompt` + `applyProjectSettingsWithHelper` (behavior-preserving).
 * Current imports first resolve the exported prompt id through `promptIdMap`, then fall back to
 * title-based resolution for older payloads without a usable id mapping.
 * A missing prompt (no title match) leaves `initialSessionPromptId` unset (initialPromptSet=false).
 *
 * EXPORT build is `buildProjectSettings` (moved from project-export.ts); it takes already-resolved
 * primitive slices so the codec does not depend on the exporter's `ExportState` shape.
 *
 * Template-metadata placement decision (DoD): template metadata recording
 * (`updateTemplateMetadata`) is NOT folded into this codec — it stays a distinct, last-in-order
 * stage. Rationale: (a) it records install provenance AFTER every section is applied, so it is a
 * lifecycle concern rather than a settings concern; (b) it requires `unifiedTemplateService`,
 * which is not part of the codec apply runtime; (c) it must run after settings/presets. It will be
 * migrated as its own stage in a later task of this phase.
 *
 * Ordering: reads `createdPrompts` + `promptIdMap` (prompts codec) and `templateLabelToStatusId`
 * (statuses codec), all produced earlier.
 */
import { applyProjectSettingsWithHelper } from '../../helpers/project-runtime.helpers';
import {
  buildPromptTitleToIdMap,
  mergeProjectSettingsWithInitialPrompt,
  resolveArchiveStatusId,
  type ProjectSettingsTemplateInput,
} from '../../helpers/profile-mapping.helpers';
import type { ImportContext } from '../import-context';
import type {
  CodecApplyResult,
  CodecApplyRuntime,
  ParsedTemplatePayload,
  PipelineMode,
  TemplateSectionCodec,
} from '../template-section-codec';

/** Export shape of the projectSettings section (moved here from project-export.ts). */
export type ProjectSettingsExport = {
  initialPromptTitle?: string;
  autoCleanStatusLabels?: string[];
  epicAssignedTemplate?: string;
  messagePoolSettings?: {
    enabled?: boolean;
    delayMs?: number;
    maxWaitMs?: number;
    maxMessages?: number;
    separator?: string;
  };
};

/** The codec owns both the projectSettings payload and the sibling initialPrompt field. */
interface ProjectSettingsSection {
  projectSettings: ParsedTemplatePayload['projectSettings'];
  initialPrompt: ParsedTemplatePayload['initialPrompt'];
  prompts: ParsedTemplatePayload['prompts'];
}

// --- Export build (moved from project-export.ts `buildProjectSettings`). -------------
export function buildProjectSettings(input: {
  initialPromptTitle?: string | null;
  autoCleanStatusIds?: readonly string[];
  statuses: ReadonlyArray<{ id: string; label: string }>;
  epicAssignedTemplate?: string | null;
  poolSettings?: ProjectSettingsExport['messagePoolSettings'];
}): ProjectSettingsExport {
  const projectSettings: ProjectSettingsExport = {};

  if (input.initialPromptTitle) {
    projectSettings.initialPromptTitle = input.initialPromptTitle;
  }

  const autoCleanStatusIds = input.autoCleanStatusIds ?? [];
  if (autoCleanStatusIds.length > 0) {
    const statusMap = new Map(input.statuses.map((status) => [status.id, status.label]));
    const autoCleanLabels = autoCleanStatusIds
      .map((statusId) => statusMap.get(statusId))
      .filter((label): label is string => Boolean(label));
    if (autoCleanLabels.length > 0) {
      projectSettings.autoCleanStatusLabels = autoCleanLabels;
    }
  }

  if (input.epicAssignedTemplate) {
    projectSettings.epicAssignedTemplate = input.epicAssignedTemplate;
  }

  const poolSettings = input.poolSettings;
  if (poolSettings && Object.keys(poolSettings).length > 0) {
    projectSettings.messagePoolSettings = poolSettings;
  }

  return projectSettings;
}

class ProjectSettingsCodec implements TemplateSectionCodec<ProjectSettingsSection> {
  readonly declaration = {
    section: 'projectSettings',
    reads: ['createdPrompts', 'promptIdMap', 'templateLabelToStatusId'],
    writes: [],
    modes: ['replace', 'create'],
  } as const;

  pick(payload: ParsedTemplatePayload): ProjectSettingsSection {
    return {
      projectSettings: payload.projectSettings,
      initialPrompt: payload.initialPrompt,
      prompts: payload.prompts,
    };
  }

  build() {
    // Export build is invoked directly by project-export via `buildProjectSettings`.
    return [];
  }

  async apply(
    section: ProjectSettingsSection,
    ctx: ImportContext,
    _mode: PipelineMode,
    rt: CodecApplyRuntime,
  ): Promise<CodecApplyResult> {
    if (!rt.settings) {
      return { section: 'projectSettings', log: { skipped: 'no settings service' } };
    }

    const createdPrompts = ctx.get('createdPrompts');
    const promptIdMap = ctx.get('promptIdMap');
    const templateLabelToStatusId = ctx.get('templateLabelToStatusId');

    const mergedSettings = mergeProjectSettingsWithInitialPrompt(
      section.prompts,
      section.initialPrompt,
      section.projectSettings as ProjectSettingsTemplateInput | undefined,
    );
    const promptTitleToId = buildPromptTitleToIdMap(createdPrompts, promptIdMap);
    const initialPromptId = section.initialPrompt?.promptId
      ? promptIdMap[section.initialPrompt.promptId]
      : undefined;
    const archiveStatusId = resolveArchiveStatusId(templateLabelToStatusId);

    const settingsResult = await applyProjectSettingsWithHelper(
      rt.projectId,
      mergedSettings,
      {
        promptTitleToId,
        statusLabelToId: templateLabelToStatusId,
        ...(initialPromptId ? { initialPromptId } : {}),
      },
      archiveStatusId,
      rt.settings,
    );

    return {
      section: 'projectSettings',
      log: { initialPromptSet: settingsResult.initialPromptSet },
    };
  }
}

export const projectSettingsCodec = new ProjectSettingsCodec();
