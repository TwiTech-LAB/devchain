import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { fetchSettings } from '@/ui/lib/settings';
import { cn } from '@/ui/lib/utils';
import { Textarea } from '@/ui/components/ui/textarea';
import { Button } from '@/ui/components/ui/button';
import '@xterm/xterm/css/xterm.css';
import { termLog } from '@/ui/lib/debug';
import { useAppSocket } from '@/ui/hooks/useAppSocket';
import { useHomeSocket } from '@/ui/hooks/useHomeSocket';
import type { WsEnvelope } from '@/ui/lib/socket';
import { useAppTheme } from '@/ui/hooks/useAppTheme';
import {
  DEFAULT_TERMINAL_SCROLLBACK,
  DEFAULT_TERMINAL_SUPPRESS_CTRL_C_WITH_SELECTION,
} from '@/common/constants/terminal';
import {
  useXterm,
  useTerminalResize,
  useTerminalSubscription,
  useSeedManager,
  useTerminalMessageHandlers,
  useTerminalFocus,
  useTerminalThemeSync,
  useTerminalWritePump,
} from './hooks';
import { connectionReducer } from './connectionReducer';
import { createTerminalHistorySync } from './terminal-history-sync';
import { resetTerminal } from './xterm-utils';
import type { TerminalHistorySync } from './terminal-history-sync';
import type { ScrollIntentController } from './scroll-intent-binding';
import { resolveTerminalTheme } from './terminal-themes';
import { normalizeTerminalEnvelopeForTheme } from './terminal-output-theme';
import type { ChatTerminalProps } from './types';
import type {
  TerminalResyncAbortPayload,
  TerminalResyncCompletePayload,
  TerminalResyncRequestPayload,
  TerminalPromptPasteAck,
  TerminalPromptPasteFailureCode,
  TerminalPromptPasteInput,
} from '@/modules/terminal/dtos/ws-envelope.dto';
import { TerminalPromptPasteAckSchema } from '@/modules/terminal/dtos/ws-envelope.dto';
import { createPasteRequestId, createTtyImagePaste } from './tty-image-paste';
import { useFormImageDraft } from './useFormImageDraft';
import type { FormEditSelection } from './form-image-draft';
import { useOptionalBackend } from '@/ui/lib/backend-context';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';
import { toast } from '@/ui/hooks/use-toast';
import {
  createTerminalClipboardPasteBinding,
  readClipboardImages,
  type ClipboardFilePaste,
} from './terminal-clipboard-paste';

const RECOVERY_ABORT_ACK_TIMEOUT_MS = 5000;
export const PROMPT_PASTE_ACK_TIMEOUT_MS = 5000;
const PROMPT_PASTE_ACK_ATTEMPTS = 2;

export type TerminalPromptInsertErrorCode =
  | TerminalPromptPasteFailureCode
  | 'ACK_TIMEOUT'
  | 'INVALID_ACK'
  | 'NOT_READY';

export class TerminalPromptInsertError extends Error {
  constructor(
    readonly code: TerminalPromptInsertErrorCode,
    readonly requestId: string,
  ) {
    super(`Terminal prompt insertion failed (${code})`);
    this.name = 'TerminalPromptInsertError';
  }
}

export interface ChatTerminalHandle {
  clear: () => void;
  focus: () => void;
  fit: () => void;
  insertPromptText: (text: string) => Promise<void>;
}

export const ChatTerminal = forwardRef<ChatTerminalHandle, ChatTerminalProps>(function ChatTerminal(
  {
    sessionId,
    projectId,
    visible = true,
    className,
    chrome = 'default',
    ariaLabel = 'Agent terminal',
    onSessionEnded,
    onClipboardImagePaste,
    socket: socketTarget = 'project',
  }: ChatTerminalProps,
  ref,
) {
  const fetchFn = useFetchFactory();
  const backend = useOptionalBackend();
  const projectBackend = backend?.bindings.get(projectId ?? '') ?? 'home';
  const imageTargetReady = !backend || (backend.ready && backend.activeBackend === projectBackend);
  const ttyImages = useRef<ReturnType<typeof createTtyImagePaste> | null>(null);
  const appTheme = useAppTheme();
  const [inputMode, setInputMode] = useState<'form' | 'tty' | null>(null); // null = loading
  const [scrollbackLines, setScrollbackLines] = useState<number>(DEFAULT_TERMINAL_SCROLLBACK); // Default until loaded
  const suppressCtrlCWithSelectionRef = useRef(DEFAULT_TERMINAL_SUPPRESS_CTRL_C_WITH_SELECTION);
  const [isTerminalReady, setIsTerminalReady] = useState(false);
  const [conn, dispatchConn] = useReducer(connectionReducer, {
    status: 'connecting',
    srAnnouncement: 'Connecting to terminal…',
  });

  const terminalRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isAuthorityRef = useRef<boolean>(false);
  const isLoadingHistoryRef = useRef<boolean>(false);
  const isHistoryInFlightRef = useRef<boolean>(false);
  const pendingHistoryFramesRef = useRef<{ sequence: number; data: string }[]>([]);
  // Single owner of the history-refresh lifecycle: provider refresh capability, phase/readiness,
  // per-snapshot has-more, nullable accepted baseline, latest-observed sequence, active attempt.
  const historySyncRef = useRef<TerminalHistorySync | null>(null);
  if (!historySyncRef.current) historySyncRef.current = createTerminalHistorySync();
  const historySync = historySyncRef.current;
  const containerClassName = cn(
    'relative flex h-full min-h-0 w-full flex-col overflow-hidden text-terminal-foreground',
    chrome === 'none' ? 'bg-transparent' : 'rounded-xl border border-border bg-terminal shadow-sm',
    className,
  );
  const useSocket = socketTarget === 'home' ? useHomeSocket : useAppSocket;
  const socket = useSocket({}, []);
  const formProject =
    inputMode === 'form' && imageTargetReady && socketTarget === 'project' ? projectId : null;
  const form = useFormImageDraft(inputRef, sessionId, projectId, projectBackend, socket, fetchFn);
  const liveForm = useRef(form);
  liveForm.current = form;
  const livePromptInsertRef = useRef({ inputMode, sessionId, socket });
  livePromptInsertRef.current = { inputMode, sessionId, socket };
  const onClipboardImagePasteRef = useRef(onClipboardImagePaste);
  onClipboardImagePasteRef.current = onClipboardImagePaste;

  const handleClipboardFiles = useCallback(
    (paste: ClipboardFilePaste) => {
      if (!inputMode) return;
      const consume = onClipboardImagePasteRef.current;
      const readResult = readClipboardImages(paste);
      const event = { inputMode, browserFileCount: paste.browserFileCount, readResult };
      if (!consume && inputMode === 'tty' && ttyImages.current) {
        void ttyImages.current.start(event);
        return;
      }
      if (!consume && inputMode === 'form' && formProject) {
        liveForm.current.paste(paste, readResult);
        return;
      }
      consume?.(event);

      void readResult.then(({ images, unsupportedFileCount, unreadableFileCount }) => {
        const details = [
          `The browser supplied ${paste.browserFileCount} ${paste.browserFileCount === 1 ? 'file' : 'files'}.`,
        ];
        if (unsupportedFileCount)
          details.push(`Unsupported format (${unsupportedFileCount}). Use PNG or JPEG.`);
        if (unreadableFileCount)
          details.push(
            `Could not read ${unreadableFileCount} ${unreadableFileCount === 1 ? 'file' : 'files'}.`,
          );
        if (!consume && images.length > 0)
          details.push('Image attachments are unavailable for this terminal.');
        if (details.length === 1) return;

        toast({
          title: 'Clipboard files could not all be attached',
          description: details.join(' '),
          variant: 'destructive',
        });
      });
    },
    [inputMode, formProject],
  );

  useEffect(() => {
    const textarea = inputRef.current;
    if (!textarea || socketTarget !== 'project') return;
    const binding = createTerminalClipboardPasteBinding({
      target: textarea,
      onFiles: handleClipboardFiles,
    });
    let selection: FormEditSelection | undefined;
    const rememberSelection = () => {
      const { value, selectionStart: start, selectionEnd: end } = textarea;
      selection =
        start !== end && liveForm.current.draft.images.length
          ? { text: value, start, end }
          : undefined;
    };
    // Native input also fires when a selection is replaced with its identical literal label.
    const applySelection = () => {
      const previous = selection;
      selection = undefined;
      if (previous) liveForm.current.changeText(textarea, previous);
    };
    textarea.addEventListener('paste', rememberSelection);
    textarea.addEventListener('beforeinput', rememberSelection);
    textarea.addEventListener('input', applySelection);
    textarea.addEventListener('keydown', binding.handleKeyEvent, true);
    textarea.addEventListener('keyup', binding.handleKeyEvent, true);
    return () => {
      textarea.removeEventListener('paste', rememberSelection);
      textarea.removeEventListener('beforeinput', rememberSelection);
      textarea.removeEventListener('input', applySelection);
      textarea.removeEventListener('keydown', binding.handleKeyEvent, true);
      textarea.removeEventListener('keyup', binding.handleKeyEvent, true);
      binding.dispose();
    };
  }, [handleClipboardFiles, sessionId, socketTarget]);

  // Fetch terminal settings BEFORE mounting terminal
  useEffect(() => {
    fetchSettings(fetchFn)
      .then((json) => {
        const mode = json?.terminal?.inputMode;
        const suppressCtrlCWithSelection = json?.terminal?.suppressCtrlCWithSelection;

        // This ref must be populated before inputMode unlocks terminal construction. It is a
        // mount-time setting and intentionally does not recreate an existing xterm instance.
        suppressCtrlCWithSelectionRef.current =
          typeof suppressCtrlCWithSelection === 'boolean'
            ? suppressCtrlCWithSelection
            : DEFAULT_TERMINAL_SUPPRESS_CTRL_C_WITH_SELECTION;

        // Scrollback lines
        const scrollback = json?.terminal?.scrollbackLines;
        if (typeof scrollback === 'number' && scrollback > 0) {
          setScrollbackLines(scrollback);
        }

        setInputMode(mode === 'form' || mode === 'tty' ? mode : 'form');
      })
      .catch((error) => {
        console.warn('Failed to fetch terminal settings:', error);
        suppressCtrlCWithSelectionRef.current = DEFAULT_TERMINAL_SUPPRESS_CTRL_C_WITH_SELECTION;
        setInputMode('form'); // Default on error
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Read settings once per terminal mount; refetching can recreate xterm through scrollback changes.
  }, []);

  // Create refs that will be shared between hooks
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const pendingResyncSequenceRef = useRef<number | null>(null);
  const recoveryAbortAckTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // Task 1 scrollbar-drag lifecycle controller (set by useXterm on terminal create/recreate). The
  // message handler reads it to defer a full_history apply until a drag has fully ended.
  const scrollIntentControllerRef = useRef<ScrollIntentController | null>(null);
  // Populated by the message handler; invalidates a history response deferred on a controller that
  // is about to be swapped/nulled (its drag-end can then never fire).
  const invalidateDeferredHistoryRef = useRef<(() => void) | null>(null);
  const setScrollIntentController = useCallback((controller: ScrollIntentController | null) => {
    const previous = scrollIntentControllerRef.current;
    scrollIntentControllerRef.current = controller;
    // A terminal recreate/dispose swaps or nulls the drag controller. Any response deferred on the
    // previous controller can no longer receive its drag-end, so invalidate it now instead of
    // stranding the active attempt + in-flight buffer.
    if (previous && previous !== controller) {
      invalidateDeferredHistoryRef.current?.();
    }
  }, []);

  // Subscription management
  const { lastSequenceRef, isSubscribedRef, expectingSeedRef, attemptSubscription } =
    useTerminalSubscription(sessionId, xtermRef, dispatchConn, historySync, socket);

  useLayoutEffect(() => {
    if (
      !visible ||
      !projectId ||
      !imageTargetReady ||
      inputMode !== 'tty' ||
      socketTarget !== 'project'
    )
      return;
    const delivery = createTtyImagePaste(
      sessionId,
      projectId,
      socket,
      fetchFn,
      () => isSubscribedRef.current,
    );
    ttyImages.current = delivery;
    const cancel = () => delivery.cancel();
    const onFocusIn = (event: FocusEvent) => {
      // Two mounted terminals on the same socket can each still own their session's writer.
      const terminal =
        event.target instanceof Element && event.target.closest('[data-terminal-status]');
      if (terminal && terminal !== containerRef.current) cancel();
    };
    const onMessage = ({ topic, type, payload }: WsEnvelope) => {
      if (
        topic === `terminal/${sessionId}` &&
        type === 'focus_changed' &&
        (payload as { clientId?: string } | null)?.clientId !== socket.id
      )
        cancel();
      if (
        topic === `session/${sessionId}` &&
        type === 'state_change' &&
        ['ended', 'crashed', 'timeout'].includes(
          (payload as { status?: string } | null)?.status ?? '',
        )
      )
        cancel();
    };
    document.addEventListener('focusin', onFocusIn, true);
    socket.on('message', onMessage);
    socket.on('disconnect', cancel);
    return () => {
      ttyImages.current = null;
      cancel();
      document.removeEventListener('focusin', onFocusIn, true);
      socket.off('message', onMessage);
      socket.off('disconnect', cancel);
    };
  }, [
    sessionId,
    projectId,
    inputMode,
    visible,
    socketTarget,
    imageTargetReady,
    socket,
    fetchFn,
    isSubscribedRef,
  ]);

  // Theme sync: emits terminal:theme after subscribe confirmation and on theme changes
  const { notifySubscribed } = useTerminalThemeSync(sessionId, appTheme, isSubscribedRef, socket);

  const handleWriteOverflow = useCallback(() => {
    expectingSeedRef.current = true;
    pendingResyncSequenceRef.current = null;
    dispatchConn({ type: 'SEED_START' });
    const payload = {
      sessionId,
      reason: 'client_write_overflow',
    } satisfies TerminalResyncRequestPayload;
    socket.emit('terminal:resync_request', payload);
  }, [expectingSeedRef, pendingResyncSequenceRef, sessionId, socket]);
  const writePump = useTerminalWritePump(xtermRef, handleWriteOverflow);

  const forceCleanRecoveryReconnect = useCallback(() => {
    if (recoveryAbortAckTimeoutRef.current) {
      clearTimeout(recoveryAbortAckTimeoutRef.current);
      recoveryAbortAckTimeoutRef.current = null;
    }
    pendingResyncSequenceRef.current = null;
    lastSequenceRef.current = 0;
    expectingSeedRef.current = true;
    isSubscribedRef.current = false;
    // Invalidate any active history attempt and drop its unapplied buffer before reconnect.
    historySync.invalidateAttempt();
    historySync.suspend();
    isHistoryInFlightRef.current = false;
    isLoadingHistoryRef.current = false;
    pendingHistoryFramesRef.current = [];
    setIsTerminalReady(false);
    writePump.setTerminal(null);
    writePump.setTerminal(xtermRef.current);
    socket.disconnect();
    socket.connect();
  }, [expectingSeedRef, historySync, isSubscribedRef, lastSequenceRef, socket, writePump]);

  const handleRecoveryTimeout = useCallback(
    (abort: TerminalResyncAbortPayload, retryAllowed: boolean) => {
      if (!retryAllowed || !socket.connected) {
        forceCleanRecoveryReconnect();
        return;
      }

      let settled = false;
      const settleAbort = (accepted: boolean) => {
        if (settled) return;
        settled = true;
        if (recoveryAbortAckTimeoutRef.current) {
          clearTimeout(recoveryAbortAckTimeoutRef.current);
          recoveryAbortAckTimeoutRef.current = null;
        }
        if (accepted !== true) {
          forceCleanRecoveryReconnect();
          return;
        }
        const request = {
          sessionId,
          reason: 'client_write_overflow',
        } satisfies TerminalResyncRequestPayload;
        socket.emit('terminal:resync_request', request);
      };

      recoveryAbortAckTimeoutRef.current = setTimeout(
        () => settleAbort(false),
        RECOVERY_ABORT_ACK_TIMEOUT_MS,
      );
      socket.emit('terminal:resync_abort', abort, settleAbort);
    },
    [forceCleanRecoveryReconnect, sessionId, socket],
  );

  // Initialize xterm terminal with onReady callback that triggers subscription.
  // Defer creation until inputMode is loaded so we can honor the configured mode.
  useXterm(
    terminalRef,
    sessionId,
    xtermRef,
    fitAddonRef,
    attemptSubscription,
    inputMode,
    historySync,
    isSubscribedRef,
    isLoadingHistoryRef,
    isHistoryInFlightRef,
    pendingHistoryFramesRef,
    scrollbackLines,
    socket,
    appTheme,
    writePump.setTerminal,
    setScrollIntentController,
    isAuthorityRef,
    suppressCtrlCWithSelectionRef,
    socketTarget === 'project' ? handleClipboardFiles : undefined,
  );

  // Seed management
  const {
    seedStateRef,
    seedTimeoutRef,
    queueOrWrite,
    prepareForResync,
    handleSeedChunk,
    handleSeedEmpty,
    flushPendingWrites,
    setIgnoreWindow,
    resetRecoveryTimeoutEpisode,
    resetRecoveryDomain,
  } = useSeedManager(
    sessionId,
    xtermRef,
    fitAddonRef,
    dispatchConn,
    expectingSeedRef,
    historySync,
    () => {
      setIsTerminalReady(true);
      // Auto-focus terminal after seed is ready
      xtermRef.current?.focus?.();
      // Post-seed viewport-mode restore: the seed (capture-pane) replays cells but NOT DEC
      // private modes, and any redraw emitted DURING seed was discarded. Now that the seed
      // has settled (frames hit the normal write path), ask the server to re-emit alt-screen
      // + mouse modes. Server-gated on the provider's alt-screen policy → no-op for non-TUI
      // providers. Confined to the seed-ready hook; the wheel-forward gate is untouched.
      if (socket.connected) {
        socket.emit('terminal:restore_viewport_modes', { sessionId });
      }
    },
    scrollbackLines,
    writePump,
    (payload) => {
      lastSequenceRef.current = payload.capturedSequence;
      pendingResyncSequenceRef.current = null;
      const completion = {
        sessionId,
        sequenceEpoch: payload.sequenceEpoch,
        recoveryEpoch: payload.recoveryEpoch,
        capturedSequence: payload.capturedSequence,
      } satisfies TerminalResyncCompletePayload;
      socket.emit('terminal:resync_complete', completion);
    },
    handleRecoveryTimeout,
    (payload) => {
      // seed_empty is a successful non-writing replacement: its capture watermark is the
      // highest sequence already represented by the preserved terminal rows.
      lastSequenceRef.current = payload.capturedSequence;
    },
  );

  // Resize handling - pass expectingSeedRef to skip resize events during seed loading.
  // hasHistoryRef is intentionally NOT passed: the seed and full_history handlers own that flag.
  useTerminalResize(terminalRef, xtermRef, fitAddonRef, sessionId, expectingSeedRef, socket);

  // Focus handling
  useTerminalFocus(containerRef, sessionId, isSubscribedRef, socket);

  // Message handling
  const handleMessage = useTerminalMessageHandlers(
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
    notifySubscribed,
    writePump,
    resetRecoveryDomain,
    scrollIntentControllerRef,
    invalidateDeferredHistoryRef,
  );

  // Socket connection and message handling
  useEffect(() => {
    const handlers = {
      connect: () => {
        dispatchConn({ type: 'SOCKET_CONNECT' });
        attemptSubscription();
      },
      disconnect: () => {
        termLog('socket_disconnect_event', { sessionId });
        isAuthorityRef.current = false;
        dispatchConn({ type: 'SOCKET_DISCONNECT' });
        isSubscribedRef.current = false;
        // Invalidate any active history attempt and drop its unapplied buffer before reconnect
        // work, so a late full_history from the dead socket cannot touch the pump or baseline.
        historySync.invalidateAttempt();
        historySync.suspend();
        isHistoryInFlightRef.current = false;
        isLoadingHistoryRef.current = false;
        pendingHistoryFramesRef.current = [];
        resetRecoveryTimeoutEpisode();
      },
      message: (envelope: WsEnvelope) =>
        handleMessage(normalizeTerminalEnvelopeForTheme(envelope, appTheme)),
    };
    for (const [event, handler] of Object.entries(handlers)) socket.on(event, handler);
    return () => {
      for (const [event, handler] of Object.entries(handlers)) socket.off(event, handler);
    };
  }, [
    attemptSubscription,
    handleMessage,
    sessionId,
    isSubscribedRef,
    appTheme,
    historySync,
    resetRecoveryTimeoutEpisode,
    socket,
  ]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      termLog('terminal_dispose_complete_cleanup', { sessionId });
      if (socket.connected && isSubscribedRef.current) {
        socket.emit('terminal:unsubscribe', { sessionId });
      }
      isSubscribedRef.current = false;
      if (seedTimeoutRef.current) {
        clearTimeout(seedTimeoutRef.current);
        seedTimeoutRef.current = null;
      }
      if (recoveryAbortAckTimeoutRef.current) {
        clearTimeout(recoveryAbortAckTimeoutRef.current);
        recoveryAbortAckTimeoutRef.current = null;
      }
      seedStateRef.current = null;
      lastSequenceRef.current = 0;
      isAuthorityRef.current = false;
      expectingSeedRef.current = false;
      pendingResyncSequenceRef.current = null;
      // Clean up history in-flight state
      isHistoryInFlightRef.current = false;
      pendingHistoryFramesRef.current = [];
      historySync.reset();
    };
  }, [
    sessionId,
    isSubscribedRef,
    seedTimeoutRef,
    seedStateRef,
    lastSequenceRef,
    expectingSeedRef,
    pendingResyncSequenceRef,
    historySync,
    socket,
  ]);

  // Reset the history-refresh owner when the session changes so a prior session's capability,
  // baseline, and active attempt never leak into a new one. Runs before the new subscribe/seed.
  useEffect(() => {
    historySync.reset();
  }, [sessionId, historySync]);

  // Expose imperative handle for terminal operations
  const insertPromptText = useCallback(async (text: string): Promise<void> => {
    const live = livePromptInsertRef.current;
    if (live.inputMode === 'form') {
      if (!liveForm.current.insertText(text)) throw new TerminalPromptInsertError('NOT_READY', '');
      return;
    }

    if (live.inputMode !== 'tty') {
      throw new TerminalPromptInsertError('NOT_READY', '');
    }

    const requestId = createPasteRequestId();
    const payload = {
      kind: 'prompt-paste',
      sessionId: live.sessionId,
      requestId,
      data: text,
    } satisfies TerminalPromptPasteInput;

    const emitAttempt = (): Promise<TerminalPromptPasteAck> =>
      new Promise((resolve, reject) => {
        live.socket.emit('terminal:focus', { sessionId: live.sessionId });
        live.socket
          .timeout(PROMPT_PASTE_ACK_TIMEOUT_MS)
          .emit('terminal:input', payload, (error: Error | null, rawAck: unknown) => {
            if (error) {
              reject(new TerminalPromptInsertError('ACK_TIMEOUT', requestId));
              return;
            }
            const parsed = TerminalPromptPasteAckSchema.safeParse(rawAck);
            if (!parsed.success || parsed.data.requestId !== requestId) {
              reject(new TerminalPromptInsertError('INVALID_ACK', requestId));
              return;
            }
            if (!parsed.data.ok) {
              reject(new TerminalPromptInsertError(parsed.data.code, requestId));
              return;
            }
            resolve(parsed.data);
          });
      });

    for (let attempt = 0; attempt < PROMPT_PASTE_ACK_ATTEMPTS; attempt += 1) {
      try {
        await emitAttempt();
        return;
      } catch (error) {
        if (
          !(error instanceof TerminalPromptInsertError) ||
          error.code !== 'ACK_TIMEOUT' ||
          attempt === PROMPT_PASTE_ACK_ATTEMPTS - 1
        ) {
          throw error;
        }
      }
    }
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      clear: () => {
        if (xtermRef.current) resetTerminal(xtermRef.current, 'keep');
      },
      focus: () => {
        xtermRef.current?.focus?.();
      },
      fit: () => {
        fitAddonRef.current?.fit();
      },
      insertPromptText,
    }),
    [insertPromptText],
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (form.draft.images.length || form.attempt) {
      if (formProject && visible) void form.send(isSubscribedRef.current, isAuthorityRef.current);
      return;
    }
    const input = form.draft.text;
    if (!input.trim() || !socket.connected) return;
    if (isSubscribedRef.current && !isAuthorityRef.current) {
      socket.emit('terminal:focus', { sessionId });
    }
    socket.emit('terminal:input', { sessionId, data: input });
    form.clear();
    inputRef.current?.focus();
  };

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  };

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label={ariaLabel}
      data-terminal-status={
        conn.status === 'subscribing' || conn.status === 'seeding' ? 'connected' : conn.status
      }
      className={containerClassName}
    >
      <span className="sr-only" aria-live="polite">
        {conn.srAnnouncement}
      </span>
      <div className="relative flex-1 min-h-0">
        <div
          ref={terminalRef}
          className="h-full overflow-auto"
          {...((inputMode ?? 'form') === 'form' && { 'data-radix-scroll-area-viewport': '' })}
        />
        {/* Overlay to hide terminal flickering during seed/jiggle */}
        {!isTerminalReady && (
          <div
            className="absolute inset-0 z-10"
            style={{ backgroundColor: resolveTerminalTheme(appTheme).xtermTheme.background }}
            aria-hidden="true"
          />
        )}
      </div>
      {inputMode === 'form' && (
        <div className="border-t border-border bg-terminal/80 px-2 py-1.5">
          {form.draft.images.length > 0 && (
            <ul aria-label="Draft attachments" className="mb-1 flex flex-wrap gap-1">
              {form.draft.images.map((image) => (
                <li
                  key={image.number}
                  className="inline-flex items-center gap-1 rounded border border-border px-1.5 text-xs"
                >
                  <span>
                    Image {image.number} · {image.file.name || 'Clipboard image'}
                  </span>
                  {(image.stage === 'checking' || image.stage === 'uploading') && (
                    <span role="status">Preparing…</span>
                  )}
                  {image.stage === 'failed' && (
                    <button type="button" onClick={() => form.retryUpload(image.number)}>
                      Retry upload
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={Boolean(form.attempt)}
                    aria-label={`Remove image ${image.number}`}
                    onClick={() => {
                      form.remove(image.number);
                      inputRef.current?.focus();
                    }}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          {form.attempt && form.attempt.state !== 'sending' && (
            <div role="alert" className="mb-1 flex flex-wrap items-center gap-2 text-xs">
              <span>
                Terminal acknowledged {form.attempt.acknowledgedImages}{' '}
                {form.attempt.acknowledgedImages === 1 ? 'image' : 'images'}.{' '}
                {form.attempt.state === 'inspect'
                  ? 'Delivery may be incomplete or already submitted. Inspect the terminal before starting another draft.'
                  : `Delivery stopped after ${form.attempt.confirmed} ${form.attempt.confirmed === 1 ? 'segment' : 'segments'}. Retry to continue.`}
              </span>
              <button type="button" className="underline" onClick={() => xtermRef.current?.focus()}>
                Inspect terminal
              </button>
              {form.attempt.state === 'retryable' && form.attempt.confirmed === 0 && (
                <button type="button" className="underline" onClick={form.edit}>
                  Edit draft
                </button>
              )}
              <button type="button" className="underline" onClick={form.clear}>
                Discard form draft
              </button>
            </div>
          )}
          <form onSubmit={handleSubmit} className="flex items-center gap-1.5">
            <Textarea
              ref={inputRef}
              value={form.draft.text}
              readOnly={Boolean(form.attempt)}
              onChange={(e) => form.changeText(e.target)}
              onKeyDown={handleInputKeyDown}
              placeholder="Type command..."
              autoFocus
              rows={1}
              className="min-h-7 max-h-32 resize-y py-1.5 font-mono text-xs"
            />
            <Button
              type="submit"
              disabled={
                !socket.connected ||
                !form.draft.text.trim() ||
                (form.draft.images.length > 0 && (!formProject || !isSubscribedRef.current)) ||
                form.draft.images.some((image) => image.stage !== 'ready') ||
                form.attempt?.state === 'inspect' ||
                form.attempt?.state === 'sending'
              }
              size="sm"
              className="h-7 px-3 text-xs"
            >
              {form.attempt?.state === 'retryable'
                ? 'Retry send'
                : form.attempt?.state === 'sending'
                  ? 'Sending…'
                  : 'Send'}
            </Button>
          </form>
        </div>
      )}
    </div>
  );
});
