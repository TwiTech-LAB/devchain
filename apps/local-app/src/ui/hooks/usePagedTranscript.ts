import { useState, useCallback } from 'react';

const STORAGE_KEY = 'devchain.pagedTranscript';

export function usePagedTranscriptFlag(): [boolean, (enabled: boolean) => void] {
  const [enabled, setEnabled] = useState(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored !== null) return stored === 'true';
      return true;
    } catch {
      return true;
    }
  });

  const toggle = useCallback((value: boolean) => {
    try {
      localStorage.setItem(STORAGE_KEY, String(value));
    } catch {
      /* localStorage unavailable */
    }
    setEnabled(value);
  }, []);

  return [enabled, toggle];
}

export function isPagedTranscriptEnabled(): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored !== null) return stored === 'true';
    return true;
  } catch {
    return true;
  }
}
