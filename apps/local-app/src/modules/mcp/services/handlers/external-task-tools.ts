import type {
  ExternalTaskGetResponse,
  ExternalTasksGetParams,
  McpResponse,
} from '../../dtos/mcp.dto';
import { requireProject } from '../utils/require-project';
import { resolveSessionContext } from '../utils/session-context-helpers';
import type { ExternalTaskToolContext } from './external-task-context';
import { readExternalTaskForSession } from './external-task-resolution';

export async function handleExternalTasksGet(
  ctx: ExternalTaskToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = params as ExternalTasksGetParams;
  const required = requireProject(await resolveSessionContext(ctx, validated.sessionId));
  if (!('project' in required)) return required;

  const read = await readExternalTaskForSession(ctx, required.sessionContext, required.project.id, {
    ref: validated.ref,
    provider: validated.provider,
  });
  if ('response' in read) return read.response;

  const { provider, detail, linkedEpicId } = read.resolved;
  const data: ExternalTaskGetResponse = {
    provider,
    remoteKey: detail.remoteKey,
    remoteId: detail.remoteId,
    title: detail.title,
    description: detail.description,
    descriptionTruncated: detail.descriptionTruncated,
    status: { name: detail.status.name, category: detail.status.category },
    webUrl: read.resolved.link.sourceSnapshot.webUrl,
    location: { ...detail.location },
    subtasks: detail.subtasks.map((subtask) => ({
      remoteId: subtask.remoteId,
      remoteKey: subtask.remoteKey,
      title: subtask.title,
      status: { name: subtask.status.name, category: subtask.status.category },
      webUrl: subtask.webUrl,
    })),
    subtasksTruncated: detail.subtasksTruncated,
    linkedEpicId,
  };
  return { success: true, data };
}
