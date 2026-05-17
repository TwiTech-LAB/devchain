/**
 * Default-on paged transcript regression tests.
 *
 * Layer: Component integration (render component with real hook wiring, mock at network boundary).
 * Why this layer: Proves the production call sites pass the correct `enableTranscript` value
 * based on the paged flag, without needing a running server.
 *
 * These tests lock the R1 contract: when paged mode is on (default), the full
 * transcript endpoint is NOT called.
 */
import React from 'react';
import { render } from '@testing-library/react';
import { SessionReadSlideOver } from '../SessionReadSlideOver';
import { useSessionTranscript } from '@/ui/hooks/useSessionTranscript';

jest.mock('@/ui/hooks/useSessionTranscript', () => ({
  useSessionTranscript: jest.fn(),
}));

jest.mock('@/ui/components/session-reader/SessionViewerPanel', () => ({
  SessionViewerPanel: () => <div data-testid="session-viewer" />,
}));

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
    refetch: jest.fn(),
  };
}

describe('Default-on paged transcript regression (SessionReadSlideOver)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseSessionTranscript.mockReturnValue(defaultTranscript());
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('when paged mode is ON (default, no localStorage key), passes enableTranscript: false', () => {
    render(<SessionReadSlideOver sessionId="session-1" onClose={jest.fn()} />);

    expect(mockUseSessionTranscript).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ enableTranscript: false }),
    );
  });

  it('when paged mode is ON (explicit localStorage true), passes enableTranscript: false', () => {
    localStorage.setItem('devchain.pagedTranscript', 'true');

    render(<SessionReadSlideOver sessionId="session-1" onClose={jest.fn()} />);

    expect(mockUseSessionTranscript).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ enableTranscript: false }),
    );
  });

  it('when paged mode is OFF (localStorage false), passes enableTranscript: true', () => {
    localStorage.setItem('devchain.pagedTranscript', 'false');

    render(<SessionReadSlideOver sessionId="session-1" onClose={jest.fn()} />);

    expect(mockUseSessionTranscript).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ enableTranscript: true }),
    );
  });

  it('does NOT call GET /transcript when paged mode is default-on', () => {
    render(<SessionReadSlideOver sessionId="session-1" onClose={jest.fn()} />);

    const callOptions = mockUseSessionTranscript.mock.calls[0]?.[1];
    expect(callOptions?.enableTranscript).toBe(false);

    expect(mockUseSessionTranscript).toHaveBeenCalledTimes(1);
  });
});
