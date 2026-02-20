import { Module } from '@nestjs/common';
import { ReviewsController } from './controllers/reviews.controller';
import { ReviewsService } from './services/reviews.service';
import { StorageModule } from '../storage/storage.module';
import { EventsDomainModule } from '../events/events-domain.module';
import { GitModule } from '../git/git.module';

@Module({
  imports: [StorageModule, EventsDomainModule, GitModule],
  controllers: [ReviewsController],
  providers: [ReviewsService],
  exports: [ReviewsService],
})
export class ReviewsModule {}
