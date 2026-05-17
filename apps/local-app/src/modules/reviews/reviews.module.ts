import { Module } from '@nestjs/common';
import { ReviewsController } from './controllers/reviews.controller';
import { ReviewsService } from './services/reviews.service';
import { ReviewSuggestionApplier } from './services/review-suggestion-applier.service';
import { ReviewCommentNotifierSubscriber } from './subscribers/review-comment-notifier.subscriber';
import { StorageModule } from '../storage/storage.module';
import { EventsCoreModule } from '../events/events-core.module';
import { GitModule } from '../git/git.module';
import { AgentMessageDeliveryModule } from '../agent-message-delivery/agent-message-delivery.module';
import { TeamsModule } from '../teams/teams.module';

@Module({
  imports: [StorageModule, EventsCoreModule, GitModule, AgentMessageDeliveryModule, TeamsModule],
  controllers: [ReviewsController],
  providers: [ReviewsService, ReviewSuggestionApplier, ReviewCommentNotifierSubscriber],
  exports: [ReviewsService, ReviewSuggestionApplier],
})
export class ReviewsModule {}
