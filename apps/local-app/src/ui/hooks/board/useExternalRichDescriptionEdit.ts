import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ExternalEditSessionView,
  ExternalSessionReloadStatus,
  ExternalSessionWriteRejectionReason,
  ExternalSessionWriteOutcome,
} from '@/modules/external-integrations/models/external-edit-session.models';
import { canonicalizeRichDocument } from '@/modules/external-integrations/models/external-rich-document';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';
import type { ExternalBoardProvider } from '@/ui/lib/external-board';
import { externalMyWorkQueryKeys } from '@/ui/lib/external-my-work';
import {
  createDescriptionSession,
  readRichDescription,
  reloadSession,
  saveSession,
  touchSession,
  verifySession,
} from '@/ui/lib/external-rich-edit';
import type { IntegrationConnectionEpoch } from '@/ui/lib/integration-connections';
import {
  isSameIntegrationPresentationScope,
  validIntegrationProjectId,
  type IntegrationPresentationScope,
} from '@/ui/lib/integration-project-scope';

export type RichEditPhase =
  | 'idle'
  | 'opening'
  | 'editing'
  | 'saving'
  | 'saved'
  | 'diverged'
  | 'blocked'
  | 'unknown'
  | 'expired';

export interface RichEditState {
  phase: RichEditPhase;
  /** Session view of the active edit (null while idle/opening/expired). */
  session: ExternalEditSessionView | null;
  /** The last Save outcome detail for the UI affordances. */
  lastOutcome: ExternalSessionWriteOutcome | null;
  /** Remote verify result after an unknown outcome. */
  verifyRemoteState: string | null;
  /** The baseline revision the editor must present. */
  revision: number;
  error: string | null;
}

interface RichEditSaveVariables {
  scope: IntegrationPresentationScope;
  sessionId: string;
  document: unknown;
  revision: number;
}

interface RichEditSessionVariables {
  scope: IntegrationPresentationScope;
  sessionId: string;
}

function rejectedSavePhase(reason: ExternalSessionWriteRejectionReason): RichEditPhase {
  switch (reason) {
    case 'diverged':
    case 'revision_conflict':
      return 'diverged';
    case 'session_not_found':
    case 'session_expired':
      return 'expired';
    default:
      return 'blocked';
  }
}

function rejectedSaveMessage(reason: ExternalSessionWriteRejectionReason): string {
  switch (reason) {
    case 'operation_busy':
      return 'Another operation is in progress. Try again shortly.';
    case 'unsupported_content':
      return 'The content is outside the supported set.';
    default:
      return 'The save was rejected.';
  }
}

function reloadFailurePhase(status: ExternalSessionReloadStatus): RichEditPhase {
  return status === 'gone' ? 'expired' : 'blocked';
}

function reloadFailureMessage(status: ExternalSessionReloadStatus): string {
  return status === 'unsupported'
    ? 'The remote content is no longer supported for editing.'
    : 'The remote task is no longer available.';
}

/**
 * Description rich-edit orchestration for one task: stateless read for the
 * read-only render, session lifecycle (create → save → verify/reload), and
 * draft preservation across session expiry. Touches never call the provider
 * for content; the browser draft lives in component state and survives
 * session refreshes by design.
 */
export function useExternalRichDescriptionEdit(
  provider: ExternalBoardProvider,
  connectionEpoch: IntegrationConnectionEpoch | null,
  taskId: string | null,
  { enabled, projectId }: { enabled: boolean; projectId: string | null },
) {
  const apiFetch = useFetchFactory();
  const queryClient = useQueryClient();
  const scopedProjectId = validIntegrationProjectId(projectId);
  const admitted = enabled && scopedProjectId !== null;
  const presentationScope: IntegrationPresentationScope | null =
    admitted && connectionEpoch !== null && taskId !== null
      ? { projectId: scopedProjectId, provider, connectionEpoch, taskId }
      : null;
  const presentationScopeRef = useRef(presentationScope);
  presentationScopeRef.current = presentationScope;

  const isCurrentScope = useCallback(
    (scope: IntegrationPresentationScope) =>
      isSameIntegrationPresentationScope(scope, presentationScopeRef.current),
    [],
  );

  const descriptionQuery = useQuery({
    queryKey: [
      ...externalMyWorkQueryKeys.epoch(provider, connectionEpoch),
      'rich-description',
      taskId,
    ],
    queryFn: ({ signal }) =>
      readRichDescription(apiFetch, scopedProjectId!, provider, taskId!, signal),
    enabled: admitted && connectionEpoch !== null && taskId !== null,
  });

  const [state, setState] = useState<RichEditState>({
    phase: 'idle',
    session: null,
    lastOutcome: null,
    verifyRemoteState: null,
    revision: 0,
    error: null,
  });
  /** The current browser draft; survives session expiry and refreshes. */
  const [draft, setDraft] = useState<{ document: unknown } | null>(null);
  const touchTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTouch = useCallback(() => {
    if (touchTimer.current !== null) {
      clearInterval(touchTimer.current);
      touchTimer.current = null;
    }
  }, []);

  // Reset the editing state whenever the task or connection changes.
  useEffect(() => {
    setState({
      phase: 'idle',
      session: null,
      lastOutcome: null,
      verifyRemoteState: null,
      revision: 0,
      error: null,
    });
    setDraft(null);
    clearTouch();
  }, [provider, connectionEpoch, scopedProjectId, taskId, clearTouch]);

  useEffect(() => clearTouch, [clearTouch]);

  // A dirty editor keeps its session alive without provider content calls.
  useEffect(() => {
    const dirty = state.phase === 'editing' || state.phase === 'unknown';
    if (!admitted || !dirty || state.session === null) {
      clearTouch();
      return;
    }
    if (touchTimer.current === null) {
      touchTimer.current = setInterval(() => {
        if (state.session === null) {
          return;
        }
        void touchSession(apiFetch, scopedProjectId!, state.session.sessionId).catch(
          () => undefined,
        );
      }, 4 * 60_000);
    }
    return clearTouch;
  }, [admitted, state.phase, state.session, apiFetch, clearTouch, scopedProjectId]);

  const openSession = useMutation({
    mutationFn: (scope: IntegrationPresentationScope) => {
      return createDescriptionSession(apiFetch, scope.projectId, scope.provider, scope.taskId);
    },
    onSuccess: (session, scope) => {
      if (!isCurrentScope(scope)) return;
      setState({
        phase: 'editing',
        session,
        lastOutcome: null,
        verifyRemoteState: null,
        revision: session.revision,
        error: null,
      });
    },
    onError: (error: Error, scope) => {
      if (!isCurrentScope(scope)) return;
      setState((previous) => ({
        ...previous,
        phase: previous.session === null ? 'idle' : previous.phase,
        error: error.message,
      }));
    },
  });

  const invalidateDetailCaches = useCallback(
    (scope: IntegrationPresentationScope) => {
      if (!isCurrentScope(scope)) return;
      void queryClient.invalidateQueries({
        queryKey: externalMyWorkQueryKeys.taskDetail(
          scope.provider,
          scope.connectionEpoch,
          scope.taskId,
        ),
      });
      void queryClient.invalidateQueries({
        queryKey: [
          ...externalMyWorkQueryKeys.epoch(scope.provider, scope.connectionEpoch),
          'rich-description',
          scope.taskId,
        ],
      });
    },
    [isCurrentScope, queryClient],
  );

  const save = useMutation({
    mutationFn: ({ scope, sessionId, document, revision }: RichEditSaveVariables) => {
      const canonical = canonicalizeRichDocument(document);
      if (canonical === null) {
        throw new Error('The edited content is outside the supported set.');
      }
      return saveSession(apiFetch, scope.projectId, sessionId, canonical, revision);
    },
    onMutate: (variables) => {
      if (!isCurrentScope(variables.scope)) return;
      setState((previous) => ({ ...previous, phase: 'saving', error: null }));
    },
    onSuccess: (outcome, variables) => {
      if (!isCurrentScope(variables.scope)) return;
      if (outcome.outcome === 'saved') {
        setState((previous) => ({
          ...previous,
          phase: 'saved',
          session: outcome.session,
          lastOutcome: outcome,
          revision: outcome.revision,
          verifyRemoteState: null,
          error: null,
        }));
        setDraft(null);
        invalidateDetailCaches(variables.scope);
        return;
      }
      if (outcome.outcome === 'saved_unverified') {
        setState((previous) => ({
          ...previous,
          phase: 'blocked',
          session: outcome.session,
          lastOutcome: outcome,
          error: null,
        }));
        return;
      }
      if (outcome.outcome === 'outcome_unknown') {
        setState((previous) => ({
          ...previous,
          phase: 'unknown',
          session: outcome.session,
          lastOutcome: outcome,
          error: null,
        }));
        return;
      }
      // pre_dispatch_rejected
      const reason = outcome.reason;
      setState((previous) => ({
        ...previous,
        phase: rejectedSavePhase(reason),
        session: outcome.session,
        lastOutcome: outcome,
        error: rejectedSaveMessage(reason),
      }));
    },
    onError: (error: Error, variables) => {
      if (!isCurrentScope(variables.scope)) return;
      setState((previous) => ({
        ...previous,
        phase: previous.session !== null ? 'blocked' : 'idle',
        error: error.message,
      }));
    },
  });

  const verify = useMutation({
    mutationFn: ({ scope, sessionId }: RichEditSessionVariables) => {
      return verifySession(apiFetch, scope.projectId, sessionId);
    },
    onSuccess: (result, variables) => {
      if (!isCurrentScope(variables.scope)) return;
      if (result.remoteState === 'new_payload') {
        setState((previous) => ({
          ...previous,
          phase: 'saved',
          session: result.session,
          revision: result.session?.revision ?? previous.revision,
          verifyRemoteState: result.remoteState,
          error: null,
        }));
        setDraft(null);
        invalidateDetailCaches(variables.scope);
        return;
      }
      if (result.remoteState === 'gone') {
        setState((previous) => ({
          ...previous,
          phase: 'expired',
          session: result.session,
          verifyRemoteState: result.remoteState,
          error: 'The remote task is no longer available.',
        }));
        return;
      }
      setState((previous) => ({
        ...previous,
        phase: result.remoteState === 'diverged' ? 'diverged' : 'unknown',
        session: result.session,
        verifyRemoteState: result.remoteState,
      }));
    },
    onError: (error: Error, variables) => {
      if (!isCurrentScope(variables.scope)) return;
      setState((previous) => ({ ...previous, error: error.message }));
    },
  });

  const reload = useMutation({
    mutationFn: ({ scope, sessionId }: RichEditSessionVariables) => {
      return reloadSession(apiFetch, scope.projectId, sessionId);
    },
    onSuccess: (result, variables) => {
      if (!isCurrentScope(variables.scope)) return;
      if (result.status === 'reloaded' && result.session) {
        setState((previous) => ({
          ...previous,
          phase: 'editing',
          session: result.session,
          lastOutcome: null,
          verifyRemoteState: null,
          revision: result.session!.revision,
          error: null,
        }));
        setDraft(null);
        invalidateDetailCaches(variables.scope);
        return;
      }
      setState((previous) => ({
        ...previous,
        phase: reloadFailurePhase(result.status),
        session: result.session,
        error: reloadFailureMessage(result.status),
      }));
    },
    onError: (error: Error, variables) => {
      if (!isCurrentScope(variables.scope)) return;
      setState((previous) => ({ ...previous, error: error.message }));
    },
  });

  const startEdit = useCallback(() => {
    const scope = presentationScopeRef.current;
    if (scope === null) return;
    setDraft(null);
    setState((previous) => ({ ...previous, phase: 'opening', error: null }));
    openSession.mutate(scope);
  }, [openSession]);

  const cancelEdit = useCallback(() => {
    clearTouch();
    setDraft(null);
    setState({
      phase: 'idle',
      session: null,
      lastOutcome: null,
      verifyRemoteState: null,
      revision: 0,
      error: null,
    });
  }, [clearTouch]);

  const saveDraft = useCallback((document: unknown) => {
    setDraft({ document });
  }, []);

  const submitSave = useCallback(() => {
    const scope = presentationScopeRef.current;
    if (scope === null || draft === null || state.session === null) {
      return;
    }
    save.mutate({
      scope,
      sessionId: state.session.sessionId,
      document: draft.document,
      revision: state.revision,
    });
  }, [draft, state.session, state.revision, save]);

  const retrySamePayload = useCallback(() => {
    const scope = presentationScopeRef.current;
    if (
      scope === null ||
      draft === null ||
      state.session === null ||
      state.lastOutcome?.outcome !== 'outcome_unknown'
    ) {
      return;
    }
    save.mutate({
      scope,
      sessionId: state.session.sessionId,
      document: draft.document,
      revision: state.revision,
    });
  }, [draft, state.session, state.lastOutcome, state.revision, save]);

  const refreshSession = useCallback(() => {
    const scope = presentationScopeRef.current;
    if (scope === null) return;
    // Keeps the browser draft; opens a fresh session from a new baseline.
    setState((previous) => ({ ...previous, phase: 'opening', error: null }));
    openSession.mutate(scope);
  }, [openSession]);

  const verifyCurrentSession = useCallback(() => {
    const scope = presentationScopeRef.current;
    if (scope === null || state.session === null) return;
    verify.mutate({ scope, sessionId: state.session.sessionId });
  }, [state.session, verify]);

  const reloadCurrentSession = useCallback(() => {
    const scope = presentationScopeRef.current;
    if (scope === null || state.session === null) return;
    reload.mutate({ scope, sessionId: state.session.sessionId });
  }, [state.session, reload]);

  return useMemo(
    () => ({
      description: descriptionQuery.data,
      descriptionLoading: descriptionQuery.isLoading,
      descriptionError: descriptionQuery.error,
      state,
      draft,
      startEdit,
      cancelEdit,
      saveDraft,
      submitSave,
      retrySamePayload,
      refreshSession,
      verify: { ...verify, mutate: verifyCurrentSession },
      reload: { ...reload, mutate: reloadCurrentSession },
      savePending:
        save.isPending && save.variables !== undefined && isCurrentScope(save.variables.scope),
      verifyPending:
        verify.isPending &&
        verify.variables !== undefined &&
        isCurrentScope(verify.variables.scope),
      reloadPending:
        reload.isPending &&
        reload.variables !== undefined &&
        isCurrentScope(reload.variables.scope),
      openPending:
        openSession.isPending &&
        openSession.variables !== undefined &&
        isCurrentScope(openSession.variables),
    }),
    [
      descriptionQuery.data,
      descriptionQuery.isLoading,
      descriptionQuery.error,
      state,
      draft,
      startEdit,
      cancelEdit,
      saveDraft,
      submitSave,
      retrySamePayload,
      refreshSession,
      verify,
      reload,
      verifyCurrentSession,
      reloadCurrentSession,
      isCurrentScope,
      save.isPending,
      verify.isPending,
      reload.isPending,
      openSession.isPending,
    ],
  );
}
