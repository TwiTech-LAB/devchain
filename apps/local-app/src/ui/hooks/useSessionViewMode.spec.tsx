import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { useSessionViewMode, SessionViewModeProvider } from './useSessionViewMode';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

function TestComponent() {
  const { mode, setMode } = useSessionViewMode();

  return (
    <div>
      <span data-testid="current-mode">{mode}</span>
      <button data-testid="set-reader" onClick={() => setMode('reader')}>
        Reader
      </button>
      <button data-testid="set-diagnostic" onClick={() => setMode('diagnostic')}>
        Diagnostic
      </button>
    </div>
  );
}

function renderWithProvider() {
  return render(
    <SessionViewModeProvider>
      <TestComponent />
    </SessionViewModeProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useSessionViewMode', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to reader mode', () => {
    renderWithProvider();
    expect(screen.getByTestId('current-mode').textContent).toBe('reader');
  });

  it('persists mode to localStorage', () => {
    renderWithProvider();
    fireEvent.click(screen.getByTestId('set-diagnostic'));
    expect(screen.getByTestId('current-mode').textContent).toBe('diagnostic');
    expect(localStorage.getItem('devchain.session.viewMode')).toBe('diagnostic');
  });

  it('restores mode from localStorage', () => {
    localStorage.setItem('devchain.session.viewMode', 'diagnostic');
    renderWithProvider();
    expect(screen.getByTestId('current-mode').textContent).toBe('diagnostic');
  });

  it('falls back to reader on invalid stored value', () => {
    localStorage.setItem('devchain.session.viewMode', 'invalid-mode');
    renderWithProvider();
    expect(screen.getByTestId('current-mode').textContent).toBe('reader');
  });

  it('toggles between reader and diagnostic', () => {
    renderWithProvider();
    expect(screen.getByTestId('current-mode').textContent).toBe('reader');

    fireEvent.click(screen.getByTestId('set-diagnostic'));
    expect(screen.getByTestId('current-mode').textContent).toBe('diagnostic');

    fireEvent.click(screen.getByTestId('set-reader'));
    expect(screen.getByTestId('current-mode').textContent).toBe('reader');
  });

  it('returns reader when used outside provider', () => {
    render(<TestComponent />);
    expect(screen.getByTestId('current-mode').textContent).toBe('reader');
  });
});
