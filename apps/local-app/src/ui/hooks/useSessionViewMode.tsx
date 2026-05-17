import { createContext, useCallback, useContext, useState } from 'react';

export type SessionViewMode = 'reader' | 'diagnostic';

const STORAGE_KEY = 'devchain.session.viewMode';
const VALID_MODES: readonly string[] = ['reader', 'diagnostic'];

function readStoredMode(): SessionViewMode {
  if (typeof window === 'undefined') return 'reader';
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && VALID_MODES.includes(stored)) return stored as SessionViewMode;
  } catch {
    // localStorage unavailable
  }
  return 'reader';
}

interface SessionViewModeContextValue {
  mode: SessionViewMode;
  setMode: (m: SessionViewMode) => void;
}

export const SessionViewModeContext = createContext<SessionViewModeContextValue>({
  mode: 'reader',
  setMode: () => {},
});

export function SessionViewModeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<SessionViewMode>(readStoredMode);

  const setMode = useCallback((m: SessionViewMode) => {
    setModeState(m);
    try {
      localStorage.setItem(STORAGE_KEY, m);
    } catch {
      // localStorage unavailable
    }
  }, []);

  return (
    <SessionViewModeContext.Provider value={{ mode, setMode }}>
      {children}
    </SessionViewModeContext.Provider>
  );
}

export function useSessionViewMode(): SessionViewModeContextValue {
  return useContext(SessionViewModeContext);
}
