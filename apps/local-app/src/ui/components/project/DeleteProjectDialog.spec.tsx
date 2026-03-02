import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { DeleteProjectDialog } from './DeleteProjectDialog';

jest.mock('@radix-ui/react-dialog', () => {
  const actual = jest.requireActual('@radix-ui/react-dialog');
  return {
    ...actual,
    Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

describe('DeleteProjectDialog', () => {
  const defaultProps = {
    projectName: 'My Project',
    open: true,
    onOpenChange: jest.fn(),
    onConfirm: jest.fn(),
    isDeleting: false,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders project name in confirmation message', () => {
    render(<DeleteProjectDialog {...defaultProps} />);
    expect(screen.getByText(/My Project/)).toBeInTheDocument();
    expect(screen.getByText(/Delete Project/)).toBeInTheDocument();
  });

  it('calls onConfirm when Delete button is clicked', () => {
    render(<DeleteProjectDialog {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(defaultProps.onConfirm).toHaveBeenCalledTimes(1);
  });

  it('calls onOpenChange(false) when Cancel button is clicked', () => {
    render(<DeleteProjectDialog {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(defaultProps.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('disables Delete button while deleting', () => {
    render(<DeleteProjectDialog {...defaultProps} isDeleting={true} />);
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
  });

  it('does not render content when closed', () => {
    render(<DeleteProjectDialog {...defaultProps} open={false} />);
    expect(screen.queryByText(/Delete Project/)).not.toBeInTheDocument();
  });
});
