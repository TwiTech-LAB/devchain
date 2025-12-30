import { useState, useCallback } from 'react';
import { Loader2 } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import { Badge } from '@/ui/components/ui/badge';
import { cn } from '@/ui/lib/utils';

/** Status entity for the dropdown */
export interface Status {
  id: string;
  label: string;
  color: string;
}

export interface InlineStatusSelectProps {
  /** Current status ID */
  value: string;
  /** Available statuses for selection */
  statuses: Status[];
  /** Callback when status changes */
  onChange: (statusId: string) => void;
  /** Disable editing */
  disabled?: boolean;
  /** Show loading state */
  loading?: boolean;
  /** Optional className for the container */
  className?: string;
}

/**
 * InlineStatusSelect - Click-to-edit status dropdown component
 *
 * Displays as a colored Badge normally, transforms into a Select dropdown
 * when clicked for quick inline status changes.
 *
 * Features:
 * - Click to open dropdown (auto-focus)
 * - Select value calls onChange immediately
 * - Click outside / Escape closes without changing
 * - Loading spinner while updating
 * - Disabled state with muted appearance
 * - Status color dots in dropdown options
 */
export function InlineStatusSelect({
  value,
  statuses,
  onChange,
  disabled = false,
  loading = false,
  className,
}: InlineStatusSelectProps) {
  const [open, setOpen] = useState(false);

  // Find the current status
  const currentStatus = statuses.find((s) => s.id === value);
  const statusLabel = currentStatus?.label ?? 'Unknown';
  const statusColor = currentStatus?.color ?? '#6b7280';

  // Handle value change
  const handleValueChange = useCallback(
    (newValue: string) => {
      if (newValue !== value) {
        onChange(newValue);
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
      <div
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold',
          className,
        )}
        style={{
          borderColor: statusColor,
          color: statusColor,
        }}
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        <span>{statusLabel}</span>
      </div>
    );
  }

  // Disabled state: show badge without interaction
  if (disabled) {
    return (
      <Badge
        variant="outline"
        className={cn('cursor-not-allowed opacity-50', className)}
        style={{
          borderColor: statusColor,
          color: statusColor,
        }}
      >
        {statusLabel}
      </Badge>
    );
  }

  return (
    <Select
      open={open}
      onOpenChange={handleOpenChange}
      value={value}
      onValueChange={handleValueChange}
    >
      <SelectTrigger
        className={cn(
          'h-auto w-auto border-0 bg-transparent p-0 shadow-none ring-0 focus:ring-0 focus:ring-offset-0',
          'hover:opacity-80 transition-opacity cursor-pointer',
          className,
        )}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <Badge
          variant="outline"
          className="font-normal cursor-pointer hover:bg-accent/50 transition-colors"
          style={{
            borderColor: statusColor,
            color: statusColor,
          }}
        >
          <SelectValue placeholder={statusLabel} />
        </Badge>
      </SelectTrigger>
      <SelectContent align="start">
        {statuses.map((status) => (
          <SelectItem key={status.id} value={status.id} className="cursor-pointer">
            <div className="flex items-center gap-2">
              <span
                className="h-2.5 w-2.5 rounded-full flex-shrink-0"
                style={{ backgroundColor: status.color }}
              />
              <span>{status.label}</span>
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
