import { useRef, useEffect } from 'react';
import { Badge } from '@/ui/components/ui/badge';
import { ScrollArea } from '@/ui/components/ui/scroll-area';
import { cn } from '@/ui/lib/utils';
import type { Message } from '@/ui/lib/chat';
import { getProviderIconDataUri } from '@/ui/lib/providers';

export interface ChatMessageListProps {
  messages: Message[];
  getAgentName: (agentId: string | null) => string | null;
  getProviderForAgent: (agentId: string | null | undefined) => string | null;
}

function formatTimestamp(isoString: string) {
  const date = new Date(isoString);
  const now = new Date();
  const isToday =
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear();

  if (isToday) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function ChatMessageList({
  messages,
  getAgentName,
  getProviderForAgent,
}: ChatMessageListProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <ScrollArea className="flex-1 p-4">
      <div className="space-y-4" role="log" aria-live="polite" aria-label="Chat messages">
        {messages.length === 0 && (
          <div className="flex h-full items-center justify-center text-center text-muted-foreground">
            <p className="text-sm">No messages yet. Start the conversation!</p>
          </div>
        )}
        {messages.map((message) => {
          const isUser = message.authorType === 'user';
          const isAgentAuthor = message.authorType === 'agent';
          const isSystem = message.authorType === 'system';
          const authorName = isUser
            ? 'You'
            : getAgentName(message.authorAgentId) || (isSystem ? 'System' : 'Agent');
          const isTargeted = Boolean(message.targets && message.targets.length > 0);

          if (isSystem) {
            return (
              <div key={message.id} className="flex justify-center">
                <div className="flex max-w-2xl flex-col items-center gap-1 text-center">
                  <Badge variant="secondary" className="text-[10px] uppercase tracking-wide">
                    System
                  </Badge>
                  <div className="w-full whitespace-pre-wrap rounded-md border bg-muted px-3 py-2 text-sm text-muted-foreground">
                    {message.content}
                  </div>
                  <span className="text-[10px] uppercase text-muted-foreground">
                    {formatTimestamp(message.createdAt)}
                  </span>
                </div>
              </div>
            );
          }

          const providerName = isAgentAuthor ? getProviderForAgent(message.authorAgentId) : null;
          const providerIcon = providerName ? getProviderIconDataUri(providerName) : null;

          return (
            <div
              key={message.id}
              className={cn('flex flex-col', isUser ? 'items-end' : 'items-start')}
            >
              <div className="flex items-baseline gap-2">
                {isAgentAuthor && providerIcon ? (
                  <div className="flex items-center gap-1.5">
                    <img
                      src={providerIcon}
                      className="h-4 w-4"
                      aria-hidden="true"
                      title={`Provider: ${providerName}`}
                      alt=""
                    />
                    <span className="text-sm font-semibold">{authorName}</span>
                  </div>
                ) : (
                  <span className="text-sm font-semibold">{authorName}</span>
                )}
                <span className="text-xs text-muted-foreground">
                  {formatTimestamp(message.createdAt)}
                </span>
                {isUser && (
                  <Badge variant="outline" className="text-xs">
                    {isTargeted ? 'Targeted' : 'Broadcast'}
                  </Badge>
                )}
                {isAgentAuthor && (
                  <Badge variant="secondary" className="text-xs uppercase">
                    Agent
                  </Badge>
                )}
              </div>
              <div
                className={cn(
                  'mt-1 whitespace-pre-wrap rounded-lg px-3 py-2 text-sm',
                  isUser ? 'bg-primary text-primary-foreground' : 'bg-muted',
                )}
              >
                {message.content}
              </div>
              {isTargeted && isUser && (
                <div className="mt-1 text-xs text-muted-foreground">
                  To: {message.targets!.map((id) => getAgentName(id) || id).join(', ')}
                </div>
              )}
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>
    </ScrollArea>
  );
}
