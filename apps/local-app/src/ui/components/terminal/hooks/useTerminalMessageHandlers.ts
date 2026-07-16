import { useCallback, useEffect, useRef } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { Socket } from 'socket.io-client';
import { type WsEnvelope } from '@/ui/lib/socket';
import { termLog } from '@/ui/lib/debug';
import { DEFAULT_TERMINAL_SCROLLBACK } from '@/common/constants/terminal';
import { resolveTerminalSocket } from '../socket';
import { useTerminalWritePump } from './useTerminalWritePump';
import type { TerminalWritePumpApi } from './terminal-write-pump';
import type { TerminalHistorySync } from '../terminal-history-sync';
import type { ScrollIntentController } from '../scroll-intent-binding';
import type {
  TerminalSeedPayload,
  TerminalSeedEmptyPayload,
} from '@/modules/terminal/dtos/ws-envelope.dto';

interface TerminalDataPayload {
  data: string;
  sequence?: number;
}

/**
 * Buffered frame for sequence-based history deduplication
 */
interface BufferedFrame {
  sequence: number;
  data: string;
}

interface SessionStatePayload {
  sessionId: string;
  status: 'started' | 'ended' | 'crashed' | 'timeout';
  message?: string;
}

interface SubscribedPayload {
  currentSequence?: number;
  replayStatus?: 'seed' | 'covered' | 'gap';
  // Immutable provider refresh capability, decoupled from per-snapshot has-more.
  historyRefreshable?: boolean;
  // The server sequence-domain this ack belongs to; reconciled before any domain frame.
  sequenceEpoch?: string;
}

/** Full-history response shape (the domain epoch lets the client reject a wrong-domain response). */
interface FullHistoryPayload {
  history?: string;
  cursorX?: number;
  cursorY?: number;
  hasHistory?: boolean; // Per-snapshot has-more (response truncated due to maxBytes)
  capturedSequence?: number; // Sequence at capture time for deduplication
  sequenceEpoch?: string; // Server sequence-domain the snapshot was captured in
  correlationId?: string; // Echoed request token; identifies the owning attempt
}

interface ResyncRequiredPayload {
  currentSequence: number;
}

function buildCursorPositionSequence(
  cursorX: number | undefined,
  cursorY: number | undefined,
  cols: number,
  rows: number,
): string | null {
  if (
    cursorX === undefined ||
    cursorY === undefined ||
    !Number.isFinite(cursorX) ||
    !Number.isFinite(cursorY)
  ) {
    return null;
  }

  const maxCol = Math.max(0, cols - 1);
  const maxRow = Math.max(0, rows - 1);
  const col = Math.min(Math.max(Math.floor(cursorX), 0), maxCol) + 1;
  const row = Math.min(Math.max(Math.floor(cursorY), 0), maxRow) + 1;
  return `\x1b[${row};${col}H`;
}

/**
 * Custom hook for handling terminal WebSocket message routing and handlers.
 * Extracts message handling logic to simplify the main component.
 *
 * @param sessionId - Terminal session ID
 * @param terminalRef - Ref to terminal container DOM element
 * @param xtermRef - Ref to xterm Terminal instance
 * @param fitAddonRef - Ref to FitAddon instance
 * @param lastSequenceRef - Ref tracking last sequence number
 * @param isAuthorityRef - Ref tracking focus authority
 * @param historySync - History-refresh lifecycle owner (capability, baseline, active attempt)
 * @param isLoadingHistoryRef - Ref tracking if history is currently being loaded
 * @param isHistoryInFlightRef - Ref tracking if history request is in-flight (for buffering)
 * @param pendingHistoryFramesRef - Ref to buffer frames during in-flight for sequence-based dedup
 * @param expectingSeedRef - Ref tracking if we're expecting a seed
 * @param seedStateRef - Ref to current seed assembly state
 * @param queueOrWrite - Function to write or queue terminal data
 * @param handleSeedChunk - Function to handle seed chunks
 * @param flushPendingWrites - Function to flush pending writes immediately
 * @param onSessionEnded - Optional callback for session end events
 * @param scrollbackLines - Number of scrollback lines (from settings)
 * @returns Message handler function for useAppSocket
 */
export function useTerminalMessageHandlers(
  sessionId: string,
  terminalRef: React.RefObject<HTMLDivElement>,
  xtermRef: React.RefObject<Terminal | null>,
  fitAddonRef: React.RefObject<FitAddon | null>,
  lastSequenceRef: React.MutableRefObject<number>,
  isAuthorityRef: React.MutableRefObject<boolean>,
  isSubscribedRef: React.MutableRefObject<boolean>,
  historySync: TerminalHistorySync,
  isLoadingHistoryRef: React.MutableRefObject<boolean>,
  isHistoryInFlightRef: React.MutableRefObject<boolean>,
  pendingHistoryFramesRef: React.MutableRefObject<BufferedFrame[]>,
  expectingSeedRef: React.MutableRefObject<boolean>,
  pendingResyncSequenceRef: React.MutableRefObject<number | null>,
  seedStateRef: React.MutableRefObject<{
    totalChunks: number;
    chunks: string[];
    receivedChunks: Set<number>;
    cols?: number;
    rows?: number;
    cursorX?: number;
    cursorY?: number;
    recoveryEpoch?: number;
    capturedSequence?: number;
  } | null>,
  prepareForResync: () => void,
  queueOrWrite: (data: string) => void,
  handleSeedChunk: (payload: TerminalSeedPayload) => void,
  handleSeedEmpty: (payload: TerminalSeedEmptyPayload) => void,
  flushPendingWrites: () => void,
  setIgnoreWindow: (durationMs: number) => void,
  onSessionEnded?: (payload: SessionStatePayload) => void,
  scrollbackLines: number = DEFAULT_TERMINAL_SCROLLBACK,
  socket?: Socket | null,
  onSubscribed?: () => void,
  providedWritePump?: TerminalWritePumpApi,
  resetRecoveryDomain?: () => void,
  scrollIntentControllerRef?: React.MutableRefObject<ScrollIntentController | null>,
  deferredHistoryInvalidateRef?: React.MutableRefObject<(() => void) | null>,
) {
  const fallbackWritePump = useTerminalWritePump(xtermRef, () => undefined);
  const writePump = providedWritePump ?? fallbackWritePump;
  // Drag-deferred history: while a scrollbar drag owns xterm's cloned scrollbar state, a matching
  // full_history response is retained here and applied only after the drag ends (see handleFullHistory).
  // `deferredControllerRef` records WHICH controller the current drag-end subscription belongs to, so a
  // controller that was disposed/replaced (its listeners cleared silently) cannot strand the next
  // deferral: a defer on a new controller drops the stale subscription and re-subscribes.
  const deferredHistoryRef = useRef<FullHistoryPayload | null>(null);
  const dragEndUnsubscribeRef = useRef<(() => void) | null>(null);
  const deferredControllerRef = useRef<ScrollIntentController | null>(null);
  const cancelDeferredHistory = useCallback(() => {
    deferredHistoryRef.current = null;
    dragEndUnsubscribeRef.current?.();
    dragEndUnsubscribeRef.current = null;
    deferredControllerRef.current = null;
  }, []);
  // Full lifecycle invalidation: used when the drag controller, session, or terminal that owns a
  // pending deferral goes away and no drag-end can ever fire (controller disposal clears listeners
  // silently). Beyond dropping the deferral, it retires the active attempt and clears the in-flight
  // buffer so history-request eligibility is not stranded on a dead attempt. Gated on an actual
  // pending deferral so a lifecycle tick with nothing deferred cannot disturb a healthy request.
  const invalidateDeferredHistory = useCallback(() => {
    const hadDeferral =
      deferredHistoryRef.current !== null || dragEndUnsubscribeRef.current !== null;
    cancelDeferredHistory();
    if (hadDeferral) {
      historySync.invalidateAttempt();
      isHistoryInFlightRef.current = false;
      isLoadingHistoryRef.current = false;
      pendingHistoryFramesRef.current = [];
    }
  }, [
    cancelDeferredHistory,
    historySync,
    isHistoryInFlightRef,
    isLoadingHistoryRef,
    pendingHistoryFramesRef,
  ]);
  // Session change and unmount can never deliver a drag-end for an in-flight deferral: invalidate it.
  useEffect(() => invalidateDeferredHistory, [sessionId, invalidateDeferredHistory]);
  // Publish the invalidation so ChatTerminal can call it when useXterm swaps/nulls the drag
  // controller (terminal recreation) — a controller change is otherwise unobservable from here.
  useEffect(() => {
    if (!deferredHistoryInvalidateRef) return;
    deferredHistoryInvalidateRef.current = invalidateDeferredHistory;
    return () => {
      deferredHistoryInvalidateRef.current = null;
    };
  }, [deferredHistoryInvalidateRef, invalidateDeferredHistory]);
  const handleMessage = useCallback(
    (envelope: WsEnvelope) => {
      const { topic, type, payload } = envelope;
      const activeSocket = resolveTerminalSocket(socket);

      type Handler<P = unknown> = (payload: P) => void;

      const safe =
        <P>(name: string, fn: Handler<P>): Handler<P> =>
        (p: P) => {
          try {
            fn(p);
          } catch (err) {
            termLog('handler_error', {
              sessionId,
              handler: name,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        };

      // Seed chunks carry per-snapshot has-more only; the seed manager records it as
      // snapshotHasMore once the replacement write settles (never as refresh capability).
      const handleSeedAnsi: Handler<TerminalSeedPayload> = safe('seed_ansi', handleSeedChunk);

      // Non-writing completion for a successful empty initial capture: resolve the seed
      // attempt and adopt the baseline without resetting xterm or clearing live rows.
      const handleSeedEmptyCompletion: Handler<TerminalSeedEmptyPayload> = safe(
        'seed_empty',
        handleSeedEmpty,
      );

      // Apply an accepted, current-domain full_history response. Reads xterm scroll position at
      // CALL time, so a drag-deferred apply lands on the final post-drag offset, not the stale
      // pre-drag one. Callers MUST run the correlation + domain-epoch guards first.
      const applyFullHistory = (p: FullHistoryPayload) => {
        const h = p?.history ?? '';
        const capturedSequence = p?.capturedSequence ?? 0;
        const xterm = xtermRef.current;

        // Per-snapshot has-more, straight from the payload — never pinned true.
        historySync.setSnapshotHasMore(p.hasHistory === true);

        const clearAttempt = () => {
          isHistoryInFlightRef.current = false;
          pendingHistoryFramesRef.current = [];
          historySync.invalidateAttempt();
        };

        if (!xterm) {
          clearAttempt();
          return;
        }

        // A trusted baseline uses null for unset (0 is a valid baseline). Skip a response that
        // carries no data past the baseline and no buffered tail — no destructive rewrite.
        const baseline = historySync.getAcceptedSnapshotSequence();
        const isFirstLoad = baseline === null;
        const hasNewData = baseline === null || capturedSequence > baseline;
        const bufferedFrameCount = pendingHistoryFramesRef.current.length;

        termLog('history_load_start', {
          sessionId,
          historyLength: h.length,
          capturedSequence,
          acceptedSnapshotSequence: baseline,
          isFirstLoad,
          hasNewData,
          bufferedFrames: bufferedFrameCount,
        });

        if (!hasNewData && bufferedFrameCount === 0) {
          termLog('history_skip_unchanged', {
            sessionId,
            capturedSequence,
            acceptedSnapshotSequence: baseline,
            reason: 'no_new_data',
          });
          clearAttempt();
          return;
        }

        // Set loading flag BEFORE any xterm operations to pause scroll detection
        isLoadingHistoryRef.current = true;

        // Save current scroll position to restore later
        // We restore position unless user was exactly at the bottom
        const buffer = xterm.buffer.active;
        const savedViewportY = buffer.viewportY;
        const savedBaseY = buffer.baseY;
        const wasAtBottom = savedViewportY === savedBaseY;

        if (h) {
          writePump.discardPending();
          let mergedFrames = 0;
          let includeCursor = true;
          // Highest sequence actually applied (snapshot capture point, raised by each applied
          // tail frame). Commits the baseline and advances the reconnect watermark on success.
          let highestApplied = capturedSequence;

          const finishHistory = () => {
            pendingHistoryFramesRef.current = [];
            isHistoryInFlightRef.current = false;
            isLoadingHistoryRef.current = false;
            // Commit the capture baseline and advance the reconnect watermark to the highest
            // applied sequence ONLY after replacement + buffered-tail completion.
            historySync.commitBaseline(highestApplied);
            lastSequenceRef.current = highestApplied;
            historySync.invalidateAttempt();

            termLog('history_written', {
              sessionId,
              historyBytes: h.length,
              mergedFrames,
              highestApplied,
            });

            if (!wasAtBottom) {
              const offsetFromBottom = savedBaseY - savedViewportY;
              const newBaseY = xterm.buffer.active.baseY;
              const targetY = Math.max(0, newBaseY - offsetFromBottom);
              xterm.scrollToLine(targetY);
              termLog('history_restore_scroll', {
                sessionId,
                savedViewportY,
                savedBaseY,
                offsetFromBottom,
                newBaseY,
                targetY,
              });
            }
            termLog('history_load_complete', { sessionId });
          };

          const flushBufferedFrames = () => {
            const buffered = pendingHistoryFramesRef.current;
            pendingHistoryFramesRef.current = [];
            const newFrames = buffered.filter(
              (frame) => frame.sequence > capturedSequence || frame.sequence === -1,
            );
            for (const frame of newFrames) {
              if (frame.sequence > highestApplied) highestApplied = frame.sequence;
            }
            const cursorPositionSequence = includeCursor
              ? buildCursorPositionSequence(p.cursorX, p.cursorY, xterm.cols, xterm.rows)
              : null;
            includeCursor = false;
            mergedFrames += newFrames.length;

            termLog('history_flush_frames', {
              sessionId,
              totalBuffered: buffered.length,
              newFrames: newFrames.length,
              capturedSequence,
            });

            const tail = `${cursorPositionSequence ?? ''}${newFrames
              .map((frame) => frame.data)
              .join('')}`;
            if (!tail) {
              finishHistory();
              return;
            }
            if (
              !writePump.write(tail, {
                kind: 'history',
                onComplete: flushBufferedFrames,
              })
            ) {
              clearAttempt();
              isLoadingHistoryRef.current = false;
            }
          };

          const accepted = writePump.write(h, {
            kind: 'history',
            beforeWrite: () => {
              xterm.options.scrollback = scrollbackLines;
              xterm.reset();
              xterm.clear();
            },
            onComplete: flushBufferedFrames,
          });
          if (!accepted) {
            clearAttempt();
            isLoadingHistoryRef.current = false;
          }
          termLog('full_history_loaded', { sessionId, historyBytes: h.length });
        } else {
          // No history payload; clear all state and stop loading.
          clearAttempt();
          isLoadingHistoryRef.current = false;
        }
      };

      const handleFullHistory: Handler<FullHistoryPayload> = safe('full_history', (p) => {
        // GUARD 1: a stale/superseded response (late from a disconnected socket, or one dropped by
        // recovery/a newer request) must return before any xterm mutation or baseline update.
        if (!historySync.isActiveAttempt(p?.correlationId)) {
          termLog('history_response_stale', {
            sessionId,
            correlationId: p?.correlationId ?? null,
          });
          return;
        }

        // GUARD 2: wrong sequence-domain. A response captured in a retired domain must never
        // rewrite xterm or move the baseline. Preserve current-domain frames buffered during the
        // in-flight by flushing them to the terminal, then drop the attempt.
        const currentEpoch = historySync.getSequenceEpoch();
        if (p?.sequenceEpoch != null && currentEpoch != null && p.sequenceEpoch !== currentEpoch) {
          termLog('history_response_wrong_epoch', {
            sessionId,
            responseEpoch: p.sequenceEpoch,
            currentEpoch,
          });
          const buffered = pendingHistoryFramesRef.current;
          pendingHistoryFramesRef.current = [];
          isHistoryInFlightRef.current = false;
          isLoadingHistoryRef.current = false;
          historySync.invalidateAttempt();
          for (const frame of buffered) queueOrWrite(frame.data);
          return;
        }

        // DRAG DEFER: while a scrollbar drag owns xterm's cloned scrollbar state, a destructive
        // buffer rewrite would race that state. Retain this response and apply it only after the
        // drag has fully ended (pointerup / pointercancel / silent capture-loss), on a microtask
        // boundary after xterm's own pointerup teardown. Live frames keep buffering meanwhile. A
        // recovery/disconnect/session change invalidates the attempt, so the apply-time re-check
        // drops a superseded deferral.
        const controller = scrollIntentControllerRef?.current;
        if (controller?.isDragActive()) {
          // Drop a subscription left over from a now-replaced controller (disposal clears its
          // listeners silently, so the unsubscribe ref would otherwise stay non-null and block a
          // fresh subscribe on the new controller).
          if (deferredControllerRef.current && deferredControllerRef.current !== controller) {
            dragEndUnsubscribeRef.current?.();
            dragEndUnsubscribeRef.current = null;
            deferredControllerRef.current = null;
          }
          deferredHistoryRef.current = p;
          if (!dragEndUnsubscribeRef.current) {
            deferredControllerRef.current = controller;
            dragEndUnsubscribeRef.current = controller.onDragEnd(() => {
              dragEndUnsubscribeRef.current?.();
              dragEndUnsubscribeRef.current = null;
              deferredControllerRef.current = null;
              const deferred = deferredHistoryRef.current;
              deferredHistoryRef.current = null;
              if (!deferred) return;
              queueMicrotask(() => {
                if (!historySync.isActiveAttempt(deferred.correlationId)) return;
                const epochNow = historySync.getSequenceEpoch();
                if (
                  deferred.sequenceEpoch != null &&
                  epochNow != null &&
                  deferred.sequenceEpoch !== epochNow
                ) {
                  return;
                }
                applyFullHistory(deferred);
              });
            });
          }
          termLog('history_response_deferred_during_drag', {
            sessionId,
            correlationId: p?.correlationId ?? null,
          });
          return;
        }

        applyFullHistory(p);
      });

      const handleData: Handler<TerminalDataPayload> = safe('data', (terminalData) => {
        // Let server control cursor visibility - don't manually show cursor
        // Server (tmux/shell) will send cursor show/hide codes as part of output
        if (typeof terminalData.data === 'string') {
          let handled = false;

          // SEQUENCE-BASED BUFFERING: When history request is in-flight, buffer frames
          // with their sequence numbers for later deduplication.
          // This happens BEFORE isLoadingHistoryRef check because we need to buffer
          // frames from the moment the request is sent (not when response arrives).
          if (isHistoryInFlightRef.current) {
            const sequence = terminalData.sequence ?? -1; // -1 = no sequence, include anyway
            pendingHistoryFramesRef.current.push({ sequence, data: terminalData.data });
            handled = true;

            termLog('history_buffer_frame', {
              sessionId,
              sequence,
              bufferedCount: pendingHistoryFramesRef.current.length,
            });

            // Guard: prevent unbounded growth during long in-flight period
            const MAX_PENDING_FRAMES = 1000;
            const TARGET_SIZE_AFTER_TRIM = 500;
            const MAX_PENDING_BYTES = 2 * 1024 * 1024; // 2MB

            if (pendingHistoryFramesRef.current.length > MAX_PENDING_FRAMES) {
              termLog('pending_history_frames_overflow', {
                sessionId,
                count: pendingHistoryFramesRef.current.length,
                action: 'trimming',
              });
              pendingHistoryFramesRef.current =
                pendingHistoryFramesRef.current.slice(-TARGET_SIZE_AFTER_TRIM);
            }

            const totalBytes = pendingHistoryFramesRef.current.reduce(
              (sum, f) => sum + f.data.length,
              0,
            );
            if (totalBytes > MAX_PENDING_BYTES) {
              termLog('pending_history_frames_bytes_overflow', {
                sessionId,
                totalBytes,
                action: 'dropping_oldest',
              });
              let trimmedBytes = totalBytes;
              while (
                pendingHistoryFramesRef.current.length > TARGET_SIZE_AFTER_TRIM &&
                trimmedBytes > MAX_PENDING_BYTES
              ) {
                const removed = pendingHistoryFramesRef.current.shift();
                if (removed) {
                  trimmedBytes -= removed.data.length;
                }
              }
            }
          }

          if (!handled) {
            queueOrWrite(terminalData.data);
          }
        }
        // Every sequenced live frame advances latest-observed for dirtiness — even while a
        // seed/recovery suppresses reconnect-watermark adoption, and even while buffered.
        if (terminalData.sequence !== undefined) {
          historySync.observeLiveSequence(terminalData.sequence);
        }
        // The reconnect watermark tracks APPLIED data only: frames buffered during a history
        // load are unapplied, so they must not advance it (the load's completion does).
        if (
          terminalData.sequence !== undefined &&
          !expectingSeedRef.current &&
          seedStateRef.current === null &&
          !isHistoryInFlightRef.current
        ) {
          lastSequenceRef.current = terminalData.sequence;
        }
      });

      const handleFocusChanged: Handler<{ clientId?: string | null }> = safe(
        'focus_changed',
        (focusPayload) => {
          const clientId = focusPayload?.clientId ?? null;
          const holdsAuthority = Boolean(
            clientId && activeSocket.id && clientId === activeSocket.id,
          );
          isAuthorityRef.current = holdsAuthority;
          termLog('focus_changed', { sessionId, clientId, ours: holdsAuthority });
        },
      );

      const handleSystemPing: Handler<void> = safe('system_ping', () => {
        activeSocket.emit('pong');
      });

      const handleSessionStateChange: Handler<SessionStatePayload> = safe(
        'session_state_change',
        (statePayload) => {
          if (statePayload.status === 'crashed' || statePayload.status === 'ended') {
            queueOrWrite(
              `\r\n\u001b[31m[Session ${statePayload.status}: ${
                statePayload.message || 'No message'
              }]\u001b[0m`,
            );
          }
          if (
            statePayload.status === 'ended' ||
            statePayload.status === 'crashed' ||
            statePayload.status === 'timeout'
          ) {
            onSessionEnded?.(statePayload);
          }
        },
      );

      const handleSubscribed: Handler<SubscribedPayload> = safe('subscribed', (subPayload) => {
        // Reconcile the server sequence-domain BEFORE any domain frame is processed. The ack is
        // guaranteed to precede replay/live frames, so doing it here means a domain switch's
        // cleanup runs first. reconcileEpoch drops the old baseline/observed/attempt; a genuine
        // switch additionally retires the old recovery guards, any deferred history, and the
        // reconnect watermark, so a fresh domain's lower currentSequence is accepted, not
        // suppressed against a stale higher baseline.
        if (subPayload.sequenceEpoch !== undefined) {
          const domainSwitched = historySync.reconcileEpoch(subPayload.sequenceEpoch);
          if (domainSwitched) {
            resetRecoveryDomain?.();
            cancelDeferredHistory();
            lastSequenceRef.current = 0;
            termLog('sequence_domain_switch', {
              sessionId,
              sequenceEpoch: subPayload.sequenceEpoch,
              currentSequence: subPayload.currentSequence ?? 0,
            });
          }
        }

        if (
          subPayload.currentSequence !== undefined &&
          subPayload.replayStatus !== 'gap' &&
          subPayload.replayStatus !== 'covered'
        ) {
          lastSequenceRef.current = subPayload.currentSequence;
        }

        // Immutable provider refresh capability — first-non-undefined-wins for this instance.
        historySync.adoptRefreshable(subPayload.historyRefreshable);

        // Mark this terminal as subscribed once server confirms
        isSubscribedRef.current = true;

        // Log subscription with expecting seed status
        termLog('subscribed', {
          sessionId,
          currentSequence: subPayload.currentSequence ?? 0,
          expectingSeed: expectingSeedRef.current,
        });

        // On reconnect (not expecting seed), flush pending writes immediately
        if (!expectingSeedRef.current) {
          // Clear any partial seed state
          seedStateRef.current = null;
          if (writePump.getSnapshot().status === 'seeding') writePump.completeRecovery();
          // Flush pending writes
          flushPendingWrites();
          // Covered/no-seed reconnect: content is already current, so history is ready. A gap
          // reconnect is NOT ready — its content is incomplete until the resync_required →
          // recovery that follows, so it stays unsettled (avoids a refresh against a gapped
          // baseline if the resync is delayed/reordered).
          if (subPayload.replayStatus !== 'gap') historySync.settle();
        }

        onSubscribed?.();
      });

      const handleResyncRequired: Handler<ResyncRequiredPayload> = safe(
        'resync_required',
        (resyncPayload) => {
          pendingResyncSequenceRef.current = resyncPayload.currentSequence;
          // Recovery supersedes any in-flight history: drop the attempt and its unapplied
          // buffer so a late full_history cannot mutate the write pump or baseline.
          // Preserve lastSequenceRef at the last APPLIED sequence — invalidation must not
          // rewind the reconnect watermark to a buffered-but-unapplied frame or to 0. The
          // recovery completion path later replaces it with the applied capturedSequence.
          historySync.invalidateAttempt();
          cancelDeferredHistory();
          isHistoryInFlightRef.current = false;
          isLoadingHistoryRef.current = false;
          pendingHistoryFramesRef.current = [];
          prepareForResync();
          termLog('resync_required', {
            sessionId,
            currentSequence: resyncPayload.currentSequence,
          });
        },
      );

      // Simple router
      if (topic === `terminal/${sessionId}`) {
        switch (type) {
          case 'subscribed':
            handleSubscribed(payload as SubscribedPayload);
            break;
          case 'seed_ansi':
            handleSeedAnsi(payload as TerminalSeedPayload);
            break;
          case 'seed_empty':
            handleSeedEmptyCompletion(payload as TerminalSeedEmptyPayload);
            break;
          case 'resync_required':
            handleResyncRequired(payload as ResyncRequiredPayload);
            break;
          case 'data':
            handleData(payload as TerminalDataPayload);
            break;
          case 'full_history':
            handleFullHistory(payload as FullHistoryPayload);
            break;
          case 'focus_changed':
            handleFocusChanged(payload as { clientId?: string | null });
            break;
          default:
            // intentionally ignore unknown types for terminal topic
            break;
        }
        return;
      }

      if (topic === 'system' && type === 'ping') {
        handleSystemPing(undefined);
        return;
      }

      if (topic === `session/${sessionId}` && type === 'state_change') {
        handleSessionStateChange(payload as SessionStatePayload);
      }
    },
    [
      sessionId,
      terminalRef,
      xtermRef,
      fitAddonRef,
      lastSequenceRef,
      isAuthorityRef,
      isSubscribedRef,
      historySync,
      isLoadingHistoryRef,
      isHistoryInFlightRef,
      pendingHistoryFramesRef,
      expectingSeedRef,
      pendingResyncSequenceRef,
      seedStateRef,
      prepareForResync,
      queueOrWrite,
      handleSeedChunk,
      handleSeedEmpty,
      flushPendingWrites,
      setIgnoreWindow,
      onSessionEnded,
      scrollbackLines,
      socket,
      onSubscribed,
      writePump,
      resetRecoveryDomain,
      scrollIntentControllerRef,
      cancelDeferredHistory,
    ],
  );

  return handleMessage;
}
