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
  provider: string,
  taskId: string,
  signal?: AbortSignal,
): Promise<ExternalRichDescriptionRead> {
  return fetchJsonOrThrow<ExternalRichDescriptionRead>(
    `/api/integrations/my-work/${provider}/tasks/${encodeURIComponent(taskId)}/rich-description`,
    { signal },
    'The description could not be loaded.',
    '',
    fetchFn,
  );
}

export function createDescriptionSession(
  fetchFn: FetchFn,
  provider: string,
  taskId: string,
): Promise<ExternalEditSessionView> {
  return fetchJsonOrThrow<ExternalEditSessionView>(
    `/api/integrations/my-work/${provider}/tasks/${encodeURIComponent(taskId)}/edit-sessions`,
    { method: 'POST' },
    'The editing session could not be opened.',
    '',
    fetchFn,
  );
}

export function touchSession(
  fetchFn: FetchFn,
  sessionId: string,
): Promise<ExternalEditSessionView> {
  return fetchJsonOrThrow<ExternalEditSessionView>(
    `${SESSION_BASE}/${encodeURIComponent(sessionId)}/touch`,
    { method: 'POST' },
    'The editing session could not be refreshed.',
    '',
    fetchFn,
  );
}

export function saveSession(
  fetchFn: FetchFn,
  sessionId: string,
  document: ExternalRichDocumentV1,
  revision: number,
): Promise<ExternalSessionWriteOutcome> {
  return fetchJsonOrThrow<ExternalSessionWriteOutcome>(
    `${SESSION_BASE}/${encodeURIComponent(sessionId)}/save`,
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
  sessionId: string,
): Promise<ExternalSessionVerifyResult> {
  return fetchJsonOrThrow<ExternalSessionVerifyResult>(
    `${SESSION_BASE}/${encodeURIComponent(sessionId)}/verify`,
    { method: 'POST' },
    'The remote content could not be verified.',
    '',
    fetchFn,
  );
}

export function reloadSession(
  fetchFn: FetchFn,
  sessionId: string,
): Promise<ExternalSessionReloadResult> {
  return fetchJsonOrThrow<ExternalSessionReloadResult>(
    `${SESSION_BASE}/${encodeURIComponent(sessionId)}/reload`,
    { method: 'POST' },
    'The remote content could not be reloaded.',
    '',
    fetchFn,
  );
}

export function createCommentEditSession(
  fetchFn: FetchFn,
  provider: string,
  taskId: string,
  commentId: string,
  lookupToken: string | null,
): Promise<ExternalEditSessionView> {
  return fetchJsonOrThrow<ExternalEditSessionView>(
    `/api/integrations/my-work/${provider}/tasks/${encodeURIComponent(taskId)}/comments/${encodeURIComponent(commentId)}/edit-sessions`,
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
  provider: string,
  taskId: string,
  commentId: string,
  lookupToken: string | null,
): Promise<ExternalEditSessionView> {
  return fetchJsonOrThrow<ExternalEditSessionView>(
    `/api/integrations/my-work/${provider}/tasks/${encodeURIComponent(taskId)}/comments/${encodeURIComponent(commentId)}/delete-sessions`,
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
  sessionId: string,
): Promise<ExternalCommentDeleteOutcome> {
  return fetchJsonOrThrow<ExternalCommentDeleteOutcome>(
    `${SESSION_BASE}/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE' },
    'The comment could not be deleted.',
    '',
    fetchFn,
  );
}
