import { AlertTriangle, Plug } from 'lucide-react';
import { Checkbox } from '@/ui/components/ui/checkbox';
import { Badge } from '@/ui/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/ui/components/ui/alert';
import { cn } from '@/ui/lib/utils';
import { getProviderIconDataUri } from '@/ui/lib/providers';
import type { SetupPreviewProviderSummary } from '@/ui/pages/projects/lib/project-api';

/**
 * Display names for known providers. `providerSummary[].name` is the lowercase canonical name, so a
 * small map avoids showing e.g. "openai" -> "Openai". Unknown providers fall back to title-casing.
 * Kept minimal (no marketing copy) and colocated with the only current consumer (Step 1).
 */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  claude: 'Claude',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  codex: 'Codex',
  gpt: 'GPT',
  opencode: 'OpenCode',
  agy: 'Antigravity',
  antigravity: 'Antigravity',
  copilot: 'Copilot',
};

/** Short, copy-light explanations keyed by lowercase provider name. */
const PROVIDER_DESCRIPTIONS: Record<string, string> = {
  claude: 'Anthropic Claude models.',
  anthropic: 'Anthropic Claude models.',
  openai: 'OpenAI GPT models.',
  codex: 'OpenAI Codex / GPT models.',
  gpt: 'OpenAI GPT models.',
  opencode: 'OpenCode multi-model agent.',
  agy: 'Google Antigravity agent.',
  antigravity: 'Google Antigravity agent.',
  copilot: 'GitHub Copilot agent.',
};

function displayName(name: string): string {
  return (
    PROVIDER_DISPLAY_NAMES[name] ?? (name ? name.charAt(0).toUpperCase() + name.slice(1) : name)
  );
}

function descriptionFor(name: string): string {
  return PROVIDER_DESCRIPTIONS[name] ?? 'Provider referenced by this template.';
}

export interface Step1ProvidersProps {
  /** Every provider referenced by the template (from the setup-preview response). */
  providerSummary: SetupPreviewProviderSummary[];
  /** Current selection — lowercased canonical provider names owned by the flow controller. */
  selectedProviderNames: string[];
  /** Family slugs that lose coverage under the current selection (empty when the gate passes). */
  uncoveredFamilies: string[];
  /** Emit the next full selection when a provider is toggled. */
  onSelectedChange: (next: string[]) => void;
}

/**
 * Wizard Step 1 — provider selection. Renders one selectable card per referenced provider
 * (provider icon + short explanation + family badges + agent count + availability). The selection is
 * owned by the flow controller (`useCreateProjectWizard`); this component is presentational and never
 * touches cross-step state — it receives the current selection + the derived `uncoveredFamilies` and
 * emits toggles via `onSelectedChange`.
 *
 * Unavailable providers are shown DISABLED with a hint (never hidden) — including config-only
 * providers (present only via `providerConfigs[].providerName`), which remain selectable/selectable-
 * looking per the design; their availability comes straight from `providerSummary[].available`.
 */
export function Step1Providers({
  providerSummary,
  selectedProviderNames,
  uncoveredFamilies,
  onSelectedChange,
}: Step1ProvidersProps) {
  if (providerSummary.length === 0) {
    return (
      <div
        className="rounded-md border border-dashed p-6 text-sm text-muted-foreground"
        data-testid="wizard-providers-empty"
      >
        This template doesn&rsquo;t reference any providers. You can continue.
      </div>
    );
  }

  const selectedSet = new Set(selectedProviderNames.map((name) => name.trim().toLowerCase()));

  const toggle = (name: string, checked: boolean) => {
    // Preserve canonical (lowercase) ordering; add newly selected providers to the end.
    const next = providerSummary
      .map((p) => p.name)
      .filter((n) => (n === name ? checked : selectedSet.has(n)));
    onSelectedChange(next);
  };

  return (
    <div className="space-y-3" data-testid="wizard-providers-step">
      <div className="space-y-2">
        {providerSummary.map((provider) => {
          const id = `wizard-provider-${provider.name}`;
          const isSelected = selectedSet.has(provider.name);
          const unavailable = !provider.available;
          const icon = getProviderIconDataUri(provider.name);

          return (
            <label
              key={provider.name}
              htmlFor={id}
              className={cn(
                'flex items-start gap-3 rounded-md border p-3 transition-colors',
                isSelected ? 'border-primary bg-primary/5' : 'border-border',
                unavailable ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-accent',
              )}
            >
              <Checkbox
                id={id}
                checked={isSelected}
                disabled={unavailable}
                onCheckedChange={(checked) => toggle(provider.name, checked === true)}
                aria-label={`${displayName(provider.name)} provider`}
                className="mt-0.5"
              />
              {icon ? (
                <img
                  src={icon}
                  alt=""
                  aria-hidden="true"
                  title={`Provider: ${provider.name}`}
                  className="mt-0.5 h-5 w-5 shrink-0"
                />
              ) : (
                <Plug
                  className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
              )}
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-medium text-foreground">{displayName(provider.name)}</span>
                  {unavailable && (
                    <Badge variant="secondary" className="font-normal">
                      Not installed
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">{descriptionFor(provider.name)}</p>
                {(provider.families.length > 0 || provider.agentCount > 0) && (
                  <div className="flex flex-wrap items-center gap-1.5 pt-0.5 text-xs text-muted-foreground">
                    {provider.families.map((family) => (
                      <Badge key={family} variant="outline" className="font-normal">
                        {family}
                      </Badge>
                    ))}
                    {provider.agentCount > 0 && (
                      <span>
                        {provider.agentCount} agent{provider.agentCount === 1 ? '' : 's'}
                      </span>
                    )}
                  </div>
                )}
                {unavailable && (
                  <p className="text-xs text-muted-foreground">
                    Install it on the Providers page to enable it for this project.
                  </p>
                )}
              </div>
            </label>
          );
        })}
      </div>

      {/* Only warn once the user has actually selected something: with the empty initial
          selection every family is trivially uncovered and Next is already gated. */}
      {selectedProviderNames.length > 0 && uncoveredFamilies.length > 0 && (
        <Alert variant="destructive" data-testid="wizard-providers-coverage-alert">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Family loses coverage</AlertTitle>
          <AlertDescription>
            The selection leaves {uncoveredFamilies.join(', ')} without any available provider.
            Select at least one available provider for{' '}
            {uncoveredFamilies.length === 1 ? 'this family' : 'each family'} to continue.
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
