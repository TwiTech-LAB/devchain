import { ExternalTasksGetParamsSchema } from '../dtos/mcp.dto';
import type { ToolMetadataEntry } from './types';

export const externalTaskMetadata: ToolMetadataEntry[] = [
  {
    name: 'devchain_external_tasks_get',
    description:
      "Read a ClickUp or Jira task through the project's integration: key, id, title, description (bounded, with descriptionTruncated), status, webUrl, location, subtasks (bounded, with subtasksTruncated) and linkedEpicId (the epic in this project already linked to the task, or null). Prefer pasting the task URL; a bare id or key works only when the project has one connected integration or provider is set. Link an epic with devchain_create_epic or devchain_update_epic (externalTask).",
    inputSchema: {
      type: 'object',
      required: ['sessionId', 'ref'],
      properties: {
        sessionId: {
          type: 'string',
          minLength: 8,
          description: 'Session ID (full UUID or 8+ char prefix)',
        },
        ref: {
          type: 'string',
          minLength: 1,
          maxLength: 2048,
          description:
            'Task URL (preferred), e.g. https://app.clickup.com/t/<id> or https://<site>.atlassian.net/browse/<KEY>; or the task id or key',
        },
        provider: {
          type: 'string',
          enum: ['clickup', 'jira'],
          description:
            'Optional provider; needed for a bare id when both ClickUp and Jira are connected',
        },
      },
      additionalProperties: false,
    },
    paramsSchema: ExternalTasksGetParamsSchema,
  },
];
