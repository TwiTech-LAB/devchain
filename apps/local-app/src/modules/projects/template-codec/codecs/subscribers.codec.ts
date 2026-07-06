/**
 * Subscribers codec — owns the `subscribers` section (export build + import apply).
 *
 * Apply delegates to the legacy `createSubscribersFromPayloadWithHelper` (behavior-preserving).
 * Subscribers carry no name/id references to other entities, so they need no ImportContext
 * maps — just the target project + storage.
 */
import { createSubscribersFromPayloadWithHelper } from '../../helpers/project-runtime.helpers';
import type { SubscriberTemplateInput } from '../../helpers/project-runtime.helpers';
import type { ImportContext } from '../import-context';
import type {
  CodecApplyResult,
  CodecApplyRuntime,
  ParsedTemplatePayload,
  PipelineMode,
  TemplateSectionCodec,
} from '../template-section-codec';

type SubscribersSection = ParsedTemplatePayload['subscribers'];

// --- Export build (moved from project-export.ts `buildExportSubscribers`). ------------
interface ExportSubscriberRow {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  eventName: string;
  eventFilter: {
    field: string;
    operator: 'equals' | 'contains' | 'regex';
    value: string;
  } | null;
  actionType: string;
  actionInputs: Record<
    string,
    { source: 'event_field' | 'custom'; eventField?: string; customValue?: string }
  >;
  delayMs: number;
  cooldownMs: number;
  retryOnError: boolean;
  groupName: string | null;
  position: number;
  priority: number;
}

export function buildExportSubscribers(subscribers: ReadonlyArray<ExportSubscriberRow>) {
  return subscribers.map((subscriber) => ({
    id: subscriber.id,
    name: subscriber.name,
    description: subscriber.description,
    enabled: subscriber.enabled,
    eventName: subscriber.eventName,
    eventFilter: subscriber.eventFilter,
    actionType: subscriber.actionType,
    actionInputs: subscriber.actionInputs,
    delayMs: subscriber.delayMs,
    cooldownMs: subscriber.cooldownMs,
    retryOnError: subscriber.retryOnError,
    groupName: subscriber.groupName,
    position: subscriber.position,
    priority: subscriber.priority,
  }));
}

class SubscribersCodec implements TemplateSectionCodec<SubscribersSection> {
  readonly declaration = {
    section: 'subscribers',
    reads: [],
    writes: ['subscriberIdMap'],
    requiresState: ['existingDataCleared'],
    modes: ['replace', 'create'],
  } as const;

  pick(payload: ParsedTemplatePayload): SubscribersSection {
    return payload.subscribers;
  }

  build() {
    // Export build is invoked directly by project-export via `buildExportSubscribers`.
    return [];
  }

  async apply(
    subscribers: SubscribersSection,
    ctx: ImportContext,
    _mode: PipelineMode,
    rt: CodecApplyRuntime,
  ): Promise<CodecApplyResult> {
    const { created, subscriberIdMap } = await createSubscribersFromPayloadWithHelper(
      rt.projectId,
      subscribers as SubscriberTemplateInput[],
      rt.storage,
    );

    // Publish the id map so the import orchestrator can surface it in the response `mappings`.
    ctx.set('subscriberIdMap', subscriberIdMap);

    return { section: 'subscribers', log: { subscribers: created } };
  }
}

export const subscribersCodec = new SubscribersCodec();
