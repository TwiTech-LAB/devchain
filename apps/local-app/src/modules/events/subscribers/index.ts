import type { Provider } from '@nestjs/common';
import { EpicAssignmentNotifierSubscriber } from './epic-assignment-notifier.subscriber';
import { ChatMessageBroadcasterSubscriber } from './chat-message-broadcaster.subscriber';
import { ChatMessageDeliverySubscriber } from './chat-message-delivery.subscriber';

export const subscribers: Provider[] = [
  EpicAssignmentNotifierSubscriber,
  ChatMessageBroadcasterSubscriber,
  ChatMessageDeliverySubscriber,
];
