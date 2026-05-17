import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/components/ui/popover';
import { Input } from '@/ui/components/ui/input';
import { Button } from '@/ui/components/ui/button';
import { ScrollArea } from '@/ui/components/ui/scroll-area';
import { ChevronsUpDown } from 'lucide-react';

const COMMON_TIMEZONES = [
  'UTC',
  'Pacific/Honolulu',
  'America/Anchorage',
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Moscow',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Dhaka',
  'Asia/Bangkok',
  'Asia/Singapore',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Australia/Sydney',
  'Pacific/Auckland',
];

function getRuntimeTimezones(): string[] {
  try {
    return (
      (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ??
      []
    );
  } catch {
    return [];
  }
}

export function getDetectedTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

export function getAllTimezones(detected?: string): string[] {
  const runtimeZones = getRuntimeTimezones();
  const base = runtimeZones.length > 0 ? runtimeZones : COMMON_TIMEZONES;
  const set = new Set(base);
  for (const tz of COMMON_TIMEZONES) {
    set.add(tz);
  }
  if (detected) {
    set.add(detected);
  }
  const sorted = Array.from(set).sort((a, b) => a.localeCompare(b));
  return sorted;
}

export { COMMON_TIMEZONES };

export interface TimezoneSelectorProps {
  value: string;
  onChange: (tz: string) => void;
  variant?: 'inline' | 'field';
  'aria-label'?: string;
}

export function TimezoneSelector({
  value,
  onChange,
  variant = 'inline',
  'aria-label': ariaLabel,
}: TimezoneSelectorProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const detected = getDetectedTimezone();
  const allZones = getAllTimezones(detected);
  const filtered = search
    ? allZones.filter((tz) => tz.toLowerCase().includes(search.toLowerCase()))
    : COMMON_TIMEZONES.includes(value)
      ? COMMON_TIMEZONES
      : [value, ...COMMON_TIMEZONES];

  if (variant === 'inline') {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="rounded-sm text-xs underline text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
          >
            Change
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-2 space-y-2" align="start">
          <Input
            placeholder="Search timezones..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-7 text-xs"
            data-testid="tz-search"
          />
          <div className="max-h-48 overflow-y-auto space-y-0.5">
            {filtered.map((tz) => (
              <button
                key={tz}
                type="button"
                className={`w-full rounded px-2 py-1 text-left text-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${tz === value ? 'bg-accent font-medium' : ''}`}
                onClick={() => {
                  onChange(tz);
                  setOpen(false);
                  setSearch('');
                }}
              >
                {tz}
              </button>
            ))}
            {filtered.length === 0 && (
              <p className="text-xs text-muted-foreground px-2 py-1">No results</p>
            )}
          </div>
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel ?? 'Select timezone'}
          className="w-full justify-between font-normal"
          type="button"
        >
          <span className="truncate">{value || 'Select timezone...'}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-2 space-y-2" align="start">
        <Input
          placeholder="Search timezones..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-8 text-sm"
          data-testid="tz-search"
        />
        <ScrollArea className="max-h-56">
          <div className="space-y-0.5">
            {filtered.map((tz) => (
              <button
                key={tz}
                type="button"
                className={`w-full rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${tz === value ? 'bg-accent font-medium' : ''}`}
                onClick={() => {
                  onChange(tz);
                  setOpen(false);
                  setSearch('');
                }}
              >
                {tz}
              </button>
            ))}
            {filtered.length === 0 && (
              <p className="text-sm text-muted-foreground px-2 py-1.5">No results</p>
            )}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
