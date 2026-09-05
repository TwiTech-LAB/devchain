import type { EpicsService } from '../../epics/services/epics.service';
import type { EpicRelationsService } from '../../epics/services/epic-relations.service';
import type { EpicToolContext } from '../services/handlers/epic-context';
import {
  handleListEpics,
  handleListAssignedEpicsTasks,
  handleCreateEpic,
  handleGetEpicById,
  handleListEpicRelations,
  handleListEpicRelationCandidates,
  handleSetEpicRelation,
  handleDeleteEpicRelation,
  handleAddEpicComment,
  handleUpdateEpic,
  handleDeleteEpic,
} from '../services/handlers/epic-tools';
import { createNullAdapter } from '../services/handlers/null-adapter';
import { defineToolGroup, type McpBindingRuntime } from './binding-types';

function createEpicContext(runtime: McpBindingRuntime): EpicToolContext {
  return {
    storage: runtime.storage,
    epicsService: runtime.epicsService ?? createNullAdapter<EpicsService>('EpicsService'),
    epicRelationsService:
      runtime.epicRelationsService ??
      createNullAdapter<EpicRelationsService>('EpicRelationsService'),
    resolveSessionContext: runtime.resolveSessionContext,
  };
}

export const epicBindings = defineToolGroup<EpicToolContext>(createEpicContext, [
  ['devchain_list_epics', handleListEpics],
  ['devchain_list_assigned_epics_tasks', handleListAssignedEpicsTasks],
  ['devchain_create_epic', handleCreateEpic],
  ['devchain_get_epic_by_id', handleGetEpicById],
  ['devchain_epic_relations_list', handleListEpicRelations],
  ['devchain_epic_relations_list_candidates', handleListEpicRelationCandidates],
  ['devchain_epic_relations_set', handleSetEpicRelation],
  ['devchain_epic_relations_delete', handleDeleteEpicRelation],
  ['devchain_add_epic_comment', handleAddEpicComment],
  ['devchain_update_epic', handleUpdateEpic],
  ['devchain_delete_epic', handleDeleteEpic],
]);
