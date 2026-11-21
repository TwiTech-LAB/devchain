import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { waitWithSignal } from '../../../common/wait-with-signal';
import { SessionImageStore } from '../../runtime-directory/session-image-store.service';
import { SessionRowStore } from '../../storage/sessions/session-row.store';
import { ProjectWriteGate } from '../../storage/write-gate/project-write-gate';
import {
  IMAGE_PASTE_TIMEOUT_MS,
  formSendTimeoutMs,
  ImageGestureSchema,
  ImagePasteInputSchema,
  FormSendInputSchema,
  type FormSendAck,
  type FormSendInput,
  type ImagePasteAck,
} from '../dtos/ws-envelope.dto';
import { HumanPromptInputService } from './human-prompt-input.service';
import { HumanPromptStateService } from './human-prompt-state.service';
import { TerminalIOService } from './terminal-io/terminal-io.service';
import { TerminalSession } from './terminal-session/terminal-session';
import { TerminalSessionRegistry } from './terminal-session/terminal-session-registry';

interface Gesture {
  readonly clientId: string;
  readonly projectId: string;
  readonly provider: string;
  readonly writer: AbortSignal;
  readonly cancellation: AbortController;
  draft?: symbol;
  expires: number;
  next: number;
  last?: { index: number; attachmentId: string; result: Promise<ImagePasteAck> };
}

class StaleDraft extends Error {}
const GESTURE_IDLE_MS = 120_000;
type EnqueueImageBegin = (
  sessionId: string,
  admit: (retired: boolean) => ImagePasteAck,
) => Promise<ImagePasteAck>;

interface FormSend {
  clientId: string;
  fingerprint: string;
  projectId: string;
  provider: string;
  writer: AbortSignal;
  draft: symbol;
  paneId?: string;
  continuation?: symbol;
  snapshot?: string | null;
  outcome: FormSendAck;
  pending?: Promise<FormSendAck>;
  touched: number;
}

@Injectable()
export class TerminalImageInputService {
  private readonly gestures = new WeakMap<TerminalSession, Map<string, Gesture>>();
  private readonly formSends = new WeakMap<TerminalSession, Map<string, FormSend>>();

  constructor(
    private readonly registry: TerminalSessionRegistry,
    private readonly rows: SessionRowStore,
    private readonly gate: ProjectWriteGate,
    private readonly images: SessionImageStore,
    private readonly prompt: HumanPromptStateService,
    private readonly humanInput: HumanPromptInputService,
    private readonly io: TerminalIOService,
  ) {}

  begin(clientId: string, raw: unknown): ImagePasteAck;
  begin(
    clientId: string,
    raw: unknown,
    enqueue: EnqueueImageBegin,
  ): ImagePasteAck | Promise<ImagePasteAck>;
  begin(
    clientId: string,
    raw: unknown,
    enqueue?: EnqueueImageBegin,
  ): ImagePasteAck | Promise<ImagePasteAck> {
    const parsed = ImageGestureSchema.safeParse(raw);
    if (!parsed.success) return { gestureId: '', index: -1, status: 'failed' };
    const { sessionId, projectId, gestureId } = parsed.data;
    const result = { gestureId, index: -1 };
    const session = this.registry.get(sessionId);
    if (!session || !session.hasSubscriber(clientId) || session.getAuthority() !== clientId)
      return { ...result, status: 'stale' };
    const provider = this.provider(session, projectId);
    if (!provider) return { ...result, status: 'stale' };
    const entries = this.gestures.get(session) ?? new Map<string, Gesture>();
    for (const [id, entry] of entries) if (entry.expires <= Date.now()) entries.delete(id);
    if (entries.has(gestureId) || entries.size >= 64) return { ...result, status: 'busy' };
    const gesture: Gesture = {
      clientId,
      projectId,
      provider,
      writer: session.writerToken,
      cancellation: new AbortController(),
      expires: Date.now() + IMAGE_PASTE_TIMEOUT_MS,
      next: 0,
    };
    entries.set(gestureId, gesture);
    this.gestures.set(session, entries);

    // End or writer loss can revoke the reservation while earlier input changes the draft.
    const admit = (retired: boolean): ImagePasteAck => {
      if (retired || !this.isCurrentGesture(session, gestureId, gesture)) {
        if (entries.get(gestureId) === gesture) entries.delete(gestureId);
        return { ...result, status: 'stale' };
      }
      gesture.draft = this.prompt.captureDraftTarget(session.tmuxSessionName);
      gesture.expires = Date.now() + GESTURE_IDLE_MS;
      return { ...result, status: 'ready' };
    };
    return enqueue ? enqueue(sessionId, admit) : admit(false);
  }

  end(clientId: string, raw: unknown): void {
    const parsed = ImageGestureSchema.safeParse(raw);
    if (!parsed.success) return;
    const { gestureId, sessionId } = parsed.data;
    const session = this.registry.get(sessionId);
    const entries = session && this.gestures.get(session);
    if (!entries) return;
    const gesture = entries.get(gestureId);
    if (gesture?.clientId === clientId) {
      gesture.cancellation.abort();
      entries.delete(gestureId);
    }
  }

  async paste(clientId: string, raw: unknown): Promise<ImagePasteAck> {
    const parsed = ImagePasteInputSchema.safeParse(raw);
    if (!parsed.success) return { gestureId: '', index: -1, status: 'failed' };
    const { sessionId, projectId, gestureId, index, attachmentId } = parsed.data;
    const reply = { gestureId, index };
    const session = this.registry.get(sessionId);
    const gesture = session && this.gestures.get(session)?.get(gestureId);
    const draft = gesture?.draft;
    if (
      !draft ||
      !gesture ||
      !session ||
      gesture.clientId !== clientId ||
      gesture.projectId !== projectId ||
      gesture.expires <= Date.now()
    )
      return { ...reply, status: 'stale' };
    if (gesture.last?.index === index) {
      return gesture.last.attachmentId === attachmentId
        ? gesture.last.result
        : { ...reply, status: 'stale' };
    }
    if (index !== gesture.next) return { ...reply, status: 'stale' };
    gesture.expires = Date.now() + GESTURE_IDLE_MS;
    const execute = async (): Promise<ImagePasteAck> => {
      const signal = AbortSignal.any([
        gesture.writer,
        gesture.cancellation.signal,
        AbortSignal.timeout(IMAGE_PASTE_TIMEOUT_MS),
      ]);
      const assertCurrent = () => {
        if (
          !this.isCurrentGesture(session, gestureId, gesture) ||
          !this.prompt.isCurrentDraftTarget(session.tmuxSessionName, draft)
        )
          throw new StaleDraft();
      };
      try {
        assertCurrent();
        const path = await waitWithSignal(this.images.resolvePath(sessionId, attachmentId), signal);
        assertCurrent();
        // Activation takes the agent lock. Finish it before entering the pane FIFO.
        const status = await this.humanInput.run(session, { kind: 'image-paste', signal }, () =>
          this.io.withComposer(
            { name: session.tmuxSessionName },
            (pane) => {
              assertCurrent();
              return pane.pasteImage(path, gesture.provider, assertCurrent);
            },
            signal,
          ),
        );
        if (status === 'delivered' || status === 'recognized') gesture.next = index + 1;
        return { ...reply, status };
      } catch (error) {
        return {
          ...reply,
          status:
            error instanceof StaleDraft ||
            gesture.writer.aborted ||
            gesture.cancellation.signal.aborted
              ? 'stale'
              : 'failed',
        };
      }
    };
    // Reject a different payload at the same index, including after an uncertain pane write.
    const result = execute();
    gesture.last = { index, attachmentId, result };
    return result;
  }

  private isCurrentGesture(session: TerminalSession, gestureId: string, gesture: Gesture): boolean {
    return (
      this.registry.get(session.sessionId) === session &&
      this.gestures.get(session)?.get(gestureId) === gesture &&
      !gesture.cancellation.signal.aborted &&
      session.writerToken === gesture.writer &&
      !gesture.writer.aborted &&
      session.hasSubscriber(gesture.clientId) &&
      session.getAuthority() === gesture.clientId &&
      this.provider(session, gesture.projectId) === gesture.provider &&
      gesture.expires > Date.now()
    );
  }

  // Admission runs when the socket packet arrives, before earlier session inputs drain.
  prepareFormSend(clientId: string, raw: FormSendInput): () => Promise<FormSendAck> {
    const parsed = FormSendInputSchema.safeParse(raw);
    const empty: FormSendAck = {
      sendId: typeof raw?.sendId === 'string' ? raw.sendId : '',
      status: 'rejected',
      confirmedSegments: 0,
      acknowledgedImages: 0,
    };
    const refuse = (status: FormSendAck['status']) => async () => ({ ...empty, status });
    if (!parsed.success) return refuse('rejected');
    const { sessionId, projectId, sendId, segments, resume } = parsed.data;
    const session = this.registry.get(sessionId);
    if (!session || !session.hasSubscriber(clientId) || session.getAuthority() !== clientId)
      return refuse(resume ? 'inspect' : 'rejected');
    const provider = this.provider(session, projectId);
    if (!provider) return refuse(resume ? 'inspect' : 'rejected');
    const entries = this.formSends.get(session) ?? new Map<string, FormSend>();
    this.formSends.set(session, entries);
    const now = Date.now();
    for (const [id, item] of entries)
      if (!item.pending && now - item.touched > 600_000) entries.delete(id);
    const fingerprint = createHash('sha256').update(JSON.stringify(segments)).digest('hex');
    const existing = entries.get(sendId);
    if (
      existing &&
      (existing.clientId !== clientId ||
        existing.projectId !== projectId ||
        existing.fingerprint !== fingerprint)
    )
      return refuse('inspect');
    if (!existing && resume) return refuse('inspect');
    if (!existing && entries.size >= 64) return refuse('rejected');
    const entry: FormSend = existing ?? {
      clientId,
      fingerprint,
      projectId,
      provider,
      writer: session.writerToken,
      draft: this.prompt.captureDraftTarget(session.tmuxSessionName),
      outcome: empty,
      touched: now,
    };
    entries.set(sendId, entry);
    const signal = AbortSignal.any([
      entry.writer,
      AbortSignal.timeout(formSendTimeoutMs(segments.length)),
    ]);
    return () => {
      if (entry.pending) return entry.pending;
      if (existing && (!resume || entry.outcome.status !== 'retryable'))
        return Promise.resolve({ ...entry.outcome });
      if (entries.get(sendId) !== entry)
        return Promise.resolve({ ...entry.outcome, status: 'inspect' });
      entry.pending = this.executeFormSend(session, entry, segments, signal).finally(() => {
        entry.touched = Date.now();
        entry.pending = undefined;
      });
      return entry.pending;
    };
  }

  private async executeFormSend(
    session: TerminalSession,
    entry: FormSend,
    segments: FormSendInput['segments'],
    signal: AbortSignal,
  ): Promise<FormSendAck> {
    const target = { name: session.tmuxSessionName };
    const result = entry.outcome;
    const assertCurrent = (paneId?: string) => {
      if (
        this.registry.get(session.sessionId) !== session ||
        !session.hasSubscriber(entry.clientId) ||
        session.getAuthority() !== entry.clientId ||
        session.writerToken !== entry.writer ||
        !this.prompt.isCurrentDraftTarget(target.name, entry.draft) ||
        this.provider(session, entry.projectId) !== entry.provider ||
        (paneId && entry.paneId && paneId !== entry.paneId)
      )
        throw new StaleDraft();
      if (paneId) entry.paneId = paneId;
    };
    try {
      assertCurrent();
      const remainingSegments = segments.slice(result.confirmedSegments);
      const paths = new Map<string, string>();
      for (const segment of remainingSegments) {
        if (segment.kind === 'image')
          paths.set(
            segment.attachmentId,
            await waitWithSignal(
              this.images.resolvePath(session.sessionId, segment.attachmentId),
              signal,
            ),
          );
      }
      assertCurrent();
      await this.humanInput.run(
        session,
        { kind: 'form-send', signal, submitted: () => result.status === 'submitted' },
        () =>
          this.io.withComposer(
            target,
            async (pane) => {
              assertCurrent();
              if (
                result.confirmedSegments > 0 &&
                (!entry.continuation ||
                  pane.previousContinuation !== entry.continuation ||
                  !entry.snapshot ||
                  !entry.paneId ||
                  (await pane.snapshot(entry.paneId)) !== entry.snapshot)
              )
                throw new StaleDraft();
              try {
                for (const segment of remainingSegments) {
                  const outcome =
                    segment.kind === 'text'
                      ? await pane.pasteText(segment.text, assertCurrent)
                      : await pane.pasteImage(
                          paths.get(segment.attachmentId)!,
                          entry.provider,
                          assertCurrent,
                        );
                  if (outcome === 'uncertain') {
                    result.status = 'inspect';
                    return;
                  }
                  result.confirmedSegments++;
                  if (segment.kind === 'image') result.acknowledgedImages++;
                  if (outcome === 'unconfirmed') {
                    result.status = 'inspect';
                    return;
                  }
                }
                result.status =
                  (await pane.submit(assertCurrent)) === 'submitted' ? 'submitted' : 'inspect';
              } catch (error) {
                if (!result.confirmedSegments || error instanceof StaleDraft) throw error;
                // Only the very next operation in this exact pane may continue the confirmed prefix.
                entry.snapshot = entry.paneId ? await pane.snapshot(entry.paneId) : null;
                if (entry.snapshot) entry.continuation = pane.checkpoint();
                result.status = entry.snapshot ? 'retryable' : 'inspect';
              }
            },
            signal,
          ),
      );
    } catch (error) {
      if (result.status !== 'submitted' && result.status !== 'inspect') {
        result.status =
          error instanceof StaleDraft || entry.writer.aborted
            ? result.confirmedSegments
              ? 'inspect'
              : 'rejected'
            : 'retryable';
      }
    }
    return { ...result };
  }

  private provider(session: TerminalSession, projectId: string): string | null {
    const row = this.rows.getSession(session.sessionId);
    if (
      !this.gate.isWritable(projectId) ||
      row?.status !== 'running' ||
      row.tmuxSessionId !== session.tmuxSessionName ||
      this.rows.getSessionProjectScope(session.sessionId)?.projectId !== projectId
    )
      return null;
    return row.providerNameAtLaunch?.toLowerCase() ?? null;
  }
}
