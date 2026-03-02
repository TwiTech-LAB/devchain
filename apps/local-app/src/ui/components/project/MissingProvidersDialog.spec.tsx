import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MissingProvidersDialog } from './MissingProvidersDialog';

jest.mock('@radix-ui/react-dialog', () => {
  const actual = jest.requireActual('@radix-ui/react-dialog');
  return {
    ...actual,
    Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

describe('MissingProvidersDialog', () => {
  const defaultProps = {
    open: true,
    onOpenChange: jest.fn(),
    missingProviders: ['Claude', 'GPT-4'],
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders title and provider list', () => {
    render(<MissingProvidersDialog {...defaultProps} />);
    expect(screen.getByText('Providers Required')).toBeInTheDocument();
    expect(screen.getByText('Claude')).toBeInTheDocument();
    expect(screen.getByText('GPT-4')).toBeInTheDocument();
  });

  it('calls onOpenChange(false) when Close button is clicked', () => {
    render(<MissingProvidersDialog {...defaultProps} />);
    const buttons = screen.getAllByRole('button', { name: 'Close' });
    fireEvent.click(buttons[0]);
    expect(defaultProps.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('renders no list items when missingProviders is undefined', () => {
    render(<MissingProvidersDialog {...defaultProps} missingProviders={undefined} />);
    expect(screen.getByText('Providers Required')).toBeInTheDocument();
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
  });

  it('renders no list items when missingProviders is empty', () => {
    render(<MissingProvidersDialog {...defaultProps} missingProviders={[]} />);
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
  });
});
