import { Module } from '@nestjs/common';
import { ReviewsController } from './controllers/reviews.controller';
import { ReviewsService } from './services/reviews.service';
import { StorageModule } from '../storage/storage.module';
import { EventsModule } from '../events/events.module';
import { GitModule } from '../git/git.module';

@Module({
  imports: [StorageModule, EventsModule, GitModule],
  controllers: [ReviewsController],
  providers: [ReviewsService],
  exports: [ReviewsService],
})
export class ReviewsModule {}
