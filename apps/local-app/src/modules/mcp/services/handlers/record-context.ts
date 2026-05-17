import type { RecordStorage } from '../../../storage/interfaces/storage.interface';

export type RecordToolStorage = RecordStorage;

export interface RecordToolContext {
  storage: RecordToolStorage;
}
