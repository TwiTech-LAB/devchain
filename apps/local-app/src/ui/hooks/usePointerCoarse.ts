import { useEffect, useState } from 'react';

/**
 * Detects whether the current device primarily uses a coarse pointer (touch).
 * Falls back to `false` during SSR or when `matchMedia` is unavailable.
 */
export function usePointerCoarse(): boolean {
  const [isCoarse, setIsCoarse] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const mediaQuery = window.matchMedia('(pointer: coarse)');
    const handleChange = (event: MediaQueryListEvent) => {
      setIsCoarse(event.matches);
    };

    setIsCoarse(mediaQuery.matches);

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handleChange);
      return () => mediaQuery.removeEventListener('change', handleChange);
    }

    // Fallback for Safari < 14
    const legacyListener = (event: MediaQueryListEvent) => {
      setIsCoarse(event.matches);
    };

    mediaQuery.addListener(legacyListener);
    return () => mediaQuery.removeListener(legacyListener);
  }, []);

  return isCoarse;
}
