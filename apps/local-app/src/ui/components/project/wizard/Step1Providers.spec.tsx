import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { Step1Providers } from './Step1Providers';
import { getUncoveredFamilies } from './providerSelection';
import type {
  SetupPreviewFamilyAlternative,
  SetupPreviewProviderSummary,
} from '@/ui/pages/projects/lib/project-api';

const PROVIDERS: SetupPreviewProviderSummary[] = [
  { name: 'claude', available: true, families: ['reasoning'], agentCount: 2 },
  { name: 'codex', available: false, families: ['reasoning'], agentCount: 0 },
];

function fam(slug: string, availableProviders: string[]): SetupPreviewFamilyAlternative {
  return {
    familySlug: slug,
    defaultProvider: availableProviders[0] ?? '',
    defaultProviderAvailable: availableProviders.length > 0,
    availableProviders,
    hasAlternatives: availableProviders.length > 0,
  };
}

describe('getUncoveredFamilies', () => {
  it('returns no families when every family has a selected available provider', () => {
    expect(getUncoveredFamilies([fam('reasoning', ['claude', 'codex'])], ['claude'])).toEqual([]);
  });

  it('returns a family when none of its available providers are selected', () => {
    expect(getUncoveredFamilies([fam('reasoning', ['claude', 'codex'])], [])).toEqual([
      'reasoning',
    ]);
  });

  it('ignores families with no available providers (cannot be fixed by selection)', () => {
    expect(getUncoveredFamilies([fam('reasoning', [])], ['claude'])).toEqual([]);
  });

  it('returns only the families that actually lose coverage', () => {
    const families = [fam('reasoning', ['claude']), fam('vision', ['codex', 'gemini'])];
    // reasoning covered by claude; vision uncovered (codex + gemini both unselected).
    expect(getUncoveredFamilies(families, ['claude'])).toEqual(['vision']);
  });

  it('matches provider names case-insensitively', () => {
    expect(getUncoveredFamilies([fam('reasoning', ['claude'])], ['CLAUDE'])).toEqual([]);
  });

  it('returns no families when there are no family alternatives', () => {
    expect(getUncoveredFamilies([], ['claude'])).toEqual([]);
  });
});

describe('Step1Providers', () => {
  it('renders a selectable card for every referenced provider', () => {
    render(
      <Step1Providers
        providerSummary={PROVIDERS}
        selectedProviderNames={['claude']}
        uncoveredFamilies={[]}
        onSelectedChange={jest.fn()}
      />,
    );

    expect(screen.getByRole('checkbox', { name: 'Claude provider' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Codex provider' })).toBeInTheDocument();
    // Both providers belong to the reasoning family.
    expect(screen.getAllByText('reasoning')).toHaveLength(2);
    expect(screen.getByText(/2 agents/)).toBeInTheDocument();
  });

  it('marks unavailable providers disabled with a not-installed hint (never hidden)', () => {
    render(
      <Step1Providers
        providerSummary={PROVIDERS}
        selectedProviderNames={['claude']}
        uncoveredFamilies={[]}
        onSelectedChange={jest.fn()}
      />,
    );

    expect(screen.getByRole('checkbox', { name: 'Codex provider' })).toBeDisabled();
    expect(screen.getByText('Not installed')).toBeInTheDocument();
    expect(screen.getByText(/Install it on the Providers page/)).toBeInTheDocument();
  });

  it('reflects the supplied selection as the checked state', () => {
    render(
      <Step1Providers
        providerSummary={PROVIDERS}
        selectedProviderNames={['claude']}
        uncoveredFamilies={[]}
        onSelectedChange={jest.fn()}
      />,
    );

    expect(screen.getByRole('checkbox', { name: 'Claude provider' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Codex provider' })).not.toBeChecked();
  });

  it('emits the next selection when an available provider is deselected', () => {
    const onChange = jest.fn();
    render(
      <Step1Providers
        providerSummary={PROVIDERS}
        selectedProviderNames={['claude']}
        uncoveredFamilies={[]}
        onSelectedChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole('checkbox', { name: 'Claude provider' }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('emits the provider name when an available provider is selected from empty', () => {
    const onChange = jest.fn();
    render(
      <Step1Providers
        providerSummary={PROVIDERS}
        selectedProviderNames={[]}
        uncoveredFamilies={[]}
        onSelectedChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole('checkbox', { name: 'Claude provider' }));
    expect(onChange).toHaveBeenCalledWith(['claude']);
  });

  it('does not emit when a disabled (unavailable) provider is clicked', () => {
    const onChange = jest.fn();
    render(
      <Step1Providers
        providerSummary={PROVIDERS}
        selectedProviderNames={['claude']}
        uncoveredFamilies={[]}
        onSelectedChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole('checkbox', { name: 'Codex provider' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows the family-coverage alert naming the uncovered family', () => {
    render(
      <Step1Providers
        providerSummary={PROVIDERS}
        selectedProviderNames={['codex']}
        uncoveredFamilies={['reasoning']}
        onSelectedChange={jest.fn()}
      />,
    );

    expect(screen.getByTestId('wizard-providers-coverage-alert')).toHaveTextContent('reasoning');
  });

  it('suppresses the coverage alert while nothing is selected (fresh deselected state)', () => {
    render(
      <Step1Providers
        providerSummary={PROVIDERS}
        selectedProviderNames={[]}
        uncoveredFamilies={['reasoning']}
        onSelectedChange={jest.fn()}
      />,
    );

    expect(screen.queryByTestId('wizard-providers-coverage-alert')).not.toBeInTheDocument();
  });

  it('hides the alert when every family keeps coverage', () => {
    render(
      <Step1Providers
        providerSummary={PROVIDERS}
        selectedProviderNames={['claude']}
        uncoveredFamilies={[]}
        onSelectedChange={jest.fn()}
      />,
    );

    expect(screen.queryByTestId('wizard-providers-coverage-alert')).not.toBeInTheDocument();
  });

  it('renders an empty state when the template references no providers', () => {
    render(
      <Step1Providers
        providerSummary={[]}
        selectedProviderNames={[]}
        uncoveredFamilies={[]}
        onSelectedChange={jest.fn()}
      />,
    );

    expect(screen.getByTestId('wizard-providers-empty')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});
