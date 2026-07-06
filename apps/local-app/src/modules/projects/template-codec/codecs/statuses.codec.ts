/**
 * Statuses codec — owns the `statuses` template section (export build + import apply).
 *
 * Replace-mode apply preserves the legacy semantics EXACTLY (was
 * `recreateStatuses` + `applyStatusMappings` in project-import.ts):
 *  - merge existing statuses BY LABEL (statuses are updated, never dropped, so epic
 *    references survive),
 *  - offset existing positions by a large temp value first to avoid unique-position
 *    collisions while re-inserting,
 *  - then apply `statusMappings`: remap epics off orphaned statuses and delete them.
 *
 * Writes `statusIdMap` and `templateLabelToStatusId` into the ImportContext for
 * downstream codecs (initial-prompt resolution, scheduled epics, etc.).
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

const logger = createLogger('StatusesCodec');
const TEMP_POSITION_OFFSET = 100000;

type StatusesSection = ParsedTemplatePayload['statuses'];

/** Export builder (moved verbatim from project-export.ts `buildExportStatuses`). */
export function buildExportStatuses(statusesRes: ExportBuildContext['statusesRes']) {
  return statusesRes.items.map((status) => ({
    id: status.id,
    label: status.label,
    color: status.color,
    position: status.position,
    mcpHidden: status.mcpHidden,
  }));
}

class StatusesCodec implements TemplateSectionCodec<StatusesSection> {
  readonly declaration = {
    section: 'statuses',
    reads: [],
    writes: ['statusIdMap', 'templateLabelToStatusId'],
    requiresState: ['existingDataCleared'],
    producesState: ['statusesPersisted'],
    modes: ['replace', 'create'],
  } as const;

  pick(payload: ParsedTemplatePayload): StatusesSection {
    return payload.statuses;
  }

  build(ctx: ExportBuildContext) {
    return buildExportStatuses(ctx.statusesRes);
  }

  async apply(
    templateStatuses: StatusesSection,
    ctx: ImportContext,
    _mode: PipelineMode,
    rt: CodecApplyRuntime,
  ): Promise<CodecApplyResult> {
    const { projectId, storage } = rt;
    const existingStatuses = rt.existingStatuses ?? [];

    const statusIdMap: Record<string, string> = {};
    const existingStatusByLabel = new Map<string, (typeof existingStatuses)[number]>();
    for (const status of existingStatuses) {
      existingStatusByLabel.set(status.label.trim().toLowerCase(), status);
    }

    for (const status of existingStatuses) {
      await storage.updateStatus(status.id, {
        position: status.position + TEMP_POSITION_OFFSET,
      });
    }

    for (const status of [...templateStatuses].sort((a, b) => a.position - b.position)) {
      const labelKey = status.label.trim().toLowerCase();
      const existing = existingStatusByLabel.get(labelKey);

      if (existing) {
        const updated = await storage.updateStatus(existing.id, {
          color: status.color,
          position: status.position,
          mcpHidden: status.mcpHidden,
        });
        if (status.id) statusIdMap[status.id] = updated.id;
        existingStatusByLabel.delete(labelKey);
        continue;
      }

      const created = await storage.createStatus({
        projectId,
        label: status.label,
        color: status.color,
        position: status.position,
        mcpHidden: status.mcpHidden,
      });
      if (status.id) statusIdMap[status.id] = created.id;
    }

    const templateLabelToStatusId = new Map<string, string>();
    const allStatuses = await storage.listStatuses(projectId, { limit: 10000, offset: 0 });
    for (const status of allStatuses.items) {
      templateLabelToStatusId.set(status.label.trim().toLowerCase(), status.id);
    }

    ctx.set('statusIdMap', statusIdMap);
    ctx.set('templateLabelToStatusId', templateLabelToStatusId);

    const mappingResult = await this.applyStatusMappings(
      rt.statusMappings,
      templateLabelToStatusId,
      storage,
    );

    return { section: 'statuses', log: mappingResult };
  }

  /** statusMappings remap + orphan delete (was `applyStatusMappings`). */
  private async applyStatusMappings(
    statusMappings: CodecApplyRuntime['statusMappings'],
    templateLabelToStatusId: Map<string, string>,
    storage: CodecApplyRuntime['storage'],
  ): Promise<Record<string, number>> {
    if (!statusMappings || Object.keys(statusMappings).length === 0) {
      return { epicsMapped: 0, statusesDeleted: 0 };
    }

    let epicsMapped = 0;
    let statusesDeleted = 0;

    for (const [oldStatusId, targetLabel] of Object.entries(statusMappings)) {
      const targetStatusId = templateLabelToStatusId.get(targetLabel.trim().toLowerCase());
      if (!targetStatusId) continue;

      const remapped = await storage.updateEpicsStatus(oldStatusId, targetStatusId);
      epicsMapped += remapped;
      await storage.deleteStatus(oldStatusId);
      statusesDeleted++;
    }

    logger.info(
      { epicsMapped, statusesDeleted },
      'Applied status mappings: epics remapped and old statuses deleted',
    );
    return { epicsMapped, statusesDeleted };
  }
}

export const statusesCodec = new StatusesCodec();
