import { useState, type ReactNode } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Check, Copy, Smartphone } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import { cn } from '@/ui/lib/utils';
import { useToast } from '@/ui/hooks/use-toast';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/ui/components/ui/dialog';
import {
  APP_DOWNLOAD_STORES,
  type AppDownloadStore,
  type AppStoreId,
} from '@/ui/lib/app-downloads';

/** Decorative Apple logo glyph (currentColor — adapts to button text colour). */
function AppleGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      fill="currentColor"
      className={className}
    >
      <path d="M16.365 1.43c0 1.14-.493 2.27-1.177 3.08-.744.9-1.99 1.57-2.987 1.57-.12 0-.23-.02-.3-.03-.01-.06-.04-.22-.04-.39 0-1.15.572-2.27 1.206-2.98.804-.94 2.142-1.64 3.248-1.68.03.13.05.28.05.43zm4.565 15.71c-.03.07-.463 1.58-1.518 3.12-.945 1.34-1.94 2.71-3.43 2.71-1.517 0-1.9-.88-3.63-.88-1.698 0-2.302.91-3.67.91-1.377 0-2.332-1.26-3.428-2.8-1.287-1.82-2.323-4.63-2.323-7.28 0-4.28 2.797-6.55 5.552-6.55 1.448 0 2.675.95 3.6.95.865 0 2.222-1.01 3.902-1.01.613 0 2.886.06 4.374 2.19-.13.09-2.383 1.37-2.383 4.19 0 3.26 2.854 4.42 2.955 4.45z" />
    </svg>
  );
}

/** Decorative Google Play glyph (brand-coloured triangle — not the official badge). */
function GooglePlayGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 512 512" aria-hidden="true" focusable="false" className={className}>
      <path
        fill="#00D2FF"
        d="M99.6 12.7c-4.3 4.6-6.8 11.7-6.8 20.9v444.8c0 9.2 2.5 16.3 6.8 20.9l1.5 1.4 249.2-249.2v-5.9L101.1 11.3l-1.5 1.4z"
      />
      <path
        fill="#FFCE00"
        d="M433.4 333.4l-84.1-84.1v-5.9l84.2-84.2 1.9 1.1 99.7 56.6c28.5 16.1 28.5 42.6 0 58.8l-99.7 56.6-2 1.1z"
      />
      <path
        fill="#00F076"
        d="M435.4 332.3l-86.1-86.1L99.6 498c9.4 9.9 24.9 11.1 42.3 1.2l293.5-166.9z"
      />
      <path
        fill="#FF3B44"
        d="M435.4 159.7L141.9-6.2C124.5-16.1 109-14.9 99.6-5l249.7 250.5 86.1-85.8z"
      />
    </svg>
  );
}

function StoreGlyph({ store, className }: { store: AppStoreId; className?: string }) {
  return store === 'ios' ? (
    <AppleGlyph className={className} />
  ) : (
    <GooglePlayGlyph className={className} />
  );
}

/** Body of a store download dialog: QR + direct link + copy-to-clipboard. */
function AppDownloadDialogBody({ store }: { store: AppDownloadStore }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard API unavailable');
      }
      await navigator.clipboard.writeText(store.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast({
        title: 'Link copied',
        description: 'The download link is on your clipboard.',
      });
    } catch {
      toast({
        variant: 'destructive',
        title: 'Could not copy link',
        description: 'Copy the link manually from the field above.',
      });
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-center">
        {/* The QR quiet zone must stay white to match the black-on-white code in every theme. */}
        <div
          className="rounded-xl bg-white p-4 shadow-sm"
          data-testid={`app-download-qr-${store.id}`}
        >
          <QRCodeSVG
            value={store.url}
            size={220}
            level="M"
            bgColor="#ffffff"
            fgColor="#000000"
            includeMargin
            marginSize={4}
          />
        </div>
      </div>

      <p className="text-center text-xs text-muted-foreground">
        Scan with your phone camera, or use the link below.
      </p>

      <div className="space-y-2">
        <a
          href={store.url}
          target="_blank"
          rel="noopener noreferrer"
          data-testid={`app-download-link-${store.id}`}
          className="block break-all rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {store.url}
        </a>
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          onClick={handleCopy}
          data-testid={`app-download-copy-${store.id}`}
        >
          {copied ? (
            <>
              <Check className="mr-2 h-4 w-4 text-status-ok" aria-hidden="true" />
              Copied
            </>
          ) : (
            <>
              <Copy className="mr-2 h-4 w-4" aria-hidden="true" />
              Copy link
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

/** A single store: trigger button + its download dialog (open state local to the card). */
export function AppDownloadDialog({ store }: { store: AppDownloadStore }) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="default"
          aria-label={store.ariaLabel}
          data-testid={`app-download-button-${store.id}`}
          className="h-auto w-full justify-start gap-3 py-3"
        >
          <StoreGlyph store={store.id} className="h-6 w-6 shrink-0" />
          <span className="flex flex-col items-start leading-tight">
            <span className="text-sm font-semibold">{store.label}</span>
            <span className="text-xs font-normal text-muted-foreground">{store.channel}</span>
          </span>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{store.dialogTitle}</DialogTitle>
          <DialogDescription>
            Scan the QR code or open the link to install the DevChain mobile app.
          </DialogDescription>
        </DialogHeader>
        {open && <AppDownloadDialogBody store={store} />}
      </DialogContent>
    </Dialog>
  );
}

export interface AppDownloadCardProps {
  className?: string;
  /** Optional content (e.g. setup steps) rendered between the header and the store buttons. */
  children?: ReactNode;
}

/**
 * Download CTA card for users without the mobile app installed.
 * Renders one store button per channel; each opens a QR + direct-link dialog.
 */
export function AppDownloadCard({ className, children }: AppDownloadCardProps) {
  return (
    <div
      className={cn(
        'rounded-xl border border-border bg-card shadow-sm p-6 lg:p-8 space-y-5',
        className,
      )}
      data-testid="app-download-card"
    >
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Smartphone className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          <span className="text-base font-semibold">Get the DevChain mobile app</span>
        </div>
        <p className="text-sm text-muted-foreground">
          Approve sign-ins and receive notifications on your phone.
        </p>
      </div>

      {children}

      <div className="grid gap-3 sm:grid-cols-2">
        {APP_DOWNLOAD_STORES.map((store) => (
          <AppDownloadDialog key={store.id} store={store} />
        ))}
      </div>
    </div>
  );
}

export default AppDownloadCard;
