import { useCallback } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { getAppSocket, type WsEnvelope } from '@/ui/lib/socket';
import { termLog } from '@/ui/lib/debug';
import { DEFAULT_TERMINAL_SCROLLBACK } from '@/common/constants/terminal';

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

interface TerminalSeedPayload {
  data: string;
  chunk: number;
  totalChunks: number;
  totalLines?: number;
  hasHistory?: boolean;
  cols?: number;
  rows?: number;
  cursorX?: number;
  cursorY?: number;
}

interface SessionStatePayload {
  sessionId: string;
  status: 'started' | 'ended' | 'crashed' | 'timeout';
  message?: string;
}

interface SubscribedPayload {
  currentSequence?: number;
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
 * @param hasHistoryRef - Ref tracking scrollback history availability
 * @param isLoadingHistoryRef - Ref tracking if history is currently being loaded
 * @param isHistoryInFlightRef - Ref tracking if history request is in-flight (for buffering)
 * @param pendingHistoryFramesRef - Ref to buffer frames during in-flight for sequence-based dedup
 * @param expectingSeedRef - Ref tracking if we're expecting a seed
 * @param seedStateRef - Ref to current seed assembly state
 * @param pendingWritesRef - Ref to pending writes buffer
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
  hasHistoryRef: React.MutableRefObject<boolean>,
  isLoadingHistoryRef: React.MutableRefObject<boolean>,
  historyViewportOffsetRef: React.MutableRefObject<number | null>,
  isHistoryInFlightRef: React.MutableRefObject<boolean>,
  pendingHistoryFramesRef: React.MutableRefObject<BufferedFrame[]>,
  lastCapturedSequenceRef: React.MutableRefObject<number>,
  expectingSeedRef: React.MutableRefObject<boolean>,
  seedStateRef: React.MutableRefObject<{
    totalChunks: number;
    chunks: string[];
    receivedChunks: Set<number>;
    cols?: number;
    rows?: number;
    cursorX?: number;
    cursorY?: number;
  } | null>,
  pendingWritesRef: React.MutableRefObject<string[]>,
  queueOrWrite: (data: string) => void,
  handleSeedChunk: (payload: TerminalSeedPayload) => void,
  flushPendingWrites: () => void,
  setIgnoreWindow: (durationMs: number) => void,
  onSessionEnded?: (payload: SessionStatePayload) => void,
  scrollbackLines: number = DEFAULT_TERMINAL_SCROLLBACK,
) {
  const handleMessage = useCallback(
    (envelope: WsEnvelope) => {
      const { topic, type, payload } = envelope;

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

      const handleSeedAnsi: Handler<TerminalSeedPayload> = safe('seed_ansi', (seedPayload) => {
        // Set hasHistoryRef based on server's hasHistory flag
        // true = more history available in tmux scrollback, can request via scroll-up
        // false = seed contains all available history
        if (
          typeof (seedPayload as TerminalSeedPayload & { hasHistory?: boolean }).hasHistory !==
          'undefined'
        ) {
          hasHistoryRef.current = (
            seedPayload as TerminalSeedPayload & { hasHistory?: boolean }
          ).hasHistory!;
        }
        handleSeedChunk(seedPayload);
      });

      const handleFullHistory: Handler<{
        history?: string;
        cursorX?: number;
        cursorY?: number;
        hasHistory?: boolean; // P1: Server sends this when response was truncated due to maxBytes
        capturedSequence?: number; // Sequence at capture time for deduplication
      }> = safe('full_history', (p) => {
        const h = p?.history ?? '';
        const capturedSequence = p?.capturedSequence ?? 0;
        const xterm = xtermRef.current;

        // Always keep hasHistoryRef true to allow refresh on scroll-up
        // This enables users to get latest tmux state during active streaming
        hasHistoryRef.current = true;

        if (!xterm) {
          // Clear in-flight state even if xterm is not available
          isHistoryInFlightRef.current = false;
          pendingHistoryFramesRef.current = [];
          return;
        }

        // Check if history actually has new data
        // If capturedSequence is same or lower, no new data arrived since last load
        // First load (lastCapturedSequenceRef.current === 0) always processes
        const lastCaptured = lastCapturedSequenceRef.current;
        const isFirstLoad = lastCaptured === 0;
        const hasNewData = capturedSequence > lastCaptured;
        const bufferedFrameCount = pendingHistoryFramesRef.current.length;

        termLog('history_load_start', {
          sessionId,
          historyLength: h.length,
          capturedSequence,
          lastCapturedSequence: lastCaptured,
          isFirstLoad,
          hasNewData,
          bufferedFrames: bufferedFrameCount,
        });

        // Skip refresh if:
        // - NOT the first load (we always process first load)
        // - AND no new data (capturedSequence didn't increase)
        // - AND no buffered frames to merge
        if (!isFirstLoad && !hasNewData && bufferedFrameCount === 0) {
          termLog('history_skip_unchanged', {
            sessionId,
            capturedSequence,
            lastCapturedSequence: lastCaptured,
            reason: 'no_new_data',
          });
          isHistoryInFlightRef.current = false;
          pendingHistoryFramesRef.current = [];
          return;
        }

        // Update last captured sequence
        lastCapturedSequenceRef.current = capturedSequence;

        // Set loading flag BEFORE any xterm operations to pause scroll detection
        isLoadingHistoryRef.current = true;

        // Save current scroll position to restore later
        // We restore position unless user was exactly at the bottom
        const buffer = xterm.buffer.active;
        const savedViewportY = buffer.viewportY;
        const savedBaseY = buffer.baseY;
        const wasAtBottom = savedViewportY === savedBaseY;

        if (h) {
          // Enable scrollback, reset, and write full history
          xterm.options.scrollback = scrollbackLines;
          xterm.reset();
          xterm.clear();

          // Write complete history
          if (h.length > 0) {
            xterm.write(h, () => {
              // SEQUENCE-BASED MERGE: Filter and flush buffered frames
              // Only include frames with sequence > capturedSequence (new frames after capture)
              // or frames with sequence === -1 (no sequence, include anyway as safety)
              const newFrames = pendingHistoryFramesRef.current.filter(
                (f) => f.sequence > capturedSequence || f.sequence === -1,
              );

              termLog('history_flush_frames', {
                sessionId,
                totalBuffered: pendingHistoryFramesRef.current.length,
                newFrames: newFrames.length,
                capturedSequence,
              });

              // Write new frames in order (they have preserved ANSI data)
              newFrames.forEach((f) => xterm.write(f.data));

              // Clear buffered frames and in-flight state
              pendingHistoryFramesRef.current = [];
              isHistoryInFlightRef.current = false;

              termLog('history_written', {
                sessionId,
                historyBytes: h.length,
                mergedFrames: newFrames.length,
              });

              // Restore scroll position (don't jump to bottom unless user was at bottom)
              if (!wasAtBottom) {
                // User was viewing history, restore their position
                // Calculate offset from bottom to maintain relative position
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

              // NOTE: We intentionally do NOT send SIGWINCH jiggle after history load.
              // The TUI (Claude Code) will naturally update when user scrolls down and
              // interacts. Sending SIGWINCH would cause TUI to redraw and potentially
              // add garbled content to the scrollback we just loaded.

              // Clear pending writes (legacy) and finish loading
              pendingWritesRef.current.length = 0;
              isLoadingHistoryRef.current = false;

              termLog('history_load_complete', { sessionId });
            });
          } else {
            // Empty history string but h was truthy (shouldn't happen)
            pendingHistoryFramesRef.current = [];
            isHistoryInFlightRef.current = false;
            pendingWritesRef.current.length = 0;
            isLoadingHistoryRef.current = false;
          }

          termLog('full_history_loaded', { sessionId, historyBytes: h.length });
        } else {
          // No history payload; clear all state and stop loading.
          pendingHistoryFramesRef.current = [];
          isHistoryInFlightRef.current = false;
          pendingWritesRef.current.length = 0;
          isLoadingHistoryRef.current = false;
        }
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

          // Legacy: While full history is being written into xterm, buffer incoming frames.
          // This handles the case after history response arrives and xterm.write is in progress.
          if (!handled && isLoadingHistoryRef.current) {
            pendingWritesRef.current.push(terminalData.data);
            handled = true;

            // Guard: prevent unbounded growth during long history writes
            const MAX_PENDING_WRITES = 1000;
            const TARGET_SIZE_AFTER_TRIM = 500;
            const MAX_PENDING_BYTES = 2 * 1024 * 1024; // 2MB

            if (pendingWritesRef.current.length > MAX_PENDING_WRITES) {
              termLog('pending_writes_overflow', {
                sessionId,
                count: pendingWritesRef.current.length,
                action: 'trimming',
              });
              pendingWritesRef.current = pendingWritesRef.current.slice(-TARGET_SIZE_AFTER_TRIM);
            }

            const totalBytes = pendingWritesRef.current.reduce((sum, s) => sum + s.length, 0);
            if (totalBytes > MAX_PENDING_BYTES) {
              termLog('pending_writes_bytes_overflow', {
                sessionId,
                totalBytes,
                action: 'dropping_oldest',
              });
              // Drop oldest writes until we're back under the target threshold.
              let trimmedBytes = totalBytes;
              while (
                pendingWritesRef.current.length > TARGET_SIZE_AFTER_TRIM &&
                trimmedBytes > MAX_PENDING_BYTES
              ) {
                const removed = pendingWritesRef.current.shift();
                if (removed) {
                  trimmedBytes -= removed.length;
                }
              }
            }
          }

          if (!handled) {
            queueOrWrite(terminalData.data);
          }
        }
        if (terminalData.sequence !== undefined) {
          lastSequenceRef.current = terminalData.sequence;
        }
      });

      const handleFocusChanged: Handler<{ clientId?: string | null }> = safe(
        'focus_changed',
        (focusPayload) => {
          const socket = getAppSocket();
          const clientId = focusPayload?.clientId ?? null;
          const holdsAuthority = Boolean(clientId && socket.id && clientId === socket.id);
          isAuthorityRef.current = holdsAuthority;
          termLog('focus_changed', { sessionId, clientId, ours: holdsAuthority });
        },
      );

      const handleSystemPing: Handler<void> = safe('system_ping', () => {
        const socket = getAppSocket();
        socket.emit('pong');
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
        // Update last sequence from server
        if (subPayload.currentSequence !== undefined) {
          lastSequenceRef.current = subPayload.currentSequence;
        }

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
          // Flush pending writes
          flushPendingWrites();
        }
      });

      // Simple router
      if (topic === `terminal/${sessionId}`) {
        switch (type) {
          case 'subscribed':
            handleSubscribed(payload as SubscribedPayload);
            break;
          case 'seed_ansi':
            handleSeedAnsi(payload as TerminalSeedPayload);
            break;
          case 'data':
            handleData(payload as TerminalDataPayload);
            break;
          case 'full_history':
            handleFullHistory(payload as { history?: string });
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
      hasHistoryRef,
      isHistoryInFlightRef,
      pendingHistoryFramesRef,
      lastCapturedSequenceRef,
      expectingSeedRef,
      seedStateRef,
      pendingWritesRef,
      queueOrWrite,
      handleSeedChunk,
      flushPendingWrites,
      setIgnoreWindow,
      onSessionEnded,
      scrollbackLines,
    ],
  );

  return handleMessage;
}
