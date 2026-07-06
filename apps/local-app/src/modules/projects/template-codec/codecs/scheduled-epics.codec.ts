/**
 * ScheduledEpics codec — owns the `scheduledEpics` section.
 *
 * Apply = the legacy `createImportedScheduledEpics`, moved verbatim except that its two
 * remap inputs now come from the ImportContext (`agentNameToId` from the agents codec,
 * `templateLabelToStatusId` from the statuses codec) instead of a hand-passed `maps`
 * argument. Those are exact equivalents — the orchestrator already passed
 * `mappingResults.agentNameToId` (built from the same agentIdMap) and
 * `templateLabelToStatusId` into the legacy call.
 *
 * Parent-epic title → id is resolved against LIVE storage (`listEpics`), because epics are
 * PRESERVED across a replace import (not cleared, not created by any codec) — hence the
 * declared `requiresState: ['epicsLoaded']` precondition. Fatal in both modes (matrix row 14).
 */
import { createLogger } from '../../../../common/logging/logger';
import type { StorageService } from '../../../storage/interfaces/storage.interface';
import type { ImportContext } from '../import-context';
import type {
  CodecApplyResult,
  CodecApplyRuntime,
  ParsedTemplatePayload,
  PipelineMode,
  TemplateSectionCodec,
} from '../template-section-codec';

const logger = createLogger('ScheduledEpicsCodec');

type ScheduledEpicsSection = ParsedTemplatePayload['scheduledEpics'];

/** Narrow export-state slice the export builder reads (statuses/agents name resolution). */
interface ScheduledEpicsExportState {
  statusesRes: { items: ReadonlyArray<{ id: string; label: string }> };
  agentsRes: { items: ReadonlyArray<{ id: string; name: string }> };
}

// --- Export build (moved from project-export.ts `buildExportScheduledEpics`). ---------
export async function buildExportScheduledEpics(
  projectId: string,
  state: ScheduledEpicsExportState,
  storage: StorageService,
) {
  const { items: schedules } = await storage.listScheduledEpics(projectId, { limit: 10000 });

  const statusMap = new Map(state.statusesRes.items.map((s) => [s.id, s.label]));
  const agentMap = new Map(state.agentsRes.items.map((a) => [a.id, a.name]));

  const epicTitleCache = new Map<string, string>();

  return Promise.all(
    schedules.map(async (schedule) => {
      let templateParentEpicTitle: string | null = null;
      if (schedule.templateParentEpicId) {
        if (epicTitleCache.has(schedule.templateParentEpicId)) {
          templateParentEpicTitle = epicTitleCache.get(schedule.templateParentEpicId)!;
        } else {
          try {
            const epic = await storage.getEpic(schedule.templateParentEpicId);
            templateParentEpicTitle = epic.title;
            epicTitleCache.set(schedule.templateParentEpicId, epic.title);
          } catch {
            templateParentEpicTitle = null;
          }
        }
      }

      return {
        name: schedule.name,
        cronExpression: schedule.cronExpression,
        timezone: schedule.timezone,
        enabled: schedule.enabled,
        titleTemplate: schedule.titleTemplate,
        descriptionTemplate: schedule.descriptionTemplate,
        templateStatusLabel: schedule.templateStatusId
          ? (statusMap.get(schedule.templateStatusId) ?? null)
          : null,
        templateParentEpicTitle,
        templateAgentName: schedule.templateAgentId
          ? (agentMap.get(schedule.templateAgentId) ?? null)
          : null,
        templateTags: schedule.templateTags,
        allowOverlap: schedule.allowOverlap,
        missedRunPolicy: schedule.missedRunPolicy,
      };
    }),
  );
}

class ScheduledEpicsCodec implements TemplateSectionCodec<ScheduledEpicsSection> {
  readonly declaration = {
    section: 'scheduledEpics',
    reads: ['agentNameToId', 'templateLabelToStatusId'],
    writes: [],
    requiresState: ['epicsLoaded'],
    modes: ['replace', 'create'],
  } as const;

  pick(payload: ParsedTemplatePayload): ScheduledEpicsSection {
    return payload.scheduledEpics;
  }

  build() {
    // Export build is invoked directly by project-export via `buildExportScheduledEpics`.
    return [];
  }

  async apply(
    scheduledEpics: ScheduledEpicsSection,
    _ctx: ImportContext,
    _mode: PipelineMode,
    rt: CodecApplyRuntime,
  ): Promise<CodecApplyResult> {
    const { projectId, storage } = rt;

    // Match the legacy gate: skip entirely (including the listEpics query) when there are
    // no schedules to import.
    if (!scheduledEpics || scheduledEpics.length === 0) {
      return { section: 'scheduledEpics', log: { scheduledEpics: 0 } };
    }

    const agentNameToId = _ctx.get('agentNameToId');
    const templateLabelToStatusId = _ctx.get('templateLabelToStatusId');

    let created = 0;

    // Build epic title→id map for resolving templateParentEpicTitle against preserved epics.
    const epicTitleToId = new Map<string, string>();
    const { items: existingEpics } = await storage.listEpics(projectId, {
      limit: 100000,
      offset: 0,
    });
    for (const epic of existingEpics) {
      epicTitleToId.set(epic.title.trim().toLowerCase(), epic.id);
    }

    for (const schedule of scheduledEpics) {
      const templateStatusId = schedule.templateStatusLabel
        ? (templateLabelToStatusId.get(schedule.templateStatusLabel.trim().toLowerCase()) ?? null)
        : null;

      const templateAgentId = schedule.templateAgentName
        ? (agentNameToId[schedule.templateAgentName.trim().toLowerCase()] ?? null)
        : null;

      const templateParentEpicId = schedule.templateParentEpicTitle
        ? (epicTitleToId.get(schedule.templateParentEpicTitle.trim().toLowerCase()) ?? null)
        : null;

      const nextRunAt = rt.computeNextRunAt
        ? rt.computeNextRunAt(schedule.cronExpression, schedule.timezone)
        : null;

      await storage.createScheduledEpic({
        projectId,
        name: schedule.name,
        cronExpression: schedule.cronExpression,
        timezone: schedule.timezone,
        enabled: schedule.enabled,
        titleTemplate: schedule.titleTemplate,
        descriptionTemplate: schedule.descriptionTemplate ?? null,
        templateStatusId,
        templateParentEpicId,
        templateAgentId,
        templateTags: schedule.templateTags,
        allowOverlap: schedule.allowOverlap,
        missedRunPolicy: schedule.missedRunPolicy,
        nextRunAt: nextRunAt?.toISOString() ?? null,
      });

      created++;
    }

    if (created > 0 && rt.scheduledEpicsRefresh) {
      rt.scheduledEpicsRefresh.refreshScheduleWindow();
    }

    logger.info({ projectId, created }, 'Scheduled epics imported');
    return { section: 'scheduledEpics', log: { scheduledEpics: created } };
  }
}

export const scheduledEpicsCodec = new ScheduledEpicsCodec();
