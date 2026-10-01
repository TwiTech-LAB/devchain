import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Button } from '@/ui/components/ui/button';
import { Checkbox } from '@/ui/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/components/ui/tabs';
import {
  useOpencodeLogins,
  useProviderAuth,
  type ImportResult,
  type OpencodeLoginItem,
} from '@/ui/hooks/useProviderAuth';
import { GenerateLoginDialog } from './GenerateLoginDialog';
import { PROVIDER_NAMES } from './login-choices';

/** A provider of the dialog; `other` stores any environment key for any provider. */
export type AddLoginProvider = 'claude' | 'codex' | 'copilot' | 'agy' | 'opencode' | 'other';

type Method = 'token' | 'sign-in' | 'import' | 'key';

const PROVIDER_ORDER: AddLoginProvider[] = [
  'claude',
  'codex',
  'copilot',
  'agy',
  'opencode',
  'other',
];

const PROVIDER_LABELS: Record<AddLoginProvider, string> = {
  ...(PROVIDER_NAMES as Record<Exclude<AddLoginProvider, 'other'>, string>),
  other: 'Other key',
};

/** The methods that work for each provider, the default first. */
const METHODS: Record<AddLoginProvider, Method[]> = {
  claude: ['token'],
  copilot: ['token', 'sign-in'],
  codex: ['sign-in'],
  agy: ['sign-in'],
  opencode: ['import', 'sign-in'],
  other: ['key'],
};

const METHOD_LABELS: Record<Method, string> = {
  token: 'Paste a token',
  'sign-in': 'Sign in',
  import: 'Import from this PC',
  key: 'Environment key',
};

const TOKEN_KEYS: Partial<Record<AddLoginProvider, string>> = {
  claude: 'CLAUDE_CODE_OAUTH_TOKEN',
  copilot: 'COPILOT_GITHUB_TOKEN',
};

/** The command that creates a provider's token, shown under the token field. */
const TOKEN_COMMANDS: Partial<Record<AddLoginProvider, string>> = {
  claude: 'claude setup-token',
};

/** The entry a method stored, for a caller that selects it. */
export interface AddedLogin {
  id: string;
  provider: string;
}

function TokenForm({
  provider,
  generic,
  pending,
  onSubmit,
}: {
  provider: AddLoginProvider;
  generic: boolean;
  pending: boolean;
  onSubmit: (body: Record<string, string>) => void;
}) {
  const [label, setLabel] = useState('');
  const [token, setToken] = useState('');
  const [keyProvider, setKeyProvider] = useState('');
  const [envKey, setEnvKey] = useState('');
  const canSubmit =
    !pending &&
    label.trim().length > 0 &&
    token.trim().length > 0 &&
    (!generic || (keyProvider.trim().length > 0 && envKey.trim().length > 0));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    onSubmit(
      generic
        ? {
            provider: keyProvider.trim().toLowerCase(),
            label: label.trim(),
            envKey: envKey.trim(),
            value: token,
          }
        : { provider, label: label.trim(), token },
    );
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      {generic && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="add-login-key-provider">Provider name</Label>
            <Input
              id="add-login-key-provider"
              value={keyProvider}
              onChange={(event) => setKeyProvider(event.target.value)}
              placeholder="claude"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="add-login-env-key">Environment key</Label>
            <Input
              id="add-login-env-key"
              value={envKey}
              onChange={(event) => setEnvKey(event.target.value)}
              placeholder="ANTHROPIC_AUTH_TOKEN"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
          </div>
        </div>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="add-login-label">Label</Label>
        <Input
          id="add-login-label"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder={`Main ${PROVIDER_LABELS[provider]} ${generic ? 'key' : 'token'}`}
          autoComplete="off"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="add-login-value">{generic ? 'Value' : 'Token value'}</Label>
        <Input
          id="add-login-value"
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          autoComplete="off"
        />
        {!generic && TOKEN_COMMANDS[provider] && (
          <p className="text-xs text-muted-foreground">
            Run <span className="font-mono">{TOKEN_COMMANDS[provider]}</span> on a PC where you are
            signed in to {PROVIDER_LABELS[provider]}, then paste the token here.
          </p>
        )}
        {!generic && TOKEN_KEYS[provider] && (
          <p className="text-xs text-muted-foreground">
            Stored as <span className="font-mono">{TOKEN_KEYS[provider]}</span>.
          </p>
        )}
      </div>
      <DialogFooter>
        <Button type="submit" disabled={!canSubmit} data-testid="add-token-submit">
          {pending ? 'Storing…' : generic ? 'Store key' : 'Store token'}
        </Button>
      </DialogFooter>
    </form>
  );
}

type LoginRowState = { defaultChecked: boolean; disabled: boolean; note: string | null };

function loginRowState(login: OpencodeLoginItem): LoginRowState {
  if (login.type === 'oauth') {
    return { defaultChecked: false, disabled: true, note: 'OAuth login: sign in instead' };
  }
  if (!login.importable) {
    return { defaultChecked: false, disabled: true, note: 'cannot be imported' };
  }
  if (login.imported) {
    return {
      defaultChecked: false,
      disabled: false,
      note: 'already imported — importing again adds a second entry',
    };
  }
  return { defaultChecked: true, disabled: false, note: null };
}

/** This PC's OpenCode API keys; each import adds one reusable token. */
function OpencodeImport({
  pending,
  results,
  onSubmit,
}: {
  pending: boolean;
  results: ImportResult[] | null;
  onSubmit: (providerIds: string[]) => void;
}) {
  const { logins, loginsLoading, loginsError } = useOpencodeLogins();
  const [selection, setSelection] = useState<ReadonlySet<string> | null>(null);
  const defaults = useMemo(
    () =>
      new Set(
        logins
          .filter((login) => loginRowState(login).defaultChecked)
          .map((login) => login.providerId),
      ),
    [logins],
  );

  // Defaults apply once per mount; a background refetch must not reset what
  // the user already changed.
  useEffect(() => {
    if (selection === null && logins.length > 0) setSelection(new Set(defaults));
  }, [selection, logins, defaults]);

  // Each completed import unchecks what it stored, independently of refreshes.
  useEffect(() => {
    if (!results) return;
    setSelection((prev) => {
      if (prev === null) return prev;
      const next = new Set(prev);
      let changed = false;
      for (const result of results) {
        if (result.outcome === 'imported' && next.delete(result.providerId)) changed = true;
      }
      return changed ? next : prev;
    });
  }, [results]);

  const checkedIds = logins
    .filter((login) => selection?.has(login.providerId))
    .map((login) => login.providerId);
  const toggle = (providerId: string, checked: boolean) =>
    setSelection((prev) => {
      const next = new Set(prev ?? defaults);
      if (checked) next.add(providerId);
      else next.delete(providerId);
      return next;
    });

  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        The API keys of this PC&apos;s OpenCode import as reusable tokens. OAuth logins need a
        sign-in instead.
      </p>
      {loginsLoading ? (
        <p className="text-muted-foreground">Loading OpenCode logins…</p>
      ) : loginsError ? (
        <p className="text-destructive">Could not load the OpenCode logins.</p>
      ) : logins.length === 0 ? (
        <p className="text-muted-foreground">No OpenCode logins found on this PC</p>
      ) : (
        <div className="space-y-2">
          {logins.map((login, index) => {
            const row = loginRowState(login);
            const id = `opencode-login-${index}`;
            return (
              <div key={login.providerId} className="flex flex-wrap items-center gap-2">
                <Checkbox
                  id={id}
                  checked={selection?.has(login.providerId) ?? false}
                  disabled={row.disabled}
                  onCheckedChange={(checked) => toggle(login.providerId, checked === true)}
                />
                <Label htmlFor={id} className="font-normal leading-none">
                  {login.providerId}
                </Label>
                {row.note && <span className="text-xs text-muted-foreground">{row.note}</span>}
              </div>
            );
          })}
        </div>
      )}
      {results && (
        <ul aria-label="Import results" className="space-y-1">
          {results.map((result) => (
            <li key={result.providerId} data-testid={`import-result-${result.providerId}`}>
              {result.providerId}:{' '}
              {result.outcome === 'imported'
                ? 'imported'
                : result.outcome === 'missing'
                  ? 'not found in the OpenCode auth file'
                  : `refused — ${result.reason}`}
            </li>
          ))}
        </ul>
      )}
      <DialogFooter>
        <Button
          onClick={() => onSubmit(checkedIds)}
          disabled={pending || loginsLoading || checkedIds.length === 0}
          data-testid="opencode-import-submit"
        >
          Import
        </Button>
      </DialogFooter>
    </div>
  );
}

/**
 * Adds one vault login: the provider first, then only the methods that work
 * for it. Sign-in hands over to the isolated login terminal. `onAdded`
 * receives the stored entry, so a login step can select it.
 */
export function AddLoginDialog({
  initialProvider,
  onClose,
  onAdded,
}: {
  initialProvider?: AddLoginProvider;
  onClose: () => void;
  onAdded?: (login: AddedLogin) => void;
}) {
  const { createStatic, importOpencode } = useProviderAuth();
  const [provider, setProvider] = useState<AddLoginProvider | null>(initialProvider ?? null);
  const [method, setMethod] = useState<Method | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [importResults, setImportResults] = useState<ImportResult[] | null>(null);
  const methods = provider ? METHODS[provider] : [];
  const activeMethod = method && methods.includes(method) ? method : (methods[0] ?? null);
  const pending = createStatic.isPending || importOpencode.isPending;

  if (signingIn && provider) {
    return (
      <GenerateLoginDialog
        provider={provider}
        onClose={onClose}
        onStored={(generation) => {
          const entry = generation.entries[0];
          if (entry) onAdded?.({ id: entry.id, provider: entry.provider });
        }}
      />
    );
  }

  const storeToken = (body: Record<string, string>) =>
    createStatic.mutate(body, {
      onSuccess: (entry) => {
        onAdded?.({ id: entry.id, provider: entry.provider });
        onClose();
      },
    });

  const importKeys = (providerIds: string[]) =>
    importOpencode.mutate(providerIds, {
      onSuccess: ({ results }) => {
        setImportResults(results);
        const imported = results.find(
          (result): result is Extract<ImportResult, { outcome: 'imported' }> =>
            result.outcome === 'imported',
        );
        if (imported) onAdded?.({ id: imported.entryId, provider: 'opencode' });
      },
    });

  const methodBody = (value: Method) => {
    switch (value) {
      case 'token':
      case 'key':
        return (
          <TokenForm
            key={`${provider}:${value}`}
            provider={provider!}
            generic={value === 'key'}
            pending={pending}
            onSubmit={storeToken}
          />
        );
      case 'import':
        return <OpencodeImport pending={pending} results={importResults} onSubmit={importKeys} />;
      case 'sign-in':
        return (
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              Sign in to {PROVIDER_LABELS[provider!]} in an isolated terminal. DevChain stores the
              login when it verifies, and a VM checks it out while it uses it.
            </p>
            <DialogFooter>
              <Button onClick={() => setSigningIn(true)}>Start sign-in</Button>
            </DialogFooter>
          </div>
        );
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-2rem)] overflow-y-auto sm:w-full sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add login</DialogTitle>
          <DialogDescription>
            Logins are stored encrypted on this PC. A token&apos;s value is sent once and never
            shown again.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="add-login-provider">Provider</Label>
          <Select
            value={provider ?? undefined}
            onValueChange={(value) => {
              setProvider(value as AddLoginProvider);
              setMethod(null);
              setImportResults(null);
            }}
            disabled={pending}
          >
            <SelectTrigger id="add-login-provider">
              <SelectValue placeholder="Choose a provider" />
            </SelectTrigger>
            <SelectContent>
              {PROVIDER_ORDER.map((value) => (
                <SelectItem key={value} value={value}>
                  {PROVIDER_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {provider && activeMethod && methods.length > 1 && (
          <Tabs value={activeMethod} onValueChange={(value) => setMethod(value as Method)}>
            <TabsList className="h-auto flex-wrap">
              {methods.map((value) => (
                <TabsTrigger key={value} value={value} disabled={pending}>
                  {METHOD_LABELS[value]}
                </TabsTrigger>
              ))}
            </TabsList>
            {methods.map((value) => (
              <TabsContent key={value} value={value} className="pt-2">
                {methodBody(value)}
              </TabsContent>
            ))}
          </Tabs>
        )}
        {provider && activeMethod && methods.length === 1 && methodBody(activeMethod)}
        {!provider && (
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
