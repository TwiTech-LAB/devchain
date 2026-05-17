import type { ToolBindingEntry } from './types';
import {
  handleListEpics,
  handleListAssignedEpicsTasks,
  handleCreateEpic,
  handleGetEpicById,
  handleAddEpicComment,
  handleUpdateEpic,
  handleDeleteEpic,
} from '../services/handlers/epic-tools';

export const epicBindings: ToolBindingEntry[] = [
  ['devchain_list_epics', handleListEpics as unknown as ToolBindingEntry[1]],
  [
    'devchain_list_assigned_epics_tasks',
    handleListAssignedEpicsTasks as unknown as ToolBindingEntry[1],
  ],
  ['devchain_create_epic', handleCreateEpic as unknown as ToolBindingEntry[1]],
  ['devchain_get_epic_by_id', handleGetEpicById as unknown as ToolBindingEntry[1]],
  ['devchain_add_epic_comment', handleAddEpicComment as unknown as ToolBindingEntry[1]],
  ['devchain_update_epic', handleUpdateEpic as unknown as ToolBindingEntry[1]],
  ['devchain_delete_epic', handleDeleteEpic as unknown as ToolBindingEntry[1]],
];
