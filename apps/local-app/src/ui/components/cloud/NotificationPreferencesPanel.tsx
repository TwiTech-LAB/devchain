import React from 'react';
import { CategoryToggleList } from './CategoryToggleList';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Switch } from '../ui/switch';
import { useSmartSuppression } from '@/ui/hooks/useSmartSuppression';

const SMART_SUPPRESSION_WINDOW_OPTIONS = [5, 10, 15] as const;

export function SmartSuppressionConfig() {
  const { smartSuppression, isLoading, upsert } = useSmartSuppression();
  const [enabled, setEnabled] = React.useState(smartSuppression.enabled);
  const [windowMinutes, setWindowMinutes] = React.useState(smartSuppression.windowMinutes);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setEnabled(smartSuppression.enabled);
    setWindowMinutes(smartSuppression.windowMinutes);
  }, [smartSuppression.enabled, smartSuppression.windowMinutes]);

  const persist = (next: { enabled: boolean; windowMinutes: number }) => {
    const previous = { enabled, windowMinutes };
    setEnabled(next.enabled);
    setWindowMinutes(next.windowMinutes);
    setError(null);
    upsert.mutate(next, {
      onError: () => {
        setEnabled(previous.enabled);
        setWindowMinutes(previous.windowMinutes);
        setError('Could not save smart notification settings. Try again.');
      },
      onSuccess: () => setError(null),
    });
  };

  const disabled = isLoading || upsert.isPending;

  return (
    <section
      className="space-y-3 rounded-lg border border-primary/20 bg-primary/10 p-4"
      aria-labelledby="smart-notifications-title"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h4 id="smart-notifications-title" className="text-sm font-medium">
            Smart notifications
          </h4>
          <p className="text-sm text-muted-foreground">
            Pause push notifications for projects you are actively using. Inbox items still appear.
          </p>
        </div>
        <Switch
          checked={enabled}
          disabled={disabled}
          onCheckedChange={(checked) => persist({ enabled: checked, windowMinutes })}
          aria-label="Enable smart notifications"
        />
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <label htmlFor="smart-notifications-window" className="text-sm text-muted-foreground">
          Active project window
        </label>
        <Select
          value={String(windowMinutes)}
          onValueChange={(value) => persist({ enabled, windowMinutes: Number(value) })}
          disabled={disabled || !enabled}
        >
          <SelectTrigger
            id="smart-notifications-window"
            aria-label="Smart notifications activity window"
            className="w-full sm:w-44"
          >
            <SelectValue placeholder="5 minutes" />
          </SelectTrigger>
          <SelectContent>
            {SMART_SUPPRESSION_WINDOW_OPTIONS.map((minutes) => (
              <SelectItem key={minutes} value={String(minutes)}>
                {minutes} minutes
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {(upsert.isPending || isLoading) && (
        <p className="text-xs text-muted-foreground" role="status">
          Saving smart notification settings...
        </p>
      )}
      {(error || upsert.isError) && (
        <div className="flex flex-wrap items-center gap-2" role="alert">
          <p className="text-xs text-destructive">
            {error ?? 'Could not save smart notification settings. Try again.'}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2"
            onClick={() => persist({ enabled, windowMinutes })}
            disabled={disabled}
          >
            Retry
          </Button>
        </div>
      )}
    </section>
  );
}

export function NotificationPreferencesPanel() {
  return (
    <Card data-testid="notification-rules-card">
      <CardHeader>
        <CardTitle className="text-base">Push alert rules</CardTitle>
        <CardDescription>
          Choose which notification types can interrupt you. Inbox history is still kept.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <SmartSuppressionConfig />
        <CategoryToggleList />
      </CardContent>
    </Card>
  );
}
