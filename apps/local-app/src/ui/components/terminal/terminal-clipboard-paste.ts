export interface ClipboardFilePaste {
  readonly files: readonly File[];
  readonly browserFileCount: number;
}

export interface ClipboardImage {
  readonly file: File;
  readonly mimeType: 'image/png' | 'image/jpeg';
}

export interface ClipboardImageReadResult {
  readonly images: readonly ClipboardImage[];
  readonly unsupportedFileCount: number;
  readonly unreadableFileCount: number;
}

export interface TerminalClipboardImagePaste {
  readonly inputMode: 'form' | 'tty';
  readonly browserFileCount: number;
  readonly readResult: Promise<ClipboardImageReadResult>;
}

const CTRL_V = '\x16';
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function snapshotFiles(clipboard: DataTransfer | null): ClipboardFilePaste {
  const fileList = Array.from(clipboard?.files ?? []);
  const items = Array.from(clipboard?.items ?? []).filter((item) => item.kind === 'file');
  if (fileList.length >= items.length) {
    return { files: fileList, browserFileCount: fileList.length };
  }

  // FileList can omit unavailable entries. Items preserve both the order and supplied count.
  const files = items.flatMap((item) => {
    const file = item.getAsFile();
    return file ? [file] : [];
  });
  return { files, browserFileCount: items.length };
}

export async function readClipboardImages(
  paste: ClipboardFilePaste,
): Promise<ClipboardImageReadResult> {
  const images: ClipboardImage[] = [];
  let unsupportedFileCount = 0;
  let unreadableFileCount = paste.browserFileCount - paste.files.length;

  for (const file of paste.files) {
    try {
      const header = new Uint8Array(await file.slice(0, PNG_SIGNATURE.length).arrayBuffer());
      if (header.length === 0) {
        unreadableFileCount += 1;
      } else if (PNG_SIGNATURE.every((byte, index) => header[index] === byte)) {
        images.push({ file, mimeType: 'image/png' });
      } else if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
        images.push({ file, mimeType: 'image/jpeg' });
      } else {
        unsupportedFileCount += 1;
      }
    } catch {
      unreadableFileCount += 1;
    }
  }

  return { images, unsupportedFileCount, unreadableFileCount };
}

export function clipboardReadIssues(result: ClipboardImageReadResult): string[] {
  const issues: string[] = [];
  if (result.unsupportedFileCount)
    issues.push(`Unsupported format (${result.unsupportedFileCount}). Use PNG or JPEG.`);
  if (result.unreadableFileCount)
    issues.push(`Could not read ${result.unreadableFileCount} file(s).`);
  return issues;
}

interface TerminalClipboardPasteOptions {
  target: HTMLElement;
  onFiles: (paste: ClipboardFilePaste) => void;
  onCtrlV?: (data: string) => void;
}

interface PasteShortcut {
  kind: 'ctrl-v' | 'text-only' | 'native';
  key: 'v' | 'Insert';
  cancelled: boolean;
}

const isVKey = (event: KeyboardEvent) => event.key.toLowerCase() === 'v' || event.keyCode === 86;

export function createTerminalClipboardPasteBinding({
  target,
  onFiles,
  onCtrlV,
}: TerminalClipboardPasteOptions) {
  const { ownerDocument } = target;
  const view = ownerDocument.defaultView;
  const isMac = /Mac|iPhone|iPad|iPod/.test(view?.navigator.platform ?? '');
  let pending: PasteShortcut | undefined;
  let ctrlVHeld = false;

  const releaseShortcut = (event: KeyboardEvent) => {
    const isV = isVKey(event);
    const releasedControl = event.key === 'Control';
    if (isV || releasedControl) ctrlVHeld = false;
    const shortcut = pending;
    if (!shortcut) return;
    const releasedShortcut =
      shortcut.key === 'Insert'
        ? event.key === 'Insert'
        : isV || (shortcut.kind === 'ctrl-v' && releasedControl);
    if (!releasedShortcut) return;

    // Keyboard paste precedes the relevant keyup, even when reading the clipboard takes time.
    pending = undefined;
    if (!shortcut.cancelled && shortcut.kind === 'ctrl-v') onCtrlV?.(CTRL_V);
  };

  const cancelShortcut = () => {
    if (pending) pending.cancelled = true;
    ctrlVHeld = false;
  };

  const onFocusOut = (event: FocusEvent) => {
    if (event.relatedTarget instanceof Node && target.contains(event.relatedTarget)) return;
    cancelShortcut();
  };

  const onDocumentKeyUp = (event: KeyboardEvent) => {
    // A cancelled shortcut may release its key on a different element.
    if (pending?.cancelled) releaseShortcut(event);
  };

  const onContextMenu = () => {
    if (pending?.cancelled) pending = undefined;
  };

  const onPaste = (event: ClipboardEvent) => {
    const shortcut = pending;
    pending = undefined;
    if (!shortcut?.cancelled && shortcut?.kind === 'text-only') return;

    const paste = shortcut?.cancelled ? null : snapshotFiles(event.clipboardData);
    // Let xterm handle text so it can apply the running CLI's bracketed paste mode.
    if (
      paste?.browserFileCount === 0 &&
      (shortcut?.kind !== 'ctrl-v' || event.clipboardData?.getData('text/plain'))
    )
      return;

    event.preventDefault();
    event.stopImmediatePropagation();
    if (!paste) return;
    if (paste.browserFileCount > 0) onFiles(paste);
    else onCtrlV?.(CTRL_V);
  };

  target.addEventListener('paste', onPaste, true);
  target.addEventListener('focusout', onFocusOut, true);
  target.addEventListener('contextmenu', onContextMenu, true);
  ownerDocument.addEventListener('keyup', onDocumentKeyUp, true);
  view?.addEventListener('blur', cancelShortcut);

  return {
    handleKeyEvent(event: KeyboardEvent): boolean {
      if (event.type === 'keyup') releaseShortcut(event);
      if (event.type !== 'keydown') return true;

      const isV = isVKey(event);
      if (isV && ctrlVHeld) {
        event.preventDefault();
        return false;
      }

      if (isV && !event.altKey && event.ctrlKey !== event.metaKey) {
        const allowNativeCtrlV = !isMac && event.ctrlKey && !event.shiftKey;
        ctrlVHeld = allowNativeCtrlV && Boolean(onCtrlV);
        const kind = ctrlVHeld ? 'ctrl-v' : event.shiftKey ? 'text-only' : 'native';
        pending = { kind, key: 'v', cancelled: false };
        // Returning false skips xterm's input while leaving the browser's paste default enabled.
        return !allowNativeCtrlV;
      }
      if (
        event.key === 'Insert' &&
        event.shiftKey &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        pending = { kind: 'native', key: 'Insert', cancelled: false };
      }
      return true;
    },
    dispose() {
      pending = undefined;
      target.removeEventListener('paste', onPaste, true);
      target.removeEventListener('focusout', onFocusOut, true);
      target.removeEventListener('contextmenu', onContextMenu, true);
      ownerDocument.removeEventListener('keyup', onDocumentKeyUp, true);
      view?.removeEventListener('blur', cancelShortcut);
    },
  };
}
