import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
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
  promptTransfer: { imported: 2, deleted: 1, preserved: 3, skipped: 4 },
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
    const imported = screen.getByText('Imported').parentElement!;
    const deleted = screen.getByText('Deleted').parentElement!;
    expect(screen.getAllByText('agents')).toHaveLength(2);
    expect(within(imported).getByText('3')).toBeInTheDocument();
    expect(within(imported).getByText('5')).toBeInTheDocument();
    expect(within(deleted).getByText('1')).toBeInTheDocument();
    expect(within(deleted).getByText('2')).toBeInTheDocument();
  });

  it('renders initial prompt mapping status', () => {
    render(<ImportResultDialog {...defaultProps} />);
    expect(screen.getByText(/Initial prompt mapping: Set/)).toBeInTheDocument();
  });

  it('renders preserved and skipped prompt counts', () => {
    render(<ImportResultDialog {...defaultProps} />);
    const promptTransfer = screen.getByText('Prompt transfer').parentElement!;
    expect(within(promptTransfer).getByText('preserved')).toBeInTheDocument();
    expect(within(promptTransfer).getByText('skipped')).toBeInTheDocument();
    expect(within(promptTransfer).getByText('3')).toBeInTheDocument();
    expect(within(promptTransfer).getByText('4')).toBeInTheDocument();
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
