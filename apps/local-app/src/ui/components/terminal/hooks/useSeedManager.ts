import { useCallback, useEffect, useRef } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { termLog } from '@/ui/lib/debug';
import { DEFAULT_TERMINAL_SCROLLBACK } from '@/common/constants/terminal';
import { useTerminalWritePump } from './useTerminalWritePump';
import type { TerminalWritePumpApi } from './terminal-write-pump';
import type { TerminalHistorySync } from '../terminal-history-sync';
import type {
  TerminalResyncAbortPayload,
  TerminalResyncCompletePayload,
  TerminalSeedPayload,
  TerminalSeedEmptyPayload,
} from '@/modules/terminal/dtos/ws-envelope.dto';

interface SeedState {
  totalChunks: number;
  chunks: string[];
  receivedChunks: Set<number>;
  cols?: number;
  rows?: number;
  cursorX?: number;
  cursorY?: number;
  hasHistory?: boolean; // Indicates if more history is available in tmux scrollback
  // Recovery-seed watermark. `sequenceEpoch` scopes `recoveryEpoch`/`capturedSequence` to one
  // server sequence-domain; a callback that resolves after a domain switch checks it so a late
  // old-domain seed cannot commit a baseline or complete recovery in the new domain.
  sequenceEpoch?: string;
  recoveryEpoch?: number;
  capturedSequence?: number;
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
 * Custom hook for managing terminal seed chunk assembly and pump-ordered delivery.
 *
 * @param sessionId - Terminal session ID
 * @param xtermRef - React ref to the xterm Terminal instance
 * @param fitAddonRef - React ref to the FitAddon instance
 * @param dispatchConn - Connection state dispatcher
 * @param expectingSeedRef - Ref tracking if we're expecting a seed
 * @param historySync - History-refresh lifecycle owner (phase, baseline, snapshot has-more)
 * @param onSeedReady - Optional callback invoked after seed is ready
 * @param scrollbackLines - Number of scrollback lines (from settings)
 * @returns Object containing seed state management functions
 */
export function useSeedManager(
  sessionId: string,
  xtermRef: React.RefObject<Terminal | null>,
  fitAddonRef: React.RefObject<FitAddon | null>,
  dispatchConn: React.Dispatch<{
    type:
      | 'SOCKET_CONNECT'
      | 'SOCKET_DISCONNECT'
      | 'SUBSCRIBE_ATTEMPT'
      | 'SEED_START'
      | 'SEED_COMPLETE'
      | 'SEED_TIMEOUT'
      | 'ERROR';
    message?: string;
  }>,
  expectingSeedRef: React.MutableRefObject<boolean>,
  historySync: TerminalHistorySync,
  onSeedReady?: () => void,
  scrollbackLines: number = DEFAULT_TERMINAL_SCROLLBACK,
  providedWritePump?: TerminalWritePumpApi,
  onRecoveryComplete?: (payload: TerminalResyncCompletePayload) => void,
  onRecoveryTimeout?: (payload: TerminalResyncAbortPayload, retryAllowed: boolean) => void,
  onEmptySeedComplete?: (payload: TerminalSeedEmptyPayload) => void,
) {
  const seedStateRef = useRef<SeedState | null>(null);
  const seedTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const seedWrittenForTerminalRef = useRef<Terminal | null>(null); // Track which terminal instance had seed written
  const ignoreDataUntilRef = useRef<number>(0); // Timestamp until which to ignore incoming data (post-seed jiggle protection)
  const completedRecoveryEpochRef = useRef<number>(-1);
  const abortedRecoveryEpochRef = useRef<number>(-1);
  const recoveryRetryUsedRef = useRef(false);
  const fallbackWritePump = useTerminalWritePump(xtermRef, () => undefined);
  const writePump = providedWritePump ?? fallbackWritePump;

  const writeToTerminal = useCallback(
    (chunk: string) => {
      if (!chunk) return;
      writePump.write(chunk, { kind: 'live' });
    },
    [writePump],
  );

  const flushPendingWrites = useCallback(() => {
    writePump.flush();
  }, [writePump]);

  const queueOrWrite = useCallback(
    (chunk: string) => {
      // Post-seed jiggle protection: ignore data during the window after seed write
      // to prevent TUI redraw responses from duplicating content
      if (ignoreDataUntilRef.current > 0 && Date.now() < ignoreDataUntilRef.current) {
        return;
      }
      if (ignoreDataUntilRef.current > 0) {
        ignoreDataUntilRef.current = 0;
      }

      writeToTerminal(chunk);
    },
    [writeToTerminal],
  );

  const prepareForResync = useCallback(() => {
    if (seedTimeoutRef.current) {
      clearTimeout(seedTimeoutRef.current);
      seedTimeoutRef.current = null;
    }
    seedWrittenForTerminalRef.current = null;
    writePump.beginRecovery();
    // Recovery unsettles history and drops any active attempt (a late full_history from the
    // pre-recovery attempt must not touch the write pump or baseline).
    historySync.beginRecovery();
    expectingSeedRef.current = true;
    seedStateRef.current = {
      totalChunks: 0,
      chunks: [],
      receivedChunks: new Set<number>(),
    };
    dispatchConn({ type: 'SEED_START' });
  }, [dispatchConn, expectingSeedRef, historySync, writePump]);

  const handleSeedChunk = useCallback(
    (seedPayload: TerminalSeedPayload) => {
      const {
        chunk,
        totalChunks,
        data,
        cols,
        rows,
        cursorX,
        cursorY,
        hasHistory,
        sequenceEpoch,
        recoveryEpoch,
        capturedSequence,
      } = seedPayload;
      const isRecoverySeed = recoveryEpoch !== undefined && capturedSequence !== undefined;

      // Recovery state is domain-scoped: once a live domain is known, a recovery seed MUST carry the
      // matching `sequenceEpoch`. Fail closed on a missing OR mismatched epoch so a retired-domain
      // chunk (or an un-stamped one) is never assembled or written into the new domain. When no
      // domain is known yet (pre-subscribe), there is nothing to conflict with, so it is allowed.
      const currentEpoch = historySync.getSequenceEpoch();
      if (isRecoverySeed && currentEpoch !== null && sequenceEpoch !== currentEpoch) {
        return;
      }

      if (
        recoveryEpoch !== undefined &&
        (recoveryEpoch <= completedRecoveryEpochRef.current ||
          recoveryEpoch <= abortedRecoveryEpochRef.current ||
          (seedStateRef.current?.recoveryEpoch !== undefined &&
            recoveryEpoch < seedStateRef.current.recoveryEpoch))
      ) {
        return;
      }

      // CRITICAL: Check deduplication BEFORE any reset() calls
      // If this terminal instance already received a seed, ignore all new seed chunks
      if (
        xtermRef.current &&
        seedWrittenForTerminalRef.current === xtermRef.current &&
        !writePump.isDesynchronized() &&
        !isRecoverySeed
      ) {
        console.log('[SEED] BLOCKED - Terminal already seeded, ignoring chunk', chunk);
        return;
      }

      const activeSeed = seedStateRef.current;
      if (
        !activeSeed ||
        activeSeed.totalChunks !== totalChunks ||
        (isRecoverySeed && activeSeed.recoveryEpoch !== recoveryEpoch) ||
        (!isRecoverySeed && chunk === 0 && activeSeed.receivedChunks.size > 0)
      ) {
        dispatchConn({ type: 'SEED_START' });
        if (seedTimeoutRef.current) {
          clearTimeout(seedTimeoutRef.current);
          seedTimeoutRef.current = null;
        }

        // Clear expecting seed flag now that first seed has arrived
        if (expectingSeedRef.current) {
          expectingSeedRef.current = false;
        }
        seedStateRef.current = {
          totalChunks,
          chunks: Array.from({ length: totalChunks }, () => ''),
          receivedChunks: new Set<number>(),
          cols,
          rows,
          hasHistory, // Store for conditional use at seed completion
          sequenceEpoch,
          recoveryEpoch,
          capturedSequence,
        };
        // A fresh seed/recovery is a mount-time replay phase, not browsable history yet:
        // unsettle now, re-settle only after xterm applies the async replacement write below.
        if (isRecoverySeed || writePump.isDesynchronized()) {
          writePump.beginRecovery();
          historySync.beginRecovery();
        } else {
          writePump.beginSeed();
          historySync.beginSeed();
        }
        if (xtermRef.current) {
          xtermRef.current.reset();
        }

        // Set 30-second timeout for seed completion
        seedTimeoutRef.current = setTimeout(() => {
          const timedOutState = seedStateRef.current;
          termLog('seed_timeout', {
            sessionId,
            receivedChunks: timedOutState?.receivedChunks.size,
            totalChunks: timedOutState?.totalChunks,
            missingChunks: Array.from({ length: totalChunks }, (_, i) => i).filter(
              (i) => !timedOutState?.receivedChunks.has(i),
            ),
          });

          if (timedOutState?.recoveryEpoch !== undefined) {
            abortedRecoveryEpochRef.current = Math.max(
              abortedRecoveryEpochRef.current,
              timedOutState.recoveryEpoch,
            );
            const retryAllowed = !recoveryRetryUsedRef.current;
            recoveryRetryUsedRef.current = true;
            expectingSeedRef.current = true;
            seedStateRef.current = null;
            seedTimeoutRef.current = null;
            dispatchConn({ type: 'SEED_TIMEOUT' });
            onRecoveryTimeout?.(
              {
                sessionId,
                sequenceEpoch: timedOutState.sequenceEpoch,
                recoveryEpoch: timedOutState.recoveryEpoch,
              },
              retryAllowed,
            );
            return;
          }

          // Initial seeds retain the established best-effort partial-write policy.
          if (timedOutState) {
            const received = timedOutState.receivedChunks.size;
            const total = timedOutState.totalChunks;
            if (received >= total * 0.8) {
              termLog('seed_partial_write', { sessionId, received, total });
              const partialSeed = timedOutState.chunks
                .filter((_, idx) => timedOutState.receivedChunks.has(idx))
                .join('');
              if (xtermRef.current && partialSeed) {
                writePump.write(partialSeed, {
                  kind: 'seed',
                  onComplete: () => writePump.completeRecovery(),
                });
              }
            }
          }

          // Abort seed and flush pending writes
          expectingSeedRef.current = false;
          seedStateRef.current = null;
          seedTimeoutRef.current = null;
          if (writePump.getSnapshot().status === 'seeding') writePump.completeRecovery();
          flushPendingWrites();
          dispatchConn({ type: 'SEED_TIMEOUT' });
        }, 30000);
      }

      const state = seedStateRef.current;
      if (state) {
        const boundedIndex = Math.max(0, Math.min(chunk, totalChunks - 1));
        if (!state.receivedChunks.has(boundedIndex)) {
          state.receivedChunks.add(boundedIndex);
        }
        state.chunks[boundedIndex] = data || '';
        if (chunk === totalChunks - 1) {
          // Extract metadata from final chunk
          if (cols !== undefined && rows !== undefined) {
            state.cols = cols;
            state.rows = rows;
          }
          if (cursorX !== undefined) {
            state.cursorX = cursorX;
          }
          if (cursorY !== undefined) {
            state.cursorY = cursorY;
          }
          if (hasHistory !== undefined) {
            state.hasHistory = hasHistory;
          }
          if (recoveryEpoch !== undefined && capturedSequence !== undefined) {
            state.sequenceEpoch = sequenceEpoch;
            state.recoveryEpoch = recoveryEpoch;
            state.capturedSequence = capturedSequence;
          }
        }
        if (state.receivedChunks.size >= state.totalChunks) {
          // SUCCESS: Clear timeout
          if (seedTimeoutRef.current) {
            clearTimeout(seedTimeoutRef.current);
            seedTimeoutRef.current = null;
          }

          const fullSeed = state.chunks.join('');

          if (xtermRef.current) {
            if (state.cols !== undefined && state.rows !== undefined) {
              xtermRef.current.resize(state.cols, state.rows);
            }

            termLog('seed_dimensions', {
              sessionId,
              bytes: fullSeed.length,
              cols: xtermRef.current.cols,
              rows: xtermRef.current.rows,
            });
            // Fit to container first to get correct dimensions for THIS terminal
            // (floating terminals may have different dimensions than seed source)
            fitAddonRef.current?.fit();
            const cols = xtermRef.current.cols;
            const rows = xtermRef.current.rows;
            const cursorPositionSequence = buildCursorPositionSequence(
              state.cursorX,
              state.cursorY,
              cols,
              rows,
            );

            // A recovery seed is bound to the domain it was captured in. If the live domain moves off
            // state.sequenceEpoch while this replacement write settles asynchronously, EVERY remaining
            // boundary — the cursor write, completion, and the readiness timer — belongs to a retired
            // domain and must fail closed before touching shared state (pump, seed ref, dispatch,
            // history lifecycle, baseline, readiness). Epochs are opaque and restart-unique, so
            // equality is a valid domain-generation check. Initial seeds carry no recoveryEpoch and
            // are never retired here; a live domain is known whenever a recovery is in flight.
            const isRetiredRecoveryWrite = () => {
              const liveEpoch = historySync.getSequenceEpoch();
              return (
                state.recoveryEpoch !== undefined &&
                liveEpoch !== null &&
                state.sequenceEpoch !== liveEpoch
              );
            };

            let finishedSeedWrite = false;
            const finishSeedWrite = () => {
              if (finishedSeedWrite) {
                return;
              }
              finishedSeedWrite = true;

              if (isRetiredRecoveryWrite()) {
                return;
              }

              writePump.completeRecovery();
              seedStateRef.current = null;
              dispatchConn({ type: 'SEED_COMPLETE' });

              if (
                state.recoveryEpoch !== undefined &&
                state.capturedSequence !== undefined &&
                state.recoveryEpoch > completedRecoveryEpochRef.current
              ) {
                completedRecoveryEpochRef.current = state.recoveryEpoch;
                recoveryRetryUsedRef.current = false;
                // Adopt the recovery capture as the history baseline only now that the
                // replacement write has settled: the screen reflects capturedSequence, so an
                // unchanged excursion afterward is not treated as dirty.
                historySync.commitBaseline(state.capturedSequence);
                onRecoveryComplete?.({
                  sessionId,
                  sequenceEpoch: state.sequenceEpoch,
                  recoveryEpoch: state.recoveryEpoch,
                  capturedSequence: state.capturedSequence,
                });
              }

              // xterm.write is asynchronous and can emit internal scroll events while
              // replaying the seed. Settle the history lifecycle only after the replacement
              // write completes, so mount-time buffer movement is not mistaken for a scroll-up.
              // snapshotHasMore records the per-snapshot has-more (never the refresh capability,
              // which the subscribed ack owns); the request gate keys off capability + dirtiness.
              historySync.setSnapshotHasMore(state.hasHistory === true);
              historySync.settle();
              termLog('seed_hasHistory_resolved', {
                sessionId,
                snapshotHasMore: state.hasHistory === true,
                reason: 'seed_write_settled',
              });

              // Signal ready after a short delay so the xterm write/render settles. Re-check the live
              // domain: a recovery can clear finishSeedWrite in epoch B, then the domain can switch to
              // C before this fires — a stale readiness signal must not mark the new domain ready.
              setTimeout(() => {
                if (isRetiredRecoveryWrite()) {
                  return;
                }
                onSeedReady?.();
                termLog('seed_ready', { sessionId });
              }, 400);
            };

            // Write the captured tmux scrollback so the viewport has visible content
            // immediately. Do not force a resize jiggle here: subscribe already sized
            // the PTY, and repeated mount-time SIGWINCH can mutate full-screen TUIs.
            const writeCursorOrFinish = () => {
              // Bail before scrollToBottom / the cursor write: a replacement write that settled after
              // a domain switch must not scroll the live domain's viewport or queue a stale cursor
              // position sequence into it.
              if (isRetiredRecoveryWrite()) {
                return;
              }
              xtermRef.current?.scrollToBottom();
              if (cursorPositionSequence) {
                writePump.write(cursorPositionSequence, {
                  kind: 'seed',
                  onComplete: finishSeedWrite,
                });
              } else {
                finishSeedWrite();
              }
            };
            const accepted = writePump.write(fullSeed, {
              kind: 'seed',
              beforeWrite: () => {
                const current = xtermRef.current;
                if (!current) return;
                current.reset();
                current.clear();
                current.options.scrollback = scrollbackLines;
              },
              onComplete: writeCursorOrFinish,
            });
            seedWrittenForTerminalRef.current = accepted ? xtermRef.current : null;

            termLog('seed_written', {
              sessionId,
              seedBytes: fullSeed.length,
              cols,
              rows,
              seedCols: state.cols,
              seedRows: state.rows,
            });
          }
        }
      }
    },
    [
      sessionId,
      xtermRef,
      fitAddonRef,
      dispatchConn,
      flushPendingWrites,
      expectingSeedRef,
      historySync,
      onSeedReady,
      onRecoveryComplete,
      onRecoveryTimeout,
      scrollbackLines,
      writePump,
    ],
  );

  /**
   * Resolve a successful empty initial capture. The server sends this instead of a seed
   * chunk when the first capture was empty; it must complete the seed attempt WITHOUT
   * resetting xterm, clearing already-rendered live rows, or driving the write pump's
   * seed/recovery machinery (the pump never entered seeding for an empty capture).
   */
  const handleSeedEmpty = useCallback(
    (payload: TerminalSeedEmptyPayload) => {
      // Scoped to the initial attach that is awaiting a seed; ignore any stray completion
      // so it cannot clobber a healthy settled session's baseline.
      if (!expectingSeedRef.current) {
        termLog('seed_empty_ignored', { sessionId, reason: 'not_expecting_seed' });
        return;
      }
      if (seedTimeoutRef.current) {
        clearTimeout(seedTimeoutRef.current);
        seedTimeoutRef.current = null;
      }
      seedStateRef.current = null;
      expectingSeedRef.current = false;

      // Adopt the baseline (0 is valid) and settle readiness. No reset / beginSeed /
      // completeRecovery: the write pump did not enter seeding for an empty capture.
      historySync.commitBaseline(payload.capturedSequence);
      historySync.setSnapshotHasMore(false);
      historySync.settle();
      onEmptySeedComplete?.(payload);

      dispatchConn({ type: 'SEED_COMPLETE' });
      termLog('seed_empty_completion', {
        sessionId,
        capturedSequence: payload.capturedSequence,
      });
      onSeedReady?.();
    },
    [dispatchConn, expectingSeedRef, historySync, onEmptySeedComplete, onSeedReady, sessionId],
  );

  useEffect(
    () => () => {
      if (seedTimeoutRef.current) clearTimeout(seedTimeoutRef.current);
      seedTimeoutRef.current = null;
      seedStateRef.current = null;
      seedWrittenForTerminalRef.current = null;
    },
    [],
  );

  /**
   * Set an ignore window to block incoming data for a duration.
   * Used after history load to prevent TUI redraw duplicates (same issue as post-seed jiggle).
   */
  const setIgnoreWindow = useCallback(
    (durationMs: number) => {
      ignoreDataUntilRef.current = Date.now() + durationMs;
      termLog('ignore_window_set', { sessionId, durationMs });
    },
    [sessionId],
  );

  const resetRecoveryTimeoutEpisode = useCallback(() => {
    recoveryRetryUsedRef.current = false;
  }, []);

  // Retire the recovery pipeline when the server sequence-domain switches. Resets the domain-local
  // numeric guards (so domain B's recoveryEpoch 1 is not rejected against domain A's 6) AND cancels
  // any in-flight recovery seed's assembly timeout + partial state, so a retiring-domain timeout or
  // late chunk cannot settle the new domain. In-flight pump write callbacks additionally fail closed
  // in finishSeedWrite via the live-epoch check (the pump owns callbacks minted before this reset).
  const resetRecoveryDomain = useCallback(() => {
    completedRecoveryEpochRef.current = -1;
    abortedRecoveryEpochRef.current = -1;
    recoveryRetryUsedRef.current = false;
    if (seedTimeoutRef.current) {
      clearTimeout(seedTimeoutRef.current);
      seedTimeoutRef.current = null;
    }
    if (seedStateRef.current?.recoveryEpoch !== undefined) {
      // Bump the write pump's epoch so an in-flight recovery replacement write's onComplete (the
      // cursor write, then finishSeedWrite) is skipped and any queued old-domain batch is dropped —
      // the async pump callbacks then cannot run against the new domain's terminal.
      writePump.discardPending();
      seedStateRef.current = null;
    }
  }, [writePump]);

  return {
    seedStateRef,
    seedTimeoutRef,
    writeToTerminal,
    flushPendingWrites,
    queueOrWrite,
    prepareForResync,
    handleSeedChunk,
    handleSeedEmpty,
    setIgnoreWindow,
    resetRecoveryTimeoutEpisode,
    resetRecoveryDomain,
  };
}
