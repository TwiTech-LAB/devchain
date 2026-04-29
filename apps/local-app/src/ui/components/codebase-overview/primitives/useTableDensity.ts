import { useCallback, useState } from 'react';

export type Density = 'compact' | 'comfortable';

const STORAGE_KEY = 'overview.tableDensity';

function readStored(): Density {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'compact' || raw === 'comfortable') return raw;
  } catch {
    // ignore
  }
  return 'comfortable';
}

export function useTableDensity(): { density: Density; setDensity: (v: Density) => void } {
  const [density, setDensityState] = useState<Density>(readStored);

  const setDensity = useCallback((v: Density) => {
    try {
      localStorage.setItem(STORAGE_KEY, v);
    } catch {
      // ignore
    }
    setDensityState(v);
  }, []);

  return { density, setDensity };
}
