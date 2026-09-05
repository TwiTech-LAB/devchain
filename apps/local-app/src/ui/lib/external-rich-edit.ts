import type { ExternalRichDocumentV1 } from '@/modules/external-integrations/models/external-rich-document';
import type {
  ExternalCommentDeleteOutcome,
  ExternalEditSessionView,
  ExternalSessionReloadResult,
  ExternalSessionVerifyResult,
  ExternalSessionWriteOutcome,
} from '@/modules/external-integrations/models/external-edit-session.models';
import type { FetchFn } from '@/ui/lib/sessions';
import { fetchJsonOrThrow } from '@/ui/lib/sessions';
import { withIntegrationProjectId } from '@/ui/lib/integration-project-scope';

/**
 * Browser client for the gated rich content actions. URLs mirror the
 * controller exactly; every response shape is the closed backend contract.
 */

export interface ExternalRichDescriptionRead {
  document: ExternalRichDocumentV1 | null;
  fingerprint: string | null;
  supported: boolean;
  readOnlyReason: string | null;
  canEdit: boolean;
  canDeleteOwnedComments: boolean;
}

const SESSION_BASE = '/api/integrations/my-work/edit-sessions';

export function readRichDescription(
  fetchFn: FetchFn,
  projectId: string,
  provider: string,
  taskId: string,
  signal?: AbortSignal,
): Promise<ExternalRichDescriptionRead> {
  return fetchJsonOrThrow<ExternalRichDescriptionRead>(
    withIntegrationProjectId(
      `/api/integrations/my-work/${provider}/tasks/${encodeURIComponent(taskId)}/rich-description`,
      projectId,
    ),
    { signal },
    'The description could not be loaded.',
    '',
    fetchFn,
  );
}

export function createDescriptionSession(
  fetchFn: FetchFn,
  projectId: string,
  provider: string,
  taskId: string,
): Promise<ExternalEditSessionView> {
  return fetchJsonOrThrow<ExternalEditSessionView>(
    withIntegrationProjectId(
      `/api/integrations/my-work/${provider}/tasks/${encodeURIComponent(taskId)}/edit-sessions`,
      projectId,
    ),
    { method: 'POST' },
    'The editing session could not be opened.',
    '',
    fetchFn,
  );
}

export function touchSession(
  fetchFn: FetchFn,
  projectId: string,
  sessionId: string,
): Promise<ExternalEditSessionView> {
  return fetchJsonOrThrow<ExternalEditSessionView>(
    withIntegrationProjectId(`${SESSION_BASE}/${encodeURIComponent(sessionId)}/touch`, projectId),
    { method: 'POST' },
    'The editing session could not be refreshed.',
    '',
    fetchFn,
  );
}

export function saveSession(
  fetchFn: FetchFn,
  projectId: string,
  sessionId: string,
  document: ExternalRichDocumentV1,
  revision: number,
): Promise<ExternalSessionWriteOutcome> {
  return fetchJsonOrThrow<ExternalSessionWriteOutcome>(
    withIntegrationProjectId(`${SESSION_BASE}/${encodeURIComponent(sessionId)}/save`, projectId),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ document, revision }),
    },
    'The description could not be saved.',
    '',
    fetchFn,
  );
}

export function verifySession(
  fetchFn: FetchFn,
  projectId: string,
  sessionId: string,
): Promise<ExternalSessionVerifyResult> {
  return fetchJsonOrThrow<ExternalSessionVerifyResult>(
    withIntegrationProjectId(`${SESSION_BASE}/${encodeURIComponent(sessionId)}/verify`, projectId),
    { method: 'POST' },
    'The remote content could not be verified.',
    '',
    fetchFn,
  );
}

export function reloadSession(
  fetchFn: FetchFn,
  projectId: string,
  sessionId: string,
): Promise<ExternalSessionReloadResult> {
  return fetchJsonOrThrow<ExternalSessionReloadResult>(
    withIntegrationProjectId(`${SESSION_BASE}/${encodeURIComponent(sessionId)}/reload`, projectId),
    { method: 'POST' },
    'The remote content could not be reloaded.',
    '',
    fetchFn,
  );
}

export function createCommentEditSession(
  fetchFn: FetchFn,
  projectId: string,
  provider: string,
  taskId: string,
  commentId: string,
  lookupToken: string | null,
): Promise<ExternalEditSessionView> {
  return fetchJsonOrThrow<ExternalEditSessionView>(
    withIntegrationProjectId(
      `/api/integrations/my-work/${provider}/tasks/${encodeURIComponent(taskId)}/comments/${encodeURIComponent(commentId)}/edit-sessions`,
      projectId,
    ),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...(lookupToken !== null ? { lookupToken } : {}) }),
    },
    'The comment editing session could not be opened.',
    '',
    fetchFn,
  );
}

export function createCommentDeleteSession(
  fetchFn: FetchFn,
  projectId: string,
  provider: string,
  taskId: string,
  commentId: string,
  lookupToken: string | null,
): Promise<ExternalEditSessionView> {
  return fetchJsonOrThrow<ExternalEditSessionView>(
    withIntegrationProjectId(
      `/api/integrations/my-work/${provider}/tasks/${encodeURIComponent(taskId)}/comments/${encodeURIComponent(commentId)}/delete-sessions`,
      projectId,
    ),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...(lookupToken !== null ? { pageProof: lookupToken } : {}) }),
    },
    'The comment deletion session could not be opened.',
    '',
    fetchFn,
  );
}

export function executeCommentDelete(
  fetchFn: FetchFn,
  projectId: string,
  sessionId: string,
): Promise<ExternalCommentDeleteOutcome> {
  return fetchJsonOrThrow<ExternalCommentDeleteOutcome>(
    withIntegrationProjectId(`${SESSION_BASE}/${encodeURIComponent(sessionId)}`, projectId),
    { method: 'DELETE' },
    'The comment could not be deleted.',
    '',
    fetchFn,
  );
}
