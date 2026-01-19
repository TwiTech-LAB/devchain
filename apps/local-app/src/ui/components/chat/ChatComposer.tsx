import { useRef } from 'react';
import { Button } from '@/ui/components/ui/button';
import { Textarea } from '@/ui/components/ui/textarea';
import { cn } from '@/ui/lib/utils';
import { Send, Circle } from 'lucide-react';
import { useMentionAutocomplete } from '@/ui/hooks/useMentionAutocomplete';
import type { AgentPresenceMap } from '@/ui/lib/sessions';
import type { AgentOrGuest } from '@/ui/hooks/useChatQueries';

export interface ChatComposerProps {
  // State
  messageInput: string;
  setMessageInput: (value: string) => void;

  // Data
  agents: AgentOrGuest[];
  agentPresence: AgentPresenceMap;

  // Handlers
  onSendMessage: (content: string, targets?: string[]) => void;
  parseMentions: (content: string, agents: AgentOrGuest[]) => string[];

  // Loading state
  isSending: boolean;
}

export function ChatComposer({
  messageInput,
  setMessageInput,
  agents,
  agentPresence,
  onSendMessage,
  parseMentions,
  isSending,
}: ChatComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const {
    showAutocomplete,
    mentionQuery,
    selectedIndex,
    handleInputChange,
    handleKeyDown: handleAutocompleteKeyDown,
    insertMention,
  } = useMentionAutocomplete(textareaRef, agents);

  const handleSendMessage = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!messageInput.trim()) return;

    const targets = parseMentions(messageInput, agents);
    onSendMessage(messageInput, targets.length > 0 ? targets : undefined);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const autocompleteHandled = handleAutocompleteKeyDown(e, messageInput, setMessageInput);
    if (autocompleteHandled) {
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const filteredAgents = agents.filter((agent) =>
    agent.name.toLowerCase().includes(mentionQuery.toLowerCase()),
  );

  return (
    <form
      onSubmit={handleSendMessage}
      className="border-t p-4"
      aria-label="Message composition form"
    >
      <div className="flex items-end gap-2">
        <div className="relative flex-1">
          <label htmlFor="message-input" className="sr-only">
            Message
          </label>
          <Textarea
            ref={textareaRef}
            id="message-input"
            value={messageInput}
            onChange={(e) => {
              const newValue = e.target.value;
              setMessageInput(newValue);
              handleInputChange(newValue, e.target.selectionStart);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Type a message... (Ctrl/Cmd+Enter to send, @ to mention)"
            className="min-h-[60px] max-h-[200px] resize-y"
            disabled={isSending}
            aria-label="Type your message"
          />
          {showAutocomplete && (
            <div className="absolute bottom-full left-0 z-50 mb-2 w-64 rounded-md border bg-popover shadow-md">
              <div className="p-2">
                <div className="mb-2 text-xs text-muted-foreground">
                  Mention agent (↑↓ to navigate, Enter to select)
                </div>
                <div className="space-y-1">
                  {filteredAgents.map((agent, index) => (
                    <button
                      key={agent.id}
                      type="button"
                      onClick={() => {
                        const newText = insertMention(agent, messageInput);
                        setMessageInput(newText);
                      }}
                      className={cn(
                        'w-full rounded-md px-3 py-2 text-left text-sm transition-colors',
                        index === selectedIndex
                          ? 'bg-accent text-accent-foreground'
                          : 'hover:bg-muted',
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <Circle
                          className={cn(
                            'h-2 w-2 fill-current',
                            agentPresence[agent.id]?.online
                              ? 'text-green-500'
                              : 'text-muted-foreground',
                          )}
                        />
                        <span className="font-medium">{agent.name}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
        <Button
          type="submit"
          size="icon"
          disabled={!messageInput.trim() || isSending}
          aria-label="Send message"
        >
          <Send className="h-4 w-4" aria-hidden="true" />
          <span className="sr-only">Send message</span>
        </Button>
      </div>
    </form>
  );
}
