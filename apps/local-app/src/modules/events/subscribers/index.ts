import type { Provider } from '@nestjs/common';
import { EpicAssignmentNotifierSubscriber } from './epic-assignment-notifier.subscriber';
import { ChatMessageBroadcasterSubscriber } from './chat-message-broadcaster.subscriber';
import { ChatMessageDeliverySubscriber } from './chat-message-delivery.subscriber';
import { ReviewCommentNotifierSubscriber } from './review-comment-notifier.subscriber';
import { ReviewBroadcasterSubscriber } from './review-broadcaster.subscriber';
import { WorktreeBroadcasterSubscriber } from './worktree-broadcaster.subscriber';

export const subscribers: Provider[] = [
  EpicAssignmentNotifierSubscriber,
  ChatMessageBroadcasterSubscriber,
  ChatMessageDeliverySubscriber,
  ReviewCommentNotifierSubscriber,
  ReviewBroadcasterSubscriber,
  WorktreeBroadcasterSubscriber,
];
