import { Injectable } from '@nestjs/common';
import { OnCatalogEvent } from '../../events/catalog/on-catalog-event';
import type { ClaudeHooksAskUserQuestionPendingEventPayload } from '../../events/catalog/claude.hooks.ask_user_question.pending';
import { NativePushGate } from './native-push-gate';

/**
 * Native push for a pending AskUserQuestion, through the dual-channel gate of
 * {@link NativePushGate}. The mobile renders the card from `listPendingAskQuestions`
 * keyed by `toolUseId`; the push carries identifiers only — never question content.
 */
@Injectable()
export class AskUserQuestionPushGateService extends NativePushGate {
  @OnCatalogEvent('claude.hooks.ask_user_question.pending', { async: true })
  onPending(payload: ClaudeHooksAskUserQuestionPendingEventPayload): void {
    this.schedule({
      projectId: payload.projectId,
      sourceEventId: `auq.pending:${payload.toolUseId}`,
      logContext: { toolUseId: payload.toolUseId },
      push: (sourceEventId, userId, instanceId) =>
        this.eventMapper.mapToIngestPayload(
          { name: 'claude.hooks.ask_user_question.pending', payload },
          sourceEventId,
          userId,
          { instanceId },
        ),
      genericNotice: (sourceEventId, userId) =>
        this.eventMapper.mapToGenericAskUserQuestionNotice(sourceEventId, userId),
    });
  }
}
