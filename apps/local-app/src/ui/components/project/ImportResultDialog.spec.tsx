import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { ImportResultDialog } from './ImportResultDialog';
import type { ImportResult } from '@/ui/hooks/useProjectImport';

jest.mock('@radix-ui/react-dialog', () => {
  const actual = jest.requireActual('@radix-ui/react-dialog');
  return {
    ...actual,
    Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

const mockResult: ImportResult = {
  success: true,
  counts: {
    imported: { agents: 3, epics: 5 },
    deleted: { agents: 1, epics: 2 },
  },
  mappings: {},
  initialPromptSet: true,
};

describe('ImportResultDialog', () => {
  const defaultProps = {
    open: true,
    onOpenChange: jest.fn(),
    importResult: mockResult,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders import counts', () => {
    render(<ImportResultDialog {...defaultProps} />);
    expect(screen.getByText('Import Completed')).toBeInTheDocument();
    expect(screen.getByText('Imported')).toBeInTheDocument();
    expect(screen.getAllByText('agents')).toHaveLength(2);
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('Deleted')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('renders initial prompt mapping status', () => {
    render(<ImportResultDialog {...defaultProps} />);
    expect(screen.getByText(/Initial prompt mapping: Set/)).toBeInTheDocument();
  });

  it('renders "Not set" when initialPromptSet is false', () => {
    const result = { ...mockResult, initialPromptSet: false };
    render(<ImportResultDialog {...defaultProps} importResult={result} />);
    expect(screen.getByText(/Initial prompt mapping: Not set/)).toBeInTheDocument();
  });

  it('calls onOpenChange(false) when Close button is clicked', () => {
    render(<ImportResultDialog {...defaultProps} />);
    const buttons = screen.getAllByRole('button', { name: 'Close' });
    fireEvent.click(buttons[0]);
    expect(defaultProps.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('handles null importResult gracefully', () => {
    render(<ImportResultDialog {...defaultProps} importResult={null} />);
    expect(screen.getByText('Import Completed')).toBeInTheDocument();
    expect(screen.queryByText('Imported')).not.toBeInTheDocument();
  });
});
