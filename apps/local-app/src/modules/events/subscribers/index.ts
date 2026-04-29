import type { Provider } from '@nestjs/common';
import { EpicAssignmentNotifierSubscriber } from './epic-assignment-notifier.subscriber';
import { ChatMessageBroadcasterSubscriber } from './chat-message-broadcaster.subscriber';
import { ChatMessageDeliverySubscriber } from './chat-message-delivery.subscriber';
import { ReviewCommentNotifierSubscriber } from './review-comment-notifier.subscriber';
import { ReviewBroadcasterSubscriber } from './review-broadcaster.subscriber';
import { WorktreeBroadcasterSubscriber } from './worktree-broadcaster.subscriber';
import { TranscriptBroadcasterSubscriber } from './transcript-broadcaster.subscriber';
import { SubEpicCreatedNotifierSubscriber } from './sub-epic-created-notifier.subscriber';
import { TeamConfigUpdatedNotifierSubscriber } from './team-config-updated-notifier.subscriber';
import { TeamMembershipChangedNotifierSubscriber } from './team-membership-changed-notifier.subscriber';
import { ProjectStateBroadcasterSubscriber } from './project-state-broadcaster.subscriber';

export const subscribers: Provider[] = [
  EpicAssignmentNotifierSubscriber,
  SubEpicCreatedNotifierSubscriber,
  TeamConfigUpdatedNotifierSubscriber,
  TeamMembershipChangedNotifierSubscriber,
  ChatMessageBroadcasterSubscriber,
  ChatMessageDeliverySubscriber,
  ReviewCommentNotifierSubscriber,
  ReviewBroadcasterSubscriber,
  WorktreeBroadcasterSubscriber,
  TranscriptBroadcasterSubscriber,
  ProjectStateBroadcasterSubscriber,
];
