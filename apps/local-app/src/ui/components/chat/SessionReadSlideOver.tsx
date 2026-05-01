import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useSessionTranscript } from '@/ui/hooks/useSessionTranscript';
import { SessionViewerPanel } from '@/ui/components/session-reader/SessionViewerPanel';

export interface SessionReadSlideOverProps {
  sessionId: string | null;
  onClose: () => void;
}

export function SessionReadSlideOver({ sessionId, onClose }: SessionReadSlideOverProps) {
  const { messages, chunks, metrics, isLoading, error, isLive, session } =
    useSessionTranscript(sessionId);

  return (
    <DialogPrimitive.Root open={!!sessionId} onOpenChange={(open) => !open && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <DialogPrimitive.Content
          className="fixed inset-y-0 left-0 z-50 flex w-full max-w-2xl flex-col border-r border-border bg-background shadow-xl focus:outline-none"
          aria-describedby={undefined}
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <DialogPrimitive.Title className="text-sm font-semibold">
              Session transcript
            </DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <button
                type="button"
                className="rounded-sm p-1 text-muted-foreground hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                aria-label="Close transcript viewer"
              >
                <X className="h-4 w-4" />
              </button>
            </DialogPrimitive.Close>
          </div>

          <div className="flex-1 min-h-0">
            <SessionViewerPanel
              sessionId={sessionId}
              messages={messages}
              chunks={chunks}
              metrics={metrics}
              isLive={isLive}
              isLoading={isLoading}
              error={error}
              warnings={session?.warnings}
            />
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
