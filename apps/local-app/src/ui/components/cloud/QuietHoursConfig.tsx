import React, { useCallback, useEffect, useState } from 'react';
import { Switch } from '../ui/switch';
import { Input } from '../ui/input';
import { Button } from '../ui/button';
import { useQuietHours, type QuietHours } from '@/ui/hooks/useQuietHours';
import { TimezoneSelector, getDetectedTimezone } from '@/ui/components/shared/TimezoneSelector';

function toMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

function fromMinutes(mins: number): string {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

function useCurrentlyInQuietHours(qh: QuietHours | null): boolean {
  const [active, setActive] = useState(false);

  const compute = useCallback(() => {
    if (!qh?.enabled || qh.startMinutes === qh.endMinutes) {
      setActive(false);
      return;
    }
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: qh.timezone,
        hour: 'numeric',
        minute: 'numeric',
        hour12: false,
      });
      const parts = formatter.formatToParts(new Date());
      const h = parseInt(parts.find((p) => p.type === 'hour')!.value, 10);
      const m = parseInt(parts.find((p) => p.type === 'minute')!.value, 10);
      const now = (h % 24) * 60 + m;
      const inWindow =
        qh.startMinutes <= qh.endMinutes
          ? now >= qh.startMinutes && now < qh.endMinutes
          : now >= qh.startMinutes || now < qh.endMinutes;
      setActive(inWindow);
    } catch {
      setActive(false);
    }
  }, [qh]);

  useEffect(() => {
    compute();
    const id = setInterval(compute, 60_000);
    return () => clearInterval(id);
  }, [compute]);

  return active;
}

export function QuietHoursConfig() {
  const { quietHours, upsert } = useQuietHours();
  const detectedTz = getDetectedTimezone();

  const [enabled, setEnabled] = useState(quietHours?.enabled ?? false);
  const [start, setStart] = useState(fromMinutes(quietHours?.startMinutes ?? 1320));
  const [end, setEnd] = useState(fromMinutes(quietHours?.endMinutes ?? 420));
  const [tz, setTz] = useState(quietHours?.timezone ?? detectedTz);

  useEffect(() => {
    if (quietHours) {
      setEnabled(quietHours.enabled);
      setStart(fromMinutes(quietHours.startMinutes));
      setEnd(fromMinutes(quietHours.endMinutes));
      setTz(quietHours.timezone);
    }
  }, [quietHours]);

  const isCurrentlyActive = useCurrentlyInQuietHours(quietHours);
  const startEqualsEnd = start === end;

  const handleToggleChange = (nextEnabled: boolean) => {
    const prevEnabled = enabled;
    setEnabled(nextEnabled);
    upsert.mutate(
      {
        enabled: nextEnabled,
        startMinutes: toMinutes(start),
        endMinutes: toMinutes(end),
        timezone: tz,
      },
      {
        onError: () => {
          setEnabled(prevEnabled);
        },
      },
    );
  };

  const handleSave = () => {
    if (startEqualsEnd) return;
    upsert.mutate({
      enabled,
      startMinutes: toMinutes(start),
      endMinutes: toMinutes(end),
      timezone: tz,
    });
  };

  return (
    <div className="space-y-3 rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="space-y-0.5">
          <h3 className="text-sm font-medium">Quiet hours</h3>
          <p className="text-xs text-muted-foreground">
            Mute non-critical notifications during this schedule.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isCurrentlyActive && (
            <span className="text-xs text-muted-foreground" data-testid="active-now-badge">
              🌙 Active now
            </span>
          )}
          <Switch
            checked={enabled}
            onCheckedChange={handleToggleChange}
            aria-label="Enable quiet hours"
          />
        </div>
      </div>
      {enabled && (
        <>
          <div className="flex items-center gap-2">
            <Input
              type="time"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className="w-32"
              aria-label="Quiet hours start"
            />
            <span className="text-sm text-muted-foreground">to</span>
            <Input
              type="time"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              className="w-32"
              aria-label="Quiet hours end"
            />
          </div>
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <span>Timezone: {tz}</span>
            <TimezoneSelector value={tz} onChange={setTz} />
          </div>
          {startEqualsEnd && (
            <p className="text-xs text-destructive" role="alert">
              Start and end times must differ.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Account &amp; Security notifications are still delivered.
          </p>
          <Button size="sm" onClick={handleSave} disabled={startEqualsEnd || upsert.isPending}>
            {upsert.isPending ? 'Saving...' : 'Save changes'}
          </Button>
        </>
      )}
    </div>
  );
}
