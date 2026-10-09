import type { ProviderAuthEntryItem } from './lib/remote-vm-contracts';

/** Every provider a VM gets a login choice for, in display order. */
export const LOGIN_PROVIDERS = ['claude', 'copilot', 'codex', 'agy', 'opencode'] as const;

/** How each login provider is named on screen. */
export const PROVIDER_NAMES: Readonly<Record<(typeof LOGIN_PROVIDERS)[number], string>> = {
  claude: 'Claude',
  copilot: 'Copilot',
  codex: 'Codex',
  agy: 'Antigravity',
  opencode: 'OpenCode',
};

/** A provider's on-screen name; a provider without one shows its id. */
export function providerName(provider: string): string {
  return PROVIDER_NAMES[provider as keyof typeof PROVIDER_NAMES] ?? provider;
}

/** Providers whose login can be created in an isolated sign-in terminal during setup. */
const NEW_LOGIN_PROVIDERS = ['codex', 'agy', 'opencode', 'copilot'] as const;

/** Providers whose login file a running session rewrites on its next refresh. */
export const SESSION_REWRITTEN_PROVIDERS = ['codex', 'agy', 'opencode'] as const;

/** `skip` means "None"; in a change it removes the login. */
export type LoginChoice = 'keep' | 'skip' | 'generate' | `reuse:${string}`;

export interface LoginOption {
  value: LoginChoice;
  label: string;
  /** Why the option cannot be chosen, when it cannot. */
  disabledReason: string | null;
}

/** Who holds each checked-out login, and which VM the choice is for. */
export interface LoginContext {
  /** The VM the logins go to; null for a VM that does not exist yet. */
  targetRemoteId: string | null;
  remoteNames: ReadonlyMap<string, string>;
}

/**
 * The VM that holds this login, when it is another VM than the target. The
 * vault refuses such a login once setup reaches it, so it is never offered.
 */
export function heldElsewhere(entry: ProviderAuthEntryItem, context: LoginContext): string | null {
  const holder = entry.checkedOutRemoteId;
  if (!holder || holder === context.targetRemoteId) return null;
  return context.remoteNames.get(holder) ?? 'another VM';
}

/** A provider's options after "Keep current": None, its logins, then a new login. */
export function loginOptions(
  provider: string,
  entries: readonly ProviderAuthEntryItem[],
  context: LoginContext,
): LoginOption[] {
  const options: LoginOption[] = [{ value: 'skip', label: 'None', disabledReason: null }];
  for (const entry of entries) {
    if (entry.provider !== provider) continue;
    const holder = heldElsewhere(entry, context);
    const kind = entry.kind === 'static' ? 'Token' : 'Login';
    options.push({
      value: `reuse:${entry.id}`,
      label: holder ? `${entry.label} · ${kind} · on ${holder}` : `${entry.label} · ${kind}`,
      disabledReason: holder ? `In use on ${holder}` : null,
    });
  }
  if ((NEW_LOGIN_PROVIDERS as readonly string[]).includes(provider)) {
    options.push({
      value: 'generate',
      label: 'New login (sign in during setup)',
      disabledReason: null,
    });
  }
  return options;
}

/** The label of a chosen login option; the choice itself when no option matches. */
export function choiceLabel(
  provider: string,
  choice: string,
  entries: readonly ProviderAuthEntryItem[],
  context: LoginContext,
): string {
  return (
    loginOptions(provider, entries, context).find((option) => option.value === choice)?.label ??
    choice
  );
}

/** The only usable login of the provider, or None when there is none or more than one. */
export function defaultLoginChoice(
  provider: string,
  entries: readonly ProviderAuthEntryItem[],
  context: LoginContext,
): LoginChoice {
  const usable = entries.filter(
    (entry) => entry.provider === provider && heldElsewhere(entry, context) === null,
  );
  return usable.length === 1 ? `reuse:${usable[0].id}` : 'skip';
}

/** The setup body's `providerAuth`: every chosen login, without None. */
export function setupProviderAuth(
  choices: Readonly<Record<string, LoginChoice>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(choices).filter(([, choice]) => choice !== 'skip' && choice !== 'keep'),
  );
}

/** A change body's `providerAuth`: only the changed providers; None stays, as "remove". */
export function changedProviderAuth(
  choices: Readonly<Record<string, LoginChoice>>,
): Record<string, string> {
  return Object.fromEntries(Object.entries(choices).filter(([, choice]) => choice !== 'keep'));
}
