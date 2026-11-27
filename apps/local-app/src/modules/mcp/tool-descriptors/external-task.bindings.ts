import type { ExternalTaskReferenceResolver } from '../../external-integrations/resolution/external-task-reference.resolver';
import type { ExternalTaskToolContext } from '../services/handlers/external-task-context';
import type { ExternalTaskReadDeps } from '../services/handlers/external-task-resolution';
import { handleExternalTasksGet } from '../services/handlers/external-task-tools';
import { createNullAdapter } from '../services/handlers/null-adapter';
import { defineToolGroup, type McpBindingRuntime } from './binding-types';

export function createExternalTaskReadDeps(runtime: McpBindingRuntime): ExternalTaskReadDeps {
  return {
    externalTaskResolver:
      runtime.externalTaskResolver ??
      createNullAdapter<ExternalTaskReferenceResolver>('ExternalTaskReferenceResolver'),
    // Without the full app there is no resolver; its null adapter answers SERVICE_UNAVAILABLE.
    admitExternalTasks: runtime.externalTaskAdmission ?? (() => true),
  };
}

function createExternalTaskContext(runtime: McpBindingRuntime): ExternalTaskToolContext {
  return {
    ...createExternalTaskReadDeps(runtime),
    resolveSessionContext: runtime.resolveSessionContext,
  };
}

export const externalTaskBindings = defineToolGroup<ExternalTaskToolContext>(
  createExternalTaskContext,
  [['devchain_external_tasks_get', handleExternalTasksGet]],
);
