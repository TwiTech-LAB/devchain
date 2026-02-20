import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/components/ui/popover';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/components/ui/tooltip';
import { CheckCircle2, AlertCircle, Layers, Loader2 } from 'lucide-react';
import { cn } from '@/ui/lib/utils';
import type { PresetAvailability } from '@/ui/lib/preset-validation';

interface PresetPopoverProps {
  presets: PresetAvailability[];
  activePreset: string | null;
  applying: boolean;
  onApply: (presetName: string) => void;
  disabled?: boolean;
  /** Called when popover open state changes (for lazy fetching). */
  onOpenChange?: (open: boolean) => void;
  /** Always render the trigger icon, even when presets list is empty. */
  alwaysShowTrigger?: boolean;
}

export function PresetPopover({
  presets,
  activePreset,
  applying,
  onApply,
  disabled,
  onOpenChange,
  alwaysShowTrigger,
}: PresetPopoverProps) {
  const [open, setOpen] = useState(false);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };

  if (presets.length === 0 && !alwaysShowTrigger) {
    return null;
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={cn(
                  'inline-flex h-6 w-6 items-center justify-center rounded-md hover:bg-muted/60',
                  'text-muted-foreground transition-colors',
                  activePreset && 'text-primary',
                )}
                disabled={disabled || applying}
                aria-label="Select preset"
                onClick={(e) => e.stopPropagation()}
              >
                {applying ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Layers className="h-3.5 w-3.5" />
                )}
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            {activePreset ? `Preset: ${activePreset}` : 'Select preset'}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <PopoverContent className="w-56 p-1" align="end" onClick={(e) => e.stopPropagation()}>
        <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Presets</div>
        {presets.length === 0 ? (
          <div className="px-2 py-3 text-center text-xs text-muted-foreground">
            {applying ? 'Applying...' : 'Loading presets...'}
          </div>
        ) : (
          presets.map(({ preset, available, missingConfigs }) => (
            <button
              key={preset.name}
              type="button"
              className={cn(
                'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm',
                'hover:bg-accent hover:text-accent-foreground',
                !available && 'opacity-50',
                activePreset === preset.name && 'bg-accent/50',
              )}
              disabled={!available || applying}
              onClick={() => {
                onApply(preset.name);
                handleOpenChange(false);
              }}
            >
              {available ? (
                <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 text-green-500" />
              ) : (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 text-yellow-500" />
                    </TooltipTrigger>
                    <TooltipContent side="right" className="max-w-xs">
                      <p className="mb-1 font-medium">Missing configs:</p>
                      <ul className="list-disc pl-4 text-xs">
                        {missingConfigs.map((m, i) => (
                          <li key={i}>
                            {m.agentName} → {m.configName}
                          </li>
                        ))}
                      </ul>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
              <span className={cn('truncate', !available && 'text-muted-foreground')}>
                {preset.name}
              </span>
              {activePreset === preset.name && (
                <span className="ml-auto text-xs text-muted-foreground">Active</span>
              )}
            </button>
          ))
        )}
      </PopoverContent>
    </Popover>
  );
}
