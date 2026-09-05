import { Inject, Injectable, Optional } from '@nestjs/common';
import { BusyError, ValidationError } from '../../../common/errors/error-types';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import type {
  IntegrationConnection,
  IntegrationCredentials,
  IntegrationProvider,
} from '../../storage/models/domain.models';
import { ExternalProviderError } from '../errors/external-provider.errors';
import { ExternalTaskProviderRegistry } from '../external-task-provider.registry';
import {
  canonicalizeRichDocument,
  richDocumentFingerprint,
  type ExternalRichDocumentV1,
} from '../models/external-rich-document';
import {
  EXTERNAL_RICH_CAPABILITIES,
  EXTERNAL_RICH_CAPABILITIES_TOKEN,
  type ExternalRichCapabilityFlags,
} from '../models/external-rich-capabilities';
import {
  decodeExternalCommentLookupToken,
  encodeExternalCommentLookupToken,
  type ExternalCommentLookupTokenPayload,
} from '../models/external-comment-lookup-token';
import type {
  ExternalCommentDeleteOutcome,
  ExternalEditSession,
  ExternalEditSessionView,
  ExternalSessionReloadResult,
  ExternalSessionVerifyResult,
  ExternalSessionWriteOutcome,
  ExternalSessionWriteRejectionReason,
  ExternalCommentDeleteRejectionReason,
} from '../models/external-edit-session.models';
import { adfToRichDocument, richDocumentToAdf } from '../adapters/rich/jira-adf-converter';
import {
  markdownToRichDocument,
  richDocumentToMarkdown,
} from '../adapters/rich/clickup-markdown-converter';
import { clickupCommentDeltaToRichDocument } from '../adapters/rich/clickup-comment-converter';
import type { ExternalOwnedCommentSnapshot } from '../models/external-provider.models';
import {
  ExternalEditSessionStore,
  type StoreFailure,
} from '../sessions/external-edit-session.store';
import { ProviderOperationGate } from '../sessions/provider-operation-gate';

export interface ExternalRichDescriptionRead {
  document: ExternalRichDocumentV1 | null;
  fingerprint: string | null;
  supported: boolean;
  readOnlyReason: string | null;
  /** False when the Phase 13 rich-edit gate is NO_GO or content is unsupported. */
  canEdit: boolean;
  /** False when the Phase 13 owned-delete gate is NO_GO. */
  canDeleteOwnedComments: boolean;
}

/**
 * A failure whose outcome at the vendor is unknown: the request had been
 * dispatched, and timeout, network loss, an unusable 5xx, or an unreadable
 * response cannot prove the mutation did not land.
 */
function isUnknownOutcome(error: unknown): boolean {
  return (
    error instanceof ExternalProviderError &&
    error.details?.dispatched === true &&
    (error.details?.reason === 'timeout' ||
      error.details?.reason === 'unavailable' ||
      error.details?.reason === 'invalid_response')
  );
}

function isProviderNotFound(error: unknown): boolean {
  return error instanceof ExternalProviderError && error.details?.reason === 'not_found';
}

type GatePhase =
  | { phase: 'rejected'; reason: ExternalSessionWriteRejectionReason }
  | { phase: 'outcome_unknown' }
  | { phase: 'dispatched' };

@Injectable()
export class ExternalEditSessionService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly providers: ExternalTaskProviderRegistry,
    private readonly gate: ProviderOperationGate,
    private readonly store: ExternalEditSessionStore,
    @Optional()
    @Inject(EXTERNAL_RICH_CAPABILITIES_TOKEN)
    private readonly capabilities: ExternalRichCapabilityFlags = EXTERNAL_RICH_CAPABILITIES,
  ) {}

  /**
   * Stateless rich-description read. Allocates no session; the explicit
   * edit-session route is the only path that creates one.
   */
  async readRichDescription(
    projectId: string,
    provider: IntegrationProvider,
    remoteTaskId: string,
  ): Promise<ExternalRichDescriptionRead> {
    const adapter = this.providers.get(provider);
    if (!adapter.descriptionEdit) {
      throw this.unsupported(provider);
    }
    const { connection, credentials } = await this.loadStableConnection(projectId, provider);
    const raw = await adapter.descriptionEdit.readDescription(
      credentials,
      this.context(connection),
      remoteTaskId,
    );
    const parsed = this.parseProviderDescription(provider, raw);
    if (!parsed.supported) {
      return {
        document: null,
        fingerprint: null,
        supported: false,
        readOnlyReason: 'unsupported_content',
        canEdit: false,
        canDeleteOwnedComments: this.capabilities.ownedDelete,
      };
    }
    return {
      document: parsed.document,
      fingerprint: richDocumentFingerprint(parsed.document),
      supported: true,
      readOnlyReason: null,
      canEdit: this.capabilities.richEdit,
      canDeleteOwnedComments: this.capabilities.ownedDelete,
    };
  }

  /** Explicit Edit action: opens a description session from a fresh read. */
  async createDescriptionSession(
    projectId: string,
    provider: IntegrationProvider,
    remoteTaskId: string,
  ): Promise<ExternalEditSessionView> {
    this.requireRichEditCapability();
    const adapter = this.providers.get(provider);
    if (!adapter.descriptionEdit) {
      throw this.unsupported(provider);
    }
    const { connection, credentials } = await this.loadStableConnection(projectId, provider);
    const raw = await adapter.descriptionEdit.readDescription(
      credentials,
      this.context(connection),
      remoteTaskId,
    );
    const parsed = this.parseProviderDescription(provider, raw);
    if (!parsed.supported) {
      // Unsupported content stays read-only: no session is ever created.
      throw new ValidationError('This task description contains unsupported content.', {
        provider,
        reason: 'unsupported_content',
      });
    }
    const created = this.store.create({
      kind: 'description_edit',
      provider,
      projectId,
      connectionId: connection.id,
      connectionGeneration: connection.generation,
      scopeKey: this.scopeKey(connection),
      remoteTaskId,
      remoteCommentId: null,
      baseline: {
        document: parsed.document,
        fingerprint: richDocumentFingerprint(parsed.document)!,
      },
      providerMetadata: { lookupToken: null, ownerRemoteId: '' },
    });
    if (!created.ok) {
      throw this.storeFailure(created.reason);
    }
    return this.store.view(created.value);
  }

  /**
   * Explicit comment-Edit action: opens a session only after a bounded
   * lookup proves the comment exists, parses inside the closed set, and
   * belongs to the current authenticated vendor user.
   */
  async createCommentEditSession(
    projectId: string,
    provider: IntegrationProvider,
    remoteTaskId: string,
    commentId: string,
    lookupToken: string | null,
  ): Promise<ExternalEditSessionView> {
    this.requireRichEditCapability();
    const { session } = await this.createCommentSession(
      projectId,
      provider,
      remoteTaskId,
      commentId,
      lookupToken,
      'comment_edit',
    );
    return session;
  }

  /**
   * Explicit comment-Delete action: opens a deletion session through the
   * same owner-validated bounded lookup.
   */
  async createCommentDeleteSession(
    projectId: string,
    provider: IntegrationProvider,
    remoteTaskId: string,
    commentId: string,
    pageProof: string | null,
  ): Promise<ExternalEditSessionView> {
    this.requireOwnedDeleteCapability();
    const { session } = await this.createCommentSession(
      projectId,
      provider,
      remoteTaskId,
      commentId,
      pageProof,
      'comment_delete',
    );
    return session;
  }

  /** Lightweight touch; never calls the provider. */
  async touchSession(projectId: string, sessionId: string): Promise<ExternalEditSessionView> {
    await this.storage.getProject(projectId);
    const current = this.store.get(sessionId);
    if (!current.ok || !this.sessionBelongsToProject(projectId, current.value)) {
      throw this.sessionFailure('session_not_found');
    }
    const touched = this.store.touch(sessionId);
    if (!touched.ok) {
      throw this.sessionFailure(touched.reason);
    }
    return this.store.view(touched.value);
  }

  /**
   * Save: fresh provider read, revision/metadata comparison, and one vendor
   * mutation inside the shared gate; the gate is then released and a
   * read-only post-write verification runs with generation rechecks on both
   * sides. A confirmed save commits the baseline and returns the new
   * revision; anything less certain leaves the prior blocked-but-retryable
   * state intact.
   */
  async saveSession(
    projectId: string,
    sessionId: string,
    payload: ExternalRichDocumentV1,
    expectedRevision: number,
  ): Promise<ExternalSessionWriteOutcome> {
    await this.storage.getProject(projectId);
    const canonical = canonicalizeRichDocument(payload);
    if (canonical === null) {
      throw new ValidationError('The payload is outside the supported rich content set.', {
        reason: 'unsupported_content',
      });
    }
    const fingerprint = richDocumentFingerprint(canonical)!;
    const initial = this.store.get(sessionId);
    if (!initial.ok) {
      return this.writeRejected(null, this.writeFailure(initial.reason));
    }
    if (!this.sessionBelongsToProject(projectId, initial.value)) {
      return this.writeRejected(null, 'session_not_found');
    }
    const kind = initial.value.kind;
    if (kind === 'comment_delete') {
      throw new ValidationError('The session does not support content saves.', {
        reason: 'wrong_session_kind',
      });
    }
    this.requireRichEditCapability();
    const provider = initial.value.provider;

    let phase: GatePhase;
    try {
      phase = await this.gate.run({ projectId, provider }, () =>
        this.saveDispatchPhase(
          projectId,
          sessionId,
          provider,
          kind,
          canonical,
          fingerprint,
          expectedRevision,
        ),
      );
    } catch (error) {
      if (error instanceof BusyError) {
        return this.writeRejected(this.currentView(sessionId), 'operation_busy');
      }
      throw error;
    }

    if (phase.phase === 'rejected') {
      return this.writeRejected(this.currentView(sessionId), phase.reason);
    }
    if (phase.phase === 'outcome_unknown') {
      const view = this.currentView(sessionId);
      return view === null
        ? this.writeRejected(null, 'session_not_found')
        : { outcome: 'outcome_unknown', session: view };
    }

    // Gate released: read-only post-write verification with generation
    // rechecks before and after. Failures keep the prior saved_unverified
    // state and remain retryable through the verify route.
    return this.postWriteVerification(projectId, sessionId, provider, kind, fingerprint, canonical);
  }

  private async saveDispatchPhase(
    projectId: string,
    sessionId: string,
    provider: IntegrationProvider,
    kind: 'description_edit' | 'comment_edit',
    canonical: ExternalRichDocumentV1,
    fingerprint: string,
    expectedRevision: number,
  ): Promise<GatePhase> {
    const adapter = this.providers.get(provider);
    const connection = await this.storage.getIntegrationConnection({ projectId, provider });
    const session = this.store.get(sessionId);
    if (!session.ok) {
      return { phase: 'rejected', reason: this.writeFailure(session.reason) };
    }
    if (
      !connection ||
      connection.projectId !== projectId ||
      connection.provider !== provider ||
      connection.id !== session.value.connectionId ||
      connection.generation !== session.value.connectionGeneration
    ) {
      this.store.invalidate(sessionId);
      return { phase: 'rejected', reason: 'connection_superseded' };
    }
    const context = this.context(connection);

    // Step 1: fresh provider read inside the gate.
    let fresh: { fingerprint: string; document: ExternalRichDocumentV1 };
    let commentMetadata: ExternalOwnedCommentSnapshot['metadata'] | null = null;
    if (kind === 'description_edit') {
      if (!adapter.descriptionEdit) {
        throw this.unsupported(provider);
      }
      const raw = await adapter.descriptionEdit.readDescription(
        (await this.storage.getIntegrationConnectionCredentials({ projectId, provider }))!,
        context,
        session.value.remoteTaskId,
      );
      const parsed = this.parseProviderDescription(provider, raw);
      if (!parsed.supported) {
        this.store.applyVerifyOutcome(sessionId, 'diverged');
        return { phase: 'rejected', reason: 'diverged' };
      }
      fresh = { fingerprint: richDocumentFingerprint(parsed.document)!, document: parsed.document };
    } else {
      if (!adapter.ownedMutations) {
        throw this.unsupported(provider);
      }
      const token = this.sessionLookupToken(session.value.providerMetadata.lookupToken ?? '');
      if (
        token === null ||
        token.provider !== provider ||
        token.connectionId !== connection.id ||
        token.connectionGeneration !== connection.generation ||
        token.taskId !== session.value.remoteTaskId ||
        token.commentId !== session.value.remoteCommentId
      ) {
        this.store.invalidate(sessionId);
        return { phase: 'rejected', reason: 'connection_superseded' };
      }
      const snapshot = await adapter.ownedMutations.findComment(
        (await this.storage.getIntegrationConnectionCredentials({ projectId, provider }))!,
        context,
        session.value.remoteTaskId,
        session.value.remoteCommentId!,
        token.pageProof,
      );
      if (snapshot === null) {
        this.store.invalidate(sessionId);
        return { phase: 'rejected', reason: 'target_gone' };
      }
      if (
        snapshot.authorRemoteId === null ||
        snapshot.authorRemoteId !== session.value.providerMetadata.ownerRemoteId
      ) {
        this.store.applyVerifyOutcome(sessionId, 'diverged');
        return { phase: 'rejected', reason: 'diverged' };
      }
      const parsed = this.parseProviderComment(provider, snapshot.raw);
      if (!parsed.supported) {
        this.store.applyVerifyOutcome(sessionId, 'diverged');
        return { phase: 'rejected', reason: 'diverged' };
      }
      fresh = { fingerprint: richDocumentFingerprint(parsed.document)!, document: parsed.document };
      commentMetadata = snapshot.metadata;
    }

    // Step 2: revision and metadata (baseline) comparison before dispatch.
    if (fresh.fingerprint !== session.value.baseline?.fingerprint) {
      this.store.applyVerifyOutcome(sessionId, 'diverged');
      return { phase: 'rejected', reason: 'diverged' };
    }

    // Admission: only editable takes a new payload; outcome_unknown takes
    // the exact same fingerprint.
    if (session.value.state === 'outcome_unknown') {
      const retry = this.store.beginRetryDispatch(sessionId, fingerprint, expectedRevision);
      if (!retry.ok) {
        return { phase: 'rejected', reason: this.writeFailure(retry.reason) };
      }
    } else if (session.value.state === 'editable') {
      const dispatch = this.store.beginDispatch(sessionId, fingerprint, expectedRevision);
      if (!dispatch.ok) {
        return { phase: 'rejected', reason: this.writeFailure(dispatch.reason) };
      }
    } else {
      return { phase: 'rejected', reason: 'session_not_editable' };
    }

    // Emission (descriptions emit provider-native here; comments carry the
    // canonical document into the adapter, which owns its provider shape).
    if (kind === 'description_edit') {
      const emit =
        provider === 'jira' ? richDocumentToAdf(canonical) : richDocumentToMarkdown(canonical);
      if ('ok' in emit && !emit.ok) {
        this.store.revertDispatch(sessionId);
        return { phase: 'rejected', reason: 'unsupported_content' };
      }
      const raw = 'ok' in emit && 'markdown' in emit ? emit.markdown : emit;
      try {
        await adapter.descriptionEdit!.writeDescription(
          (await this.storage.getIntegrationConnectionCredentials({ projectId, provider }))!,
          context,
          session.value.remoteTaskId,
          raw,
        );
      } catch (error) {
        if (isUnknownOutcome(error)) {
          return { phase: 'outcome_unknown' };
        }
        this.store.revertDispatch(sessionId);
        throw error;
      }
    } else {
      try {
        await adapter.ownedMutations!.updateOwnedComment(
          (await this.storage.getIntegrationConnectionCredentials({ projectId, provider }))!,
          context,
          session.value.remoteTaskId,
          session.value.remoteCommentId!,
          canonical,
          commentMetadata!,
        );
      } catch (error) {
        if (isUnknownOutcome(error)) {
          return { phase: 'outcome_unknown' };
        }
        this.store.revertDispatch(sessionId);
        throw error;
      }
    }

    const saved = this.store.markSavedUnverified(sessionId);
    if (!saved.ok) {
      return { phase: 'outcome_unknown' };
    }
    return { phase: 'dispatched' };
  }

  private async postWriteVerification(
    projectId: string,
    sessionId: string,
    provider: IntegrationProvider,
    kind: 'description_edit' | 'comment_edit',
    pendingFingerprint: string,
    canonical: ExternalRichDocumentV1,
  ): Promise<ExternalSessionWriteOutcome> {
    const session = this.store.get(sessionId);
    if (!session.ok) {
      return this.writeRejected(null, this.writeFailure(session.reason));
    }
    const read = await this.freshContentFingerprint(projectId, provider, kind, session.value);
    if (read.generationChanged) {
      this.store.invalidate(sessionId);
      return { outcome: 'saved_unverified', session: this.currentView(sessionId)! };
    }
    if (!read.ok) {
      // Verification read failed; prior state stays, verify remains retryable.
      return { outcome: 'saved_unverified', session: this.currentView(sessionId)! };
    }
    if (read.fingerprint === pendingFingerprint) {
      const committed = this.store.applyVerifyOutcome(sessionId, 'new_payload', {
        document: canonical,
        fingerprint: pendingFingerprint,
      });
      if (committed.ok) {
        return {
          outcome: 'saved',
          revision: committed.value.revision,
          session: this.store.view(committed.value),
        };
      }
    } else if (read.fingerprint !== session.value.baseline?.fingerprint) {
      // The write landed but the remote already shows other content.
      this.store.applyVerifyOutcome(sessionId, 'diverged');
    }
    return { outcome: 'saved_unverified', session: this.currentView(sessionId)! };
  }

  /** Fresh read-only content fingerprint with generation rechecks. */
  private async freshContentFingerprint(
    projectId: string,
    provider: IntegrationProvider,
    kind: 'description_edit' | 'comment_edit',
    session: ExternalEditSession,
  ): Promise<{ ok: boolean; fingerprint: string | null; generationChanged: boolean }> {
    const adapter = this.providers.get(provider);
    const before = await this.storage.getIntegrationConnection({ projectId, provider });
    if (
      !before ||
      before.projectId !== projectId ||
      before.provider !== provider ||
      before.id !== session.connectionId ||
      before.generation !== session.connectionGeneration
    ) {
      return { ok: false, fingerprint: null, generationChanged: true };
    }
    let fingerprint: string | null = null;
    try {
      if (kind === 'description_edit') {
        if (!adapter.descriptionEdit) {
          throw this.unsupported(provider);
        }
        const raw = await adapter.descriptionEdit.readDescription(
          (await this.storage.getIntegrationConnectionCredentials({ projectId, provider }))!,
          this.context(before),
          session.remoteTaskId,
        );
        const parsed = this.parseProviderDescription(provider, raw);
        fingerprint = parsed.supported ? richDocumentFingerprint(parsed.document) : null;
      } else {
        if (!adapter.ownedMutations) {
          throw this.unsupported(provider);
        }
        const token = this.sessionLookupToken(session.providerMetadata.lookupToken ?? '');
        const snapshot =
          token === null
            ? null
            : await adapter.ownedMutations.findComment(
                (await this.storage.getIntegrationConnectionCredentials({ projectId, provider }))!,
                this.context(before),
                session.remoteTaskId,
                session.remoteCommentId!,
                token.pageProof,
              );
        if (snapshot !== null) {
          const parsed = this.parseProviderComment(provider, snapshot.raw);
          fingerprint = parsed.supported ? richDocumentFingerprint(parsed.document) : null;
        }
      }
    } catch {
      return { ok: false, fingerprint: null, generationChanged: false };
    }
    const after = await this.storage.getIntegrationConnection({ projectId, provider });
    if (
      !after ||
      after.projectId !== projectId ||
      after.provider !== provider ||
      after.id !== session.connectionId ||
      after.generation !== session.connectionGeneration
    ) {
      return { ok: false, fingerprint: null, generationChanged: true };
    }
    return { ok: fingerprint !== null, fingerprint, generationChanged: false };
  }

  /** Explicit reload: re-baselines an editable session from a fresh read. */
  async reloadSession(projectId: string, sessionId: string): Promise<ExternalSessionReloadResult> {
    await this.storage.getProject(projectId);
    const session = this.store.get(sessionId);
    if (!session.ok) {
      throw this.sessionFailure(session.reason);
    }
    if (!this.sessionBelongsToProject(projectId, session.value)) {
      throw this.sessionFailure('session_not_found');
    }
    if (session.value.kind === 'comment_delete') {
      throw new ValidationError('The session does not support reload.', {
        reason: 'wrong_session_kind',
      });
    }
    this.requireRichEditCapability();
    const provider = session.value.provider;
    const { connection, credentials } = await this.loadStableConnection(projectId, provider);
    if (connection.id !== session.value.connectionId) {
      this.store.invalidate(sessionId);
      throw new ValidationError('The connection was replaced; the session is invalid.', {
        reason: 'connection_superseded',
      });
    }

    if (session.value.kind === 'description_edit') {
      const adapter = this.providers.get(provider);
      if (!adapter.descriptionEdit) {
        throw this.unsupported(provider);
      }
      const raw = await adapter.descriptionEdit.readDescription(
        credentials,
        this.context(connection),
        session.value.remoteTaskId,
      );
      const parsed = this.parseProviderDescription(provider, raw);
      if (!parsed.supported) {
        this.store.applyVerifyOutcome(sessionId, 'diverged');
        return { status: 'unsupported', session: this.currentView(sessionId) };
      }
      const reloaded = this.store.commitReload(sessionId, {
        document: parsed.document,
        fingerprint: richDocumentFingerprint(parsed.document)!,
      });
      if (!reloaded.ok) {
        throw this.sessionFailure(reloaded.reason);
      }
      return { status: 'reloaded', session: this.store.view(reloaded.value) };
    }

    const adapter = this.providers.get(provider);
    if (!adapter.ownedMutations) {
      throw this.unsupported(provider);
    }
    const token = this.sessionLookupToken(session.value.providerMetadata.lookupToken ?? '');
    if (token === null) {
      this.store.invalidate(sessionId);
      return { status: 'unsupported', session: this.currentView(sessionId) };
    }
    const snapshot = await adapter.ownedMutations.findComment(
      credentials,
      this.context(connection),
      session.value.remoteTaskId,
      session.value.remoteCommentId!,
      token.pageProof,
    );
    if (snapshot === null) {
      const gone = this.store.markDeleted(sessionId);
      return { status: 'gone', session: gone.ok ? this.store.view(gone.value) : null };
    }
    if (
      snapshot.authorRemoteId === null ||
      snapshot.authorRemoteId !== session.value.providerMetadata.ownerRemoteId
    ) {
      this.store.applyVerifyOutcome(sessionId, 'diverged');
      return { status: 'unsupported', session: this.currentView(sessionId) };
    }
    const parsed = this.parseProviderComment(provider, snapshot.raw);
    if (!parsed.supported) {
      this.store.applyVerifyOutcome(sessionId, 'diverged');
      return { status: 'unsupported', session: this.currentView(sessionId) };
    }
    const reloaded = this.store.commitReload(sessionId, {
      document: parsed.document,
      fingerprint: richDocumentFingerprint(parsed.document)!,
    });
    if (!reloaded.ok) {
      throw this.sessionFailure(reloaded.reason);
    }
    return { status: 'reloaded', session: this.store.view(reloaded.value) };
  }

  /**
   * Verifies a session against a fresh remote read. After an unknown outcome,
   * seeing the new payload commits the save exactly once; seeing the old
   * baseline never re-arms writes; anything else is divergence. Verification
   * failures leave the prior state untouched and stay retryable.
   */
  async verifySession(projectId: string, sessionId: string): Promise<ExternalSessionVerifyResult> {
    await this.storage.getProject(projectId);
    const session = this.store.get(sessionId);
    if (!session.ok) {
      return { session: null, remoteState: null, reason: this.verifyFailure(session.reason) };
    }
    if (!this.sessionBelongsToProject(projectId, session.value)) {
      return { session: null, remoteState: null, reason: 'session_not_found' };
    }
    if (session.value.kind === 'comment_delete') {
      return this.verifyDeleteSession(projectId, session.value);
    }
    const read = await this.freshContentFingerprint(
      projectId,
      session.value.provider,
      session.value.kind,
      session.value,
    );
    if (read.generationChanged) {
      this.store.invalidate(sessionId);
      return this.verifyResult(sessionId, 'diverged');
    }
    if (!read.ok) {
      // Retryable: keep the prior state, report nothing conclusive.
      return this.verifyResult(sessionId, null);
    }
    const pending = session.value.pendingWrite?.fingerprint ?? null;
    if (pending !== null && read.fingerprint === pending) {
      const applied = this.store.applyVerifyOutcome(sessionId, 'new_payload', {
        document: null,
        fingerprint: pending,
      });
      return this.verifyResult(sessionId, applied.ok ? 'new_payload' : null);
    }
    if (read.fingerprint === session.value.baseline?.fingerprint) {
      if (session.value.state === 'editable') {
        return this.verifyResult(sessionId, 'old_baseline');
      }
      const applied = this.store.applyVerifyOutcome(sessionId, 'old_baseline');
      return this.verifyResult(sessionId, applied.ok ? 'old_baseline' : null);
    }
    const applied = this.store.applyVerifyOutcome(sessionId, 'diverged');
    return this.verifyResult(sessionId, applied.ok ? 'diverged' : null);
  }

  /** Executes an owned comment deletion through the shared gate. */
  async executeCommentDelete(
    projectId: string,
    sessionId: string,
  ): Promise<ExternalCommentDeleteOutcome> {
    await this.storage.getProject(projectId);
    this.requireOwnedDeleteCapability();
    const session = this.store.get(sessionId);
    if (!session.ok) {
      return {
        outcome: 'rejected',
        reason: this.deleteFailure(session.reason),
        session: null,
      };
    }
    if (!this.sessionBelongsToProject(projectId, session.value)) {
      return { outcome: 'rejected', reason: 'session_not_found', session: null };
    }
    if (session.value.kind !== 'comment_delete') {
      throw new ValidationError('The session does not support comment deletion.', {
        reason: 'wrong_session_kind',
      });
    }
    const provider = session.value.provider;
    const adapter = this.providers.get(provider);
    if (!adapter.ownedMutations) {
      throw this.unsupported(provider);
    }

    try {
      return await this.gate.run({ projectId, provider }, async () => {
        const connection = await this.storage.getIntegrationConnection({ projectId, provider });
        if (
          !connection ||
          connection.projectId !== projectId ||
          connection.provider !== provider ||
          connection.id !== session.value.connectionId ||
          connection.generation !== session.value.connectionGeneration
        ) {
          this.store.invalidate(sessionId);
          return this.deleteRejected(this.currentView(sessionId), 'connection_superseded');
        }
        const token = this.sessionLookupToken(session.value.providerMetadata.lookupToken ?? '');
        if (
          token === null ||
          token.provider !== provider ||
          token.connectionId !== connection.id ||
          token.connectionGeneration !== connection.generation ||
          token.taskId !== session.value.remoteTaskId ||
          token.commentId !== session.value.remoteCommentId
        ) {
          this.store.invalidate(sessionId);
          return this.deleteRejected(this.currentView(sessionId), 'connection_superseded');
        }

        const preflight = this.store.get(sessionId);
        if (!preflight.ok) {
          return this.deleteRejected(null, this.deleteFailure(preflight.reason));
        }
        const deleteFingerprint = `comment_delete:${session.value.remoteCommentId}`;
        if (preflight.value.state === 'outcome_unknown') {
          const retry = this.store.beginRetryDispatch(
            sessionId,
            deleteFingerprint,
            preflight.value.revision,
          );
          if (!retry.ok) {
            return this.deleteRejected(
              this.currentView(sessionId),
              this.deleteFailure(retry.reason),
            );
          }
        } else if (preflight.value.state === 'editable') {
          const dispatch = this.store.beginDispatch(
            sessionId,
            deleteFingerprint,
            preflight.value.revision,
          );
          if (!dispatch.ok) {
            return this.deleteRejected(
              this.currentView(sessionId),
              this.deleteFailure(dispatch.reason),
            );
          }
        } else {
          return this.deleteRejected(
            this.currentView(sessionId),
            this.deleteFailure('session_not_editable'),
          );
        }

        try {
          await adapter.ownedMutations!.deleteComment(
            (await this.storage.getIntegrationConnectionCredentials({ projectId, provider }))!,
            this.context(connection),
            session.value.remoteTaskId,
            session.value.remoteCommentId!,
          );
        } catch (error) {
          if (isProviderNotFound(error)) {
            // A later 404 is treated as already deleted, never as a failure.
            const deleted = this.store.markDeleted(sessionId);
            return {
              outcome: 'already_deleted',
              session: this.store.view(deleted.ok ? deleted.value : session.value),
            };
          }
          if (isUnknownOutcome(error)) {
            return { outcome: 'outcome_unknown', session: this.currentView(sessionId)! };
          }
          // Known rejection fails closed: the session can no longer delete.
          this.store.invalidate(sessionId);
          return this.deleteRejected(this.currentView(sessionId), 'delete_rejected');
        }
        const deleted = this.store.markDeleted(sessionId);
        return {
          outcome: 'deleted',
          session: this.store.view(deleted.ok ? deleted.value : session.value),
        };
      });
    } catch (error) {
      if (error instanceof BusyError) {
        return this.deleteRejected(this.currentView(sessionId), 'operation_busy');
      }
      throw error;
    }
  }

  private async createCommentSession(
    projectId: string,
    provider: IntegrationProvider,
    remoteTaskId: string,
    commentId: string,
    lookupProof: string | null,
    kind: 'comment_edit' | 'comment_delete',
  ): Promise<{ session: ExternalEditSessionView }> {
    const adapter = this.providers.get(provider);
    if (!adapter.ownedMutations) {
      throw this.unsupported(provider);
    }
    const { connection, credentials } = await this.loadStableConnection(projectId, provider);
    const [ownerRemoteId, snapshot] = await Promise.all([
      adapter.ownedMutations.getCurrentOwnerRemoteId(credentials),
      adapter.ownedMutations.findComment(
        credentials,
        this.context(connection),
        remoteTaskId,
        commentId,
        lookupProof,
      ),
    ]);
    if (snapshot === null) {
      throw new ValidationError('The comment could not be found.', {
        provider,
        reason: 'comment_not_found',
      });
    }
    if (snapshot.authorRemoteId === null || snapshot.authorRemoteId !== ownerRemoteId) {
      throw new ValidationError('Only comments you authored can be changed.', {
        provider,
        reason: 'not_owned',
      });
    }

    let baseline: { document: ExternalRichDocumentV1; fingerprint: string } | null = null;
    if (kind === 'comment_edit') {
      const parsed = this.parseProviderComment(provider, snapshot.raw);
      if (!parsed.supported) {
        throw new ValidationError('The comment contains unsupported content.', {
          provider,
          reason: 'unsupported_content',
        });
      }
      baseline = {
        document: parsed.document,
        fingerprint: richDocumentFingerprint(parsed.document)!,
      };
    }

    const lookupToken = encodeExternalCommentLookupToken({
      v: 1,
      provider,
      connectionId: connection.id,
      connectionGeneration: connection.generation,
      taskId: remoteTaskId,
      commentId,
      pageProof: lookupProof,
    } satisfies ExternalCommentLookupTokenPayload);
    const created = this.store.create({
      kind,
      provider,
      projectId,
      connectionId: connection.id,
      connectionGeneration: connection.generation,
      scopeKey: this.scopeKey(connection),
      remoteTaskId,
      remoteCommentId: commentId,
      baseline,
      providerMetadata: { lookupToken, ownerRemoteId },
    });
    if (!created.ok) {
      throw this.storeFailure(created.reason);
    }
    return { session: this.store.view(created.value) };
  }

  private parseProviderDescription(
    provider: IntegrationProvider,
    raw: unknown,
  ): { supported: true; document: ExternalRichDocumentV1 } | { supported: false } {
    const parsed = provider === 'jira' ? adfToRichDocument(raw) : markdownToRichDocument(raw);
    return parsed.supported ? { supported: true, document: parsed.document } : { supported: false };
  }

  private parseProviderComment(
    provider: IntegrationProvider,
    raw: unknown,
  ): { supported: true; document: ExternalRichDocumentV1 } | { supported: false } {
    const parsed =
      provider === 'jira' ? adfToRichDocument(raw) : clickupCommentDeltaToRichDocument(raw);
    return parsed.supported ? { supported: true, document: parsed.document } : { supported: false };
  }

  private sessionLookupToken(value: string): ExternalCommentLookupTokenPayload | null {
    const token = decodeExternalCommentLookupToken(value);
    return token;
  }

  private requireRichEditCapability(): void {
    if (!this.capabilities.richEdit) {
      throw new ValidationError('Rich external editing is disabled by the capability gate.', {
        reason: 'capability_no_go',
      });
    }
  }

  private requireOwnedDeleteCapability(): void {
    if (!this.capabilities.ownedDelete) {
      throw new ValidationError('Owned comment deletion is disabled by the capability gate.', {
        reason: 'capability_no_go',
      });
    }
  }

  private async loadStableConnection(
    projectId: string,
    provider: IntegrationProvider,
  ): Promise<{
    connection: IntegrationConnection;
    credentials: IntegrationCredentials;
  }> {
    await this.storage.getProject(projectId);
    const identity = { projectId, provider } as const;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = await this.storage.getIntegrationConnection(identity);
      if (before?.projectId !== projectId || before.provider !== provider) {
        throw this.notConnected(projectId, provider);
      }
      const credentials = await this.storage.getIntegrationConnectionCredentials(identity);
      const after = await this.storage.getIntegrationConnection(identity);
      if (
        !credentials ||
        credentials.provider !== provider ||
        !after ||
        after.projectId !== projectId ||
        after.provider !== provider
      ) {
        throw this.notConnected(projectId, provider);
      }
      if (before.id === after.id && before.generation === after.generation) {
        return { connection: after, credentials };
      }
    }
    throw new BusyError('Integration connection changed during the operation.', {
      provider,
      projectId,
      reason: 'connection_changed',
    });
  }

  private currentView(sessionId: string): ExternalEditSessionView | null {
    const session = this.store.get(sessionId);
    return session.ok ? this.store.view(session.value) : null;
  }

  private verifyResult(
    sessionId: string,
    remoteState: ExternalSessionVerifyResult['remoteState'],
  ): ExternalSessionVerifyResult {
    const session = this.store.get(sessionId);
    return {
      session: session.ok ? this.store.view(session.value) : null,
      remoteState,
      reason: null,
    };
  }

  private async verifyDeleteSession(
    projectId: string,
    session: ExternalEditSession,
  ): Promise<ExternalSessionVerifyResult> {
    const adapter = this.providers.get(session.provider);
    if (!adapter.ownedMutations) {
      throw this.unsupported(session.provider);
    }
    const token = this.sessionLookupToken(session.providerMetadata.lookupToken ?? '');
    if (token === null) {
      this.store.invalidate(session.sessionId);
      return this.verifyResult(session.sessionId, 'diverged');
    }
    const { connection, credentials } = await this.loadStableConnection(
      projectId,
      session.provider,
    );
    if (connection.id !== session.connectionId) {
      this.store.invalidate(session.sessionId);
      return this.verifyResult(session.sessionId, 'diverged');
    }
    const snapshot = await adapter.ownedMutations.findComment(
      credentials,
      this.context(connection),
      session.remoteTaskId,
      session.remoteCommentId!,
      token.pageProof,
    );
    if (snapshot === null) {
      const deleted = this.store.markDeleted(session.sessionId);
      return this.verifyResult(deleted.ok ? deleted.value.sessionId : session.sessionId, 'gone');
    }
    if (snapshot.authorRemoteId !== session.providerMetadata.ownerRemoteId) {
      const diverged = this.store.applyVerifyOutcome(session.sessionId, 'diverged');
      return this.verifyResult(
        diverged.ok ? diverged.value.sessionId : session.sessionId,
        'diverged',
      );
    }
    if (session.state === 'outcome_unknown' || session.state === 'saved_unverified') {
      const stillPresent = this.store.applyVerifyOutcome(session.sessionId, 'old_baseline');
      return this.verifyResult(
        stillPresent.ok ? stillPresent.value.sessionId : session.sessionId,
        'old_baseline',
      );
    }
    return this.verifyResult(session.sessionId, 'old_baseline');
  }

  private writeRejected(
    session: ExternalEditSessionView | null,
    reason: ExternalSessionWriteRejectionReason,
  ): ExternalSessionWriteOutcome {
    return { outcome: 'pre_dispatch_rejected', reason, session };
  }

  private deleteRejected(
    session: ExternalEditSessionView | null,
    reason: ExternalCommentDeleteRejectionReason,
  ): ExternalCommentDeleteOutcome {
    return { outcome: 'rejected', reason, session };
  }

  private writeFailure(reason: StoreFailure): ExternalSessionWriteRejectionReason {
    if (reason === 'session_not_found' || reason === 'session_expired') {
      return reason;
    }
    if (reason === 'revision_conflict') {
      return reason;
    }
    return 'session_not_editable';
  }

  private deleteFailure(reason: StoreFailure): ExternalCommentDeleteRejectionReason {
    if (reason === 'session_not_found' || reason === 'session_expired') {
      return reason;
    }
    return 'session_not_editable';
  }

  private verifyFailure(reason: StoreFailure): 'session_not_found' | 'session_expired' {
    return reason === 'session_expired' ? 'session_expired' : 'session_not_found';
  }

  private sessionFailure(reason: StoreFailure): ValidationError {
    // Every store failure reason is already a safe closed reason code.
    return new ValidationError('The edit session is no longer available.', { reason });
  }

  private storeFailure(reason: StoreFailure): ValidationError {
    return new ValidationError('The edit session could not be created.', {
      reason: reason === 'baseline_too_large' ? 'baseline_too_large' : 'store_limit_exceeded',
    });
  }

  private notConnected(projectId: string, provider: IntegrationProvider): ValidationError {
    return new ValidationError('Connect the integration before editing.', {
      provider,
      projectId,
      reason: 'not_connected',
    });
  }

  private sessionBelongsToProject(projectId: string, session: ExternalEditSession): boolean {
    return session.projectId === projectId;
  }

  private unsupported(provider: IntegrationProvider): ValidationError {
    return new ValidationError('The provider does not support this operation.', {
      provider,
      reason: 'unsupported_capability',
    });
  }

  private context(connection: IntegrationConnection): {
    connectionId: string;
    connectionGeneration: number;
  } {
    return {
      connectionId: connection.id,
      connectionGeneration: connection.generation,
    };
  }

  /** Sessions are pinned to their connection; the connection id is the scope. */
  private scopeKey(connection: IntegrationConnection): string {
    return connection.id;
  }
}
