import { useEffect, useRef } from 'react';
import { cn } from '@/ui/lib/utils';

interface Agent {
  id: string;
  name: string;
}

interface MentionAutocompleteProps {
  agents: Agent[];
  query: string;
  onSelect: (agent: Agent) => void;
  position: { top: number; left: number };
  selectedIndex: number;
}

export function MentionAutocomplete({
  agents,
  query,
  onSelect,
  position,
  selectedIndex,
}: MentionAutocompleteProps) {
  const listRef = useRef<HTMLUListElement>(null);

  // Filter agents by query
  const filteredAgents = agents.filter((agent) =>
    agent.name.toLowerCase().includes(query.toLowerCase()),
  );

  // Scroll selected item into view
  useEffect(() => {
    if (listRef.current) {
      const selected = listRef.current.querySelector('[data-selected="true"]');
      if (selected) {
        selected.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }, [selectedIndex]);

  if (filteredAgents.length === 0) {
    return null;
  }

  return (
    <div
      className="fixed z-50 w-64 rounded-md border bg-popover p-1 shadow-md"
      style={{
        top: `${position.top}px`,
        left: `${position.left}px`,
      }}
    >
      <ul
        ref={listRef}
        className="max-h-60 overflow-y-auto"
        role="listbox"
        aria-label="Agent mentions"
      >
        {filteredAgents.map((agent, index) => (
          <li
            key={agent.id}
            role="option"
            aria-selected={index === selectedIndex}
            data-selected={index === selectedIndex}
            onClick={() => onSelect(agent)}
            className={cn(
              'flex cursor-pointer items-center gap-2 rounded-sm px-3 py-2 text-sm transition-colors',
              'hover:bg-accent hover:text-accent-foreground',
              index === selectedIndex && 'bg-accent text-accent-foreground',
            )}
          >
            <span className="font-medium">@{agent.name}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
