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
        availableProviders: ['claude', 'codex'],
        hasAlternatives: true,
      },
    ] as FamilyAlternative[],
    canImport: true,
    onConfirm: jest.fn(),
  };

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('shows blocked import and missing alternatives', () => {
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
    {
      expect(screen.queryByRole('button', { name: 'Import' })).not.toBeInTheDocument();
    }
    {
      expect(screen.getByText('Cannot Import')).toBeInTheDocument();
      expect(
        screen.getByText(/One or more required families have no available providers/),
      ).toBeInTheDocument();
    }
    {
      expect(screen.getByText('No alternatives')).toBeInTheDocument();
    }
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

  it('disables import and cancel while importing', () => {
    render(<ProviderMappingModal {...defaultProps} loading={true} />);
    {
      expect(screen.getByRole('button', { name: 'Importing...' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Importing...' })).toBeDisabled();
    }
    {
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    }
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
          availableProviders: ['claude', 'codex'],
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

  it('names blocked families and missing providers in the import alert', () => {
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
    {
      const alertText = screen.getByText(/One or more required families/);
      expect(alertText.textContent).toContain('reviewer');
      expect(alertText.textContent).toContain('planner');
    }
    {
      const alertText = screen.getByText(/Install the missing providers/);
      expect(alertText.textContent).toContain('codex');
      expect(alertText.textContent).toContain('openai');
    }
  });
});
