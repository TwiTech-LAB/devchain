import React from 'react';
import { render } from '@testing-library/react';
import { SessionViewModeContext, type SessionViewMode } from '@/ui/hooks/useSessionViewMode';

/**
 * Wraps a React element with the SessionViewMode context set to the given mode.
 * Use in component tests to assert Reader-default or Diagnostic-opt-in behavior.
 */
export function renderWithMode(ui: React.ReactElement, mode: SessionViewMode = 'reader') {
  return render(
    <SessionViewModeContext.Provider value={{ mode, setMode: jest.fn() }}>
      {ui}
    </SessionViewModeContext.Provider>,
  );
}
