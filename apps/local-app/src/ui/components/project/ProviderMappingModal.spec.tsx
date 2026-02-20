import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProviderMappingModal, FamilyAlternative } from './ProviderMappingModal';

// Mock Radix Dialog portal to render inline for testing
jest.mock('@radix-ui/react-dialog', () => {
  const actual = jest.requireActual('@radix-ui/react-dialog');
  return {
    ...actual,
    Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

// Mock Radix Select portal
jest.mock('@radix-ui/react-select', () => {
  const actual = jest.requireActual('@radix-ui/react-select');
  return {
    ...actual,
    Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

// ResizeObserver mock for Radix components
(global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

describe('ProviderMappingModal', () => {
  const defaultProps = {
    open: true,
    onOpenChange: jest.fn(),
    missingProviders: ['codex'],
    familyAlternatives: [
      {
        familySlug: 'coder',
        defaultProvider: 'codex',
        defaultProviderAvailable: false,
        availableProviders: ['claude', 'gemini'],
        hasAlternatives: true,
      },
    ] as FamilyAlternative[],
    canImport: true,
    onConfirm: jest.fn(),
  };

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders nothing when open is false', () => {
    render(<ProviderMappingModal {...defaultProps} open={false} />);
    expect(screen.queryByText('Provider Configuration Required')).not.toBeInTheDocument();
  });

  it('displays the dialog title and warning message when open', () => {
    render(<ProviderMappingModal {...defaultProps} />);

    expect(screen.getByText('Provider Configuration Required')).toBeInTheDocument();
    expect(
      screen.getByText(/The recommended provider configuration is not possible/),
    ).toBeInTheDocument();
  });

  it('displays missing providers', () => {
    render(<ProviderMappingModal {...defaultProps} />);

    expect(screen.getByText('Missing Providers')).toBeInTheDocument();
    // 'codex' appears in both the missing providers alert and the table
    // Use getAllByText to verify it appears at least once
    expect(screen.getAllByText('codex').length).toBeGreaterThanOrEqual(1);
  });

  it('displays family mapping table with default provider marked as unavailable', () => {
    render(<ProviderMappingModal {...defaultProps} />);

    // Table headers
    expect(screen.getByText('Family')).toBeInTheDocument();
    expect(screen.getByText('Default Provider')).toBeInTheDocument();
    expect(screen.getByText('Use Instead')).toBeInTheDocument();

    // Family row
    expect(screen.getByText('coder')).toBeInTheDocument();
  });

  it('shows Import button when canImport is true', () => {
    render(<ProviderMappingModal {...defaultProps} />);

    expect(screen.getByRole('button', { name: 'Import' })).toBeInTheDocument();
  });

  it('hides Import button when all families are blocked (no alternatives)', () => {
    const propsAllBlocked = {
      ...defaultProps,
      familyAlternatives: [
        {
          familySlug: 'special',
          defaultProvider: 'codex',
          defaultProviderAvailable: false,
          availableProviders: [],
          hasAlternatives: false,
        },
      ] as FamilyAlternative[],
      canImport: false,
    };

    render(<ProviderMappingModal {...propsAllBlocked} />);

    expect(screen.queryByRole('button', { name: 'Import' })).not.toBeInTheDocument();
  });

  it('shows cannot import alert when all families are blocked', () => {
    const propsAllBlocked = {
      ...defaultProps,
      familyAlternatives: [
        {
          familySlug: 'special',
          defaultProvider: 'codex',
          defaultProviderAvailable: false,
          availableProviders: [],
          hasAlternatives: false,
        },
      ] as FamilyAlternative[],
      canImport: false,
    };

    render(<ProviderMappingModal {...propsAllBlocked} />);

    expect(screen.getByText('Cannot Import')).toBeInTheDocument();
    expect(
      screen.getByText(/One or more required families have no available providers/),
    ).toBeInTheDocument();
  });

  it('shows "No alternatives" for families without available providers', () => {
    const propsWithNoAlternatives = {
      ...defaultProps,
      familyAlternatives: [
        {
          familySlug: 'special',
          defaultProvider: 'codex',
          defaultProviderAvailable: false,
          availableProviders: [],
          hasAlternatives: false,
        },
      ] as FamilyAlternative[],
      canImport: false,
    };

    render(<ProviderMappingModal {...propsWithNoAlternatives} />);

    expect(screen.getByText('No alternatives')).toBeInTheDocument();
  });

  it('calls onOpenChange when Cancel button is clicked', () => {
    render(<ProviderMappingModal {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(defaultProps.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('calls onConfirm with mappings when Import button is clicked', async () => {
    render(<ProviderMappingModal {...defaultProps} />);

    // Select a provider from the dropdown (default selection is first available)
    // The component initializes with the first available provider
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() => {
      expect(defaultProps.onConfirm).toHaveBeenCalledWith({
        coder: 'claude', // Default selection is first available provider
      });
    });
  });

  it('shows loading state when loading prop is true', () => {
    render(<ProviderMappingModal {...defaultProps} loading={true} />);

    expect(screen.getByRole('button', { name: 'Importing...' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Importing...' })).toBeDisabled();
  });

  it('displays multiple missing providers correctly', () => {
    render(
      <ProviderMappingModal
        {...defaultProps}
        missingProviders={['codex', 'openai', 'anthropic']}
      />,
    );

    expect(screen.getByText('codex, openai, anthropic')).toBeInTheDocument();
  });

  it('only shows families that need mapping (default not available)', () => {
    const propsWithMixed = {
      ...defaultProps,
      familyAlternatives: [
        {
          familySlug: 'coder',
          defaultProvider: 'codex',
          defaultProviderAvailable: false,
          availableProviders: ['claude'],
          hasAlternatives: true,
        },
        {
          familySlug: 'reviewer',
          defaultProvider: 'claude',
          defaultProviderAvailable: true, // This one should NOT be shown
          availableProviders: ['claude'],
          hasAlternatives: true,
        },
      ] as FamilyAlternative[],
    };

    render(<ProviderMappingModal {...propsWithMixed} />);

    // 'coder' should be visible (needs mapping)
    expect(screen.getByText('coder')).toBeInTheDocument();
    // 'reviewer' should NOT be visible (default is available)
    expect(screen.queryByText('reviewer')).not.toBeInTheDocument();
  });

  it('handles multiple families needing mapping', async () => {
    const propsWithMultipleFamilies = {
      ...defaultProps,
      familyAlternatives: [
        {
          familySlug: 'coder',
          defaultProvider: 'codex',
          defaultProviderAvailable: false,
          availableProviders: ['claude', 'gemini'],
          hasAlternatives: true,
        },
        {
          familySlug: 'reviewer',
          defaultProvider: 'codex',
          defaultProviderAvailable: false,
          availableProviders: ['claude'],
          hasAlternatives: true,
        },
      ] as FamilyAlternative[],
    };

    render(<ProviderMappingModal {...propsWithMultipleFamilies} />);

    // Both families should be visible
    expect(screen.getByText('coder')).toBeInTheDocument();
    expect(screen.getByText('reviewer')).toBeInTheDocument();

    // Click Import and verify both families are in mappings
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() => {
      expect(defaultProps.onConfirm).toHaveBeenCalledWith({
        coder: 'claude',
        reviewer: 'claude',
      });
    });
  });

  it('handles single available provider correctly', () => {
    const propsWithSingleProvider = {
      ...defaultProps,
      familyAlternatives: [
        {
          familySlug: 'coder',
          defaultProvider: 'codex',
          defaultProviderAvailable: false,
          availableProviders: ['claude'], // Only one alternative
          hasAlternatives: true,
        },
      ] as FamilyAlternative[],
    };

    render(<ProviderMappingModal {...propsWithSingleProvider} />);

    // Should still show the table and allow import
    expect(screen.getByText('coder')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import' })).toBeInTheDocument();
  });

  it('disables Cancel button while loading', () => {
    render(<ProviderMappingModal {...defaultProps} loading={true} />);

    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });

  it('handles mixed families - some with alternatives, some without (canImport=false)', () => {
    const propsWithMixedAlternatives = {
      ...defaultProps,
      familyAlternatives: [
        {
          familySlug: 'coder',
          defaultProvider: 'codex',
          defaultProviderAvailable: false,
          availableProviders: ['claude'],
          hasAlternatives: true,
        },
        {
          familySlug: 'special',
          defaultProvider: 'codex',
          defaultProviderAvailable: false,
          availableProviders: [],
          hasAlternatives: false,
        },
      ] as FamilyAlternative[],
      canImport: false, // Cannot import because 'special' has no alternatives
    };

    render(<ProviderMappingModal {...propsWithMixedAlternatives} />);

    // Both families should be shown
    expect(screen.getByText('coder')).toBeInTheDocument();
    expect(screen.getByText('special')).toBeInTheDocument();

    // 'No alternatives' message should be shown for special
    expect(screen.getByText('No alternatives')).toBeInTheDocument();

    // Import button should NOT be shown when canImport=false
    expect(screen.queryByRole('button', { name: 'Import' })).not.toBeInTheDocument();

    // Cannot Import alert should be shown
    expect(screen.getByText('Cannot Import')).toBeInTheDocument();

    // Partial coverage warning should NOT be shown when canImport=false
    expect(screen.queryByText('Partial Provider Coverage')).not.toBeInTheDocument();
  });

  it('includes blocked family names in Cannot Import alert', () => {
    const props = {
      ...defaultProps,
      familyAlternatives: [
        {
          familySlug: 'coder',
          defaultProvider: 'codex',
          defaultProviderAvailable: false,
          availableProviders: ['claude'],
          hasAlternatives: true,
        },
        {
          familySlug: 'reviewer',
          defaultProvider: 'openai',
          defaultProviderAvailable: false,
          availableProviders: [],
          hasAlternatives: false,
        },
        {
          familySlug: 'planner',
          defaultProvider: 'openai',
          defaultProviderAvailable: false,
          availableProviders: [],
          hasAlternatives: false,
        },
      ] as FamilyAlternative[],
      missingProviders: ['codex', 'openai'],
      canImport: false,
    };

    render(<ProviderMappingModal {...props} />);

    // The "Cannot Import" alert should enumerate blocked family slugs
    const alertText = screen.getByText(/One or more required families/);
    expect(alertText.textContent).toContain('reviewer');
    expect(alertText.textContent).toContain('planner');
  });

  it('includes missing provider names in Cannot Import alert', () => {
    const props = {
      ...defaultProps,
      familyAlternatives: [
        {
          familySlug: 'special',
          defaultProvider: 'codex',
          defaultProviderAvailable: false,
          availableProviders: [],
          hasAlternatives: false,
        },
      ] as FamilyAlternative[],
      missingProviders: ['codex', 'openai'],
      canImport: false,
    };

    render(<ProviderMappingModal {...props} />);

    // The "Cannot Import" alert should include the missing provider names
    const alertText = screen.getByText(/Install the missing providers/);
    expect(alertText.textContent).toContain('codex');
    expect(alertText.textContent).toContain('openai');
  });
});
