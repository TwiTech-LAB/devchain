import type { ToolBindingEntry } from './types';
import {
  handleCreateRecord,
  handleUpdateRecord,
  handleGetRecord,
  handleListRecords,
  handleAddTags,
  handleRemoveTags,
} from '../services/handlers/record-tools';

export const recordBindings: ToolBindingEntry[] = [
  ['devchain_create_record', handleCreateRecord as unknown as ToolBindingEntry[1]],
  ['devchain_update_record', handleUpdateRecord as unknown as ToolBindingEntry[1]],
  ['devchain_get_record', handleGetRecord as unknown as ToolBindingEntry[1]],
  ['devchain_list_records', handleListRecords as unknown as ToolBindingEntry[1]],
  ['devchain_add_tags', handleAddTags as unknown as ToolBindingEntry[1]],
  ['devchain_remove_tags', handleRemoveTags as unknown as ToolBindingEntry[1]],
];
