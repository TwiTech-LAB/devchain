interface CtrlCSelectionTerminal {
  attachCustomKeyEventHandler: (handler: (event: KeyboardEvent) => boolean) => void;
  onSelectionChange: (listener: () => void) => { dispose: () => void };
  hasSelection: () => boolean;
  getSelection: () => string;
  clearSelection: () => void;
  element?: HTMLElement | null;
}

interface CtrlCSelectionBindingOptions {
  terminal: CtrlCSelectionTerminal;
  enabled: boolean;
  onClipboardBlocked?: (error: unknown) => void;
}

export interface CtrlCSelectionBinding {
  dispose(): void;
}

const C_KEY_CODE = 67;
const CONTROL_KEY_CODE = 17;

export function createCtrlCSelectionBinding({
  terminal,
  enabled,
  onClipboardBlocked,
}: CtrlCSelectionBindingOptions): CtrlCSelectionBinding {
  let active = true;
  let cKeyLatched = false;
  let selectionGeneration = 0;
  let copyNonce = 0;
  let clearTimer: ReturnType<typeof setTimeout> | undefined;

  const releaseLatch = () => {
    cKeyLatched = false;
  };

  const selectionDisposable = terminal.onSelectionChange(() => {
    selectionGeneration += 1;
  });

  const element = terminal.element;
  element?.addEventListener('focusout', releaseLatch, true);

  const clearIfCurrent = (attemptNonce: number, capturedGeneration: number) => {
    if (!active) return;
    if (copyNonce !== attemptNonce || selectionGeneration !== capturedGeneration) return;
    if (!terminal.hasSelection()) return;
    terminal.clearSelection();
  };

  const copyWithClipboardApi = (text: string, attemptNonce: number, capturedGeneration: number) => {
    try {
      const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
      if (!clipboard?.writeText) {
        throw new Error('Clipboard API is unavailable');
      }
      void clipboard
        .writeText(text)
        .then(() => clearIfCurrent(attemptNonce, capturedGeneration))
        .catch((error: unknown) => onClipboardBlocked?.(error));
    } catch (error) {
      onClipboardBlocked?.(error);
    }
  };

  terminal.attachCustomKeyEventHandler((event) => {
    if (!active) return true;

    if (event.type === 'keyup') {
      if (event.keyCode === C_KEY_CODE || event.keyCode === CONTROL_KEY_CODE) {
        releaseLatch();
      }
      return true;
    }

    if (event.type !== 'keydown' || event.keyCode !== C_KEY_CODE) return true;

    if (cKeyLatched) {
      event.preventDefault();
      return false;
    }

    const isBareCtrl = event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
    if (!enabled || !isBareCtrl || !terminal.hasSelection()) return true;

    const text = terminal.getSelection();
    const capturedGeneration = selectionGeneration;
    const attemptNonce = ++copyNonce;
    cKeyLatched = true;
    event.preventDefault();

    let xtermServedCopy = false;
    const observeCopy = (copyEvent: Event) => {
      if (copyEvent.defaultPrevented) xtermServedCopy = true;
    };

    try {
      if (element && typeof document.execCommand === 'function') {
        element.addEventListener('copy', observeCopy);
        document.execCommand('copy');
      }
    } catch {
      // The Clipboard API fallback below owns command absence and browser rejection.
    } finally {
      element?.removeEventListener('copy', observeCopy);
    }

    if (xtermServedCopy) {
      if (clearTimer) clearTimeout(clearTimer);
      clearTimer = setTimeout(() => {
        clearTimer = undefined;
        clearIfCurrent(attemptNonce, capturedGeneration);
      }, 0);
    } else {
      copyWithClipboardApi(text, attemptNonce, capturedGeneration);
    }

    return false;
  });

  return {
    dispose() {
      if (!active) return;
      active = false;
      copyNonce += 1;
      releaseLatch();
      if (clearTimer) clearTimeout(clearTimer);
      clearTimer = undefined;
      element?.removeEventListener('focusout', releaseLatch, true);
      selectionDisposable.dispose();
    },
  };
}
