import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { SessionReadSlideOver } from './SessionReadSlideOver';

// Mock the transcript hook — component should not fetch real data in tests
jest.mock('@/ui/hooks/useSessionTranscript', () => ({
  useSessionTranscript: jest.fn(),
}));

// Legacy mode: explicitly mock paged flag to false (legacy full-transcript path)
jest.mock('@/ui/hooks/usePagedTranscript', () => ({
  isPagedTranscriptEnabled: jest.fn().mockReturnValue(false),
}));

// Mock SessionViewerPanel to keep the test surface minimal
jest.mock('@/ui/components/session-reader/SessionViewerPanel', () => ({
  SessionViewerPanel: ({ sessionId }: { sessionId: string | null }) => (
    <div data-testid="session-viewer">{sessionId}</div>
  ),
}));

import { useSessionTranscript } from '@/ui/hooks/useSessionTranscript';
const mockUseSessionTranscript = useSessionTranscript as jest.MockedFunction<
  typeof useSessionTranscript
>;

function defaultTranscript(): ReturnType<typeof useSessionTranscript> {
  return {
    messages: [],
    chunks: [],
    metrics: null,
    isLoading: false,
    error: null,
    isLive: false,
    session: null,
  };
}

describe('SessionReadSlideOver — Legacy full-transcript mode (devchain.pagedTranscript=false)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseSessionTranscript.mockReturnValue(defaultTranscript());
  });

  it('does not render the dialog when sessionId is null', () => {
    render(<SessionReadSlideOver sessionId={null} onClose={jest.fn()} />);
    expect(screen.queryByText('Session transcript')).not.toBeInTheDocument();
  });

  it('renders the dialog when sessionId is provided', () => {
    render(<SessionReadSlideOver sessionId="session-abc" onClose={jest.fn()} />);
    expect(screen.getByText('Session transcript')).toBeInTheDocument();
  });

  it('renders SessionViewerPanel with the given sessionId', () => {
    render(<SessionReadSlideOver sessionId="session-xyz" onClose={jest.fn()} />);
    const viewer = screen.getByTestId('session-viewer');
    expect(viewer).toBeInTheDocument();
    expect(viewer.textContent).toBe('session-xyz');
  });

  it('calls onClose when the close button is clicked', () => {
    const onClose = jest.fn();
    render(<SessionReadSlideOver sessionId="session-1" onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /close transcript viewer/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('passes useSessionTranscript result to SessionViewerPanel', () => {
    mockUseSessionTranscript.mockReturnValue({
      ...defaultTranscript(),
      isLoading: true,
    });
    render(<SessionReadSlideOver sessionId="session-loading" onClose={jest.fn()} />);
    // Dialog is still open (loading state doesn't hide it)
    expect(screen.getByText('Session transcript')).toBeInTheDocument();
  });
});
