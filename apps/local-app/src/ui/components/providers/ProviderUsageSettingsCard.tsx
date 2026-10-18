import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import {
  PROVIDER_USAGE_INTERVAL_LIMITS,
  PROVIDER_USAGE_SETTINGS_DEFAULTS,
  ProviderUsageSettingsSchema,
  type ProviderUsageSettings,
} from '@devchain/shared';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { Button } from '@/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/components/ui/card';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/label';
import { Switch } from '@/ui/components/ui/switch';
import { useHomeFetch } from '@/ui/hooks/useFetchFactory';
import { fetchJsonOrThrow } from '@/ui/lib/http-json';
import { settingsQueries, settingsQueryKeys, type SettingsDto } from '@/ui/lib/settings';
import { getErrorMessage } from '@/ui/lib/toast-helpers';

type IntervalField = Exclude<keyof ProviderUsageSettings, 'enabled'>;

function rangeError(key: IntervalField): string {
  const { min, max } = PROVIDER_USAGE_INTERVAL_LIMITS[key];
  return `a whole number from ${min} to ${max}.`;
}

const INTERVAL_FIELDS: Array<{ key: IntervalField; label: string; help?: string; error: string }> =
  [
    {
      key: 'runningMaxAgeMin',
      label: 'Check accounts with running sessions every (min)',
      error: `Enter ${rangeError('runningMaxAgeMin')}`,
    },
    {
      key: 'openProjectMaxAgeMin',
      label: "Check the open project's accounts every (min)",
      error: `Enter ${rangeError('openProjectMaxAgeMin')}`,
    },
    {
      key: 'hoverMaxAgeSec',
      label: 'Refresh on hover when older than (s)',
      error: `Enter ${rangeError('hoverMaxAgeSec')}`,
    },
    {
      key: 'tokenCheckMinutes',
      label: 'Claude token check every (min, 0 = off)',
      help: 'Sends one 9-token request with the provider env token while the account has a running session.',
      error: `Enter 0, or ${rangeError('tokenCheckMinutes')}`,
    },
  ];

type Draft = { enabled: boolean } & Record<IntervalField, string>;

function toDraft(settings: ProviderUsageSettings): Draft {
  return {
    enabled: settings.enabled,
    runningMaxAgeMin: String(settings.runningMaxAgeMin),
    openProjectMaxAgeMin: String(settings.openProjectMaxAgeMin),
    hoverMaxAgeSec: String(settings.hoverMaxAgeSec),
    tokenCheckMinutes: String(settings.tokenCheckMinutes),
  };
}

/**
 * Home-owned refresh intervals of the usage rings. Reads and writes home's settings
 * even while a VM project is open; home pushes them to its VMs.
 */
export function ProviderUsageSettingsCard() {
  const homeFetch = useHomeFetch();
  const homeClient = useHomeQueryClient();
  const settingsQuery = useQuery(settingsQueries.get(homeFetch), homeClient);
  const [draft, setDraft] = useState<Draft>(() => toDraft(PROVIDER_USAGE_SETTINGS_DEFAULTS));
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<IntervalField, string>>>({});
  const settings = settingsQuery.data;
  useEffect(() => {
    if (!settings) return;
    setDraft(toDraft({ ...PROVIDER_USAGE_SETTINGS_DEFAULTS, ...settings.providerUsage }));
    setFieldErrors({});
  }, [settings]);

  const saveMutation = useMutation(
    {
      mutationFn: (providerUsage: ProviderUsageSettings) =>
        fetchJsonOrThrow<SettingsDto>(
          '/api/settings',
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ providerUsage }),
          },
          'Failed to save the provider usage settings.',
          homeFetch,
        ),
      onSuccess: () => homeClient.invalidateQueries({ queryKey: settingsQueryKeys.all }),
    },
    homeClient,
  );

  const handleSave = () => {
    const parsed = ProviderUsageSettingsSchema.safeParse({
      enabled: draft.enabled,
      ...Object.fromEntries(
        INTERVAL_FIELDS.map(({ key }) => [
          key,
          draft[key].trim() === '' ? NaN : Number(draft[key]),
        ]),
      ),
    });
    if (!parsed.success) {
      const errors: Partial<Record<IntervalField, string>> = {};
      for (const field of INTERVAL_FIELDS) {
        if (parsed.error.issues.some((issue) => issue.path[0] === field.key)) {
          errors[field.key] = field.error;
        }
      }
      setFieldErrors(errors);
      return;
    }
    setFieldErrors({});
    saveMutation.mutate(parsed.data);
  };

  const disabled = !settingsQuery.data || saveMutation.isPending;

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>Provider usage</CardTitle>
        <CardDescription>Applies to this PC and all connected VMs.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {settingsQuery.isError && (
          <p className="text-sm text-destructive">
            {getErrorMessage(settingsQuery.error, 'Failed to load the settings.')}
          </p>
        )}
        <div className="flex items-center gap-3">
          <Switch
            id="provider-usage-enabled"
            checked={draft.enabled}
            onCheckedChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
            disabled={disabled}
          />
          <Label htmlFor="provider-usage-enabled">Show usage rings</Label>
        </div>
        {INTERVAL_FIELDS.map(({ key, label, help }) => (
          <div key={key} className="space-y-1">
            <Label htmlFor={`provider-usage-${key}`}>{label}</Label>
            <Input
              id={`provider-usage-${key}`}
              type="number"
              inputMode="numeric"
              className="w-32"
              value={draft[key]}
              onChange={(event) =>
                setDraft((current) => ({ ...current, [key]: event.target.value }))
              }
              aria-invalid={fieldErrors[key] ? true : undefined}
              aria-describedby={fieldErrors[key] ? `provider-usage-${key}-error` : undefined}
              disabled={disabled}
            />
            {help && <p className="text-xs text-muted-foreground">{help}</p>}
            {fieldErrors[key] && (
              <p id={`provider-usage-${key}-error`} className="text-xs text-destructive">
                {fieldErrors[key]}
              </p>
            )}
          </div>
        ))}
        {saveMutation.isError && (
          <p className="text-sm text-destructive">
            {getErrorMessage(saveMutation.error, 'Failed to save the provider usage settings.')}
          </p>
        )}
        <Button onClick={handleSave} disabled={disabled}>
          {saveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save
        </Button>
      </CardContent>
    </Card>
  );
}
