import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { EventsDomainModule } from '../events/events-domain.module';
import { TeamsController } from './controllers/teams.controller';
import { TeamsService } from './services/teams.service';
import { TeamsStore } from './storage/teams.store';

@Module({
  imports: [StorageModule, EventsDomainModule],
  controllers: [TeamsController],
  providers: [TeamsService, TeamsStore],
  exports: [TeamsService],
})
export class TeamsModule {}
