import { useCallback, useRef } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { termLog } from '@/ui/lib/debug';
import { getAppSocket } from '@/ui/lib/socket';
import { DEFAULT_TERMINAL_SCROLLBACK } from '@/common/constants/terminal';

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

interface SeedState {
  totalChunks: number;
  chunks: string[];
  receivedChunks: Set<number>;
  cols?: number;
  rows?: number;
  cursorX?: number;
  cursorY?: number;
  hasHistory?: boolean; // Indicates if more history is available in tmux scrollback
}

/**
 * Custom hook for managing terminal seed chunk handling with timeout and pending writes.
 * Handles seed state, chunk assembly, timeout, and pending writes flush.
 *
 * @param sessionId - Terminal session ID
 * @param xtermRef - React ref to the xterm Terminal instance
 * @param fitAddonRef - React ref to the FitAddon instance
 * @param dispatchConn - Connection state dispatcher
 * @param expectingSeedRef - Ref tracking if we're expecting a seed
 * @param hasHistoryRef - Ref tracking if history is available (for scroll-up loading)
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
  hasHistoryRef: React.MutableRefObject<boolean>,
  onSeedReady?: () => void,
  scrollbackLines: number = DEFAULT_TERMINAL_SCROLLBACK,
) {
  const seedStateRef = useRef<SeedState | null>(null);
  const seedTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pendingWritesRef = useRef<string[]>([]);
  const seedWrittenForTerminalRef = useRef<Terminal | null>(null); // Track which terminal instance had seed written
  const ignoreDataUntilRef = useRef<number>(0); // Timestamp until which to ignore incoming data (post-seed jiggle protection)

  const writeToTerminal = useCallback(
    (chunk: string) => {
      if (!chunk || !xtermRef.current) {
        return;
      }
      xtermRef.current.write(chunk);
    },
    [xtermRef],
  );

  const flushPendingWrites = useCallback(() => {
    const terminal = xtermRef.current;
    if (pendingWritesRef.current.length === 0 || !terminal) {
      return;
    }
    const combined = pendingWritesRef.current.join('');
    terminal.write(combined);
    pendingWritesRef.current.length = 0;
  }, [xtermRef]);

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

      if (seedStateRef.current) {
        // CRITICAL: Guard against unbounded buffer growth
        const MAX_PENDING_WRITES = 1000;
        const TARGET_SIZE_AFTER_TRIM = 500;
        const MAX_PENDING_BYTES = 2 * 1024 * 1024; // 2MB

        pendingWritesRef.current.push(chunk);

        // Guard: Limit by count
        if (pendingWritesRef.current.length > MAX_PENDING_WRITES) {
          termLog('pending_writes_overflow', {
            sessionId,
            count: pendingWritesRef.current.length,
            action: 'trimming',
          });
          // Keep last 500 writes
          pendingWritesRef.current = pendingWritesRef.current.slice(-TARGET_SIZE_AFTER_TRIM);
        }

        // Guard: Limit by total bytes
        const totalBytes = pendingWritesRef.current.reduce((sum, s) => sum + s.length, 0);
        if (totalBytes > MAX_PENDING_BYTES) {
          termLog('pending_writes_bytes_overflow', {
            sessionId,
            totalBytes,
            action: 'aborting_seed',
          });
          // Abort seed and flush what we have to prevent memory leak
          if (seedTimeoutRef.current) {
            clearTimeout(seedTimeoutRef.current);
            seedTimeoutRef.current = null;
          }
          seedStateRef.current = null;
          flushPendingWrites();
        }

        return;
      }
      writeToTerminal(chunk);
    },
    [writeToTerminal, sessionId, flushPendingWrites],
  );

  const handleSeedChunk = useCallback(
    (seedPayload: TerminalSeedPayload) => {
      const { chunk, totalChunks, data, cols, rows, cursorX, cursorY, hasHistory } = seedPayload;

      // CRITICAL: Check deduplication BEFORE any reset() calls
      // If this terminal instance already received a seed, ignore all new seed chunks
      if (xtermRef.current && seedWrittenForTerminalRef.current === xtermRef.current) {
        console.log('[SEED] BLOCKED - Terminal already seeded, ignoring chunk', chunk);
        return;
      }

      if (
        !seedStateRef.current ||
        chunk === 0 ||
        seedStateRef.current.totalChunks !== totalChunks
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
        };
        pendingWritesRef.current.length = 0;
        if (xtermRef.current) {
          xtermRef.current.reset();
        }

        // Set 30-second timeout for seed completion
        seedTimeoutRef.current = setTimeout(() => {
          termLog('seed_timeout', {
            sessionId,
            receivedChunks: seedStateRef.current?.receivedChunks.size,
            totalChunks: seedStateRef.current?.totalChunks,
            missingChunks: Array.from({ length: totalChunks }, (_, i) => i).filter(
              (i) => !seedStateRef.current?.receivedChunks.has(i),
            ),
          });

          // Attempt to write partial seed if we have most chunks (80%+)
          if (seedStateRef.current) {
            const received = seedStateRef.current.receivedChunks.size;
            const total = seedStateRef.current.totalChunks;
            if (received >= total * 0.8) {
              termLog('seed_partial_write', { sessionId, received, total });
              const partialSeed = seedStateRef.current.chunks
                .filter((_, idx) => seedStateRef.current!.receivedChunks.has(idx))
                .join('');
              if (xtermRef.current && partialSeed) {
                xtermRef.current.write(partialSeed);
              }
            }
          }

          // Abort seed and flush pending writes
          expectingSeedRef.current = false;
          seedStateRef.current = null;
          seedTimeoutRef.current = null;
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
        }
        if (state.receivedChunks.size >= state.totalChunks) {
          // SUCCESS: Clear timeout
          if (seedTimeoutRef.current) {
            clearTimeout(seedTimeoutRef.current);
            seedTimeoutRef.current = null;
          }

          const fullSeed = state.chunks.join('');

          // Mark that we're writing the seed for THIS terminal instance
          // (deduplication check already happened at function start)
          if (xtermRef.current) {
            seedWrittenForTerminalRef.current = xtermRef.current;
          }

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
            xtermRef.current.reset();
            xtermRef.current.clear(); // Clear buffer content (reset only resets terminal state)

            // Option A: Skip seed content, rely on scroll-up history
            // 1. Don't write seed (avoids seed/TUI content mismatch)
            // 2. Force TUI redraw → viewport shows correctly with proper cursor
            // 3. User scrolls up → history loads from tmux on demand
            xtermRef.current.options.scrollback = scrollbackLines;

            // Fit to container first to get correct dimensions for THIS terminal
            // (floating terminals may have different dimensions than seed source)
            fitAddonRef.current?.fit();
            const cols = xtermRef.current.cols;
            const rows = xtermRef.current.rows;

            termLog('seed_skip_for_tui_redraw', {
              sessionId,
              seedBytes: fullSeed.length,
              cols,
              rows,
              seedCols: state.cols,
              seedRows: state.rows,
              reason: 'option_a_scroll_up_history',
            });

            // Force TUI redraw via SIGWINCH (resize jiggle)
            // Use current terminal dimensions, not seed dimensions
            const socket = getAppSocket();
            if (socket.connected) {
              socket.emit('terminal:resize', { sessionId, cols, rows: rows - 1 });
              setTimeout(() => {
                socket.emit('terminal:resize', { sessionId, cols, rows });
                termLog('seed_trigger_resize', { sessionId, cols, rows });
              }, 50);
            }

            // Signal ready after delay for TUI to redraw
            // TUI redraw starts at ~50ms (after second resize), needs time for network + rendering
            setTimeout(() => {
              onSeedReady?.();
              termLog('seed_ready', { sessionId });
            }, 400);

            // Option A: ALWAYS enable history loading
            // Since we skip seed content and rely on TUI redraw for viewport,
            // we MUST allow users to scroll up to load clean history from tmux.
            // The seed's hasHistory flag indicates truncation, but with Option A
            // we always need tmux history because the seed was never written.
            hasHistoryRef.current = true;
            termLog('seed_hasHistory_enabled', {
              sessionId,
              reason: 'option_a_no_seed_content',
            });

            seedStateRef.current = null;
            pendingWritesRef.current.length = 0;
            dispatchConn({ type: 'SEED_COMPLETE' });
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
      hasHistoryRef,
      onSeedReady,
      scrollbackLines,
    ],
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

  return {
    seedStateRef,
    seedTimeoutRef,
    pendingWritesRef,
    writeToTerminal,
    flushPendingWrites,
    queueOrWrite,
    handleSeedChunk,
    setIgnoreWindow,
  };
}
