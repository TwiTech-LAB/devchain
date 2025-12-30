import { useState, useEffect } from 'react';
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/ui/components/ui/drawer';
import { Button } from '@/ui/components/ui/button';
import { Badge } from '@/ui/components/ui/badge';
import { ScrollArea } from '@/ui/components/ui/scroll-area';
import { Copy, Check, Clock, User, Zap, Hash, AlertCircle, Loader2 } from 'lucide-react';
import { cn } from '@/ui/lib/utils';
import type { MessageLogEntry, MessageLogPreview } from './MessageActivityList';

interface MessageDetailDrawerProps {
  /** Message preview (from list endpoint) - will fetch full content when opened */
  message: MessageLogPreview | null;
  onClose: () => void;
}

/** Fetch full message content by ID */
async function fetchMessageDetail(messageId: string): Promise<MessageLogEntry> {
  const res = await fetch(`/api/sessions/messages/${messageId}`);
  if (!res.ok) {
    throw new Error('Failed to fetch message details');
  }
  const data = await res.json();
  return data.message;
}

function formatDateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString();
}

interface StatusBadgeProps {
  status: 'queued' | 'delivered' | 'failed';
}

function StatusBadge({ status }: StatusBadgeProps) {
  const variants = {
    queued: 'bg-muted text-muted-foreground',
    delivered: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/40',
    failed: 'bg-destructive/10 text-destructive border-destructive/40',
  };

  return (
    <Badge variant="outline" className={cn('text-xs uppercase font-medium', variants[status])}>
      {status}
    </Badge>
  );
}

/** Section wrapper for visual grouping */
function Section({
  icon: Icon,
  title,
  children,
  className,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
        {Icon && <Icon className="h-4 w-4" />}
        <span>{title}</span>
      </div>
      <div className="pl-6">{children}</div>
    </div>
  );
}

/** Content block with copy button */
function ContentBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  return (
    <div className="relative rounded-lg border bg-muted/50">
      <div className="absolute right-2 top-2 z-10">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleCopy}
          className="h-8 w-8 p-0 hover:bg-background"
          aria-label="Copy content"
        >
          {copied ? (
            <Check className="h-4 w-4 text-emerald-500" />
          ) : (
            <Copy className="h-4 w-4 text-muted-foreground" />
          )}
        </Button>
      </div>
      <pre className="overflow-auto p-4 pr-12 text-sm whitespace-pre-wrap break-words max-h-72">
        {text}
      </pre>
    </div>
  );
}

export function MessageDetailDrawer({ message, onClose }: MessageDetailDrawerProps) {
  const [fullMessage, setFullMessage] = useState<MessageLogEntry | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch full message content when drawer opens
  useEffect(() => {
    if (!message) {
      setFullMessage(null);
      setError(null);
      return;
    }

    setIsLoading(true);
    setError(null);

    fetchMessageDetail(message.id)
      .then(setFullMessage)
      .catch((err) => {
        console.error('Failed to fetch message details:', err);
        setError('Failed to load message content');
      })
      .finally(() => setIsLoading(false));
  }, [message?.id]);

  return (
    <Drawer open={!!message} onOpenChange={(open) => !open && onClose()}>
      <DrawerContent aria-describedby="message-detail-description">
        <DrawerHeader className="pb-2">
          <DrawerTitle>Message Details</DrawerTitle>
          <DrawerDescription id="message-detail-description">
            {message && formatDateTime(message.timestamp)}
          </DrawerDescription>
        </DrawerHeader>

        {message && (
          <ScrollArea className="flex-1 px-4">
            <div className="space-y-5 pb-4">
              {/* Status & Delivery Info */}
              <Section icon={Clock} title="Status">
                <div className="flex items-center gap-3">
                  <StatusBadge status={message.status} />
                  {message.deliveredAt && (
                    <span className="text-sm text-muted-foreground">
                      Delivered at {formatTime(message.deliveredAt)}
                    </span>
                  )}
                  {message.immediate && (
                    <Badge variant="secondary" className="text-xs">
                      <Zap className="h-3 w-3 mr-1" />
                      Immediate
                    </Badge>
                  )}
                </div>
              </Section>

              {/* Recipient & Source */}
              <Section icon={User} title="Routing">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-muted-foreground">Recipient</span>
                    <p className="font-medium">{message.agentName}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Source</span>
                    <p className="font-mono text-xs">{message.source}</p>
                  </div>
                </div>
              </Section>

              {/* Error (if failed) */}
              {message.error && (
                <Section icon={AlertCircle} title="Error" className="text-destructive">
                  <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3">
                    <p className="text-sm text-destructive">{message.error}</p>
                  </div>
                </Section>
              )}

              {/* Content */}
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <span>Content</span>
                </div>
                {isLoading ? (
                  <div className="flex items-center justify-center p-8 rounded-lg border bg-muted/50">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                    <span className="ml-2 text-sm text-muted-foreground">Loading content...</span>
                  </div>
                ) : error ? (
                  <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4">
                    <p className="text-sm text-destructive">{error}</p>
                    <p className="text-xs text-muted-foreground mt-2">Preview: {message.preview}</p>
                  </div>
                ) : fullMessage ? (
                  <ContentBlock text={fullMessage.text} />
                ) : (
                  <ContentBlock text={message.preview} />
                )}
              </div>

              {/* Metadata */}
              <Section icon={Hash} title="Metadata">
                <div className="rounded-lg border bg-muted/30 p-3">
                  <dl className="text-sm space-y-2">
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">Message ID</dt>
                      <dd className="font-mono text-xs text-right max-w-[200px] truncate">
                        {message.id}
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">Agent ID</dt>
                      <dd className="font-mono text-xs text-right max-w-[200px] truncate">
                        {message.agentId}
                      </dd>
                    </div>
                    {message.batchId && (
                      <div className="flex justify-between">
                        <dt className="text-muted-foreground">Batch ID</dt>
                        <dd className="font-mono text-xs text-right max-w-[200px] truncate">
                          {message.batchId}
                        </dd>
                      </div>
                    )}
                    {message.senderAgentId && (
                      <div className="flex justify-between">
                        <dt className="text-muted-foreground">Sender Agent</dt>
                        <dd className="font-mono text-xs text-right max-w-[200px] truncate">
                          {message.senderAgentId}
                        </dd>
                      </div>
                    )}
                  </dl>
                </div>
              </Section>
            </div>
          </ScrollArea>
        )}

        <DrawerFooter>
          <DrawerClose asChild>
            <Button variant="outline">Close</Button>
          </DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
