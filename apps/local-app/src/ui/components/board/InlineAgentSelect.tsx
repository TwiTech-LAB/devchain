import { useState, useCallback } from 'react';
import { Loader2 } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import { cn } from '@/ui/lib/utils';

/** Agent entity for the dropdown */
export interface Agent {
  id: string;
  name: string;
}

/** Special value for unassigned */
const UNASSIGNED_VALUE = '__unassigned__';

export interface InlineAgentSelectProps {
  /** Current agent ID (null for unassigned) */
  value: string | null;
  /** Available agents for selection */
  agents: Agent[];
  /** Callback when agent changes (null for unassigned) */
  onChange: (agentId: string | null) => void;
  /** Disable editing */
  disabled?: boolean;
  /** Show loading state */
  loading?: boolean;
  /** Optional className for the container */
  className?: string;
}

/**
 * InlineAgentSelect - Click-to-edit agent dropdown component
 *
 * Displays agent name or "Unassigned" normally, transforms into a Select
 * dropdown when clicked for quick inline agent assignment changes.
 *
 * Features:
 * - Click to open dropdown (auto-focus)
 * - Select value calls onChange immediately
 * - Click outside / Escape closes without changing
 * - Loading spinner while updating
 * - Disabled state with no interaction
 * - "Unassigned" option at top of dropdown
 */
export function InlineAgentSelect({
  value,
  agents,
  onChange,
  disabled = false,
  loading = false,
  className,
}: InlineAgentSelectProps) {
  const [open, setOpen] = useState(false);

  // Find the current agent
  const currentAgent = value ? agents.find((a) => a.id === value) : null;
  const displayName = currentAgent?.name ?? 'Unassigned';
  const isUnassigned = !currentAgent;

  // Convert null to special value for Select
  const selectValue = value ?? UNASSIGNED_VALUE;

  // Handle value change
  const handleValueChange = useCallback(
    (newValue: string) => {
      const agentId = newValue === UNASSIGNED_VALUE ? null : newValue;
      if (agentId !== value) {
        onChange(agentId);
      }
      setOpen(false);
    },
    [value, onChange],
  );

  // Handle open change (for click outside / escape)
  const handleOpenChange = useCallback((isOpen: boolean) => {
    setOpen(isOpen);
  }, []);

  // Loading state: show spinner
  if (loading) {
    return (
      <div className={cn('inline-flex items-center gap-1.5 text-sm', className)}>
        <Loader2 className="h-3 w-3 animate-spin" />
        <span className={isUnassigned ? 'text-muted-foreground' : ''}>{displayName}</span>
      </div>
    );
  }

  // Disabled state: show text without interaction
  if (disabled) {
    return (
      <span
        className={cn(
          'text-sm cursor-not-allowed opacity-50',
          isUnassigned && 'text-muted-foreground',
          className,
        )}
      >
        {displayName}
      </span>
    );
  }

  return (
    <Select
      open={open}
      onOpenChange={handleOpenChange}
      value={selectValue}
      onValueChange={handleValueChange}
    >
      <SelectTrigger
        className={cn(
          'h-auto w-auto border-0 bg-transparent p-0 shadow-none ring-0 focus:ring-0 focus:ring-offset-0',
          'hover:underline transition-all cursor-pointer text-sm font-normal',
          isUnassigned && 'text-muted-foreground',
          className,
        )}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <SelectValue placeholder={displayName} />
      </SelectTrigger>
      <SelectContent align="start">
        <SelectItem value={UNASSIGNED_VALUE} className="cursor-pointer text-muted-foreground">
          Unassigned
        </SelectItem>
        {agents.map((agent) => (
          <SelectItem key={agent.id} value={agent.id} className="cursor-pointer">
            {agent.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
