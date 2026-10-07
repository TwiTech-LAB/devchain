import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { Step1Providers } from './Step1Providers';
import { getUncoveredFamilies } from './providerSelection';
import type {
  SetupPreviewFamilyAlternative,
  SetupPreviewProviderSummary,
} from '@/ui/pages/projects/lib/project-contracts';

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
  it('returns only the families that actually lose coverage', () => {
    const families = [fam('reasoning', ['claude']), fam('vision', ['codex', 'gemini'])];
    // reasoning covered by claude; vision uncovered (codex + gemini both unselected).
    expect(getUncoveredFamilies(families, ['claude'])).toEqual(['vision']);
  });

  it('matches provider names case-insensitively', () => {
    expect(getUncoveredFamilies([fam('reasoning', ['claude'])], ['CLAUDE'])).toEqual([]);
  });
});

describe('Step1Providers', () => {
  it('shows referenced providers with availability, selection and coverage state', () => {
    render(
      <Step1Providers
        providerSummary={PROVIDERS}
        selectedProviderNames={['claude']}
        uncoveredFamilies={[]}
        onSelectedChange={jest.fn()}
      />,
    );
    {
      expect(screen.getByRole('checkbox', { name: 'Claude provider' })).toBeInTheDocument();
      expect(screen.getByRole('checkbox', { name: 'Codex provider' })).toBeInTheDocument();
      expect(screen.getAllByText('reasoning')).toHaveLength(2);
      expect(screen.getByText(/2 agents/)).toBeInTheDocument();
    }
    {
      expect(screen.getByRole('checkbox', { name: 'Codex provider' })).toBeDisabled();
      expect(screen.getByText('Not installed')).toBeInTheDocument();
      expect(screen.getByText(/Install it on the Providers page/)).toBeInTheDocument();
    }
    {
      expect(screen.getByRole('checkbox', { name: 'Claude provider' })).toBeChecked();
      expect(screen.getByRole('checkbox', { name: 'Codex provider' })).not.toBeChecked();
    }
    {
      expect(screen.queryByTestId('wizard-providers-coverage-alert')).not.toBeInTheDocument();
    }
  });

  it.each([
    { label: 'deselect Claude', selected: ['claude'], name: 'Claude provider', expected: [] },
    { label: 'select Claude', selected: [], name: 'Claude provider', expected: ['claude'] },
    { label: 'unavailable Codex', selected: ['claude'], name: 'Codex provider', expected: null },
  ] as const)('$label', ({ selected, name, expected }) => {
    const onChange = jest.fn();
    render(
      <Step1Providers
        providerSummary={PROVIDERS}
        selectedProviderNames={[...selected]}
        uncoveredFamilies={[]}
        onSelectedChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole('checkbox', { name }));
    if (expected === null) expect(onChange).not.toHaveBeenCalled();
    else expect(onChange).toHaveBeenCalledWith(expected);
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
