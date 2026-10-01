import { useCallback, useMemo, useState } from 'react';
import { Button } from '@/ui/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import type { ProviderAuthEntryItem } from '@/ui/hooks/useProviderAuth';
import { AddLoginDialog } from './AddLoginDialog';
import {
  LOGIN_PROVIDERS,
  loginOptions,
  providerName,
  type LoginChoice,
  type LoginContext,
} from './login-choices';

/** One provider's recorded login on a set-up VM; never credentials. */
export interface RecordedLogin {
  choice?: string;
  entryIds?: string[];
}

interface StepProps {
  entries: readonly ProviderAuthEntryItem[];
  context: LoginContext;
  choices: Readonly<Record<string, LoginChoice>>;
  onChange: (provider: string, choice: LoginChoice) => void;
  disabled?: boolean;
  /** Opens Add login; the new entry comes back through `onChange`. */
  onAddLogin?: () => void;
}

function LoginChoiceRows({
  providers,
  entries,
  context,
  choices,
  onChange,
  disabled,
  onAddLogin,
  keepLabel,
}: StepProps & {
  providers: readonly string[];
  keepLabel?: (provider: string) => string;
}) {
  return (
    <div className="space-y-2">
      {providers.map((provider) => {
        const options = loginOptions(provider, entries, context);
        return (
          <div key={provider} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="w-24 font-medium">{providerName(provider)}</span>
            <Select
              value={choices[provider] ?? 'skip'}
              onValueChange={(value) => onChange(provider, value as LoginChoice)}
              disabled={disabled}
            >
              <SelectTrigger
                aria-label={`${provider} login choice`}
                className="h-9 min-w-[12rem] flex-1"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {keepLabel && <SelectItem value="keep">{keepLabel(provider)}</SelectItem>}
                {options.map((option) => (
                  <SelectItem
                    key={option.value}
                    value={option.value}
                    disabled={option.disabledReason !== null}
                  >
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        );
      })}
      {onAddLogin && (
        <Button
          type="button"
          variant="link"
          className="h-auto p-0"
          disabled={disabled}
          onClick={onAddLogin}
        >
          Add a token
        </Button>
      )}
    </div>
  );
}

/** A new VM's logins: every provider, starting at its only usable login or None. */
export function SetupLoginStep(props: StepProps) {
  return (
    <>
      <p className="text-sm text-muted-foreground">
        Choose the login each provider uses on the VM. A login that another VM holds cannot be
        chosen.
      </p>
      <LoginChoiceRows {...props} providers={LOGIN_PROVIDERS} />
    </>
  );
}

/** A set-up VM's logins: every provider starts at Keep current. */
export function ChangeLoginStep({
  recorded,
  ...props
}: StepProps & { recorded: Readonly<Record<string, RecordedLogin>> }) {
  const keepLabel = (provider: string) => {
    const ids = recorded[provider]?.entryIds ?? [];
    // OpenCode can hold several logins at once; say how many Keep current keeps.
    return provider === 'opencode' && ids.length > 0
      ? `Keep current (${ids.length} login${ids.length === 1 ? '' : 's'})`
      : 'Keep current';
  };
  return <LoginChoiceRows {...props} providers={LOGIN_PROVIDERS} keepLabel={keepLabel} />;
}

/** Only the providers whose login test failed. */
export function ReauthLoginStep({
  providers,
  ...props
}: StepProps & { providers: readonly string[] }) {
  return <LoginChoiceRows {...props} providers={providers} />;
}

/**
 * The step's choices: a choice the user made wins; the others follow
 * `defaultFor`, which can change while the logins load.
 */
export function useLoginChoices(
  providers: readonly string[],
  defaultFor: (provider: string) => LoginChoice,
) {
  const [manual, setManual] = useState<Record<string, LoginChoice>>({});
  const choices = useMemo(
    () =>
      Object.fromEntries(
        providers.map((provider) => [provider, manual[provider] ?? defaultFor(provider)]),
      ) as Record<string, LoginChoice>,
    [providers, manual, defaultFor],
  );
  const setChoice = useCallback(
    (provider: string, choice: LoginChoice) =>
      setManual((current) => ({ ...current, [provider]: choice })),
    [],
  );
  return { choices, setChoice };
}

/**
 * The login step's "Add a token" link: opens Add login and selects the new
 * entry for its provider when it is one of the step's providers.
 */
export function useAddLoginLink(
  providers: readonly string[],
  setChoice: (provider: string, choice: LoginChoice) => void,
) {
  const [open, setOpen] = useState(false);
  const addLoginDialog = open ? (
    <AddLoginDialog
      onClose={() => setOpen(false)}
      onAdded={(login) => {
        if (providers.includes(login.provider)) setChoice(login.provider, `reuse:${login.id}`);
      }}
    />
  ) : null;
  return { onAddLogin: () => setOpen(true), addLoginDialog };
}
