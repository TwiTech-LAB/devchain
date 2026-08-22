/**
 * Server-issued lookup tokens for ClickUp task comments. ClickUp has no
 * exact-comment read, so every comment-bearing surface (comment pages,
 * delete/edit session creation) carries a token binding the connection
 * identity, task, comment, and the provider page cursor that produced the
 * comment. Deletion and edit lookups replay at most that page plus one
 * provider-issued adjacent page.
 */
import type { IntegrationProvider } from '../../storage/models/domain.models';

const LOOKUP_TOKEN_PREFIX = 'v1';

export interface ExternalCommentLookupTokenPayload {
  v: 1;
  provider: IntegrationProvider;
  connectionId: string;
  connectionGeneration: number;
  taskId: string;
  commentId: string;
  pageProof: string | null;
}

export function encodeExternalCommentLookupToken(
  payload: ExternalCommentLookupTokenPayload,
): string {
  return `${LOOKUP_TOKEN_PREFIX}:${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
}

export function decodeExternalCommentLookupToken(
  value: unknown,
): ExternalCommentLookupTokenPayload | null {
  if (typeof value !== 'string' || !value.startsWith(`${LOOKUP_TOKEN_PREFIX}:`)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.from(value.slice(LOOKUP_TOKEN_PREFIX.length + 1), 'base64url').toString('utf8'),
    );
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const provider = record.provider;
  const connectionId = record.connectionId;
  const connectionGeneration = record.connectionGeneration;
  const taskId = record.taskId;
  const commentId = record.commentId;
  const pageProof = record.pageProof ?? null;
  if (
    typeof provider !== 'string' ||
    !['clickup', 'jira'].includes(provider) ||
    typeof connectionId !== 'string' ||
    typeof connectionGeneration !== 'number' ||
    typeof taskId !== 'string' ||
    typeof commentId !== 'string' ||
    (pageProof !== null && typeof pageProof !== 'string')
  ) {
    return null;
  }
  return {
    v: 1,
    provider: provider as IntegrationProvider,
    connectionId,
    connectionGeneration,
    taskId,
    commentId,
    pageProof,
  };
}
