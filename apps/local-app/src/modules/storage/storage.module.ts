import { Inject, Module } from '@nestjs/common';
import { DbModule } from './db/db.module';
import { LocalStorageService } from './local/local-storage.service';
import {
  STORAGE_SERVICE,
  type ProjectHostStorage,
  type RemoteStorage,
} from './interfaces/storage.interface';
import { SNAPSHOT_PROMPT_WRITER } from './interfaces/snapshot-prompt-writer.interface';
import { EventsInfraModule } from '../events/events-infra.module';
import { ProjectWriteGate } from './write-gate/project-write-gate';

@Module({
  imports: [DbModule, EventsInfraModule],
  providers: [
    ProjectWriteGate,
    LocalStorageService,
    {
      provide: STORAGE_SERVICE,
      useExisting: LocalStorageService,
    },
    {
      provide: SNAPSHOT_PROMPT_WRITER,
      useExisting: LocalStorageService,
    },
  ],
  exports: [STORAGE_SERVICE, SNAPSHOT_PROMPT_WRITER, ProjectWriteGate],
})
export class StorageModule {
  constructor(
    @Inject(STORAGE_SERVICE) storage: RemoteStorage & ProjectHostStorage,
    gate: ProjectWriteGate,
  ) {
    gate.bindStorage(storage);
  }
}
