import type { Socket } from 'socket.io-client';
import {
  ImagePasteAckSchema,
  IMAGE_PASTE_TIMEOUT_MS,
  type ImageGesture,
  type ImagePasteInput,
  type ImagePasteAck,
} from '@/modules/terminal/dtos/ws-envelope.dto';
import { fetchJsonOrThrow, SessionApiError } from '@/ui/lib/http-json';
import type { FetchFn } from '@/ui/lib/api-transport';
import type { SessionImageReceipt } from '@/modules/runtime-directory/session-image-store.service';
import { clipboardReadIssues, type TerminalClipboardImagePaste } from './terminal-clipboard-paste';
import { toast } from '@/ui/hooks/use-toast';

export function createPasteRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function acknowledged(
  socket: Socket,
  event: string,
  payload: ImageGesture | ImagePasteInput,
  index: number,
): Promise<ImagePasteAck['status'] | 'timeout'> {
  return new Promise<ImagePasteAck['status'] | 'timeout'>((resolve) => {
    socket
      .timeout(IMAGE_PASTE_TIMEOUT_MS)
      .emit(event, payload, (error: Error | null, raw: unknown) => {
        if (error) return resolve('timeout');
        const ack = ImagePasteAckSchema.safeParse(raw);
        resolve(
          ack.success && ack.data.gestureId === payload.gestureId && ack.data.index === index
            ? ack.data.status
            : 'uncertain',
        );
      });
  }).catch(() => 'uncertain' as const);
}

export async function uploadSessionImage(
  fetchFn: FetchFn,
  target: Pick<ImageGesture, 'projectId' | 'sessionId'>,
  file: File,
  signal: AbortSignal,
): Promise<string> {
  const url = `/api/sessions/${encodeURIComponent(target.sessionId)}/attachments?projectId=${encodeURIComponent(target.projectId)}`;
  const receipt = await fetchJsonOrThrow<SessionImageReceipt>(
    url,
    { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file, signal },
    'Image upload failed',
    fetchFn,
  );
  if (typeof receipt.attachmentId !== 'string')
    throw new Error('The host did not return an image reference.');
  return receipt.attachmentId;
}

export function createTtyImagePaste(
  sessionId: string,
  projectId: string,
  socket: Socket,
  fetchFn: FetchFn,
  subscribed: () => boolean,
) {
  const active = new Set<AbortController>();
  let tail: Promise<void> = Promise.resolve();
  function start(paste: TerminalClipboardImagePaste) {
    const gesture: ImageGesture = { sessionId, projectId, gestureId: createPasteRequestId() };
    const controller = new AbortController();
    const connection = socket.id;
    const connected = () => socket.connected && socket.id === connection && subscribed();
    const check = () => {
      if (controller.signal.aborted || !connected())
        throw new Error('The terminal target changed.');
    };
    const finish = () => {
      if (active.delete(controller) && socket.connected && socket.id === connection)
        socket.emit('terminal:image-end', gesture);
    };
    active.add(controller);
    controller.signal.addEventListener('abort', finish, { once: true });
    // Reserve this gesture's place in terminal input order before waiting for another upload.
    const begin = connected()
      ? acknowledged(socket, 'terminal:image-begin', gesture, -1)
      : Promise.resolve('stale');
    async function run() {
      let delivered = 0;
      const details: string[] = [];
      try {
        const [target, files] = await Promise.all([begin, paste.readResult]);
        details.push(...clipboardReadIssues(files));
        if (target !== 'ready') throw new Error('Could not claim the original terminal draft.');
        for (const [index, image] of files.images.entries()) {
          check();
          const upload = () => uploadSessionImage(fetchFn, gesture, image.file, controller.signal);
          const attachmentId = await upload().catch(async (error) => {
            check();
            if (
              !(
                error instanceof TypeError ||
                (error instanceof SessionApiError &&
                  (error.status === 408 || error.status === 429 || error.status >= 500))
              )
            )
              throw error;
            toast({
              title: 'Retrying image upload',
              description: `Browser supplied ${paste.browserFileCount}. Terminal acknowledged ${delivered}. Retrying file ${index + 1}.`,
            });
            return upload();
          });
          check();
          const input: ImagePasteInput = { ...gesture, kind: 'image-paste', index, attachmentId };
          let status = await acknowledged(socket, 'terminal:input', input, index);
          if (status === 'timeout' && !controller.signal.aborted && connected()) {
            status = await acknowledged(socket, 'terminal:input', input, index);
            if (status === 'stale') status = 'uncertain';
          }
          if (status === 'recognized' || status === 'delivered') {
            delivered++;
            continue;
          }
          if (status === 'unconfirmed') {
            delivered++;
            details.push(
              `Copilot did not show an attachment chip for file ${index + 1}. Inspect the original draft before pasting again.`,
            );
          } else if (status === 'timeout' || status === 'uncertain') {
            details.push(
              `File ${index + 1} may already be attached. Inspect the original draft before pasting again.`,
            );
          } else {
            details.push(
              status === 'stale'
                ? 'The original writer or draft changed.'
                : 'Could not paste the image into the terminal.',
            );
          }
          break;
        }
      } catch (error) {
        details.push(
          controller.signal.aborted
            ? 'The paste was cancelled.'
            : error instanceof Error
              ? error.message
              : 'Image paste failed.',
        );
      } finally {
        finish();
        const failed = details.length > 0;
        toast({
          title: failed ? 'Image paste incomplete' : 'Image paste delivered',
          description: [
            `Browser supplied ${paste.browserFileCount}. Terminal acknowledged ${delivered}.`,
            ...details,
          ].join(' '),
          ...(failed && { variant: 'destructive' as const }),
        });
      }
    }
    tail = tail.then(run, run);
    return tail;
  }
  return {
    start,
    cancel() {
      for (const controller of active) controller.abort();
    },
  };
}
